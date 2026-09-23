#!/usr/bin/env node
// rig — cross-repo work harness. Zero dependencies by design; see DESIGN.md §2.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { RigError, TrackerError } from './errors.mjs'
import { githubViaGh, githubInMemory } from './github.mjs'
import { twgViaCli, twgInMemory } from './jira.mjs'
import { worktrees, remotesOnGitHub, remotesInDirectory } from './worktrees.mjs'
import { checkouts, unreadable } from './checkouts.mjs'
import { discover, notARepository } from './gitfs.mjs'
import { MAJOR, FORMAT_STAMP, dataMajor, stampUnreadable, pendingMigrations, writesBlocked, applyMigrations } from './version.mjs'
import { REFRESH_COMMAND, skipReason, dueForRefresh, staleLine, announces } from './freshness.mjs'
import { impact, unattached } from './catalog-graph.mjs'
import { releaseMark } from './release.mjs'
import { renderDash } from './dash.mjs'
import { renderDemo, summarize as demoModel } from './demo.mjs'
import { workState } from './workstate.mjs'
import { phaseOf, phaseLabel, statusLine, gatesOf, contradictions } from './phase.mjs'
import { nextFor } from './next.mjs'
import { doctorFindings, problemCount, ISSUES_URL } from './doctor.mjs'
import { stackOf, nextStage, stageBranchProblem, stageTable, renderPlanRegion, refreshedPlan, planIsStale, adriftNote } from './stages.mjs'
import { locate, withDataRoot, load, readOrg, writeMachine, writeOrg, strayOrgKeys, sameDir, insideDir, registry, anchoredRoot, rootsCataloguing, DEFAULT_ROOT_NAME } from './roots.mjs'

// The tool checkout this file is part of, and the installation a run is a run *of* unless
// it is told otherwise: a test drives this code against a throwaway installation in a temp
// directory, and `rig.local.json`, `prompts/`, `templates/` and every freshness reading have
// to be that one's rather than this checkout's.
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- primitives

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
}

// ------------------------------------------------------------- an invocation

// One run of rig, and everything about it that is not code: the installation it is a run of,
// where it is standing, what it may read of the machine, where its words go, and the state it
// collects on the way. `run` at the bottom builds one, makes it current for the length of the
// call and puts back what was there, so nothing a run accumulates can reach the next one —
// which is what lets a test drive rig in its own process instead of paying for one.
//
// Ambient rather than a parameter, and that is the trade this makes: threading one argument
// through every function in this file would *be* the change, and what a second run in one
// process needed was the state's **lifetime**, not the plumbing. What used to end when the
// process ended — the five module-level bindings, the two memoised tracker adapters, the PATH
// answers — now ends when the invocation does. One run at a time in a process, which is what
// the CLI has by construction and what `node --test` gives: files run in parallel processes
// and a file's tests in sequence.
//
// It starts as the process, because two of the helpers in the export block —
// `branchFirstCommitAt` and `prTiming` — are exported for their logic and reach git and
// GitHub to apply it, and a test calls those without ever starting a run.
let current = invocationOf({})

const toolRoot = () => current.toolRoot
// Where the run is standing, for the commands that need to know. A run handed none is standing
// where the process is, and the process is asked only now: a shell left in a folder `rig close`
// deleted has no cwd to give, and `rig help` from there has no use for one.
const cwd = () => current.cwd ?? process.cwd()

// Whether the run is standing in `dir`, asked before removing it. A directory the process can
// no longer report — the shell a `rig close` left in a folder that is gone — is standing in
// nothing about to be removed, and a command pinned by `--work` never needed it at all.
const standingIn = dir => { try { return insideDir(cwd(), dir) } catch { return false } }
const env = () => current.env
// Windows refuses to remove a directory that is some process's cwd, so `rig close` and
// `rig detach` move out of the one they are standing in. Where the *run* is standing always
// moves; whether the process moves with it is the caller's answer, because an in-process run
// does not own the process.
const chdir = dir => { current.cwd = dir; current.chdir(dir) }
// Raw writers: what a command has to say, with nothing added. The six sinks below add the
// line and the glyph; `cmds.catalog` and `cmds.prompt` write a file through `out` unchanged,
// which is what keeps a piped entry byte-for-byte the file it came from.
const out = s => current.out(s)
const err = s => current.err(s)

// Six sinks and one writer behind each pair, so that "where does rig's output go" is a
// property of the run rather than of the process. Line-ending is theirs and not the writer's:
// `cmds.prompt` and `cmds.catalog` write a file through the same stdout with no line added.
const say = s => out(`${s}\n`)
// For the ambient freshness line alone: it is rig talking about itself, not part of any
// command's answer, so it must not land in a pipe someone is reading the answer out of.
const aside = s => err(`${s}\n`)
const step = s => out(`${C.cyan('·')} ${s}\n`)
const warn = s => out(`${C.yellow('!')} ${s}\n`)
const ok = s => out(`${C.green('✓')} ${s}\n`)
// A rung above `warn`, and `doctor` is the only caller: `!` is something for you to deal
// with, `✗` is something that should not be possible. Keeping them apart is what stops the
// one report that means "rig has a bug" reading like the eleven that mean "push your data
// root".
const bad = s => out(`${C.red('✗')} ${s}\n`)

const die = msg => { throw new RigError(msg) }

// `windowsHide` belongs to one run and not to all of them. `CREATE_NO_WINDOW` does not
// suppress a console — it gives the child its own *hidden* one, which is a `conhost.exe` per
// spawn: a second process creation stacked on the one actually being asked for, and on
// Windows a process creation is around seventeen milliseconds. Set on every spawn, it was
// doubling the cost of every `git` call rig makes, to hide a console an ordinary command
// already has and its children happily inherit.
//
// The freshness refresh is the child it was for, and there it is load-bearing. That one is
// spawned DETACHED_PROCESS, so it has no console to inherit and every `git` it runs would
// allocate a *visible* one — seconds each, a refresh that never finishes inside its deadline,
// and an orphan window per command burying the desktop.
//
// So the run that is that child hides its spawns and no other run does. Taking the command
// rather than reading it keeps this assertable without standing up a run, which matters
// because the only symptom of getting it wrong is cost.
//
// That rests on an assumption: that rig's own process has a console. Every ordinary way of
// starting it gives it one — a terminal; the npm shim, which is cmd.exe or PowerShell starting
// node plainly, so node is given a console even when the shim was launched detached; or any
// parent with a console, hidden or not. A host that starts `node bin/rig.mjs` itself with
// DETACHED_PROCESS, or calls `run()` from a process with no console, breaks it, and gets a
// visible window for every git call.
const spawnDefaults = command => ({ encoding: 'utf8', windowsHide: command === REFRESH_COMMAND })

// Every subprocess rig starts, and the one place a run's cwd and environment reach one.
// Without them a child inherits the *process's*, which for a run that is not the process is
// somebody else's: an isolated run's `GIT_CONFIG_GLOBAL` lost to the machine's real git
// config, and `git rev-parse --show-toplevel` answering for a directory the run never named.
// A run handed no cwd is the process's own, so its children inherit that one without anything
// having to read it first.
//
// `opts.env` is additions to the run's environment rather than a replacement, because that is
// what its one caller means by it — `GIT_TERMINAL_PROMPT=0` goes on top of what is already
// there, and a replacement would drop everything an isolated run depends on.
function exec (cmd, args, { env: extra, ...opts } = {}) {
  const options = { ...spawnDefaults(current.command), cwd: current.cwd, env: extra ? { ...env(), ...extra } : env(), ...opts }
  const r = spawnSync(cmd === 'git' ? gitProgram() : cmd, args, options)
  if (r.error) die(spawnFailure(cmd, args, r.error, options.cwd))
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

// Why a subprocess never ran, worded so that nobody goes looking at PATH for the wrong reason.
// Node answers ENOENT both for a program PATH cannot find and for a directory to start in that
// is not there, so the directory is looked at before PATH is blamed. Any other code — an
// output past spawnSync's buffer, say — is neither, and the command and Node's reason are
// all there is to say.
const spawnFailure = (cmd, args, error, dir) => {
  if (error.code !== 'ENOENT') return `${cmd} ${args.join(' ')} failed (${error.message})`
  if (dir && !exists(dir)) return `${cmd} could not start in ${dir}, which no longer exists`
  return `${cmd} not found on PATH (${error.message})`
}

// Git for Windows puts a **launcher** on PATH: `cmd\git.exe` is 46KB and starts
// `mingw64\bin\git.exe`, which is the 4.4MB one that does the work. So every `git` rig runs is
// two process creations, and on Windows the process creation *is* the expensive part of a git
// call — measured on this machine, 60ms through the launcher against 32ms straight to the
// binary. Across a suite that makes thousands of them it is a quarter of the runtime.
//
// The launcher does more than launch, and the rest of what it does is why MSYSTEM decides
// this. It sets MSYSTEM and puts Git's own `mingw64\bin` and `usr\bin` at the front of PATH,
// which is where git finds the `sh` every hook and `!` alias runs through, its credential
// helper and its own ssh. The binary does the same for itself only when MSYSTEM is unset or
// empty; with it set — an MSYS2 shell, a non-login bash, a variable set for the whole user — it
// assumes a PATH that is not there, and every one of those fails to start. So with MSYSTEM set
// the launcher is kept. Without it the two differ in one thing, taken knowingly: the binary
// puts `~\bin` ahead of Git's own directories rather than after them, which is the order Git
// Bash's own login shell gives it.
//
// **Only that launcher is stepped past.** Somebody's own `git` on PATH — a corporate wrapper,
// a credential shim — is a program they put there on purpose, and going around it would be
// rig deciding it knew better. So the launcher has to be recognised rather than assumed: the
// file PATH resolves to must sit in a Git for Windows layout (`cmd\` or `bin\`) *and* have the
// real binary as a sibling under `mingw64`. A shim anywhere else looks like nothing of the
// sort and is left alone, which is the answer for every case this cannot positively identify.
// Cached against PATH and MSYSTEM rather than per process, for `onPath`'s reason below: a run
// owns neither, so one run's answer is the next run's for as long as they are handed the same
// two.
const gitPrograms = new Map()
function gitProgram () {
  const searchPath = pickEnv('PATH')
  const msystem = pickEnv('MSYSTEM')
  const key = `${searchPath}\u0000${msystem}`
  if (!gitPrograms.has(key)) gitPrograms.set(key, realGitFor(searchPath, msystem))
  return gitPrograms.get(key)
}

const GIT_LAUNCHER_DIRS = ['cmd', 'bin']
function realGitFor (searchPath, msystem = '') {
  if (process.platform !== 'win32' || msystem) return 'git'
  const launcher = programPath('git', searchPath)
  if (!launcher) return 'git'
  const dir = path.dirname(launcher)
  if (!GIT_LAUNCHER_DIRS.includes(path.basename(dir).toLowerCase())) return 'git'
  const real = path.join(path.dirname(dir), 'mingw64', 'bin', 'git.exe')
  return exists(real) ? real : 'git'
}

// Where a spawn on Windows finds a program, without starting one to find out — or null where
// that cannot be said for sure, which `realGitFor` answers as plain `git`. The search is
// libuv's, because that is what Node's spawn runs: each PATH entry in turn, less one pair of
// surrounding quotes, trying `<name>.com` and then `<name>.exe`. PATHEXT plays no part in it.
//
// An entry this cannot read the way libuv does ends the search rather than being walked past:
// the program there may be the one the spawn runs, and the next layout along would then be
// somebody else's git. That is an entry that leans on a cwd to say where it points, which
// libuv would read against the run's; and one with a quote left once the surrounding pair is
// gone, which is how a quoted entry holding a `;` arrives, split in two. A directory with an
// apostrophe in its name goes with them, and costs only the saving.
//
// A directory called `git.exe` is no program to the spawn, which walks on past it, and so
// does this.
//
// One difference is kept on purpose: the libuv some Node releases still ship looks in the
// child's cwd before PATH, and this does not. The answer is cached against PATH, which the cwd
// is no part of, and a git.exe that happens to sit where a run is standing is not one worth
// preferring.
const QUOTED = /^(["'])(.*)\1$/
const FULLY_QUALIFIED = /^([a-z]:[\\/]|[\\/]{2})/i
function programPath (name, searchPath) {
  for (const entry of searchPath.split(';').filter(Boolean)) {
    const dir = entry.replace(QUOTED, '$2')
    if (/["']/.test(dir) || !FULLY_QUALIFIED.test(dir)) return null
    for (const ext of ['.com', '.exe']) {
      const candidate = path.join(dir, name + ext)
      if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate
    }
  }
  return null
}

// What a child of this run would be handed for `name`. On Windows the case of a name is no
// part of it — PATH is `Path` about as often as not — and a copied environment keeps whichever
// case it was given, so `{ ...env, PATH }` can hold two spellings of one variable. Node's spawn
// hands the child whichever key sorts first, so that is the one read here: reading the other
// answers for an environment no child of the run ever sees. Everywhere else a name is exactly
// itself, because that is how a child there reads it.
const pickEnv = name => {
  const e = env()
  const key = process.platform === 'win32'
    ? Object.keys(e).sort().find(k => k.toUpperCase() === name.toUpperCase())
    : name
  return key === undefined ? '' : e[key] ?? ''
}

// Is the command on PATH at all? `exec` dies when it is not, which is right for every caller
// that needs it — except the ones whose whole job is to report that it is missing.
//
// Asked once per command name per PATH, because the answer was being bought again every
// time: a tenth of every process rig starts across the test suite was `git --version`, asked
// to be told what the last one had already said.
//
// The cache outlives the invocation and PATH is part of its key, which is the pair that makes
// it safe. A run does not own PATH — the machine does — so one run's answer is the next
// run's too for as long as they are handed the same one; keying on it is what stops a run
// given a crippled PATH being told what a run with a whole one found. The probe takes `env`
// and no `cwd` for the same reason: what it asks about is PATH, and a `--version` cannot care
// where it runs — where a run is standing may be a directory `rig close` has just removed.
const onPathAnswers = new Map()
const onPath = cmd => {
  const key = `${pickEnv('PATH')}\u0000${cmd}`
  if (!onPathAnswers.has(key)) {
    onPathAnswers.set(key, !spawnSync(cmd, ['--version'], { ...spawnDefaults(current.command), env: env() }).error)
  }
  return onPathAnswers.get(key)
}

// `df -Pk`: a header line, then one line per filesystem — Filesystem, 1024-blocks, Used,
// Available, Capacity, Mounted on. POSIX guarantees `-P` keeps each entry on a single line,
// which is the whole reason for the flag; the mount point is the rest of the line, because
// it is the one field allowed to contain spaces.
function parseDf (out) {
  const row = out.trim().split('\n').slice(1).pop()
  const cols = row ? row.trim().split(/\s+/) : []
  if (cols.length < 6) return null
  const kb = Number(cols[3])
  if (!Number.isFinite(kb)) return null
  return { label: cols.slice(5).join(' '), bytes: kb * 1024 }
}

// Free space where rig puts worktrees: asked of the runtime on Windows and of `df` everywhere
// else. On Windows `fs.statfsSync` answers without starting a process — the only other probe
// there is a PowerShell, the dearest process rig could start (decision 54) — and libuv counts
// the free blocks there in the `bsize` it reports, so their product is bytes. Linux counts
// them in `f_frsize`, which Node does not report, and on a FUSE mount the two differ: Docker
// Desktop's virtiofs has a 2MiB `bsize` over 16KiB blocks (nodejs/node#62495), which reads as
// 128 times the free space and turns a nearly full disk into a pass. `df` asks in the right
// unit, and off Windows it costs about a millisecond.
//
// Decision 54: a check rig cannot make is dropped, never fatal. So this answers null when the
// probe is missing — no `df` on PATH, or a Node without `fs.statfsSync` — and when the path
// cannot be answered for: a work root on a disconnected share, or one that is not there yet.
//
// `label` names the volume the number is about: on Windows the drive, or the share a UNC path
// is on; anywhere else the mount point `df` found the work root on. On Windows it is read off
// the resolved path, because statfs follows a junction or a symlink and the path as written
// would name the drive the link sits on — a work root moved off a full system drive by a
// junction would report the other drive's space under the full one's letter. A mapped drive
// resolves the same way, to the share behind it, so it is named by the share.
const volumeOf = dir => {
  let real
  try { real = fs.realpathSync.native(dir) } catch { real = dir }
  return path.parse(real).root.replace(/[\\/]+$/, '') || dir
}

// The blocks this user may write, in bytes. Windows is the one place this runs, and libuv fills
// `bavail` and `bfree` there with the same free-cluster count, so `bavail` is chosen for what it
// means rather than for a difference it makes.
const bytesFree = s => s.bavail * s.bsize

function freeSpace (dir) {
  if (process.platform === 'win32') {
    try {
      const bytes = bytesFree(fs.statfsSync(dir))
      if (!Number.isFinite(bytes)) return null
      return { label: volumeOf(dir), bytes }
    } catch { return null }
  }
  if (!onPath('df')) return null
  const r = exec('df', ['-Pk', dir])
  return r.code === 0 ? parseDf(r.out) : null
}

function must (cmd, args, opts = {}) {
  const r = exec(cmd, args, opts)
  if (r.code !== 0) die(`${cmd} ${args.join(' ')}\n${r.err || r.out}`)
  return r.out
}

const git = (dir, ...args) => exec('git', ['-C', dir, ...args])
const gitMust = (dir, ...args) => must('git', ['-C', dir, ...args])

// The two checkouts an installation owns — the data root and the tool itself. Reading one
// and moving one is `checkouts.mjs`'s; what to warn about and when to refuse is the policy
// below, which is the only part that differs between them.
const co = checkouts({ run: exec, env })

// Asked for at the moment a command wants it rather than when the run starts: reading fd 0
// blocks, and `rig help` must not wait on a terminal nobody is piping into.
const readStdin = () => current.stdin()

const exists = p => fs.existsSync(p)
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p, v) => writeText(p, JSON.stringify(v, null, 2) + '\n')
const readText = p => fs.readFileSync(p, 'utf8')
// Writes only when the content differs: the record, its doc header and its folder are
// rewritten together on every command, and an unchanged file must not churn — not its
// mtime under `git add -A`, and not an editor that has it open.
const writeText = (p, v) => {
  if (exists(p) && fs.readFileSync(p, 'utf8') === v) return
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, v)
}

// ------------------------------------------------------------------- config

// The repo the command is standing in, for the one step of the resolution order that needs to
// ask git. Named by its remote rather than its folder, because a clone can be called anything
// and the catalogue is keyed by the repo's real name; by its folder only when there is no
// origin to go by. Null for anywhere that is not a checkout, or is one git will not open —
// both of which simply mean this step has no answer.
function repoAtCwd () {
  // Where the checkout is comes from the filesystem (`gitfs.discover`), which is what git
  // would walk anyway — so the answer this step gives most often, that the cwd is not a
  // checkout at all, costs no subprocess and does not even need git on PATH. A layout
  // `gitfs` declines to commit to answers null, and git is asked about those.
  const place = discover(cwd(), env())
  if (place && !place.top) return null
  // `exec` dies when the command is not there, and this is ambient work on behalf of whatever
  // the user actually asked for — `rig doctor` on a machine with no git has to live long
  // enough to say so, which it cannot if resolving the data root killed it first.
  if (!onPath('git')) return null
  let top = place?.top
  if (!top) {
    const asked = exec('git', ['rev-parse', '--show-toplevel'])
    if (asked.code !== 0) return null
    top = asked.out
  }
  // The remote's URL stays git's: `url.<base>.insteadOf` rewrites it, and a config file read
  // that skipped the rewrite would name the wrong repo on exactly the machines that set one.
  const url = exec('git', ['remote', 'get-url', 'origin'])
  if (url.code === 0 && url.out) return url.out.replace(/\.git$/, '').split(/[/:]/).pop() || null
  // git fails this for a repository it refuses to open — another user's, or one with an
  // extension it does not know — as well as for one with no origin, and the filesystem walk
  // sees neither refusal. The folder is the name only for a checkout git will open, and where
  // the walk placed it git has not been asked that yet.
  if (place && exec('git', ['rev-parse', '--show-toplevel']).code !== 0) return null
  return path.basename(top)
}

// Where config lives, resolved on first use rather than when the run starts: `help` and
// `prompt` never read config, and a broken rig.local.json should fail inside a command with
// the file named, not before one has run. `cmds.init` is the one thing that reassigns
// `current.location`, at its top, when the data root is moving in the command that is running
// — bin/roots.mjs owns everything else about the two files.
//
// `requestedData` and `requestedRepos` are what the command line said, read before anything
// reads config. They sit on the invocation rather than being parameters of `where`, because
// every caller of `where` wants the same answer and threading it through all of them would be
// a second way to be wrong about which knowledge is in hand.
const where = () => (current.location ??= locate(toolRoot(), env(), {
  data: current.requestedData, repos: current.requestedRepos, repoAt: repoAtCwd, cwd: current.cwd,
}))

// `current` chose this root, and no flag, shell or work folder did. Said by the commands
// that have no work folder to anchor them, and only when there is more than one root to
// have chosen between — a pointer that could only point one way is not invisible state.
// `dataRoot` is what a rig from before named roots reads, and it is the only thing it can
// read. One exists on any machine that has not updated yet — including this one, between an
// `init` that names the roots and the `rig update` that brings the installed copy forward — so
// it is kept pointed at whatever is current rather than deleted. Code that knows about
// `dataRoots` ignores it entirely, which is what stops it being a second answer.
const mirrorLegacyDataRoot = machine => {
  const current = machine.dataRoots?.[machine.current]?.path
  if (current) machine.dataRoot = current
  return machine
}

const CHOSE_QUIETLY = { current: 'current', repo: 'the repo it is about' }
function sayCurrentRoot () {
  const w = where()
  if (CHOSE_QUIETLY[w.source] && Object.keys(w.roots).length > 1) {
    say(C.dim(`· data root: ${w.name} (${CHOSE_QUIETLY[w.source]})`))
  }
}
const dataRoot = () => where().dataRoot
const localConfigFile = () => where().localFile
const repoConfigFile = () => where().orgFile

// The tracker clients, each resolved on first use. Production shells to the real CLI.
// With the matching RIG_FAKE_* env var naming a JSON file, the in-memory adapter runs
// instead, loaded from that file and written back when the command ends, so a
// subprocess test sees the issues and comments rig made — one mechanism for both.
// One per run, not one per process: the resolved client and the fake's state are a run's, and
// a second run in the same process that found the first one's issues already in memory would
// be reading a file nobody wrote.
function adapterResolver (envVar, viaCli, inMemory) {
  let resolved, fake
  return {
    get () {
      if (resolved) return resolved
      const file = env()[envVar]
      if (!file) {
        const spawnCli = args =>
          spawnSync(CLI_FOR[envVar], args, { ...spawnDefaults(current.command), cwd: current.cwd, env: env() })
        return (resolved = viaCli({ exec: spawnCli }))
      }
      fake = { file, state: exists(file) ? readJson(file) : {} }
      return (resolved = inMemory(fake.state, { env: env() }))
    },
    persist () { if (fake) writeJson(fake.file, fake.state) },
  }
}
// The real CLI behind each adapter. Spawned here rather than inside the tracker module, so
// the run's environment reaches `gh` and `twg` the way it reaches `git`.
const CLI_FOR = { RIG_FAKE_GITHUB: 'gh', RIG_FAKE_TWG: 'twg' }
const github = () => current.github.get()
const jira = () => current.jira.get()
const persistFakeTrackers = () => { current.github.persist(); current.jira.persist() }

// Runs a tracker call the caller can carry on without, and answers why it failed, or
// nothing when it didn't. Anything but a tracker failure is a bug and propagates.
function trackerFailure (call) {
  try { call() } catch (e) {
    if (e instanceof TrackerError) return e.message
    throw e
  }
}

const config = () => load(where())

const workDir = (cfg, id) => path.join(cfg.workRoot, id)
// The data root is the current one unless a caller names another. `doctor` is the only one
// that does: every other command works in the root it resolved, and one that reached past it
// would be writing a work's records somewhere its work folder does not point.
const recordDir = (id, root = dataRoot()) => path.join(root, 'work', id)
const recordFile = (id, root = dataRoot()) => path.join(recordDir(id, root), 'work.json')
const contextFile = id => path.join(recordDir(id), 'context.md')
const planFile = id => path.join(recordDir(id), 'rollout-testing-plan.md')

// ----------------------------------------------- record format & freshness

// rig.json as it sits on disk. `config()` merges it with the machine's file; the record
// format is a property of the data root alone, so the gate reads it unmerged.
const repoConfigJson = () => readOrg(where()) ?? {}

// What the tool checkout is, as far as freshness goes; freshness.mjs decides what that
// means. The reading is `checkouts.mjs`'s; the one thing here is the guard in front of it.
function toolState () {
  // Ambient work on behalf of a command that has already run: no environment problem found
  // here is this function's to report. So the probe must not be `exec`, which dies when git is
  // absent — doctor calls this before it reaches its own `git` check, and has to live long
  // enough to make it.
  if (!onPath('git')) return unreadable()
  return co.identify(toolRoot())
}

// Disposable state, so it lives with the other disposable state rather than in the config
// file the user owns: rig must not rewrite rig.local.json on a schedule, and a half-written
// config is a worse failure than a missing cache.
const cacheFile = (cfg, name) => path.join(cfg.workRoot, '.rig', name)
const readCache = (cfg, name) => {
  try { return readJson(cacheFile(cfg, name)) } catch { return null }   // absent or half-written: measure again
}
// Written through a temp file and renamed: two commands can end at once, and a half-written
// cache reads as due, which would put the refresh back in a loop. A cache nobody asked for
// must not turn every command into a complaint on a machine whose work root is read-only, so
// a failed write is dropped and the next run measures again — and it never creates the work
// root, which is a thing `rig doctor` checks for and `rig init` makes. Returns whether the
// cache landed, because a caller that cannot cache must not arm work it would repeat forever.
const writeCache = (cfg, name, value) => {
  if (!exists(cfg.workRoot)) return false
  const file = cacheFile(cfg, name)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* nothing left to try */ }
    return false
  }
}

const readFreshness = cfg => readCache(cfg, 'freshness.json')
const writeFreshness = (cfg, measured) => writeCache(cfg, 'freshness.json', measured)

// Distance from the upstream *as last fetched* — the caller decides whether to fetch first.
// `behind: null` means unmeasurable, and reads as "nothing to say" everywhere downstream.
const measureFreshness = state => ({
  sha: state.head,
  remote: state.upstream,
  behind: co.countCommits(toolRoot(), 'HEAD..@{u}'),
  checkedAt: new Date().toISOString(),
})

// Spawns the refresh and returns: the fetch outlives this process, writes the cache, and the
// *next* command reads it. Detached with no stdio of its own — inheriting the parent's would
// keep a piped `rig prompt` from ever closing. The child never arms another (see
// `freshnessEpilogue`); an unreachable remote is the ordinary case, and a chain of detached
// processes retrying it forever is not something a user would ever see to stop.
//
// `cwd` is the tool root, which is the only tree the child touches: a process's cwd is an
// open directory handle on Windows, so a child left sitting in the caller's worktree is one
// `rig close` cannot remove. `windowsHide` on every `git` call the child makes is what keeps
// it usable — `detached` means DETACHED_PROCESS, so the child has no console to hand on, and
// every git call it makes would otherwise open a visible window of its own, at a cost of
// seconds each under load.
// Nothing on this spawn can tell the child that: beside DETACHED_PROCESS Windows ignores the
// CREATE_NO_WINDOW that `windowsHide` asks for, and no spawn's options reach the spawns its
// child makes. The child hides its own, in `spawnDefaults`, because `refreshArgv` hands it the
// command that asks for that.
// Asserted by a test rather than left to a comment: every field is load-bearing, and each
// failure it prevents is invisible until it is expensive. `detached` lets the fetch outlive
// the command; `stdio: 'ignore'` stops a piped `rig prompt` hanging on a child holding the
// pipe; `cwd` keeps the child out of a worktree `rig close` must remove.
const refreshSpawn = (root, environment) =>
  ({ cwd: root, env: environment, detached: true, stdio: 'ignore' })
const refreshArgv = root => [path.join(root, 'bin', 'rig.mjs'), REFRESH_COMMAND]

// The installation's own copy and not this file, which for a run driven in another process's
// memory are two different rigs: what is being measured is the checkout the run is a run of.
function refreshFreshnessInBackground () {
  try {
    spawn(process.execPath, refreshArgv(toolRoot()), refreshSpawn(toolRoot(), env())).unref()
  } catch { /* a refresh that will not spawn is not worth a word to the user */ }
}

// The end of every command: one dim line read from the cache — never a fetch, so it cannot
// add latency — and then, at most once per configured interval, the refresh that makes the
// next run's line true. Runs outside the command's own error handling, so nothing in here may
// throw: a freshness check has no business turning a command that worked into a stack trace.
function freshnessEpilogue (command) {
  // The refresh is the check. If it armed another, a remote nobody can reach would spawn a
  // chain of detached processes with no one to stop it.
  if (command === REFRESH_COMMAND) return
  try {
    const cfg = config()
    if (!cfg.freshness.enabled) return
    // Cheap first: most runs have nothing to say and nothing to do, and `toolState` costs
    // four git spawns, or eight in a layout `gitfs` hands back to git (test/checkouts.test.mjs
    // pins the four). The free half of that is decided from the cache alone, and it is
    // decided before the reading below — a cache written inside its interval by an
    // installation that was up to date is the ordinary run, and it was paying a spawn to be
    // told what it already held.
    const cache = readFreshness(cfg)
    const due = dueForRefresh(cache, cfg.freshness.everyHours)
    const speaks = announces(command, { enabled: cfg.freshness.enabled })
    if (!due && !(speaks && cache?.behind)) return
    // A tool copy that is no checkout — an install from a tarball, the suite's own copies — has
    // no HEAD to ask about, and the filesystem says so without a spawn. A layout `gitfs` hands
    // back is still git's to answer.
    if (notARepository(discover(toolRoot(), env()))) return
    const head = git(toolRoot(), 'rev-parse', 'HEAD')
    if (head.code !== 0) return
    const line = speaks ? staleLine(cache, head.out) : null
    if (!due && !line) return
    if (skipReason(toolState())) return
    if (line) aside(C.dim(`· ${line}`))
    // Only arm a refresh whose cache can land. With no work root there is nowhere to write
    // one, so every command would find the check due and spawn another fetch that nobody
    // reads — one orphan per command, for as long as the work root is missing.
    if (due && exists(cfg.workRoot)) refreshFreshnessInBackground()
  } catch { /* ambient: a command that has already finished must not fail because of this */ }
}

// Commands that write records. The distinction drives the write refusal — an old rig must not
// write a record format it has never seen — and the sync below.
// `demo` is here because it writes into the data root by default, so it must fast-forward
// before it reads: a page rendered from stale records and committed on top of them would be
// wrong twice. It is the only member that changes no work.
const MUTATING = new Set(['new', 'ticket', 'attach', 'detach', 'plan', 'save', 'close', 'backfill', 'demo'])

// Before a mutating command reads anything. rig pushes the data root but never pulled it, so
// a second machine read stale records and wrote on top of them. Fast-forward only: a data
// root with commits of its own is left for `commitDataRoot`'s rebase at the end. Then the
// gate, which holds whether or not there is a remote to sync with.
//
// Answers the half of that reading `commitDataRoot` may have at the end of the command, or
// null when there was nothing here to read.
function prepareDataRoot () {
  const root = dataRoot()
  let before = null
  if (exists(root) && where().split) {
    // The full reading, for three fields: what it costs over the identity questions is
    // one `status`, whose branch header carries the distance, and the network fetch on the
    // next line dwarfs it.
    // The reading worth keeping cheap is the freshness one, which runs after every command.
    before = co.describe(root)
    if (before.repo === 'own' && before.branch && before.upstream && dataFetchDue()) {
      const fetched = co.fetch(root)
      if (!fetched.ok) {
        stampDataFetchFailure()
        say(C.dim(`· data root: could not fetch (${fetched.error}) — working from what is here`))
      } else {
        clearDataFetchFailure()
        const { outcome, state, error } = co.fastForward(root)
        // Everything but these four is a data root with nothing to do, and a command about
        // to run is the wrong moment to be told about it.
        if (outcome === 'diverged') {
          warn(`data root: ${state.behind} behind and ${state.ahead} ahead of origin — left alone; it is rebased when this command commits`)
        } else if (outcome === 'blocked') {
          warn(`data root: ${state.behind} commit(s) behind origin with uncommitted changes — run \`rig save\`, then it will fast-forward`)
        } else if (outcome === 'failed') {
          warn(`data root: could not fast-forward (${error})`)
        } else if (outcome === 'moved') {
          say(C.dim(`· data root: fast-forwarded ${state.behind} commit(s) from origin`))
        }
      }
    }
  }
  checkWriteGate()
  return before && stillTrueAtTheEnd(before)
}

// The half of a data root's reading that the command running between the two readings cannot
// change: what kind of checkout it is, which branch it is on, what that branch tracks, and
// whether anything was already waiting to be pushed. A command writes records into the data
// root and never commits into it, moves its branch or changes its upstream; the fast-forward
// above runs only with nothing ahead and leaves nothing ahead. So `commitDataRoot` reads these
// five rather than buying `describe`'s `git status` a second time — which was the whole cost
// of `rig save` on a data root with nothing new in it.
//
// The tree is the half that *did* change, and it comes back null, because a reading that does
// not answer for the tree must not be read as a clean one (decision 80).
const stillTrueAtTheEnd = state => ({ ...state, head: null, behind: null, dirty: null, modified: null })

// An unreachable remote is retried once an interval rather than at the start of every
// command: a fetch against a remote that is not there costs a full connect timeout — twenty
// seconds, measured — and paying that on every `save` is what makes a tool unusable on a
// plane. Short enough that a second machine is never working from stale records for long.
const DATA_FETCH_RETRY_MS = 15 * 60_000
const dataFetchDue = () => {
  const at = Date.parse(readCache(config(), 'datafetch.json')?.failedAt ?? '')
  if (Number.isNaN(at)) return true
  return Date.now() - at >= DATA_FETCH_RETRY_MS || at > Date.now()
}
const stampDataFetchFailure = () => writeCache(config(), 'datafetch.json', { failedAt: new Date().toISOString() })
const clearDataFetchFailure = () => {
  try { fs.rmSync(cacheFile(config(), 'datafetch.json'), { force: true }) } catch { /* nothing to forget */ }
}

// The record format the data root is in has to be readable, and not ahead of what this rig
// knows how to write. Every command that writes a record runs this — `prepareDataRoot` for
// the mutating set, and `rig init` for itself, since it hand-writes the one file the gate
// is about.
function checkWriteGate () {
  const root = dataRoot()
  const cfgJson = repoConfigJson()
  if (stampUnreadable(cfgJson)) {
    die(`${repoConfigFile()} records writtenBy ${JSON.stringify(cfgJson.writtenBy)}, which is not a record format any rig wrote — fix it by hand; rig will not guess.`)
  }
  if (writesBlocked(cfgJson)) {
    die(`this rig writes record format ${MAJOR}, but ${root} is at ${dataMajor(cfgJson)} — run \`rig update\`. Read-only commands (list, status, catalog, doctor) still work.`)
  }
  if (exists(repoConfigFile())) {
    const pending = pendingMigrations(cfgJson)
    if (pending.length) {
      warn(`${root} is at record format ${dataMajor(cfgJson)}, this rig writes ${MAJOR} — run \`rig update\` to migrate (${pending.length} pending)`)
    }
  }
}

// Runs the pending migrations over rig.json and writes the result. The one place a
// migration lands on disk, through the same writer as every other rig.json.
function writeOrgMigrations (loc = where()) {
  let ran = []
  writeOrg(loc, prev => {
    const result = applyMigrations(prev ?? {}, FORMAT_STAMP)
    ran = result.ran
    return result.config
  })
  return { ran }
}

// --------------------------------------------------------------- work lookup

// The work id is anchored by D:\w\<id>\.rig\id — a marker, not a duplicated fact.
// The authoritative record lives in the rig repo (DESIGN.md §7.1).
function findWorkId (cfg, explicit) {
  if (explicit) return explicit
  let dir = cwd()
  for (;;) {
    const marker = path.join(dir, WORK_FOLDER.marker, 'id')
    if (exists(marker)) return readText(marker).trim()
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  die('not inside a work (no .rig/id found). Pass --work <id> or cd into one.')
}

function loadWork (cfg, id, root = dataRoot()) {
  if (!exists(recordFile(id, root))) die(`no work record for "${id}" at ${recordFile(id, root)}`)
  const w = readJson(recordFile(id, root))
  // Records written before the field was renamed carry `jiraKeys`.
  if (w.tickets === undefined) { w.tickets = w.jiraKeys || []; delete w.jiraKeys }
  w.repos = w.repos || []
  // Records written before the phase replaced `status` carry the field instead of the gate.
  // Three of its four values were observable facts written down — `planning` and
  // `in-progress` are `repos.length`, and `closed` is `closedAt` — so `phaseOf` reproduces
  // them exactly and they are simply dropped. Only `designed` said something no lookup can
  // recover, and that one becomes the gate it always meant.
  //
  // Its date was never recorded, so the record's last activity stands in: the tightest bound
  // the record itself can offer. Approximate for records written before this major and exact
  // for every one after it, which is the trade for not losing nine live design gates to a
  // field rename. There is no migration mechanism for `work/*/work.json` (see
  // `unrunnableHook` in version.mjs), so the read path is where this has to happen.
  if (w.status === 'designed' && !w.designedAt && !w.closedAt) w.designedAt = activityAt(w)
  delete w.status
  w.stages = w.stages || []
  for (const r of w.repos) {
    // A worktree's path is derived from this machine's work root, never stored:
    // the same record must work on every machine that shares the data root.
    r.path = path.join(workDir(cfg, id), r.repo)
    // Records written before stages carry one implicit branch — the work's — as a `base`
    // beside a single `pr`. Both become the first entry of `branches[]`, which is where a
    // base and a merged PR live now that a repo can carry more than one branch of this work.
    // Additive on the way in and lossless: nothing about a pre-stage record is discarded.
    if (!Array.isArray(r.branches)) {
      r.branches = [{ branch: w.branch, base: r.base, ...(r.pr ? { pr: r.pr } : {}) }]
    }
    delete r.pr
    // Derived on load and stripped on save, exactly like `path` above: every caller that says
    // `entry.base` means the base of this repo's *work* branch, and there is no reason to make
    // all of them walk the list for it.
    r.base = workBranch(r, w)?.base ?? r.base
  }
  return w
}

// This repo's record of one branch of this work, or of the work branch itself. Made on demand
// by `branchRecord`, because a branch nobody has cut has nothing to record yet.
const branchRecord = (entry, branch) => (entry.branches ||= []).find(b => b.branch === branch)
const workBranch = (entry, work) => branchRecord(entry, work.branch)

function ensureBranchRecord (entry, branch, base) {
  const found = branchRecord(entry, branch)
  if (found) return found
  const made = { branch, base }
  entry.branches.push(made)
  return made
}

// The current work — `--work <id>`, else the folder the command runs in — as a record.
const openWork = (cfg, flags) => loadWork(cfg, findWorkId(cfg, flags.work))

// Committing a work: the record, the context doc header and the generated work folder
// are three views of one fact, written together so no caller can forget one (AGENTS.md
// rule 2). `repos[].path` is derived by `loadWork` and stripped here — it never reaches
// disk (DESIGN.md decision 37).
function saveWork (cfg, work) {
  // `path` and `base` are both derived in `loadWork` and neither is stored: the path is this
  // machine's (decision 37), and the base now lives on the branch it belongs to.
  writeJson(recordFile(work.id), {
    ...work,
    repos: (work.repos || []).map(({ path: _machine, base: _onItsBranch, ...r }) => r),
  })
  syncDocHeader(work.id, work)
  if (exists(workDir(cfg, work.id))) regenerate(cfg, work)
  else if (!work.closedAt) warn(`${work.id}: work folder ${workDir(cfg, work.id)} is missing — its AGENTS.md was not regenerated`)
}

function listWorkIds (dataRootPath = dataRoot()) {
  const root = path.join(dataRootPath, 'work')
  if (!exists(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && exists(recordFile(d.name, dataRootPath)))
    .map(d => d.name)
}

// Every work record in a root that parses, and the ids of the ones that do not. For the readers
// that want the records as *evidence* rather than as the thing they act on — the observed graph
// behind `rig impact` and the offer `rig attach` makes. One unreadable record must not cost those
// their answer, and for `attach` it must not cost the command it follows: the offer runs after
// the worktree is cut and the record saved, and a throw there skipped the commit and left the
// data root half-written. So a record that will not read is left out and named, never swallowed.
function readRecords (root) {
  const works = []
  const unreadable = []
  for (const id of listWorkIds(root)) {
    try { works.push(readJson(recordFile(id, root))) } catch { unreadable.push(id) }
  }
  return { works, unreadable }
}

const sayUnreadable = ids => {
  if (ids.length) say(C.dim(`· ${ids.length} work record${ids.length === 1 ? '' : 's'} could not be read and ${ids.length === 1 ? 'was' : 'were'} left out: ${ids.join(', ')}`))
}

// ---------------------------------------------------------------- catalogue

const catalogFile = (org, repo) => path.join(dataRoot(),'catalog', org, `${repo}.md`)

// Minimal purpose-built frontmatter reader. Handles scalars and the one list
// shape the catalogue uses (`talks_to:` / `setup:` / `check:`). Not a general YAML parser.
function parseFrontmatter (text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { data: {}, body: text }
  const data = {}
  let key = null
  let item = null
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const listItem = /^\s*-\s+(.*)$/.exec(raw)
    if (listItem && key) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(listItem[1])
      if (kv) { item = { [kv[1]]: strip(kv[2]) }; data[key].push(item) }
      else { data[key].push(strip(listItem[1])); item = null }
      continue
    }
    const nested = /^\s{4,}([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
    if (nested && item) { item[nested[1]] = strip(nested[2]); continue }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
    if (kv) {
      key = kv[1]; item = null
      const v = strip(kv[2])
      if (v === '' || v === '[]') data[key] = []
      else { data[key] = v; key = null }
    }
  }
  return { data, body: m[2] }
}

const strip = s => s.trim().replace(/^["'](.*)["']$/, '$1')

function loadCatalog (dataRootPath = dataRoot()) {
  const root = path.join(dataRootPath, 'catalog')
  if (!exists(root)) return []
  const entries = []
  for (const org of fs.readdirSync(root)) {
    const dir = path.join(root, org)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      const { data, body } = parseFrontmatter(readText(path.join(dir, f)))
      entries.push({
        repo: data.repo || f.replace(/\.md$/, ''),
        org: data.org || org,
        role: data.role || '',
        stack: data.stack || '',
        talks_to: Array.isArray(data.talks_to) ? data.talks_to : [],
        setup: Array.isArray(data.setup) ? data.setup : (data.setup ? [data.setup] : []),
        check: Array.isArray(data.check) ? data.check : (data.check ? [data.check] : []),
        draft: /DRAFT: unreviewed/.test(body),
        body: body.trim(),
        file: path.join(dir, f),
      })
    }
  }
  return entries
}

const findCatalog = (name, dataRootPath = dataRoot()) =>
  loadCatalog(dataRootPath).find(e => e.repo.toLowerCase() === name.toLowerCase())

// This work's attached repos whose catalogue entry `rig attach` drafted and nobody has
// corrected. The repos of the work in hand rather than the whole root, because both readers
// are about *now*: `rig next` offers the correction while the worktrees are still on disk, and
// `rig close` makes the last call on the way out.
//
// One scan, not one per repo. `findCatalog` re-reads and re-parses every entry in the root each
// time it is called, so asking it per attached repo paid the whole catalogue over again for each
// one — and a work with no drafts at all paid it anyway.
function draftEntries (work) {
  const attached = work?.repos || []
  if (!attached.length) return []
  const draft = new Set(loadCatalog().filter(e => e.draft).map(e => e.repo.toLowerCase()))
  return draft.size ? attached.filter(r => draft.has(r.repo.toLowerCase())).map(r => r.repo) : []
}

// Which org a repo belongs to: the catalogue first, then GitHub. The language comes
// along from GitHub for the catalogue stub `rig attach` drafts on first sight.
function resolveOrg (cfg, repo) {
  const cat = findCatalog(repo)
  if (cat) return { org: cat.org, repo: cat.repo }
  for (const org of cfg.orgs) {
    const found = github().repo(org, repo)
    if (found) return { org, repo: found.name, language: found.language }
  }
  const auth = github().auth()
  const why = auth === 'ok' ? '' : ` — gh is ${auth === 'missing' ? 'not on PATH' : 'not authenticated'}, so GitHub was never asked`
  die(`cannot resolve "${repo}" in any of: ${cfg.orgs.join(', ')}${why}`)
}

function draftCatalogEntry (org, repo, stack) {
  const f = catalogFile(org, repo)
  if (exists(f)) return false
  writeText(f, `---
repo: ${repo}
org: ${org}
stack: ${stack || 'unknown'}
role: TODO — one line: what this repo is, in this org's terms
talks_to: []
# One item per repo this one talks to. direction: downstream means a change here can break
# that repo, upstream the other way round, both either way; leave it out if you do not know.
# talks_to:
#   - repo: some-other-repo
#     how: one line — what actually passes between them
#     direction: downstream
setup: []
check: []
---

<!-- DRAFT: unreviewed — drafted by \`rig attach\`. Correct this while the repo is
     loaded in your head; that is where the catalogue's value comes from. -->

TODO: what this repo actually is, its gotchas, and the expensive-to-rediscover facts.
`)
  return true
}

// ------------------------------------------------- mirrors and worktrees

// bin/worktrees.mjs owns the whole mirror and worktree lifecycle; rig only chooses where a
// repo's remote lives. Production is github.com; RIG_FAKE_REMOTES names a directory of bare
// repos instead, which is how the tests attach a real repo with no network — the same hook
// shape as RIG_FAKE_GITHUB and RIG_FAKE_TWG. Built per call rather than memoised: it is a
// handful of closures over `cfg`, and `effectiveIdentity` is asked about configs that are
// not this machine's.
const trees = cfg => worktrees({
  mirrorRoot: cfg.mirrorRoot,
  remotes: env().RIG_FAKE_REMOTES ? remotesInDirectory(env().RIG_FAKE_REMOTES) : remotesOnGitHub(),
  run: exec,
  step,
  warn,
})

// ------------------------------------------------------------------ helpers

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)

// Flags that never take a value, so `rig new --ticket my-id` keeps its positional.
const BOOL_FLAGS = new Set(['ticket', 'no-ticket', 'dry-run', 'designed', 'abandoned', 'setup', 'cut', 'force', 'run', 'refresh', 'quick', 'verbose', 'help', 'restarted', 'json', 'no-open'])

// The short flags rig accepts, each an alias of the long name commands read.
const SHORT_FLAGS = { m: 'message' }
const isFlag = a => a.startsWith('--') || /^-[a-z]$/.test(a)

function parseArgs (argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!isFlag(a)) { positional.push(a); continue }
    // `--flag`, `--flag=value`, `--flag value`; `-m value` is `--message value`.
    const [raw, v] = a.replace(/^-+/, '').split('=')
    const k = a.startsWith('--') ? raw : (SHORT_FLAGS[raw] || die(`unknown flag ${a} — try \`rig help\``))
    if (v !== undefined) flags[k] = v
    else if (!BOOL_FLAGS.has(k) && argv[i + 1] && !isFlag(argv[i + 1])) flags[k] = argv[++i]
    else flags[k] = true
  }
  return { flags, positional }
}

function identityFor (cfg, org) {
  return cfg.identities?.[org] || null
}

// The address rig will actually commit with for an org, and where it comes from. rig cannot
// know which address is *correct* for an org — only which one git will use — so callers report
// this rather than warning about it. The one state worth a warning is git having no answer.
//
//   rig      `identities` in rig.local.json; rig writes it onto the worktree itself
//   git      git's own resolution, which a conditional include can make org-specific
//   none     git has no user.email anywhere — nothing can commit
//   unknown  no mirror for this org yet, so there is nothing to ask git about
function effectiveIdentity (cfg, org) {
  const configured = identityFor(cfg, org)
  if (configured) return { email: configured, source: 'rig' }
  const mirror = trees(cfg).anyMirror(org)
  if (!mirror) return { email: null, source: 'unknown' }
  const r = git(mirror, 'config', 'user.email')
  return r.code === 0 && r.out ? { email: r.out, source: 'git' } : { email: null, source: 'none' }
}

function copySecrets (cfg, repo, dest) {
  const spec = cfg.secrets?.[repo]
  if (!spec) return { copied: 0, registered: false }
  const items = Array.isArray(spec) ? spec : [spec]
  let copied = 0
  for (const it of items) {
    const from = typeof it === 'string' ? it : it.from
    const to = typeof it === 'string' ? path.basename(it) : (it.to || path.basename(it.from))
    if (!exists(from)) { warn(`secrets source missing: ${from}`); continue }
    const target = path.join(dest, to)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(from, target)
    copied++
  }
  return { copied, registered: true }
}

// ------------------------------------------------------------------ tickets

// Which org's tracker a new work belongs to: --org, else the only org that has one.
function trackerFor (cfg, orgFlag) {
  const live = ([org, t]) => t && t.kind && t.kind !== 'none' ? { org, ...t } : null
  if (orgFlag) {
    return live([orgFlag, cfg.tracker?.[orgFlag]]) ||
      die(`no tracker configured for org "${orgFlag}" in rig.json`)
  }
  const configured = Object.entries(cfg.tracker || {}).map(live).filter(Boolean)
  if (configured.length === 1) return configured[0]
  if (!configured.length) die('no tracker configured — add `tracker` to rig.json (see `rig prompt new-work`)')
  die(`several orgs have trackers (${configured.map(t => t.org).join(', ')}) — pass --org <org>`)
}

// Does any org have a tracker that can actually hold a ticket? If none do, a work has
// no way to get one, so the ticket-decision gate at `rig new` does not apply.
const anyTrackerConfigured = cfg =>
  Object.values(cfg.tracker || {}).some(t => t && t.kind && t.kind !== 'none')

// The org whose Jira project matches a key's prefix, or null when no org claims it (or
// more than one does — misconfiguration, not a guess this function should make).
function orgForJiraKey (cfg, key) {
  const project = isJiraKey(key) ? /^([A-Z][A-Z0-9]+)-/.exec(key)[1] : null
  if (!project) return null
  const owners = Object.entries(cfg.tracker || {}).filter(([, t]) => t.kind === 'jira' && t.project === project)
  return owners.length === 1 ? owners[0][0] : null
}

// The context doc header's two rendered facts.
const ticketsLabel = work =>
  work.tickets?.length ? work.tickets.join(', ') : (work.ticketsDeclined ? 'none (declined)' : '_none_')
// The context doc header, rewritten from the record's tickets and gates in one place. The
// word `Status:` survives — it is what a reader of a document expects to find — but what
// follows it is computed from the record every time it is written, never stored.
function syncDocHeader (id, work) {
  const f = contextFile(id)
  if (!exists(f)) return
  writeText(f, readText(f).replace(/^Tickets: .*? · Status: .*$/m,
    `Tickets: ${ticketsLabel(work)} · Status: ${statusLine(work)}`))
}

// Where the work records live on GitHub, for linking issues back to context docs.
function dataRemoteUrl () {
  const r = git(dataRoot(), 'remote', 'get-url', 'origin')
  if (r.code !== 0 || !r.out) return null
  return r.out.replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/')
}

// A relative reference when the data root has no remote: a machine path in an
// issue body would leak into a tracker that may be public.
const contextDocRef = id => {
  const remote = dataRemoteUrl()
  return remote ? `${remote}/blob/main/work/${id}/context.md` : `work/${id}/context.md in the rig data root`
}

// Ticket keys: Jira `PROJ-42`, or GitHub `owner/repo#n`. Only the Jira shape is
// safe in a branch name.
const isJiraKey = k => /^[A-Z][A-Z0-9]+-\d+$/.test(k)
const isGithubKey = k => /^[\w.-]+\/[\w.-]+#\d+$/.test(k)

// Resolves an org's `tracker.<org>.fields` (rig.json, e.g. `{ assignee: "me", sprint:
// "active", story_points: 3, components: ["Payments"] }`), merged with `--field
// name=value` overrides, into what `twg jira workitem create --field` wants: a
// usable id for every name. Custom field and allowed-value ids are discovered through
// `field create-metadata`, never hardcoded — see docs/adr/0001-jira-via-twg.md for the
// KTLO ids that must never be pasted in here as a shortcut. System fields are the one
// thing rig knows by heart (JIRA_SYSTEM_FIELDS): their ids are Jira's, not a site's.
// `--field name=value,name2=value2` on top of `t.fields` from rig.json; last write wins.
function mergeFieldOverrides (configuredFields, overrides) {
  const configured = { ...configuredFields }
  for (const o of overrides || []) {
    const eq = o.indexOf('=')
    if (eq < 1) die(`--field wants name=value, got "${o}"`)
    configured[o.slice(0, eq)] = o.slice(eq + 1)
  }
  return configured
}

// `sprint: "active"` (rig.json) resolved through the org's board to a real sprint id.
// Any other `sprint` value (or none) passes through unchanged.
function resolveActiveSprint (jiraClient, t, sprint) {
  if (sprint !== 'active') return sprint
  if (!t.board) die(`tracker for ${t.org} has fields.sprint "active" but no "board" in rig.json`)
  const id = jiraClient.activeSprintId(t.board)
  return id ?? die(`no active sprint on board ${t.board} (${t.org})`)
}

// Fixed vocabulary -> a field's human name in Jira; anything else is looked up by that
// name directly. A bare `customfield_*` key never reaches this — it passes straight
// through in resolveJiraFields.
const NAMED_JIRA_FIELDS = { sprint: 'Sprint', story_points: 'Story Points', components: 'Components' }

// Jira's system fields, spelled as Jira's own ids — for these the id *is* the name, and it
// is the same on every site. They are a fixed list rather than a discovery because
// `field create-metadata` returns **custom fields only**: for KTLO/Story it answers 31
// entries, every one a `customfield_*`, and no system field at all (hugoforte/rig#45). So
// there is nothing to discover them from, and a configured `components` used to die on a
// field that plainly exists on the create screen. Extending the list is a one-line change
// when an org needs one; guessing at unknown names is not (see the die below).
const JIRA_SYSTEM_FIELDS = ['components', 'labels', 'priority', 'versions', 'fixVersions']

// rig.json's vocabulary is snake_case (`story_points`), Jira's is camelCase, so
// `fix_versions` and `fixVersions` are one field.
const systemFieldId = key => JIRA_SYSTEM_FIELDS.find(id => id.toLowerCase() === key.replace(/_/g, '').toLowerCase())

// Component names -> their ids, against whatever list of allowed values applies. A name
// that matches nothing dies here — passing it through would let a typo or a
// renamed/removed component reach `twg` unresolved (ADR-0001: fail loudly, don't guess).
function resolveComponentIds (allowed, label, where, value) {
  return (Array.isArray(value) ? value : [value]).map(n => {
    const match = allowed.find(a => a.name.toLowerCase() === String(n).toLowerCase() || a.id === String(n))
    return match ? match.id :
      die(`"${n}" is not a value for "${label}" (${where}) — known: ${allowed.map(a => a.name).join(', ') || 'none'}`)
  })
}

// `key`/`value` from `t.fields` (rig.json), translated to the id `twg` wants — a
// `customfield_*` for a custom field, Jira's own name for a system one — and a Jira-ready
// value: `components` resolves each name to an id. Both lookups are fetched at most once
// per create and cached in `cache`.
function resolveJiraField (jiraClient, t, cache, key, value) {
  const name = NAMED_JIRA_FIELDS[key] || key
  const where = `${t.project}/${t.type}`
  cache.metadata ??= jiraClient.fieldMetadata(t.project, t.type)
  // create-metadata wins over JIRA_SYSTEM_FIELDS when both know the name: its entry is
  // this project and type's own — the real id and the real allowed values — where the
  // system list is only rig's site-independent fallback for what that endpoint omits.
  const field = cache.metadata.find(f => f.name.toLowerCase() === name.toLowerCase())
  if (field) {
    return { id: field.id, value: key === 'components' ? resolveComponentIds(field.allowedValues, field.name, where, value) : value }
  }
  const systemId = systemFieldId(key) ||
    die(`no field named "${name}" for ${where} — check rig.json or the name in Jira`)
  if (systemId !== 'components') return { id: systemId, value }
  // Allowed values for a system Components field are the project's components, since
  // create-metadata never carried the field to carry them.
  cache.components ??= jiraClient.projectComponents(t.project)
  return { id: systemId, value: resolveComponentIds(cache.components, name, t.project, value) }
}

// Resolves an org's Jira create defaults (rig.json `tracker.<org>.fields`, `--field`
// overrides applied on top) to `{ assignee, fields }`: `fields` maps field ids —
// `customfield_*`, or a system field's own Jira name — to the values `twg jira workitem
// create --field` wants.
function resolveJiraFields (jiraClient, t, overrides) {
  const configured = mergeFieldOverrides(t.fields, overrides)
  configured.sprint = resolveActiveSprint(jiraClient, t, configured.sprint)

  let assignee
  const fields = {}
  const cache = {}   // field metadata and components, each fetched at most once
  for (const [key, value] of Object.entries(configured)) {
    if (value === null || value === undefined) continue
    if (key === 'assignee') { assignee = value; continue }
    if (/^customfield_/.test(key)) { fields[key] = value; continue }
    const { id, value: resolved } = resolveJiraField(jiraClient, t, cache, key, value)
    fields[id] = resolved
  }
  return { assignee, fields }
}

// A ticket body: the prose, then where the design lives, then what opened it. One shape
// for both trackers — the context reference is `contextDocRef`'s and nobody invents a
// second format (hugoforte/rig#54).
const ticketBody = (work, prose) => [
  prose, '', `The design lives in the work record: ${contextDocRef(work.id)}`,
  '', `Opened by \`rig new ${work.id} --ticket\`.`,
].join('\n')

// Creates a ticket in the org's tracker, or previews it: `dryRun` prints what would be
// created and returns null without calling out. GitHub: the issue is the ticket, the
// context doc is the design (DESIGN.md §7.1) — a thin body, the brief's first paragraph,
// with a link back to it.
// Jira: `docs/adr/0001-jira-via-twg.md` (supersedes DESIGN.md decisions 29, 33).
function createTicket (cfg, work, brief, orgFlag, { dryRun = false, fields: fieldOverrides = [] } = {}) {
  const t = trackerFor(cfg, orgFlag)
  const summary = work.title || work.id

  if (t.kind === 'github') {
    if (!t.repo) die(`tracker for ${t.org} is GitHub but has no "repo" (owner/name) in rig.json`)
    if (fieldOverrides.length) warn('--field is ignored for a GitHub tracker (no per-field create options)')
    const firstParagraph = brief.split(/\n\s*\n/)[0] || summary
    const body = ticketBody(work, firstParagraph)
    if (dryRun) { say(`would create a GitHub issue in ${t.repo}:`); say(`  title  ${summary}`); say(`  body   ${firstParagraph}`); return null }
    step(`creating GitHub issue in ${t.repo}`)
    const n = github().createIssue(t.repo, summary, body)
    ok(`ticket ${t.repo}#${n}`)
    return `${t.repo}#${n}`
  }

  if (t.kind === 'jira') {
    if (!t.project || !t.type) die(`tracker for ${t.org} is Jira but is missing "project" or "type" in rig.json`)
    const { assignee, fields } = resolveJiraFields(jira(), t, fieldOverrides)
    // The whole brief, where GitHub gets one paragraph: a Jira ticket is read by a team
    // that may have no access to the private data root the context link points at, so it
    // has to stand on its own (hugoforte/rig#54). No truncation — Jira's own description
    // limit is 32,767 characters, which a piped brief does not reach, and silently cutting
    // the brief is the bug being fixed here; twg's error surfaces loudly if one ever does.
    const description = ticketBody(work, brief.trim() || summary)
    if (dryRun) {
      say(`would create a ${t.type} in ${t.project}:`)
      say(`  summary      ${summary}`)
      say(`  assignee     ${assignee || '_none_'}`)
      for (const [id, value] of Object.entries(fields)) say(`  ${id.padEnd(12)} ${JSON.stringify(value)}`)
      // Last, and verbatim: it is many lines, and what is printed is exactly the markdown
      // the real create sends — an indent that a reader can strip, not a summary of it.
      say('  description  (markdown, as sent):')
      for (const line of description.split('\n')) say(line ? `    ${line}` : '')
      return null
    }
    step(`creating Jira ${t.type} in ${t.project}`)
    const key = jira().createIssue({ project: t.project, type: t.type, summary, description, assignee, fields })
    ok(`ticket ${key}`)
    return key
  }

  die(`unknown tracker kind "${t.kind}" for ${t.org}`)
}

// On close, every ticket gets a comment with the PR links. GitHub tickets also close
// when every PR is merged; Jira tickets never do — transitions stay with the agent
// (Direction: KTLO alone needs two hops to reach "In Progress", which is org workflow,
// not rig's). `states` covers every attached repo, missing worktrees included, and what it
// *means* is `workState`'s to say (decision 62): a ticket left open and a `close` that
// refused now answer for the same reason, instead of each deriving "merged" its own way.
function ticketWriteBack (work, states, { abandoned = false, stages = [] } = {}) {
  const keys = work.tickets || []
  for (const k of keys) {
    if (!isJiraKey(k) && !isGithubKey(k)) warn(`ticket "${k}" is neither PROJ-123 nor owner/repo#n — skipped`)
  }
  const githubKeys = keys.filter(isGithubKey)
  const jiraKeys = keys.filter(isJiraKey)
  // A work that declined a ticket can still have slices that carry one, so the stages are
  // written back either way.
  if (!githubKeys.length && !jiraKeys.length) return stageWriteBack(work, stages, { abandoned })

  // The same stack `close` refused on, so the comment that explains a forced close can name
  // the slice that never landed. Without it `workState` reached a second, kinder verdict here
  // than the one the operator just forced past, and `reasonFor`'s slice line was unreachable.
  const { done: merged, reason, repos } = workState(work, states, { stages })
  const prs = repos.filter(v => v.pr).map(v => `- ${v.repo}: ${v.pr.url}`)
  // `forcedAt` records the decision where only rig can read it (decision 77), and the ticket
  // is what someone who was not the operator reads. A close that tore down past an open pull
  // request must not be indistinguishable there from one that had nothing to get past — that
  // is the state `rig status` would otherwise call a bug.
  const ranCmd = `rig close${work.forcedAt ? ' --force' : ''}`
  const overridden = work.forcedAt ? ' The blockers were overridden deliberately.' : ''
  // An abandoned work never closes its ticket, whatever the PRs say: stopping is a decision
  // about this attempt, and whether the *problem* is still worth solving is not rig's to
  // answer. A slice that did land is still listed — it is on the base branch either way.
  const opening = abandoned
    ? 'Abandoned — `rig close --abandoned` ran. The work was stopped without finishing; the issue stays open.'
    : `Closed by \`${ranCmd}\`.${overridden}${merged ? '' : ` ${reason} The issue stays open.`}`

  const githubBody = [
    opening,
    ...(prs.length ? ['', ...prs] : []),
    '', `Context doc: ${contextDocRef(work.id)}`,
  ].join('\n')
  for (const key of githubKeys) {
    const [repo, n] = key.split('#')
    const notCommented = trackerFailure(() => github().commentIssue(repo, n, githubBody))
    if (notCommented) { warn(`${key}: could not comment (${notCommented})`); continue }
    if (abandoned) { step(`commented on ${key} (left open: abandoned)`); continue }
    if (!merged) { step(`commented on ${key} (left open: ${reason})`); continue }
    const notClosed = trackerFailure(() => github().closeIssue(repo, n))
    if (notClosed) warn(`${key}: commented, but could not close (${notClosed})`)
    else step(`closed ${key}`)
  }

  const jiraBody = [
    abandoned
      ? '`rig close --abandoned` ran. The work was stopped without finishing.'
      : `\`${ranCmd}\` ran.${overridden}${merged ? ' Every attached PR is merged.' : ` ${reason}`}`,
    ...(prs.length ? ['', ...prs] : []),
    '', `Context doc: ${contextDocRef(work.id)}`,
    '', 'rig does not transition Jira tickets — move this one yourself.',
  ].join('\n')
  for (const key of jiraKeys) {
    const notCommented = trackerFailure(() => jira().commentIssue(key, jiraBody))
    if (notCommented) warn(`${key}: could not comment (${notCommented})`)
    else step(`commented on ${key}`)
  }

  stageWriteBack(work, stages, { abandoned })
}

// A stage's own tickets, told what became of the slice they were opened for.
//
// This is the one moment rig speaks to a tracker, and a stage's ticket is written back here
// with every other rather than the moment its pull requests merge — one outward-facing act,
// not a new rule about when rig speaks. A slice that landed closes its ticket; one that did
// not is commented on and left open, because whether the slice is still wanted is not rig's
// answer any more than an abandoned work's is.
function stageWriteBack (work, stages, { abandoned }) {
  for (const st of stages) {
    const keys = st.tickets || []
    if (!keys.length) continue
    const landed = !abandoned && st.landed
    const prs = st.prs.map(pr => `- ${pr.repo}: ${pr.url}`)
    const body = [
      landed
        ? `The slice this was opened for landed in \`${work.branch}\`, and \`rig close\` ran on ${work.id}.`
        : `\`rig close${abandoned ? ' --abandoned' : ''}\` ran on ${work.id}. This slice did not land, so the issue stays open.`,
      '', `Stage: \`${st.branch}\`${st.delivers ? ` — ${st.delivers}` : ''}`,
      ...(prs.length ? ['', ...prs] : []),
      '', `Context doc: ${contextDocRef(work.id)}`,
    ].join('\n')

    for (const key of keys) {
      if (isJiraKey(key)) {
        const notCommented = trackerFailure(() => jira().commentIssue(key, `${body}\n\nrig does not transition Jira tickets — move this one yourself.`))
        if (notCommented) warn(`${key}: could not comment (${notCommented})`)
        else step(`commented on ${key} (stage ${st.branch})`)
        continue
      }
      if (!isGithubKey(key)) { warn(`ticket "${key}" is neither PROJ-123 nor owner/repo#n — skipped`); continue }
      const [repo, n] = key.split('#')
      const notCommented = trackerFailure(() => github().commentIssue(repo, n, body))
      if (notCommented) { warn(`${key}: could not comment (${notCommented})`); continue }
      if (!landed) { step(`commented on ${key} (left open: stage ${st.branch} did not land)`); continue }
      const notClosed = trackerFailure(() => github().closeIssue(repo, n))
      if (notClosed) warn(`${key}: commented, but could not close (${notClosed})`)
      else step(`closed ${key} (stage ${st.branch} landed)`)
    }
  }
}

// ------------------------------------------------- generated work AGENTS.md

// What rig itself puts directly under a work folder; everything else there is a stray.
const WORK_FOLDER = { agents: 'AGENTS.md', claude: 'CLAUDE.md', marker: '.rig' }
const WORK_FOLDER_ENTRIES = Object.values(WORK_FOLDER)

function regenerate (cfg, work) {
  const wd = workDir(cfg, work.id)
  const cat = loadCatalog()
  const lines = []
  lines.push('<!-- GENERATED by rig — do not edit. Source of truth: the context doc below. -->')
  lines.push('')
  lines.push(`# ${work.id}${work.title ? ` — ${work.title}` : ''}`)
  lines.push('')
  if (work.title) lines.push(work.title)
  lines.push(`Tickets: ${ticketsLabel(work)} · Status: ${statusLine(work)}`)
  lines.push('')
  lines.push(`**Context doc (the only copy, edit it there):** \`${contextFile(work.id)}\``)
  if (exists(planFile(work.id))) lines.push(`**Rollout plan:** \`${planFile(work.id)}\``)
  lines.push('')
  lines.push(`**Branch (shared across every repo here):** \`${work.branch}\``)
  lines.push('')
  lines.push('## Repos in this work')
  lines.push('')
  if (!work.repos.length) lines.push('_None attached yet — `rig attach <repo>`._')
  for (const r of work.repos) {
    const c = cat.find(e => e.repo === r.repo)
    lines.push(`### ${r.repo}`)
    lines.push('')
    lines.push(`- Path: \`${r.path}\``)
    lines.push(`- Role: ${r.role || c?.role || '_not yet described in the catalogue_'}`)
    // One `gh pr list` per repo, which is the price of this file not still saying `main`
    // after a PR is repointed. It is the only GitHub call a plain `rig save` makes, and a
    // refusal costs a label, never the file.
    lines.push(`- Base: \`${baseLabel(prAndBase(r, work.branch))}\`${c?.stack ? ` · Stack: ${c.stack}` : ''}`)
    if (c?.setup?.length) lines.push(`- Setup: ${c.setup.map(s => `\`${s}\``).join(' · ')}`)
    if (c?.check?.length) lines.push(`- Check: ${c.check.map(s => `\`${s}\``).join(' · ')}`)
    lines.push('')
  }
  lines.push('## Rules in this folder')
  lines.push('')
  lines.push('- Add a repo with `rig attach <repo>` — **never** `git worktree add`.')
  lines.push('  Everything under the work root is rig-managed; `rig doctor` fails on strays.')
  lines.push('- Everything here is disposable. Durable knowledge goes in the context doc.')
  lines.push('- This file is regenerated on every mutating rig command. Edits are lost.')
  lines.push('')
  writeText(path.join(wd, WORK_FOLDER.agents), lines.join('\n'))
  writeText(path.join(wd, WORK_FOLDER.claude), `See [${WORK_FOLDER.agents}](./${WORK_FOLDER.agents}).\n`)
  writeText(path.join(wd, WORK_FOLDER.marker, 'id'), work.id + '\n')
  // Beside the work id, the data root that holds its record. This is what lets every command
  // run from inside a work folder resolve without `--data`, and so what keeps `current` off
  // the path of all but the rootless few. Nothing is written when the root has no name — an
  // installation still on the fallback has nothing to anchor to.
  if (where().name) writeText(path.join(wd, WORK_FOLDER.marker, 'data'), where().name + '\n')
}

// ------------------------------------------------------ data root commits

// Every mutating command ends here — see `main`, which runs it once the command has
// registered what it is committing as (`commitAs`), whether the command then succeeded
// or reported a failure, so a record written before a later step died is committed under
// its own message rather than swept into the next command's. The whole data root goes in
// (catalogue corrections made in passing included), then it is pushed if it has an
// upstream — event-based, no timer, no hook (DESIGN.md decision 20). Silent but
// announced: one line, never a prompt. Nothing here dies: the work is already done, so a
// git failure warns and leaves the change for the next command. Before pushing, others'
// commits are fetched and rebased under ours; a conflict aborts the rebase and says so,
// so the data root is never left mid-rebase.
//
// `known` is `prepareDataRoot`'s reading of this same directory, handed over by `main` for the
// mutating commands that made one — everything below reads only the fields a command cannot
// change while it runs (`stillTrueAtTheEnd`). `rig init` and `rig update` commit without one
// and pay for the reading here; `init` is also the one command that moves the location, which
// is why it is not among those that hand one over.
function commitDataRoot (message, loc = where(), known = null) {
  const root = loc.dataRoot
  if (!loc.split) { warn(`data root ${root} is inside the tool checkout — not committing knowledge into it`); return }
  const state = known ?? co.describe(root)
  if (state.repo === 'none') { say(C.dim(`· data root ${root} is not a git checkout — nothing committed`)); return }
  if (state.repo === 'nested') { warn(`data root ${root} is a directory inside another checkout (${state.top}) — not committing, that would stage all of it`); return }

  const commit = co.commitAll(root, message)
  if (commit.outcome === 'stage-failed') { warn(`data root: could not stage (${commit.error}) — commit it by hand`); return }
  if (commit.outcome === 'commit-failed') { warn(`data root: could not commit (${commit.error}) — the change waits for the next command`); return }
  const staged = commit.outcome === 'committed'
  const committed = staged ? `committed ${commit.hash ?? '(unborn)'}` : 'nothing to commit'
  if (!state.branch) { warn(`data root: ${committed} on a detached HEAD — check out a branch and cherry-pick it`); return }
  if (!state.upstream) {
    if (staged) ok(`data root: ${committed} (no upstream — not pushed)`)
    else say(C.dim(`· data root: ${committed}`))
    return
  }
  if (!staged && !state.ahead) { say(C.dim('· data root: nothing to commit, nothing to push')); return }

  const sent = co.pushRebasing(root)
  if (sent.outcome === 'fetch-failed') { warn(`data root: ${committed}, but could not fetch from origin (${sent.error}) — nothing pushed`); return }
  // Someone's rebase, and not rig's to finish or to throw away.
  if (sent.outcome === 'underway') { warn(`data root: ${committed}, but a rebase is already in progress in ${root} — finish or abort it, then \`rig save\`; nothing pushed`); return }
  if (sent.outcome === 'refused') { warn(`data root: ${committed}, but the rebase onto origin would not start (${sent.error}) — nothing pushed, nothing changed`); return }
  if (sent.outcome === 'conflict-stuck') { warn(`data root: ${committed}, but rebasing onto origin hit a conflict and the abort failed — sort ${root} out by hand (git status)`); return }
  if (sent.outcome === 'conflict') { warn(`data root: ${committed}, but rebasing onto origin hit a conflict — rebase aborted, tree left clean; pull, resolve and push by hand in ${root}`); return }
  // `sent.hash` is HEAD as the rebase left it, which is not what was committed above.
  if (sent.outcome === 'push-failed') { warn(`data root: ${committed} as ${sent.hash}, but the push failed (${sent.error}) — push it by hand`); return }
  ok(`data root: ${staged ? `committed ${sent.hash}` : `pushed ${sent.hash}, committed earlier`} and pushed`)
}

// A mutating command's registration of what it is committing as. Called as soon as the
// command has written anything worth committing; `invoke` does the rest.
const commitAs = (subject, detail) =>
  { current.pendingCommit = `rig ${current.command}${subject ? ` ${subject}` : ''}${detail ? `: ${detail}` : ''}` }

// ----------------------------------------------------------------- commands

const cmds = {}

// `--tracker org=github:owner/repo,org2=jira:PROJ,org3=none` -> the rig.json shape.
function parseTrackerFlag (spec) {
  const out = {}
  for (const part of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^([^=:]+)=(github|jira|none)(?::(.+))?$/.exec(part)
    if (!m) die(`--tracker: cannot read "${part}" (want org=github:owner/repo, org=jira:KEY, or org=none)`)
    const [, org, kind, arg] = m
    if (kind === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(arg || '')) die(`--tracker: ${org}=github needs :owner/repo`)
    if (kind === 'jira' && !/^[A-Z][A-Z0-9]+$/.test(arg || '')) die(`--tracker: ${org}=jira needs :PROJECTKEY (upper case, as in ticket keys)`)
    if (kind === 'none' && arg) die(`--tracker: ${org}=none takes no argument`)
    out[org] = kind === 'github' ? { kind, repo: arg } : kind === 'jira' ? { kind, project: arg } : { kind }
  }
  return out
}

// A data root needs a first commit before anything else works: `main` must exist for
// issue links (blob/main/...), and rig.json must exist for `init --orgs` to merge into.
// Idempotent: does nothing when HEAD already exists.
function ensureFirstCommit (target, name) {
  if (git(target, 'rev-parse', '--verify', 'HEAD').code === 0) return false
  if (!exists(path.join(target, 'README.md'))) {
    writeText(path.join(target, 'README.md'), `# ${name}

The data root for [rig](https://github.com/hugoforte/rig): the repo catalogue, the work records and \`rig.json\`. Private — this is everything rig knows about these orgs.

rig finds this checkout through \`dataRoot\` in its \`rig.local.json\`. Records commit straight to \`main\`; rig reads the working tree, so a record on a branch is invisible until merged.
`)
  }
  // Stamped at birth: a data root this rig just created is in this rig's record format, and
  // must not greet its owner with a pending migration. Written through the same module as
  // every other rig.json, at a location pointed at the target rather than at ours.
  writeOrg(withDataRoot(where(), target), prev => prev ?? { orgs: [], tracker: {}, writtenBy: FORMAT_STAMP })
  // Every mutating command will `git add -A` here and push, so the hard guards against
  // a secret landing beside a context doc go in before the first commit.
  if (!exists(path.join(target, '.gitignore'))) {
    writeText(path.join(target, '.gitignore'), `# Hard guards: rig commits and pushes this whole tree after every command.
*.env
.env.*
!*.env.example
!*.env.sample
*.secrets.env
*.local.json
*.pem
*.key
*.pfx
`)
  }
  const first = co.commitAll(target, 'Initialise rig data root')
  if (first.outcome !== 'committed') die(`could not make the first commit in ${target}: ${first.error || 'there was nothing to commit'}`)
  return true
}

// Make `target` a git checkout with a first commit. Refuses to `git init` a directory
// that already has unrelated content — the wrong --data-root must not turn a home
// directory into a repo.
function ensureDataRootCheckout (target) {
  if (!exists(target)) fs.mkdirSync(target, { recursive: true })
  if (!exists(path.join(target, '.git'))) {
    if (fs.readdirSync(target).length) die(`${target} is not a git checkout and is not empty — pick an empty or already-cloned directory`)
    must('git', ['init', '-q', '-b', 'main', target])
  }
  if (ensureFirstCommit(target, path.basename(target))) step(`first commit in ${target}`)
}

// `init --data-repo owner/name`: join the data repo if it exists on GitHub, create it
// (private) if not. Either way it ends up cloned beside the tool, with a first commit,
// and becomes the data root. Returns the local path.
function joinOrCreateDataRepo (spec, named) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(spec) || /\/\.\.?$/.test(spec)) die(`--data-repo wants owner/name, got "${spec}"`)
  const [owner, name] = spec.split('/')
  // Every data repo is called `rig-data` by convention, so the repo's own name cannot place
  // the second one — both would land on the same directory. A named root is put in a
  // directory named for it; the unnamed first root keeps the path it has always had.
  const target = path.join(path.dirname(toolRoot()), named ? `${name}-${named}` : name)

  // Already pointed somewhere else? Switching data roots is deliberate, not a side effect of
  // joining a repo — but `--name` *is* that deliberate act, and refusing it would make the
  // documented way to add a second root impossible.
  if (!named && where().split && !sameDir(dataRoot(), target)) {
    die(`dataRoot is already ${dataRoot()}. Switching data roots is deliberate: use --data-root, or --name to add a second.`)
  }

  if (exists(target)) {
    if (!exists(path.join(target, '.git'))) die(`${target} exists and is not a git checkout`)
    const origin = git(target, 'remote', 'get-url', 'origin').out
    if (origin && !origin.toLowerCase().includes(`/${spec.toLowerCase()}`)) {
      die(`${target} is a checkout of ${origin}, not ${spec}`)
    }
    say(`using the existing checkout at ${target}`)
    if (ensureFirstCommit(target, name) && origin) must('git', ['-C', target, 'push', '-q', '-u', 'origin', 'main'])
    return target
  }

  // Everything from here asks GitHub, and "gh could not answer" would otherwise read as
  // "does not exist" and send an existing repo down the create path.
  const auth = github().auth()
  if (auth === 'missing') die('gh not found on PATH — joining or creating a data repo needs it')
  if (auth === 'unauthenticated') die('gh is not authenticated — joining or creating a data repo needs it (gh auth login)')

  if (github().repoExists(spec)) {
    step(`joining ${spec}: cloning to ${target}`)
    github().clone(spec, target)
    // A repo with no commits clones fine and is useless; give it its first commit.
    if (ensureFirstCommit(target, name)) {
      must('git', ['-C', target, 'push', '-q', '-u', 'origin', 'main'])
      ok(`${spec} was empty — pushed its first commit`)
    }
    return target
  }

  // Create: the local checkout first, so a failure leaves nothing on GitHub; then gh
  // creates the repo from it and pushes with its own credentials.
  step(`${spec} does not exist: creating it, private`)
  ensureDataRootCheckout(target)
  const notCreated = trackerFailure(() => github().createRepo(spec, { source: target, description: 'rig data root: repo catalogue and work records' }))
  if (notCreated) {
    fs.rmSync(target, { recursive: true, force: true })
    die(`could not create ${spec}: ${notCreated}\n` +
      `  No permission to create repos in "${owner}"? Use --data-root <dir> for a local data root instead.`)
  }
  ok(`created ${spec} and pushed its first commit`)
  return target
}

cmds.init = ({ flags }) => {
  if (flags['data-repo'] === true) die('--data-repo wants owner/name')
  if (typeof flags['data-repo'] === 'string') {
    if (flags['data-root']) die('--data-repo and --data-root are alternatives; pass one')
    if (flags.name === true) die('--name wants a name for the data root')
    flags['data-root'] = joinOrCreateDataRepo(flags['data-repo'],
      typeof flags.name === 'string' && flags.name ? flags.name : null)
  }
  // The data root is decided here, before anything reads config, and the location every
  // helper below resolves against moves with it. This is the only reassignment there is:
  // `init` used to poke the resolved root half-way through itself, which left everything
  // after that line depending on a line you had to read the whole command to find.
  const previousRoot = dataRoot()
  if (flags['data-root']) current.location = withDataRoot(where(), path.resolve(toolRoot(), flags['data-root']))
  const targetDataRoot = dataRoot()
  const isSplit = where().split
  // A separate data root is always a git checkout with a first commit (local or not).
  if (isSplit) ensureDataRootCheckout(targetDataRoot)

  // rig.json is org-level and lives in the data root; --orgs adds, --tracker merges.
  let repoJson = readOrg(where())
  if (typeof flags.orgs === 'string' || typeof flags.tracker === 'string') {
    // `init` is the one writer outside the mutating set, and it hand-writes the very file
    // the gate is about — so it runs the gate itself. Not when it is creating the data root:
    // there is nothing to judge, and the first commit stamps what this rig writes.
    if (repoJson) checkWriteGate()
    repoJson = writeOrg(where(), prev => {
      const next = prev || { orgs: [], tracker: {}, writtenBy: FORMAT_STAMP }
      if (typeof flags.orgs === 'string') {
        const added = flags.orgs.split(',').map(s => s.trim()).filter(Boolean)
        next.orgs = [...new Set([...(next.orgs || []), ...added])]
      }
      if (typeof flags.tracker === 'string') {
        const parsed = parseTrackerFlag(flags.tracker)
        const unknown = Object.keys(parsed).filter(o => !next.orgs.includes(o))
        if (unknown.length) die(`--tracker names orgs not in --orgs / rig.json: ${unknown.join(', ')}`)
        next.tracker = { ...(next.tracker || {}), ...parsed }
      }
      return next
    })
    ok(`wrote ${repoConfigFile()}`)
    commitAs('', 'rig.json')
  }
  const orgs = repoJson?.orgs || []
  const email = typeof flags.email === 'string' ? flags.email : ''
  if (flags.name === true) die('--name wants a name for the data root')
  const named = typeof flags.name === 'string' && flags.name ? flags.name : null
  const knownRoots = registry(toolRoot(), env()).roots
  if (named && !flags['data-root'] && !knownRoots[named]) {
    die(`--name ${named} names a data root this machine does not configure — pass --data-root <dir> or --data-repo owner/name to say where it is`)
  }

  // Only the machine-level half goes in rig.local.json: the roots, and an identity per org.
  // An existing file is merged into — a new data root, and identities for orgs that have
  // none yet — and nothing already set is touched.
  let created = false
  const changes = []
  writeMachine(where(), prev => {
    if (!prev) {
      created = true
      const name = named || DEFAULT_ROOT_NAME
      return mirrorLegacyDataRoot({
        workRoot: flags['work-root'] ? path.resolve(flags['work-root']) : config().workRoot,
        ...(isSplit ? { dataRoots: { [name]: { path: targetDataRoot } }, current: name } : {}),
        identities: Object.fromEntries(orgs.map(o => [o, email])),
        secrets: {},
      })
    }
    const next = { ...prev }
    // The one-root form becomes a registry of one, the first time init writes. The machine
    // half is gitignored, so this is a normalisation and never a migration — nothing else on
    // any machine has to be told, and `rootsOf` reads both forms either way.
    if (next.dataRoot && !next.dataRoots) {
      next.dataRoots = { [DEFAULT_ROOT_NAME]: { path: next.dataRoot } }
      next.current = next.current || DEFAULT_ROOT_NAME
      changes.push('dataRoots')
    }
    if (flags['data-root']) {
      const name = named || next.current || DEFAULT_ROOT_NAME
      next.dataRoots = { ...(next.dataRoots || {}) }
      // A name given for a path another entry already holds is a **rename**, not a second
      // entry. Two names for one data root would make `rig use` a coin toss and the name a
      // work folder records meaningless. This is the path that names the one-root form:
      // normalisation above called it `default`, and `--name` is how it stops being that.
      for (const [n, e] of Object.entries(next.dataRoots)) {
        if (n === name || !e?.path) continue
        if (sameDir(path.resolve(path.dirname(localConfigFile()), e.path), targetDataRoot)) {
          delete next.dataRoots[n]
          changes.push(`renamed ${n} to ${name}`)
        }
      }
      next.dataRoots[name] = { ...(next.dataRoots[name] || {}), path: targetDataRoot }
      if (next.current !== name) changes.push(`current = ${name}`)
      next.current = name
      if (!changes.some(c => c.startsWith('renamed'))) changes.push(`dataRoots.${name}`)
    } else if (named && next.current !== named) { next.current = named; changes.push(`current = ${named}`) }
    if (email) {
      next.identities = { ...next.identities }
      for (const o of orgs) if (!next.identities[o]) { next.identities[o] = email; changes.push(`identity for ${o}`) }
    }
    return mirrorLegacyDataRoot(next)
  })
  if (created) ok(`wrote ${localConfigFile()}`)
  else if (changes.length) ok(`updated ${localConfigFile()}: ${changes.join(', ')}`)
  else say(`${localConfigFile()} already exists — nothing to change`)

  const cfg = config()
  for (const d of [cfg.workRoot, cfg.mirrorRoot, path.join(targetDataRoot, 'work')]) {
    fs.mkdirSync(d, { recursive: true })
  }
  ok(`work root ${cfg.workRoot}`)
  ok(`mirror root ${cfg.mirrorRoot}`)
  if (isSplit) ok(`data root ${targetDataRoot}`)
  else warn(`data root is the tool checkout — knowledge must not live inside a public tool's tree; run \`rig prompt setup\``)
  if (!repoJson) {
    warn(`no rig.json in ${targetDataRoot} — orgs and trackers are unknown until it exists`)
  }

  const lp = exec('git', ['config', '--global', 'core.longpaths'])
  if (lp.out !== 'true') {
    must('git', ['config', '--global', 'core.longpaths', 'true'])
    ok('set core.longpaths=true (MAX_PATH would otherwise break deep node_modules)')
  }
  // git is already required above; gh is optional until something needs GitHub.
  const auth = github().auth()
  if (auth === 'missing') warn('gh not found on PATH — org resolution, PR state and --ticket need it')
  else if (auth === 'unauthenticated') warn('gh is not authenticated — org resolution and PR state need it (gh auth login)')
  // twg only matters to orgs tracked in Jira; DESIGN.md decision 29 no longer bars it
  // (docs/adr/0001-jira-via-twg.md), but it stays irrelevant to a GitHub-only setup.
  if (Object.values(cfg.tracker || {}).some(t => t.kind === 'jira') && !jira().present()) {
    warn('twg not found on PATH — Jira ticket creation, fetch and write-back need it')
  }

  say('')
  if (!orgs.length) {
    say('Not set up yet: no orgs in rig.json. Run the setup interview — `rig prompt setup` —')
    say('or `rig init --orgs a,b --tracker a=github:owner/repo,b=jira:KEY` directly.')
    say('')
  }
  const missing = orgs.filter(o => !effectiveIdentity(cfg, o).email)
  if (missing.length) {
    say(`Still to do in ${localConfigFile()}:`)
    say(`  identities — commit email for ${missing.join(', ')} (or re-run \`rig init --email you@work\`)`)
    say('  secrets    — per-repo .env sources, when a repo needs them')
    say('')
  }
  say('Then: `rig doctor`, then `rig new <id> --title "..."`.')
}

// Moves `current`, and nothing else. It never creates, joins or repairs a data root —
// `rig init` does that — so the only question it answers is whether the one being switched
// to can be worked in, asked before the switch rather than at the next mutating command's
// write refusal. Reads the registry directly rather than through `where`, because a
// `current` naming a root that has gone is exactly what this command is for and resolving
// it would die first.
cmds.use = ({ positional }) => {
  const reg = registry(toolRoot(), env())
  const names = Object.keys(reg.roots)
  const name = positional[0]
  if (!name) {
    if (!names.length) die(`no data roots configured in ${reg.localFile} — run \`rig prompt setup\``)
    say('Data roots on this machine:')
    // What is marked is the root that would be resolved, not literally what `current` says:
    // the one-root form has no pointer and never needed one, and a listing that marked
    // nothing would read as "none of these".
    const inHand = reg.current ?? (names.length === 1 ? names[0] : null)
    for (const n of names) {
      const mark = n === inHand ? C.green('*') : ' '
      say(`  ${mark} ${n}  ${C.dim(reg.roots[n].path)}`)
    }
    return
  }
  const entry = reg.roots[name]
  if (!entry) die(`no data root "${name}" in ${reg.localFile}${names.length ? ` — it has ${names.join(', ')}` : ''}`)
  if (!exists(entry.path)) die(`data root "${name}" is ${entry.path}, which is not there — fix dataRoots.${name} in ${reg.localFile}`)
  const loc = withDataRoot({ toolRoot: toolRoot(), localFile: reg.localFile, roots: reg.roots }, entry.path)
  if (!loc.split) die(`data root "${name}" is inside the tool checkout — knowledge must not live in a public tool's tree; run \`rig prompt setup\``)
  if (!exists(loc.orgFile)) die(`data root "${name}" has no rig.json at ${loc.orgFile} — \`rig init --data-root ${entry.path}\` makes one`)
  const cfgJson = readOrg(loc) ?? {}
  if (stampUnreadable(cfgJson)) {
    die(`data root "${name}" records writtenBy ${JSON.stringify(cfgJson.writtenBy)}, which is not a record format any rig wrote — fix it by hand; rig will not guess.`)
  }
  if (writesBlocked(cfgJson)) {
    die(`data root "${name}" is at record format ${dataMajor(cfgJson)} and this rig writes ${MAJOR} — run \`rig update\` before switching to it.`)
  }
  // Written even when the name is not moving: the legacy pointer this keeps in step may be
  // missing or stale, and `rig use <the one you are on>` is the obvious way to ask for it back.
  // An unchanged file is not rewritten, so there is nothing to churn.
  writeMachine({ localFile: reg.localFile }, prev => mirrorLegacyDataRoot({ ...(prev ?? {}), current: name }))
  if (reg.current === name) { ok(`already on data root ${name} ${C.dim(entry.path)}`) }
  else ok(`data root ${name} ${C.dim(entry.path)}${reg.current ? C.dim(` (was ${reg.current})`) : ''}`)
  const pending = pendingMigrations(cfgJson)
  if (pending.length) warn(`${name} is at record format ${dataMajor(cfgJson)}, this rig writes ${MAJOR} — run \`rig update\` to migrate (${pending.length} pending)`)
}

cmds.new = ({ flags, positional }) => {
  sayCurrentRoot()
  const cfg = config()
  const id = positional[0] || die('usage: rig new <work-id> --title "..." [--key K | --ticket [--org o] | --no-ticket] [--repos a,b]')

  const keys = (flags.key || flags.keys || '').toString().split(',').map(s => s.trim()).filter(Boolean)
  for (const k of keys) {
    if (!isJiraKey(k) && !isGithubKey(k)) die(`--key "${k}" is neither PROJ-123 nor owner/repo#n`)
  }
  const noTicket = !!flags['no-ticket']
  const dryRun = !!flags['dry-run']
  if (dryRun && !flags.ticket) die('--dry-run only makes sense with --ticket')
  if (keys.length && noTicket) die('--key and --no-ticket are alternatives; pass one')
  if (flags.ticket && noTicket) die('--ticket and --no-ticket are alternatives; pass one')
  // The ticket decision must be explicit whenever it could matter (DESIGN direction:
  // "gates, not stages"). A data root with no live tracker anywhere has no decision to make.
  if (!keys.length && !flags.ticket && !noTicket && anyTrackerConfigured(cfg)) {
    die('a tracker is configured — pass --key <key>, --ticket, or --no-ticket (see `rig prompt new-work`)')
  }

  const brief = readStdin()
  const fieldOverrides = (flags.field || '').toString().split(',').map(s => s.trim()).filter(Boolean)
  // Read the real record, if one already exists, so `--dry-run` doesn't preview a ticket
  // the real run would just warn-and-skip (an id that already has one).
  const existing = exists(recordFile(id)) ? readJson(recordFile(id)) : null
  if (dryRun) {
    if (existing?.tickets?.length) { warn(`${id} already has a ticket (${existing.tickets.join(', ')}) — nothing to preview`); return }
    createTicket(cfg, { id, title: flags.title || existing?.title || '' }, brief, flags.org, { dryRun: true, fields: fieldOverrides })
    return
  }

  if (existing) die(`work "${id}" already exists (${recordFile(id)})`)

  // One work root, shared by every data root on this machine, so two roots can want the same
  // folder. The `.rig/data` marker detects the clash but cannot fix it — renaming a folder
  // another root's records point at would break that work — so the id is refused and the root
  // that owns it is named. This is the whole cost of not giving every data root a work root
  // of its own, and it is paid at the one moment a name is being chosen anyway.
  const folder = workDir(cfg, id)
  if (exists(folder)) {
    const owner = anchoredRoot(folder)
    const whose = owner && owner !== where().name ? ` and belongs to data root "${owner}"` : ''
    die(`${folder} already exists${whose} — pick another id`)
  }

  // A Jira `--key` needs no piped brief any more: rig fetches summary/description
  // itself, used as a default wherever `--title`/stdin didn't already supply one.
  let fetched = null
  const jiraKey = keys.find(isJiraKey)
  if (jiraKey && orgForJiraKey(cfg, jiraKey)) {
    try { fetched = jira().getIssue(jiraKey) } catch (e) { warn(`could not fetch ${jiraKey} from Jira: ${e.message}`) }
  }
  const title = flags.title || fetched?.title || ''

  const idKey = /^([A-Z][A-Z0-9]+-\d+)/.exec(id)?.[1] ?? ''
  // Only a Jira-shaped key goes in the branch name. GitHub keys carry `#` and `/`;
  // the PR links those with "Fixes #n" instead.
  const branchKey = keys.find(isJiraKey) || idKey
  const type = flags.type || 'feat'
  const branchSlug = flags.slug || slug(title || id.replace(/^[A-Z][A-Z0-9]+-\d+-?/, '') || id)
  const branch = flags.branch ||
    `${type}/${branchKey ? branchKey + '-' : ''}${branchSlug}`.replace(/-$/, '')

  const work = {
    id,
    title,
    tickets: keys.length ? keys : (idKey ? [idKey] : []),
    ...(noTicket ? { ticketsDeclined: true } : {}),
    type,
    branch,
    repos: [],
    createdAt: new Date().toISOString(),
  }

  // The complete record first — a work with no ticket is a valid, but now explicit,
  // state — then the ticket. If gh/twg fails, `rig ticket <key>` attaches one later;
  // nothing is half-built and no issue is orphaned.
  fs.mkdirSync(workDir(cfg, id), { recursive: true })
  commitAs(id)
  // Context doc — scaffolded minimal, not eleven empty sections (DESIGN.md §7.2). The
  // header line it carries is then rewritten by saveWork, which owns it from here on.
  const tpl = readText(path.join(toolRoot(), 'templates', 'context.md'))
  writeText(contextFile(id), tpl
    .replace(/\{\{ID\}\}/g, id)
    .replace(/\{\{TITLE\}\}/g, title || id)
    .replace(/\{\{KEYS\}\}/g, work.tickets.join(', ') || '_none_')
    .replace(/\{\{DATE\}\}/g, new Date().toISOString().slice(0, 10))
    .replace(/\{\{BRIEF\}\}/g, brief || fetched?.body || '_TODO: one line, then the narrative. State scope explicitly._'))
  saveWork(cfg, work)

  if (flags.ticket && work.tickets.length) {
    warn(`--ticket ignored: the work already has ${work.tickets.join(', ')}`)
  } else if (flags.ticket) {
    const created = createTicket(cfg, work, brief || fetched?.body || '', flags.org, { fields: fieldOverrides })
    if (created) {
      work.tickets.push(created)
      saveWork(cfg, work)
    }
  }

  ok(`created work ${C.bold(id)}`)
  say(`  record   ${recordFile(id)}`)
  say(`  context  ${contextFile(id)}`)
  say(`  folder   ${workDir(cfg, id)}`)
  say(`  branch   ${branch}`)
  say(`  tickets  ${ticketsLabel(work)}`)
  say('')

  const repos = (flags.repos || '').toString().split(',').map(s => s.trim()).filter(Boolean)
  if (repos.length) {
    for (const r of repos) attachRepo(cfg, work, r, { setup: !!flags.setup })
  } else {
    say('No repos attached yet. Run the selection interview:')
    say(C.dim('  rig prompt select-repos'))
    say(C.dim(`  rig attach <repo> --work ${id}`))
  }
}

// Attaches to the record it is given — `rig new --repos a,b` passes the one it just built.
function attachRepo (cfg, work, repoName, { setup = false } = {}) {
  if (work.repos.some(r => r.repo.toLowerCase() === repoName.toLowerCase())) {
    say(`${repoName} already attached — nothing to do`)
    return
  }
  // The other side of a repo naming its data root. A work lives in exactly one root — one
  // `work.json`, one `context.md` — so a repo catalogued in a different one cannot join it.
  // Without this, `attach` would draft an entry for an employer's repo into a personal
  // catalogue: the leak the separation exists to stop, arriving by the back door.
  const here = where().name
  const elsewhere = here ? rootsCataloguing(where().roots, repoName).filter(n => n !== here) : []
  if (elsewhere.length) {
    die(`"${repoName}" is catalogued in data root ${elsewhere.map(n => `"${n}"`).join(' and ')}, ` +
      `and ${work.id} is in "${here}" — one work cannot span two data roots. ` +
      `Open a separate work there (\`rig new <id> --data ${elsewhere[0]}\`), or move this one.`)
  }
  const { org, repo, language } = resolveOrg(cfg, repoName)
  const dest = path.join(workDir(cfg, work.id), repo)
  const { base } = trees(cfg).cut({ org, repo, branch: work.branch, dest })

  const configured = identityFor(cfg, org)
  if (configured) {
    gitMust(dest, 'config', 'user.email', configured)
    step(`identity ${configured}`)
  } else {
    // No override to write, so report what git resolves in this very worktree rather than
    // assuming the global address: a conditional include on the remote URL answers per-org.
    const resolved = git(dest, 'config', 'user.email')
    if (resolved.code === 0 && resolved.out) step(`identity ${resolved.out} — from git, not rig`)
    else warn(`no identity for org "${org}" — git has no user.email to commit with`)
  }

  const sec = copySecrets(cfg, repo, dest)
  if (sec.copied) step(`copied ${sec.copied} secrets file(s)`)

  // Draft only for a repo the catalogue does not know: a hit means its file exists, or
  // that its frontmatter names a different path — a misconfiguration, not a gap to fill.
  const known = findCatalog(repo)
  if (!known && draftCatalogEntry(org, repo, language)) {
    warn(`drafted catalogue entry ${catalogFile(org, repo)} — correct it while this is fresh`)
  }

  const cat = known || findCatalog(repo)
  // The base belongs to the branch it was cut from, not to the repo: a repo carries several
  // branches of one work once it has stages, each landing somewhere different.
  work.repos.push({
    repo, org, path: dest, base, role: cat?.role || '',
    attachedAt: new Date().toISOString(),
    branches: [{ branch: work.branch, base }],
  })
  saveWork(cfg, work)
  ok(`attached ${C.bold(repo)} at ${dest}`)

  if (cat?.setup?.length) {
    if (setup) runCatalogCommands(dest, cat.setup, 'setup')
    else {
      say(`  ${C.dim('setup (not run — `rig setup ' + repo + '` or --setup):')}`)
      for (const s of cat.setup) say(`    ${s}`)
    }
  }
}

cmds.ticket = ({ flags, positional }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  const key = positional[0] || die('usage: rig ticket <PROJ-123 | owner/repo#n>')
  if (!isJiraKey(key) && !isGithubKey(key)) die(`"${key}" is neither PROJ-123 nor owner/repo#n`)
  if (work.tickets.includes(key)) return say(`${key} already recorded — nothing to do`)
  work.tickets.push(key)
  delete work.ticketsDeclined   // a real ticket supersedes an earlier --no-ticket
  commitAs(id, key)
  saveWork(cfg, work)
  ok(`recorded ${key} on ${id}`)
}

cmds.attach = ({ flags, positional }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const name = positional[0] || die('usage: rig attach <repo>')
  commitAs(work.id, name)
  attachRepo(cfg, work, name, { setup: !!flags.setup })
  offerNeighbours(work, name)
}

// What else this repo travels with, said once, at the moment the repo set is being chosen.
// **Both graphs here, unlike `rig next`, which offers only the declared one.** The difference
// is how often each command speaks: `attach` runs once per repo and is the moment the question
// is live, so a co-attachment the records keep making is worth raising; `next` runs constantly
// and has to stay quiet enough to be read.
//
// Offers, never blocks — nothing is attached for you, and the command has already done its job
// by the time this prints.
function offerNeighbours (work, name) {
  const catalog = loadCatalog()
  if (!catalog.length) return
  const { works, unreadable } = readRecords(dataRoot())
  const answer = impact(catalog, name, { works })
  const have = new Set((work.repos || []).map(r => r.repo.toLowerCase()))
  const said = repo => say(C.dim(`· ${repo}`))

  for (const n of answer.hop1) {
    if (have.has(n.repo.toLowerCase())) continue
    const why = n.disagreed ? '' : n.direction === 'downstream' ? `, and a change in ${name} can break it`
      : n.direction === 'upstream' ? `, and a change in it can break ${name}`
        : n.direction === 'both' ? ', and either can break the other' : ''
    said(`${n.repo} talks to ${name}${why} — not attached (\`rig attach ${n.repo}\`)`)
  }
  for (const o of answer.observed) {
    if (have.has(o.repo.toLowerCase()) || o.declared) continue
    said(`${o.repo} has shared ${o.works.length} work${o.works.length === 1 ? '' : 's'} with ${name}, with nothing in talks_to to say why`)
  }
  sayUnreadable(unreadable)
}

// The explicit save, for edits made outside rig — chiefly the context doc. `--designed`
// records the "design agreed" gate, which is what the flag's name always said it did: a
// decision someone took, on a date nothing else can recover. It used to set a status.
cmds.save = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  if (flags.message === true) die('-m needs a message')
  commitAs(id, flags.message)
  if (flags.designed) {
    if (work.closedAt) die(`${id} is closed — its design gate is behind it`)
    if (work.abandonedAt) die(`${id} was abandoned — its design gate is behind it`)
    // Re-recorded rather than refused: agreeing the design a second time is a real thing to
    // do after a rethink, and the date that matters is the one the current design was agreed.
    work.designedAt = new Date().toISOString()
    ok(`${id}: design agreed`)
  }
  saveWork(cfg, work)
}

cmds.detach = ({ flags, positional }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  const name = positional[0] || die('usage: rig detach <repo>')
  const entry = work.repos.find(r => r.repo.toLowerCase() === name.toLowerCase())
  if (!entry) die(`${name} is not attached to ${id}`)

  const { dirty } = trees(cfg).state({ dir: entry.path, base: entry.base })
  if (dirty && !flags.force) die(`${entry.repo} has uncommitted changes — commit, or pass --force`)

  // Out of the worktree before it goes, for the reason `close` gives.
  if (standingIn(entry.path)) chdir(toolRoot())
  const failed = trees(cfg).remove({ org: entry.org, repo: entry.repo, dir: entry.path, force: !!flags.force })
  if (failed) die(failed)

  work.repos = work.repos.filter(r => r !== entry)
  commitAs(id, entry.repo)
  saveWork(cfg, work)
  ok(`detached ${entry.repo}`)
}

// What GitHub says about this branch in this repo: its newest PR, and the base that PR
// lands on. One lookup answers both — `baseRefName` rides along with the PR state — and
// the live base wins, because `entry.base` is only where the branch was cut from at
// `rig attach` and goes stale the moment the PR is repointed at another PR's branch.
//
// The lookup only needs org/repo/branch, so it runs even with the worktree missing — a repo
// whose folder is gone can still have an open PR. One repo GitHub cannot answer for must not
// take the whole listing down; the caller shows the state as unknown, and `close` treats
// unknown as a blocker. A refused lookup leaves the recorded base in place and keeps
// `prError` beside it, so no caller can pass the record off as the live answer.
function prAndBase (entry, branch) {
  const s = { pr: null, base: entry.base, recordedBase: entry.base }
  s.prError = trackerFailure(() => { s.pr = github().prForBranch(entry.org, entry.repo, branch) })
  if (s.pr?.base) s.base = s.pr.base
  return s
}

// Is the branch landing somewhere other than where it was cut from? The stacked-PR case.
const baseMoved = s => !s.prError && !!s.base && s.base !== s.recordedBase

// One rendering of a base, for every surface that shows one. The record alone when the
// live base agrees with it, or when there is no PR to disagree; both, `recorded → live`,
// when they differ, because a bare `feat/other-work` hides that the record still says
// `main`; and on a lookup GitHub refused, the record named as the record — a base rig
// could not confirm must never read as one it did (the `prUnknown` rule, applied to the
// base).
const baseLabel = s => s.prError ? `${s.recordedBase} (recorded — GitHub would not say)`
  : baseMoved(s) ? `${s.recordedBase} → ${s.base}`
  : s.recordedBase

function repoState (cfg, entry, branch) {
  const s = { repo: entry.repo, ...prAndBase(entry, branch) }
  return Object.assign(s, trees(cfg).state({ dir: entry.path, base: s.base, recordedBase: entry.base, branch }))
}

// The one ordering rule for works: least recently touched first, so the last line of
// `rig list` is the work in hand. Every timestamp is already in the record — nothing is
// stored for this, and neither git nor GitHub is asked to sort.
const activityAt = work => [work.createdAt, work.closedAt, ...(work.repos || []).map(r => r.attachedAt)]
  .filter(Boolean).sort().pop() || ''

function relativeAge (iso) {
  if (!iso) return 'undated'
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000)
  if (!Number.isFinite(mins)) return 'undated'
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 2880) return `${Math.floor(mins / 60)}h ago`
  return `${Math.floor(mins / 1440)}d ago`
}

// When the work started, when it was first looked at, and when it was approved — one GitHub
// call for all three, because a second call per repo is what makes a listing unusable.
// The first commit comes from the PR rather than the branch, which GitHub deletes on merge;
// with no PR the branch is still the answer, and the worktree is where it is read from.
// `error` carries a refused lookup: a consumer measuring cycle time has to tell "GitHub would
// not say" from "there is none", and a null that means both is how a work silently leaves
// the numerator.
function prTiming (entry, pr) {
  // The PR's own base when it has one: a stacked branch measured from `main` dates itself
  // to the first commit of the PR underneath it, which is not when this work started.
  const fromBranch = () => branchFirstCommitAt(entry, pr?.base)
  if (!pr) return { firstCommitAt: fromBranch() }
  let times = null
  // `prTimeline` answers null for a PR gh could not read at all, which is not a PR nobody
  // reviewed. Left as a plain null, that work leaves the review figures without a trace.
  const error = trackerFailure(() => { times = github().prTimeline(entry.org, entry.repo, pr.number) }) ||
    (times ? undefined : `GitHub would not answer for ${entry.org}/${entry.repo}#${pr.number}`)
  if (!times) return { firstCommitAt: fromBranch(), error }
  return { ...times, firstCommitAt: times.firstCommitAt || fromBranch(), error }
}

// The stored shape (AGENTS.md rule 3's narrow exception, DESIGN.md decision 60): a merged
// PR's terminal facts, and nothing else — never `state`, dirty, or ahead/behind, which keep
// moving after the record is written. `close` and `backfill` both reach a MERGED pr this way,
// so there is exactly one place that decides what "terminal" means. An error here is the
// caller's cue to store nothing (no negative caching): a rate limit is transient, and a record
// saying "unknown forever" is worse than asking again next time.
function terminalPr (entry, pr) {
  // The one place that decides what terminal means, rather than each caller deciding again.
  if (!pr || pr.state !== 'MERGED') return { error: `${entry.repo}: PR is ${pr ? pr.state.toLowerCase() : 'absent'}, not merged` }
  const timing = prTiming(entry, pr)
  if (timing.error) return { error: timing.error }
  // Without the first commit there is no start line, and a record is what stops rig asking
  // again — so an incomplete one would cache the missing half of every cycle time forever.
  if (!timing.firstCommitAt) return { error: `${entry.repo}#${pr.number}: no first commit found, so there is nothing to measure from` }
  return {
    record: {
      number: pr.number,
      url: pr.url,
      openedAt: pr.openedAt,
      firstCommitAt: timing.firstCommitAt,
      firstReviewAt: timing.firstReviewAt ?? null,
      approvedAt: timing.approvedAt ?? null,
      mergedAt: pr.mergedAt,
    },
  }
}

// The first commit this branch adds over its base, or null when the worktree is gone or git
// cannot resolve the range. Never the base's own history — which is why `base` is the live
// base when one is known: over `main`, a branch stacked on another PR claims that PR's
// commits as its own. The recorded base is the fallback, for a live base naming a branch
// this checkout has never fetched.
function branchFirstCommitAt (entry, base) {
  if (!exists(entry.path)) return null
  for (const b of new Set([base, entry.base].filter(Boolean))) {
    const log = git(entry.path, 'log', '--reverse', '--format=%aI', `refs/remotes/origin/${b}..HEAD`)
    if (log.code === 0) return log.out.split('\n')[0].trim() || null
  }
  return null
}

// The JSON listing: records as they are, plus the live fields a consumer cannot derive
// for itself. `closedAt` is when `rig close` ran, not when anything merged — `pr.mergedAt`
// is the end of the work and `firstCommitAt` the start. Under --quick every live field is
// absent rather than null, so a consumer can tell "not looked up" from "no PR".
//
// The fields are listed rather than spread, deliberately: `repos[].path` is derived from
// this machine's work root (decision 37) and must not escape into a consumer's data.
const workJson = (cfg, work, live) => ({
  id: work.id,
  title: work.title || '',
  tickets: work.tickets || [],
  ticketsDeclined: !!work.ticketsDeclined,
  type: work.type || '',
  branch: work.branch,
  stages: (work.stages || []).map(st => ({ branch: st.branch, delivers: st.delivers || '' })),
  createdAt: work.createdAt || null,
  designedAt: work.designedAt || null,
  abandonedAt: work.abandonedAt || null,
  closedAt: work.closedAt || null,
  activityAt: activityAt(work) || null,
  repos: (work.repos || []).map(r => repoEntryJson(cfg, r, work.branch, live)),
})

function repoEntryJson (cfg, entry, branch, live) {
  const out = {
    repo: entry.repo,
    org: entry.org,
    base: entry.base,
    role: entry.role || '',
    attachedAt: entry.attachedAt || null,
  }
  // A stored `pr` is a merged PR's terminal facts (`rig backfill`, `rig close`) — recorded
  // once and never re-asked, so this reads it back with no GitHub call at all, live or
  // `--quick` alike. `recorded: true` says where it came from, so a consumer never mistakes
  // it for a lookup that just happened.
  // `state` is not stored — it is the thing that kept moving — but a record only ever exists
  // for a merged PR, so the reader knows it without asking. Put back here, the payload is the
  // same shape either way and no consumer has to learn that a recorded PR is a special case.
  // Listed rather than spread, for the same reason the record above is.
  // Every branch of this work this repo carries, with the base each lands on and the merged
  // PR each recorded — the stack, as a consumer sees it. Listed rather than spread for the
  // same reason the rest of this function is.
  out.branches = (entry.branches || []).map(br => ({
    branch: br.branch,
    base: br.base,
    ...(br.pr ? { pr: { ...br.pr, state: 'MERGED', recorded: true } } : {}),
  }))
  const stored = (entry.branches || []).find(br => br.branch === branch)?.pr
  if (stored) {
    out.pr = {
      number: stored.number,
      state: 'MERGED',
      url: stored.url,
      openedAt: stored.openedAt,
      firstReviewAt: stored.firstReviewAt ?? null,
      approvedAt: stored.approvedAt ?? null,
      mergedAt: stored.mergedAt,
      recorded: true,
    }
    out.firstCommitAt = stored.firstCommitAt
    // Local git state costs no GitHub call either, so a live listing still gets it — a
    // record does not mean the worktree stopped being worth reporting on.
    if (live) Object.assign(out, trees(cfg).state({ dir: entry.path, base: entry.base }))
    return out
  }
  if (!live) return out
  const s = repoState(cfg, entry, branch)
  Object.assign(out, { missing: s.missing, dirty: s.dirty, ahead: s.ahead, behind: s.behind })
  // A repo GitHub could not answer for says so, rather than reading as a repo with no PR.
  if (s.prError) out.prUnknown = s.prError
  else out.pr = s.pr
  const timing = prTiming(entry, s.pr)
  out.firstCommitAt = timing.firstCommitAt ?? null
  // One refusal, two things left unknown: where the work started, and whether it was ever
  // reviewed. Both are named, because a consumer counting either would otherwise count a
  // refused lookup as a fact.
  if (timing.error) {
    if (!out.firstCommitAt) out.firstCommitAtUnknown = timing.error
    if (out.pr) out.prTimelineUnknown = timing.error
  }
  // When it was first looked at and when it was approved belong to the PR, and are what
  // separates the time a work spent with its author from the time it spent waiting.
  if (out.pr) Object.assign(out.pr, {
    firstReviewAt: timing.firstReviewAt ?? null,
    approvedAt: timing.approvedAt ?? null,
  })
  return out
}

// Every work, least recently touched first. ISO-8601 exists so that byte order is
// chronological order; decorate once rather than recomputing the key inside the comparator.
const worksByActivity = cfg => listWorkIds().map(id => loadWork(cfg, id))
  .map(work => [activityAt(work), work])
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([, work]) => work)

// The release this checkout stands on, or null when nothing here was ever tagged. One spawn,
// inside a command somebody ran on purpose — never in `toolState`, which every command's
// epilogue already pays four spawns for (ADR 0003). `head` is not passed: without a tag there
// is no release to name, and a sha in a field called `release` would be a different claim.
//
// Guarded like every other ambient git call in this file (`repoAtCwd`, `doctorSnapshot`):
// `exec` dies when the command is not there, and `rig list --json` on a machine with no git
// has a full answer to give about the records — which release wrote it is the one field that
// needs git, and a missing field is the right way to say so.
const releaseHere = () => (onPath('git')
  ? releaseMark({ describe: git(toolRoot(), 'describe', '--tags', '--long', '--match', 'v[0-9]*').out })
  : null)

// The one machine-readable surface (decision 55). `rig list --json` prints it; `rig dash`
// renders it; neither reads the records a second way.
//
// Two facts about the installation, and they are different kinds of thing: `recordFormat` is
// derived and free and gates writes, `release` costs a spawn and names what was published.
// There used to be a `rig` beside them holding `MAJOR.minor.patch`, which was the format said a
// second time in a semver's clothing (ADR 0004).
const listPayload = (cfg, live) => ({
  recordFormat: MAJOR,
  release: releaseHere(),
  generatedAt: new Date().toISOString(),
  live,
  works: worksByActivity(cfg).map(w => workJson(cfg, w, live)),
})

// The same payload, for a consumer inside this process rather than downstream of a pipe — a
// test asserting the shape of the published surface should not have to parse a subprocess's
// stdout to see it.
//
// It takes no config, deliberately. `listPayload` finds the *records* through this
// installation's own data root (`where()`) whatever config it is handed, so a published
// signature that accepted one would promise a choice it does not make; giving one data root
// per call is hugoforte/rig#77's, and it is a change to how the records are located, not to
// how they are published. Handing a config out would publish the machine half besides — the
// work root, the mirrors, the identities and the secrets — which is exactly what the payload
// withholds from a consumer field by field (decision 37).
const listing = live => listPayload(config(), live)

cmds.list = ({ flags }) => {
  sayCurrentRoot()
  const cfg = config()
  const live = flags.prs !== false && !flags.quick

  if (flags.json) return say(JSON.stringify(listPayload(cfg, live), null, 2))

  const works = worksByActivity(cfg)
  if (!works.length) return say('no works yet — `rig new <id> --title "..."`')
  for (const work of works) {
    const id = work.id
    const wd = workDir(cfg, id)
    const open = exists(wd)
    const head = `${C.bold(id)} ${C.dim(work.branch)}`
    const stopped = work.closedAt || work.abandonedAt
    // One verdict, rendered — never a second rule for what the badges add up to. Under
    // `--quick` nothing was looked up, so the facts are empty and only a recorded PR
    // (decision 60) has anything to say; the closing line stays behind `live` for that
    // reason, because "no blockers" from an empty lookup is not an answer.
    //
    // Gathered before the phase line rather than after it: a work that stopped is settled by
    // its gate and costs no lookup, and for every other work this is the lookup that lets the
    // line say `Reviewing` instead of guessing from the record.
    const states = stopped ? [] : work.repos.map(r => live
      ? repoState(cfg, r, work.branch)
      : { repo: r.repo, dirty: 0, ahead: 0, behind: 0, pr: null, missing: !exists(r.path) })
    const verdict = workState(work, states)
    say(head)
    say(`  ${C.dim(`${phaseLabel(phaseOf(work, stopped ? null : verdict.repos))} · ${relativeAge(activityAt(work))}`)}`)
    if (work.title) say(`  ${work.title}`)
    if (work.tickets?.length) say(`  ${C.dim(work.tickets.join(', '))}`)
    if (stopped) {
      say(`  ${C.dim(`${work.repos.length} repo(s) · context kept at ${contextFile(id)}`)}`)
      say('')
      continue
    }
    if (!open) warn('  work folder is missing but the work is not closed')
    verdict.repos.forEach((v, i) => {
      const bits = []
      if (v.missing) bits.push(C.red('missing'))
      if (v.dirty) bits.push(C.yellow(`${v.dirty} dirty`))
      if (v.ahead) bits.push(`${v.ahead} ahead`)
      if (v.behind) bits.push(C.dim(`${v.behind} behind`))
      if (v.distanceUnknown) bits.push(C.dim('commits unknown'))
      if (v.prUnknown) bits.push(C.yellow('PR state unknown'))
      else if (v.pr) bits.push(v.merged ? C.green(`PR #${v.pr.number} merged`) : `PR #${v.pr.number} ${v.pr.state.toLowerCase()}`)
      // Only when the PR landed somewhere other than the record: a listing of every work
      // cannot afford `base main` on every line, and `PR state unknown` above already
      // says when the base was not confirmed either.
      if (baseMoved(states[i])) bits.push(C.yellow(`base ${baseLabel(states[i])}`))
      say(`  ${v.repo.padEnd(34)} ${bits.join(' · ') || C.dim('clean')}`)
    })
    // `close` asks the stack whether a slice is still up for review; `list` does not, because
    // reading it is a git pass and a GitHub call per stage per work, which is not what a
    // listing is (decision 77). So on a work that has stages the verdict says what it
    // measured and no more — the same rule `--quick` and `prUnknown` already follow. The
    // record alone answers this, so a work with no stages costs nothing and reads unchanged.
    const unchecked = work.stages.length ? ' (stages not checked)' : ''
    if (live && verdict.done) {
      // The qualifier is dim outside the green: its job is to take the edge off the verdict,
      // and the colour the verdict is printed in is half of that edge.
      say(`  ${C.green('→ all PRs merged, nothing uncommitted — safe to `rig close`')}${unchecked ? C.dim(unchecked) : ''}`)
    } else if (live && verdict.safeToClose && verdict.repos.length) {
      // The disagreement #2 was filed for: `list` used to stay silent here while `close`
      // would have closed the work without a murmur. Said plainly instead, and not as a
      // recommendation — nothing landed, so this is not finished work.
      say(`  ${C.dim(`→ nothing outstanding, but nothing merged either — \`rig close\` would not refuse${unchecked}`)}`)
    }
    say('')
  }
}

// `--since 14d` or `--since 2026-09-01`. A window nobody can parse is worth dying over: a
// dashboard that quietly showed everything when you asked for a fortnight would be read as
// a fortnight.
function sinceFlag (value) {
  if (!value || value === true) return null
  const days = /^(\d+)d$/.exec(String(value))
  if (days) return new Date(Date.now() - Number(days[1]) * 86400000).toISOString()
  // A full date, and only a full date. `new Date` reads "7" as the year 2001 and "2026-9" as
  // September, so trusting it turns `--since 7` — the obvious slip for `7d` — into a window
  // that shows everything to someone who asked for a week.
  const at = /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(String(value)) ? new Date(value) : new Date(NaN)
  if (Number.isNaN(+at)) die(`--since wants a number of days like 14d, or a date like 2026-09-01 — not "${value}"`)
  return at.toISOString()
}

const OPENERS = { win32: ['cmd', ['/c', 'start', '']], darwin: ['open', []] }

cmds.dash = ({ flags }) => {
  sayCurrentRoot()
  const from = typeof flags.from === 'string' ? flags.from : null
  const opts = { org: typeof flags.org === 'string' ? flags.org : null, since: sinceFlag(flags.since) }
  // `--from` renders a payload captured earlier (`rig list --json > x.json`). The live path
  // is one GitHub round trip per repo whose PR is not yet recorded; iterating on the page must
  // not cost that every time. A capture interrupted halfway is a likely input, and deserves
  // its filename back rather than a JSON parser's stack trace.
  //
  // `--quick` means the same here as it does for `list`: look nothing up. Since the terminal
  // facts are recorded (decision 60) that still renders every closed work in full, with no
  // GitHub call — which is the form to use in front of other people, and the one that works
  // with no network.
  let payload
  if (!from) payload = listPayload(config(), !flags.quick)
  else if (!exists(from)) die(`no such payload file: ${from}`)
  else try { payload = readJson(from) } catch (e) { die(`${from} is not a rig payload: ${e.message}`) }

  // A directory of rig's own under the temp root, so the filename can stay stable — a
  // browser tab reloads onto the new page — without writing to a name anyone else could have
  // got there first. Never the data root: this is a rendering of a moment, not knowledge.
  const dir = path.join(os.tmpdir(), 'rig-dash')
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, 'dash.html')
  writeText(out, renderDash(payload, opts))
  ok(`dashboard at ${out}`)
  if (flags['no-open']) return

  const [cmd, args] = OPENERS[process.platform] || ['xdg-open', []]
  // Opening it is a convenience; the path above is the deliverable. A machine with no opener
  // on PATH must not turn a rendered page into a failed command.
  const r = onPath(cmd) ? exec(cmd, [...args, out]) : { code: 1, err: `${cmd} is not on PATH` }
  if (r.code !== 0) warn(`could not open a browser (${(r.err || '').trim() || cmd}) — open the file above`)
}

// The demo page, rendered from whichever data root is in hand. Unlike `dash` — which renders
// live PR state and so writes to the temp root, being a picture of a moment — everything this
// reads is durable: the catalogue, and the closed records whose facts are terminal. That is
// what makes it a thing a data root can hold rather than a rendering that would be a lie by
// the afternoon, and why the default output is `demo/index.html` inside the root itself.
//
// It is still a generated file, and rule 2 covers generated files: never edit one. `rig demo`
// is the only writer of that path.
cmds.demo = ({ flags }) => {
  sayCurrentRoot()
  const root = dataRoot()
  const works = listWorkIds(root).map(id => readJson(recordFile(id, root)))
  const catalog = loadCatalog(root)
  if (!catalog.length) die(`no catalogue in ${root} — there is nothing to show. \`rig attach\` drafts an entry the first time it sees a repo.`)

  const model = demoModel({
    catalog,
    works,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z',
    root: where().name,
    example: typeof flags.example === 'string' ? flags.example : null,
  })

  // `--out` is for a render you want somewhere else — a scratch path, a USB stick, a machine
  // you are presenting from. The default keeps it beside the knowledge it was made from, and
  // the data root's own commit sweeps it up like anything else.
  const out = typeof flags.out === 'string' ? path.resolve(flags.out) : path.join(root, 'demo', 'index.html')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  writeText(out, renderDemo(model))
  ok(`demo at ${out}`)
  say(C.dim(`  ${model.counts.repos} repos · ${model.counts.edges} relationships · ${model.steps.length} steps` +
    `${model.example ? ` · walking through ${model.example.id}` : ''}`))
  if (insideDir(out, root)) commitAs('', path.relative(root, out).replace(/\\/g, '/'))

  if (flags['no-open']) return
  const [cmd, args] = OPENERS[process.platform] || ['xdg-open', []]
  const r = onPath(cmd) ? exec(cmd, [...args, out]) : { code: 1, err: `${cmd} is not on PATH` }
  if (r.code !== 0) warn(`could not open a browser (${(r.err || '').trim() || cmd}) — open the file above`)
}

cmds.status = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  // The same verdict `list` and `close` read, printed as facts rather than acted on: a
  // distance git could not measure says so, instead of a confident `0 ahead · 0 behind`,
  // and a PR read back from the record (decision 60) reads as the merged PR it is.
  // The states are kept rather than passed straight in: the verdict is about whether the
  // work is finished (`bin/workstate.mjs`), and a base is never a blocker, so where the
  // branch lands is read off the state beside it.
  const states = work.repos.map(r => repoState(cfg, r, work.branch))
  const verdict = workState(work, states)
  say(`${C.bold(work.id)} — ${work.title || ''}`)
  say(`branch ${work.branch}`)
  // Gathered above rather than below, because this is the one command that looks the PRs up
  // anyway: `rig status` is where `reviewing` and `landing` can be said out loud.
  say(`phase ${phaseLabel(phaseOf(work, verdict.repos))}`)
  for (const { gate, at } of gatesOf(work)) say(`  ${gate} ${at.slice(0, 10)}`)
  // Named, not enumerated: `rig stage` is where the stack is read, and a status that
  // reprinted it would be two places to keep saying the same thing.
  if (work.stages.length) say(`stages ${work.stages.length} — \`rig stage\` for the stack`)
  say(`tickets ${ticketsLabel(work)}`)
  say(`context ${contextFile(id)}`)
  say('')
  work.repos.forEach((r, i) => {
    const v = verdict.repos[i]
    say(`${C.bold(r.repo)} ${C.dim(`(${r.org}, base ${baseLabel(states[i])})`)}`)
    say(`  path    ${r.path}${v.missing ? C.red('  MISSING') : ''}`)
    if (!v.missing) {
      say(`  changes ${v.dirty || 'none'}`)
      say(`  commits ${v.distanceUnknown ? `unknown (${v.distanceUnknown})` : `${v.ahead} ahead · ${v.behind} behind`}`)
    }
    say(`  pr      ${v.pr ? `#${v.pr.number} ${v.pr.state} ${v.pr.url}${v.pr.recorded ? C.dim(' (recorded)') : ''}` : v.prUnknown ? `unknown — ${v.prUnknown}` : 'none'}`)
    say('')
  })
  // The contradictions that need a lookup fire here, because this is the command that has
  // already paid for one. `doctor` asks the records alone and runs over every work, so a PR
  // call per repo per work would make it too slow to be the command you reach for when
  // something is already broken.
  for (const message of contradictions(work, verdict.repos)) {
    warn(`${message} — this should not be possible; please file an issue at ${ISSUES_URL}`)
  }
}

// The catalogue's commands for one repo, in that repo's worktree. `label` is the
// frontmatter key they came from, so a failure names the thing that failed.
function runCatalogCommands (dir, commands, label) {
  for (const c of commands) {
    step(`${c}  ${C.dim(`(in ${path.basename(dir)})`)}`)
    // `inherit` and not a pipe, because a catalogue command is `npm install` or a test run
    // and watching it is the point — which is also why a run this is part of has to be the
    // process for its output to reach whoever asked. The environment is still the run's.
    const r = spawnSync(c, { cwd: dir, shell: true, stdio: 'inherit', env: env() })
    if (r.status !== 0) { warn(`${label} command failed: ${c}`); return false }
  }
  return true
}

cmds.setup = ({ flags, positional }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const targets = positional.length
    ? work.repos.filter(r => positional.some(p => p.toLowerCase() === r.repo.toLowerCase()))
    : work.repos
  if (!targets.length) die('no matching attached repos')
  for (const r of targets) {
    const cat = findCatalog(r.repo)
    if (!cat?.setup?.length) { warn(`${r.repo}: no setup commands in the catalogue`); continue }
    runCatalogCommands(r.path, cat.setup, 'setup')
  }
}

// What verifies a repo — its test run, its lint, its build — printed rather than run,
// which is decision 31's rule for `setup` holding for the same reason: a check in a
// worktree nothing has set up yet fails for a reason that is not the code's, and a test
// suite nobody asked for is slow at exactly the wrong moment. `--run` opts in.
//
// A repo with an empty `check` is told where to write one: the moment you went looking is
// the moment that knowledge is cheap (AGENTS.md rule 4). Nothing about a run is recorded
// anywhere — the catalogue holds the command, never a verdict (decision 3), so the only
// place a failure lands is `--run`'s exit code, where the caller that asked can read it.
cmds.check = ({ flags, positional }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  // Repo selection reads like `setup`'s twice over on purpose: two are a coincidence, and
  // the third is when it earns a name of its own.
  const targets = positional.length
    ? work.repos.filter(r => positional.some(p => p.toLowerCase() === r.repo.toLowerCase()))
    : work.repos
  if (!targets.length) die('no matching attached repos')
  for (const r of targets) {
    const cat = findCatalog(r.repo)
    if (!cat?.check?.length) {
      warn(`${r.repo}: no check commands in the catalogue — add \`check:\` to ${catalogFile(r.org, r.repo)}`)
      continue
    }
    if (flags.run) {
      if (!runCatalogCommands(r.path, cat.check, 'check')) current.exitCode = 1
      continue
    }
    say(`${C.bold(r.repo)} ${C.dim(`(not run — \`rig check ${r.repo} --run\`)`)}`)
    for (const c of cat.check) say(`  ${c}`)
  }
}

// Catalogue only, exactly as decision 27 has it for the interview: no code is read, so the
// offer is visibly only as good as the catalogue, and a thin one produces a thin offer rather
// than a confident wrong answer. The traversal itself is `unattached` in bin/catalog-graph.mjs.
function unattachedNeighbours (work) {
  const catalog = loadCatalog()
  return catalog.length ? unattached(catalog, (work.repos || []).map(r => r.repo)) : []
}

// The "what now" answer. Read-only, and a command you run — never a hook, and never fired
// off the back of another command (decision 66). The gathering lives here; every decision
// about what is worth offering is `bin/next.mjs`'s.
cmds.next = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const states = work.repos.map(r => repoState(cfg, r, work.branch))
  // The stack costs one PR lookup per branch, and `rig next` is a command you ran on purpose
  // — the one place that can afford to know where you are in it. Read once and shared by
  // everything below that needs it, `workState` included: `close` refuses over an open slice,
  // so a verdict here that did not ask would disagree with the command it is describing.
  const stack = work.stages.length ? stackOf(work, branchRows(cfg, work)) : []
  const verdict = workState(work, states, { stages: stack })
  // `workState` answers the verdict half and the worktree state answers `pushed`; joined
  // here rather than in either, because "is this branch on the remote" is not a question
  // about whether the work is finished.
  const repos = verdict.repos.map((v, i) => ({ ...v, pushed: !!states[i].pushed }))

  const doc = exists(contextFile(work.id)) ? readText(contextFile(work.id)) : ''
  const offers = nextFor({
    work,
    repos,
    // The scaffolded stub, still standing where the design should be.
    directionTodo: directionIsTodo(doc),
    planExists: exists(planFile(work.id)),
    planStale: exists(planFile(work.id)) && planIsStale(readText(planFile(work.id)), stack),
    stack,
    // Only this work's repos, not the whole catalogue: `doctor` reports every draft in the
    // root, and the question here is what is available on the work in hand.
    drafts: draftEntries(work),
    neighbours: unattachedNeighbours(work),
  })

  const phase = phaseOf(work, repos)
  say(`${C.bold(work.id)} ${C.dim(`— ${phaseLabel(phase)}`)}`)
  if (!offers.length) {
    // Asked of the phase, not of `closedAt`: an abandoned work carries `closedAt` too — the
    // teardown did run — so reading that field alone told a work that was stopped unfinished
    // that it was done, which is a lie about the one thing `--abandoned` exists to record.
    say(C.dim(phase === 'abandoned' ? '  nothing — this work was abandoned'
      : phase === 'closed' ? '  nothing — this work is done'
        : '  nothing to suggest'))
    return
  }
  say('')
  for (const o of offers) {
    say(`  ${C.cyan('→')} ${o.says}`)
    if (o.command) say(`    ${C.dim(o.command)}`)
  }
}

// The Direction section of a context doc, sliced out by hand rather than by one clever
// expression. The clever one was wrong: `(?=^## |\Z)` reads as "the next heading, or the end
// of the input" and `\Z` is not an end-of-input assertion in JavaScript — it is a literal `Z`.
// So a Direction section that happened to be the last one matched nothing at all, and any
// Direction containing a capital Z was silently truncated there. Measured against the real
// data root when this was found: two of forty-six context docs truncated, one of them losing
// 6,300 of 17,500 characters at the word `listHostedZones`.
//
// Finding the heading and then finding the next one is duller and cannot be wrong in that way.
function directionSection (text) {
  const heading = /^## Direction[^\n]*\n/m.exec(text || '')
  if (!heading) return ''
  const rest = text.slice(heading.index + heading[0].length)
  const next = /^## /m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}

// What the section actually says: its prose with the template's guidance comments stripped.
// Both readers below go through this, so neither can disagree with the other about whether a
// section that is only a comment and a stub counts as written.
const directionSaid = text => directionSection(text).replace(/^\s*<!--[\s\S]*?-->\s*$/gm, '').trim()

// Is the design still the scaffolded stub? Asked of the section rather than of the whole
// document: the old test was `/^## Direction$[\s\S]*?^_TODO_$/m`, which finds a `_TODO_`
// *anywhere* below the heading, so an agreed Direction with an unfinished checklist three
// sections later read as undesigned.
const directionIsTodo = text => directionSaid(text) === '_TODO_'

// Empty for the stub, which says nothing — and an empty section in a PR body is worse than no
// section at all.
const directionBody = text => (directionIsTodo(text) ? '' : directionSaid(text))

// Lifted verbatim into a PR body rather than summarised: a summary is a second copy that starts
// drifting the moment either is edited, and the reviewer wants the reasoning that was actually
// agreed, not rig's paraphrase of it.
const directionProse = id => (exists(contextFile(id)) ? directionBody(readText(contextFile(id))) : '')

// The PR body rig writes: what the work is, the ticket, what was decided, and what landed in
// which order. Everything in it is already recorded somewhere — the point is that it is
// assembled rather than retyped, and that the stage table is rendered from the stack rather
// than hand-maintained, which is the whole complaint against the rollout plan.
function prBody (work, stack) {
  const lines = []
  if (work.title) lines.push(work.title, '')
  if (work.tickets?.length) lines.push(`Tickets: ${work.tickets.join(', ')}`, '')

  const direction = directionProse(work.id)
  if (direction) lines.push('## Direction', '', direction, '')

  // The same renderer the rollout plan uses. Two generators would be two tables that disagree,
  // and a table that disagrees with itself is how this document got its reputation.
  if (stack.length) lines.push('## Stages', '', stageTable(stack), '')

  lines.push(`Context doc: ${contextDocRef(work.id)}`)
  return lines.join('\n')
}

// One PR per repo, work branch → base branch. rig has read PR state everywhere since it
// existed — `list`, `status`, `close`, `dash`, `workstate` — and had never opened one, which
// made review the phase it was most obviously absent from. The PR is also the one artifact rig
// is best placed to write, because it already holds everything the body needs.
//
// **Not a gate.** A command you run when the stages are in, consistent with the epic's
// principle that rig never adds a stop. And idempotent like everything else: a repo that
// already has an open PR is reported, not duplicated — "already open" is a thing to say, not
// an error to raise.
cmds.pr = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  if (!work.repos.length) die(`${work.id} has no repos attached — there is nothing to open a PR on`)
  if (work.closedAt) die(`${work.id} is ${work.abandonedAt ? 'abandoned' : 'closed'}`)

  const stack = work.stages.length ? stackOf(work, branchRows(cfg, work)) : []
  const body = prBody(work, stack)
  const title = work.title || work.id

  for (const entry of work.repos) {
    const state = repoState(cfg, entry, work.branch)
    if (state.prError) { warn(`${entry.repo}: GitHub would not say whether a PR exists (${state.prError}) — not opening one`); continue }
    if (state.pr && state.pr.state === 'OPEN') { step(`${entry.repo}: PR #${state.pr.number} is already open — ${state.pr.url}`); continue }
    if (state.pr && state.pr.state === 'MERGED') { step(`${entry.repo}: PR #${state.pr.number} already merged`); continue }
    if (!state.pushed) { warn(`${entry.repo}: ${work.branch} is not on the remote yet — push it first`); continue }

    // The base is the one this repo's work branch was cut from. A stage's PR is not rig's to
    // open: a stage is reviewed on its own, in the repo it touches, and rig would have to
    // guess which of the stack you meant.
    const base = workBranch(entry, work)?.base || entry.base
    let made = null
    const failed = trackerFailure(() => { made = github().createPr(entry.org, entry.repo, { branch: work.branch, base, title, body }) })
    if (failed) { warn(`${entry.repo}: could not open a PR (${failed})`); continue }
    ok(`${entry.repo}: PR #${made.number} → ${base}  ${C.dim(made.url)}`)
  }
}

// Every branch of this work that every repo carries, flat: one `{ repo, branch, base, pr }`
// row each. The base is read live (decision 63) because the base is what says where a stage
// sits in the stack — a recorded base is right once, and wrong the moment anything is rebased.
//
// Two sources, and neither is a copy of the other. **The record** answers for the work branch,
// whose base is the remote HEAD it was cut from, and for a merged pull request's terminal
// facts. **git** answers for the stages: whether the branch is there at all and what it sits
// on. Before this, only the record was read, and since nothing ever wrote a stage into it, no
// declared stage could be placed in the chain — which is hugoforte/rig#78.
//
// Nothing discovered is written back. A stage's place in the stack is a question the commits
// answer, and a recorded answer is a second one that disagrees the first time a branch moves.
function branchRows (cfg, work) {
  const rows = []
  const declared = (work.stages || []).map(s => s.branch)
  for (const entry of work.repos) {
    const base = workBranch(entry, work)?.base || entry.base
    const found = trees(cfg).chain({ org: entry.org, repo: entry.repo, branch: work.branch, base, stages: declared })
    const known = new Map(found.map(f => [f.branch, f]))
    // The record laid over what git found: a recorded base wins where there is one, because
    // the only branch that has one is the work branch and git cannot name a remote HEAD.
    for (const b of entry.branches || []) {
      const prior = known.get(b.branch)
      known.set(b.branch, { ...prior, ...b, base: b.base ?? prior?.base ?? null })
    }
    // A slice that landed usually loses its branch, and until `rig close` records the merged
    // pull request the record has nothing either — so a stage that finished would read as one
    // nobody ever cut, which is the symptom this whole change exists to remove. GitHub is
    // asked for the branches git could not find, and only those: a repo carrying the branch
    // costs nothing extra, and a row survives only if a pull request answers for it.
    for (const b of declared) if (!known.has(b)) known.set(b, { branch: b, base: null, absent: true })
    for (const b of known.values()) {
      let pr = null
      const prError = trackerFailure(() => { pr = github().prForBranch(entry.org, entry.repo, b.branch) })
      const recorded = b.pr ? { ...b.pr, state: 'MERGED', recorded: true } : null
      if (b.absent && !pr && !recorded) continue
      rows.push({
        repo: entry.repo,
        branch: b.branch,
        // The live base wins when GitHub answered; git, then the record, is the fallback.
        base: (!prError && pr?.base) || b.base,
        pr: pr || recorded,
        prError: prError || null,
      })
    }
  }
  return rows
}

// The stages of a work: declare one, or read the stack back.
//
// Declaring records the intent and nothing else — the branch, which is the stage's identity
// and the join across repos, and one line of what it delivers. Everything else is derived:
// whether it has started, whether it is up for review, whether it landed, which repos carry
// it, and where it sits in the stack. All of that is already written in the branches and the
// PRs, and a second copy in the record is the hand-maintained table that killed v1 — the very
// one `templates/rollout-testing-plan.md` still opens with.
//
// **rig does not cut the branch.** A stage's branch is made where branches are made, by you,
// in the repos it touches. Declaring it here is what joins those branches into one slice
// across repos and gives it the one line of prose nothing else can supply.
cmds.stage = ({ flags, positional }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const branch = positional[0]

  if (branch) {
    // Declaring and cutting are two acts on two days: a stage is normally declared before
    // anyone makes its branch, which is why recording the branch at declaration time could
    // never be the whole answer. `--cut` is how the second act reaches a stage already
    // declared, and declaring and cutting at once is just both in one command.
    const declared = work.stages.find(s => s.branch === branch)
    const key = flags.key === true ? die('--key needs a ticket, PROJ-123 or owner/repo#7') : flags.key
    if (key && !isJiraKey(key) && !isGithubKey(key)) die(`"${key}" is neither PROJ-123 nor owner/repo#7`)
    if (!declared) {
      const problem = stageBranchProblem(work, branch)
      if (problem) die(problem)
      if (flags.delivers === true) die('--delivers needs a line saying what this stage delivers')
      work.stages.push({ branch, delivers: flags.delivers || '', ...(key ? { tickets: [key] } : {}) })
    } else if (!flags.cut && !key) {
      die(`${branch} is already a stage of this work`)
    } else if (key) {
      declared.tickets = declared.tickets || []
      if (!declared.tickets.includes(key)) declared.tickets.push(key)
    }
    const cut = flags.cut ? cutStageHere(cfg, work, branch) : null
    const stage = work.stages.find(s => s.branch === branch)
    commitAs(work.id, branch)
    saveWork(cfg, work)
    ok(`${work.id}: stage ${C.bold(branch)}${stage.delivers ? ` — ${stage.delivers}` : ''}`)
    if (stage.tickets?.length) say(`  ${C.dim(stage.tickets.join(', '))}`)
    if (cut) ok(`${cut.repo}: cut ${C.bold(branch)} on ${cut.base}`)
    if (!stage.delivers) {
      say(`  ${C.dim('nothing recorded about what it delivers — that one line is the only prose a stage carries')}`)
    }
    return
  }

  const stack = stackOf(work, branchRows(cfg, work))
  if (!stack.length) {
    say(`${C.bold(work.id)} ${C.dim('— no stages')}`)
    say(C.dim('  A work with no stages is one branch per repo, which is how every work starts.'))
    say(C.dim('  Declare one with `rig stage <branch> --delivers "..."` when a work wants slicing up.'))
    return
  }

  say(`${C.bold(work.id)} ${C.dim(`— ${stack.length} stage(s), in the order the branches are stacked`)}`)
  say('')
  const upNext = nextStage(stack)
  for (const [i, st] of stack.entries()) {
    const mark = st.landed ? C.green('✓') : st.open ? C.cyan('·') : st.started ? C.dim('·') : C.dim('○')
    say(`  ${mark} ${i + 1}. ${C.bold(st.branch)}${st === upNext ? C.dim('  ← next') : ''}`)
    if (st.delivers) say(`       ${st.delivers}`)
    if (st.tickets.length) say(`       ${C.dim(st.tickets.join(', '))}`)
    say(`       ${C.dim(st.started ? st.repos.join(', ') : 'not cut in any repo yet')}`)
    for (const pr of st.prs) {
      say(`       ${C.dim(`${pr.repo}: PR #${pr.number} ${pr.state.toLowerCase()} ${pr.url}`)}`)
    }
    // Said out loud rather than left to read as "no PR": the two look identical otherwise,
    // and only one of them means there is nothing to review.
    if (st.prUnknown) say(`       ${C.yellow(`PR state unknown in ${st.prUnknown.join(', ')}`)}`)
  }
  // The header above says the list is in the order the branches are stacked. Where the branches
  // contradict that — a stage sitting on something this stack does not contain — it is said out
  // loud: a numbered list reads as evidence whether or not it is, and the reader has no other
  // way to tell.
  const adrift = adriftNote(stack)
  if (adrift) {
    say('')
    say(`  ${C.yellow(adrift)}`)
  }
}

// `--cut`: make the stage's branch here, on top of whatever this repo's stack reaches.
//
// **Which repo is never asked for.** It is the worktree the command runs in — the same
// convention every rig command already uses to resolve the work itself. A repo list typed at
// declaration time would be a prediction of a stage's scope, and the repos a stage touches
// are *derived* from where its branch is found, so a branch cut on a guess is
// indistinguishable from one cut on purpose. Over-cutting corrupts the derived answer;
// under-cutting costs nothing, because you cut it yourself later and discovery finds it.
//
// The base is this repo's own top of stack, which is the whole reason rig is worth having cut
// it: at the moment of the cut the base is not in doubt, and it never needs recording.
function cutStageHere (cfg, work, branch) {
  const here = cwd()
  const entry = work.repos.find(r => sameDir(r.path, here) || insideDir(here, r.path))
  if (!entry) {
    const names = work.repos.map(r => r.repo).join(', ') || 'none attached yet'
    die(`--cut makes the branch in one repo: run it inside one of ${work.id}'s worktrees (${names})`)
  }
  const carried = stackOf(work, branchRows(cfg, work))
    .filter(st => st.branch !== branch && st.repos.includes(entry.repo))
  const base = carried.length ? carried[carried.length - 1].branch : work.branch
  const failed = trees(cfg).cutHere({ dir: entry.path, branch, base })
  if (failed) die(`${entry.repo}: could not cut ${branch} on ${base} — ${failed}`)
  return { repo: entry.repo, base }
}

// The rollout plan, part generated and part prose.
//
// It used to be entirely prose that nothing read back — `rig plan` wrote the file and
// `regenerate` checked only that it *existed*, to add one pointer line. Its first table was a
// hand-maintained list of stages, which is the concept #62 now models properly and the exact
// shape decision 3 forbids.
//
// So the table is rig's, between markers, rewritten whole from the stack. Everything around it
// is yours, and it is the part that earns the document: *why* the order is mandatory, the
// rejection window between deploys, the per-tenant configuration prerequisites, the
// verification queries, the rollback. Those are judgements nothing can derive.
//
// The standard the whole epic uses to decide whether an artifact deserves to exist is
// **something has to read it back**. `--refresh` is that: it re-renders the region in place,
// and `rig next` offers it when the rendered table and the live stack disagree.
cmds.plan = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  const stack = work.stages.length ? stackOf(work, branchRows(cfg, work)) : []

  if (flags.refresh) {
    if (!exists(planFile(id))) die(`${planFile(id)} does not exist — \`rig plan\` writes it first`)
    const before = readText(planFile(id))
    const after = refreshedPlan(before, stack)
    if (after === null) {
      die(`${planFile(id)} has no \`rig:deploy-order\` region to refresh — it was written before the table was generated, or the markers were removed. Paste them back around the table, or rewrite the file with \`rig plan --force\`.`)
    }
    if (after === before) return ok(`${planFile(id)} is already up to date with the stack`)
    writeText(planFile(id), after)
    commitAs(id)
    saveWork(cfg, work)
    return ok(`refreshed the deploy order in ${planFile(id)}`)
  }

  if (exists(planFile(id)) && !flags.force) die(`${planFile(id)} already exists — \`rig plan --refresh\` brings its deploy order up to date`)
  const tpl = readText(path.join(toolRoot(), 'templates', 'rollout-testing-plan.md'))
  writeText(planFile(id), tpl
    .replace(/\{\{ID\}\}/g, id)
    .replace(/\{\{TITLE\}\}/g, work.title || id)
    .replace(/\{\{KEYS\}\}/g, work.tickets.join(', ') || id)
    .replace(/\{\{DEPLOY_ORDER\}\}/g, renderPlanRegion(stack))
    .replace(/\{\{DATE\}\}/g, new Date().toISOString().slice(0, 10)))
  commitAs(id)
  saveWork(cfg, work)   // the generated AGENTS.md gains its "Rollout plan" line
  ok(`created ${planFile(id)}`)
}

cmds.close = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  // What counts as unfinished business is `workState`'s to decide (decision 62); `close`
  // reads the list and refuses on it. Chiefly: a merged PR settles its branch, so the
  // commits a squash merge left looking unpushed no longer demand `--force` (#52).
  const states = work.repos.map(r => repoState(cfg, r, work.branch))
  // The stack, which `close` is the one caller that needs: a slice still up for review is
  // unfinished business, and the work branch's own PR cannot say so.
  const stack = work.stages.length ? stackOf(work, branchRows(cfg, work)) : []
  const verdict = workState(work, states, { stages: stack })
  // Abandoning is the decision to stop a work without finishing it, so every blocker that
  // asks "did it land?" is asking the wrong question — an unmerged PR and unpushed commits
  // are what being abandoned *looks like*, not a reason to refuse. `dirty` survives, because
  // unsaved work in a tree is the one thing this command can destroy whatever it is called.
  const abandoned = !!flags.abandoned
  const blockers = abandoned ? verdict.blockers.filter(b => b.kind === 'dirty') : verdict.blockers
  if (blockers.length && !flags.force) {
    warn(`not ${abandoned ? 'abandoning' : 'closing'} — unfinished business:`)
    for (const b of blockers) say(`    ${C.red('•')} ${b.message}`)
    say('')
    say(C.dim('Resolve these, or pass --force if you genuinely want to discard them.'))
    current.exitCode = 1
    return
  }
  // Forcing past the blockers is a decision, and decision 64's rule is that a decision no
  // lookup can recover afterwards is the one thing worth storing. Without it, a work closed
  // over an open pull request is indistinguishable from a rig bug — which is exactly what
  // `contradictions` used to call it. A `--force` that had nothing to get past is not a
  // decision and is not recorded.
  if (flags.force && blockers.length) work.forcedAt = new Date().toISOString()
  // Every PR left is terminal by now — blockers above already refused an open one — so this
  // is the one moment to record it, before the worktree the branch fallback would read from
  // is removed below. A record for a different PR number is re-taken: the branch carried a
  // second PR after the first was recorded, and the newest is the one that finished the work.
  // An abandoned work can still have landed a slice or two; `merged` below is what decides,
  // so those terminal facts are recorded here exactly as they would be for any other close.
  work.repos.forEach((r, i) => {
    const s = states[i]
    const onWorkBranch = ensureBranchRecord(r, work.branch, r.base)
    if (!verdict.repos[i].merged || !s.pr || onWorkBranch.pr?.number === s.pr.number) return
    const { record, error } = terminalPr(r, s.pr)
    if (record) onWorkBranch.pr = record
    // Said out loud: a close that could not record looks identical to one that did, and the
    // work is about to lose the worktree its first commit could have been read from.
    else warn(`${error} — not recorded; \`rig backfill --work ${id}\` once GitHub answers again`)
  })
  // Out of the work folder before anything in it is removed. Windows refuses to remove a
  // directory that is some process's cwd — including ours. Everywhere else git removes it
  // regardless, and a run handed its cwd rather than inheriting it would then start every later
  // subprocess in a directory that is not there, which Node refuses to do.
  const wd = workDir(cfg, id)
  if (standingIn(wd)) chdir(toolRoot())
  for (const r of work.repos) {
    if (!exists(r.path)) continue
    const failed = trees(cfg).remove({ org: r.org, repo: r.repo, dir: r.path, force: !!flags.force })
    if (failed) warn(`${r.repo}: ${failed}`)
    else step(`removed worktree ${r.repo}`)
  }
  commitAs(id)
  if (exists(wd)) {
    try {
      fs.rmSync(wd, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
    } catch (e) {
      warn(`worktrees removed, but ${wd} could not be deleted: ${e.code || e.message}`)
      warn('something still has it open (a shell, an editor). Delete it by hand.')
    }
  }
  // Two dates, two facts: `closedAt` is when the teardown ran, and `abandonedAt` is the
  // decision that it ended unfinished. `phaseOf` reports the more specific one.
  work.closedAt = new Date().toISOString()
  if (abandoned) work.abandonedAt = work.closedAt
  saveWork(cfg, work)   // regenerates only if the folder outlived the delete, so it reads as stopped
  ticketWriteBack(work, states, { abandoned, stages: stack })
  ok(`${abandoned ? 'abandoned' : 'closed'} ${id} — context doc kept at ${contextFile(id)}`)
  // The last call. `rig next` is where the correction is offered, because it runs while the
  // worktrees are still on disk and this command has just removed them: no rig command waits for
  // a human, so close could never have collected the answer whatever order it did things in. So
  // this names the entries and stops — the catalogue outlives the work, and an entry nobody
  // corrected is worth knowing about even once the cheap moment has passed.
  //
  // `--work` is in the command because the work folder is gone by now, and `rig save` resolves
  // the work from the folder it is run in. Printing the bare command would hand over one that
  // dies with "not inside a work".
  const stillDraft = draftEntries(work)
  if (stillDraft.length) {
    say(C.dim(`  catalogue still a draft for ${stillDraft.join(', ')} — correct ${stillDraft.length > 1 ? 'them' : 'it'} and \`rig save --work ${id} -m "catalogue corrections"\``))
  }
  if (abandoned) {
    const open = verdict.repos.filter(v => v.pr && v.pr.state === 'OPEN')
    // Named rather than closed: closing someone's pull request is an outward-facing act, and
    // an abandoned work is exactly the case where someone else may still want what is on it.
    for (const v of open) say(`  ${C.dim(`${v.repo}: PR #${v.pr.number} left open — ${v.pr.url}`)}`)
  }
}

// Fills `repos[].pr` for merged PRs `close` never got the chance to record — a work closed
// before the field existed, or one closed with `--force` past a lookup that failed at the
// time. Its own command, not folded into `close` or `update`, because it is explicit,
// resumable, and the one place that pays the cost of the lookups `repoEntryJson` is written
// to never pay again (context.md, "rig backfill").
//
// Idempotent by construction: an entry already carrying `pr` is skipped, so a second run
// finds nothing to do and says so — `--force` is the only way to re-ask. No negative
// caching: an entry GitHub would not answer for is reported and left unstored, because a
// rate limit is transient and a record saying "unknown forever" is worse than a retry.
cmds.backfill = ({ flags }) => {
  const cfg = config()
  const ids = flags.work ? [flags.work] : listWorkIds()
  let filled = 0
  let touchedWorks = 0
  const unresolved = []
  for (const id of ids) {
    const work = loadWork(cfg, id)
    // Only a closed work is finished. A branch that is still open can carry a second PR
    // (`bin/github.mjs` answers with the newest), and a record is what stops rig looking —
    // so recording the first merge of a work still in progress would freeze the wrong one.
    if (!work.closedAt) continue
    let changed = false
    for (const entry of work.repos) {
      // Every branch of the work this repo carries, not just the work's own: a stage is
      // reviewed on its own and its merge is as terminal as any other.
      for (const b of entry.branches) {
        const already = !!b.pr
        if (already && !flags.force) continue
        let pr = null
        const prError = trackerFailure(() => { pr = github().prForBranch(entry.org, entry.repo, b.branch) })
        if (prError) { unresolved.push(`${id}/${entry.repo} ${b.branch}: ${prError}`); continue }
        if (!pr || pr.state !== 'MERGED') continue   // not terminal — nothing to store, nothing to report
        const { record, error } = terminalPr(entry, pr)
        if (error) { unresolved.push(`${id}/${entry.repo} ${b.branch}: ${error}`); continue }
        b.pr = record
        changed = true
        filled++
        step(`${id}/${entry.repo} ${b.branch}: ${already ? 'refreshed' : 'recorded'} PR #${pr.number}`)
      }
    }
    // Registered as soon as something is on disk, not at the end: a run interrupted after
    // this work still has its records committed under their own message (decision 42).
    if (changed) { touchedWorks++; saveWork(cfg, work); commitAs('', `${filled} PR record(s) so far`) }
  }
  if (filled) {
    commitAs(flags.work || '', `${filled} PR record(s) across ${touchedWorks} work(s)`)
    ok(`backfilled ${filled} PR record(s) across ${touchedWorks} work(s)`)
  } else {
    say('nothing to backfill — every merged PR already has a stored record')
  }
  if (unresolved.length) {
    warn(`GitHub would not answer for ${unresolved.length}, left unstored (retry later):`)
    for (const u of unresolved) say(`    ${C.red('•')} ${u}`)
  }
}

cmds.catalog = ({ flags, positional }) => {
  sayCurrentRoot()
  const entries = loadCatalog().sort((a, b) => a.repo.localeCompare(b.repo))
  if (positional[0]) {
    const e = entries.find(x => x.repo.toLowerCase() === positional[0].toLowerCase())
    if (!e) die(`no catalogue entry for "${positional[0]}"`)
    // The entry to stdout and the path to stderr, so a pipe still gets the entry alone. rig has
    // no edit mode and should not grow one, so naming the file is the whole affordance — the
    // same thing `rig attach` does when it drafts one, and what `rig next` points at when it
    // offers the correction.
    out(readText(e.file))
    return aside(C.dim(e.file))
  }
  if (!entries.length) return say('catalogue is empty — entries are drafted on `rig attach`')
  for (const e of entries) {
    const flag = e.draft ? C.yellow(' [draft]') : ''
    say(`${e.repo.padEnd(34)} ${C.dim(e.org.padEnd(15))} ${e.role}${flag}`)
    if (flags.verbose && e.talks_to.length) {
      for (const t of e.talks_to) say(`  ${C.dim('→')} ${t.repo}: ${t.how || ''}${t.direction ? C.dim(` [${t.direction}]`) : ''}`)
    }
  }
}

// What else a change in this repo reaches. DESIGN.md §6 already made this traversal a rule —
// "for every selected repo, check its neighbours and say why each is or isn't in scope" — and
// left the agent to carry it out against a graph rig could have computed. This is that rule
// with a command behind it, which is also what makes correcting an entry change an outcome:
// until something reads `talks_to` back, rule 4 asks for a correction and offers no reason.
//
// **Offers, never judges.** No verdict, no threshold, nothing attached for you — `rig list`'s
// rule, information and not automation. The one thing it will not stay quiet about is a
// contradiction: two entries that disagree about which way a relationship runs are reported as
// a disagreement, never resolved by picking a side.
cmds.impact = ({ positional }) => {
  sayCurrentRoot()
  const name = positional[0]
  if (!name) die('rig impact wants a repo — `rig catalog` lists them')
  const entries = loadCatalog()
  if (!entries.length) die('catalogue is empty — entries are drafted on `rig attach`')
  const { works, unreadable } = readRecords(dataRoot())
  const answer = impact(entries, name, { works })

  // Asked only about the repos in the answer, not the whole catalogue. The measure costs a git
  // spawn per entry that has a mirror, and a neighbourhood is a handful of repos where a
  // catalogue is hundreds; `doctor` pays the full price because it reports on all of them.
  const named = new Set([answer.repo, ...answer.hop1.map(n => n.repo), ...answer.hop2.map(n => n.repo)].map(r => r.toLowerCase()))
  const cfg = config()
  const age = new Map(catalogueFreshness(dataRoot(), entries.filter(e => named.has(e.repo.toLowerCase())), cfg.mirrorRoot, onPath('git'))
    .map(f => [f.repo.toLowerCase(), f]))

  // Everything a claim should be weighed against, in one dim parenthesis: no entry at all, an
  // entry nobody has corrected, or one the repo has moved on from — decision 93's count and
  // date, carrying no opinion about either.
  const caveat = n => {
    const bits = []
    if (!n.catalogued) bits.push('no catalogue entry')
    else if (n.draft) bits.push('draft entry')
    const f = age.get(n.repo.toLowerCase())
    if (f && f.commits > 0) bits.push(`entry ${f.commits} commit${f.commits === 1 ? '' : 's'} behind, since ${f.writtenAt}`)
    return bits.length ? ` ${C.dim(`(${bits.join('; ')})`)}` : ''
  }

  const LABEL = { downstream: 'downstream', upstream: 'upstream', both: 'both ways' }
  const label = n => (n.disagreed ? C.yellow('disagreed') : C.dim(LABEL[n.direction] || 'unstated'))
  const width = Math.max(12, ...[...answer.hop1, ...answer.hop2].map(n => n.repo.length))

  say(`${C.bold(answer.repo)}${answer.org ? ` ${C.dim(answer.org)}` : ''}${answer.role ? ` — ${answer.role}` : ''}${caveat(answer)}`)

  // No declared edge is not the end of the answer. Every freshly drafted entry has `talks_to: []`,
  // and that is exactly where the observed graph below has something to say — returning here
  // hid the evidence in the one case it was built for.
  say('')
  if (!answer.hop1.length) say(C.dim('nothing in the catalogue talks to it, and it talks to nothing — `talks_to` in its entry is where that is said'))
  else say(C.dim('one hop'))
  for (const n of answer.hop1) {
    say(`  ${n.repo.padEnd(width)}  ${label(n)}${caveat(n)}`)
    // Every end's own sentence, verbatim. The direction says which way it runs and the prose
    // says what it is; neither replaces the other, and a disagreement is only legible when both
    // claims can be read side by side.
    for (const said of n.says) {
      say(C.dim(`    ${said.from} → ${said.to}: ${said.how || '(nothing said)'}`) + (said.direction ? C.dim(` [${said.direction}]`) : ''))
    }
  }

  if (answer.hop2.length) {
    // No composed direction: two edges end to end are not a third edge, and the repo in the
    // middle may well absorb what the first one does. What is printed is the route, and the
    // direction of the far hop alone.
    say('')
    say(C.dim('two hops'))
    for (const n of answer.hop2) {
      const via = n.via.map(v => `${v.through}${v.disagreed ? ' (disagreed)' : v.direction ? ` (${LABEL[v.direction]} of it)` : ''}`).join(', ')
      say(`  ${n.repo.padEnd(width)}  ${C.dim(`via ${via}`)}${caveat(n)}`)
    }
  }

  // The observed graph, under the declared one and never merged into it. A pair the records
  // keep making with nothing in `talks_to` to explain it is the finding — evidence that an
  // entry is missing an edge, and it names which entry. A pair the catalogue already explains
  // is still printed, because the count is how strong the declared edge turned out to be.
  if (answer.observed.length) {
    say('')
    say(C.dim('worked on together'))
    for (const o of answer.observed) {
      const n = o.works.length
      const count = `${n} work${n === 1 ? '' : 's'}`
      say(`  ${o.repo.padEnd(width)}  ${C.dim(count)}${o.declared ? C.dim(' — and talks_to says why') : C.yellow(' — and nothing in talks_to says why')}`)
      say(C.dim(`    ${o.works.join(', ')}`))
    }
    const quiet = answer.observed.filter(o => !o.declared)
    if (quiet.length) {
      say('')
      say(C.dim(`${quiet.length === 1 ? 'that pair keeps' : 'those pairs keep'} happening and the catalogue does not say why — ${answer.catalogued
        ? `\`rig catalog ${answer.repo}\` names the file to correct`
        : `and ${answer.repo} has no catalogue entry — one is drafted the first time it is attached`}`))
    }
  }

  // Two different gaps, pointed at two different things. A draft has a file, and `rig catalog`
  // names it; a repo with no entry has none, and `rig catalog` dies on it — the entry is drafted
  // the first time the repo is attached, so that is the pointer.
  const drafts = answer.hop1.filter(n => n.catalogued && n.draft).map(n => n.repo)
  const unwritten = answer.hop1.filter(n => !n.catalogued).map(n => n.repo)
  if (drafts.length || unwritten.length) say('')
  if (drafts.length) {
    say(C.dim(drafts.length === 1
      ? `${drafts[0]} is still a draft — \`rig catalog ${drafts[0]}\` names the file`
      : `${drafts.join(', ')} are still drafts — \`rig catalog <repo>\` names each file`))
  }
  if (unwritten.length) {
    say(C.dim(unwritten.length === 1
      ? `${unwritten[0]} has no catalogue entry — one is drafted the first time it is attached`
      : `${unwritten.join(', ')} have no catalogue entry — one is drafted the first time each is attached`))
  }
  sayUnreadable(unreadable)
}

cmds.prompt = ({ positional }) => {
  const name = positional[0]
  const dir = path.join(toolRoot(), 'prompts')
  if (!name) {
    say('available prompts:')
    for (const f of fs.readdirSync(dir)) say(`  ${f.replace(/\.md$/, '')}`)
    return
  }
  const f = path.join(dir, `${name}.md`)
  if (!exists(f)) die(`no prompt "${name}" (see \`rig prompt\`)`)
  out(readText(f))
}

// Fast-forwards one of the two checkouts an installation is made of. Never merges and never
// rebases: a diverged tree is yours to sort out, and moving it silently is how a commit gets
// lost. A tree that cannot move is reported, not fatal — the other one still updates.
// `clean` is reported separately from `status`: a tree with nothing to update is not the
// same as a tree that is safe to commit into, and `rig update` migrates only when it is
// both. A local-only data root reaches 'current' without the question ever being asked.
// What to do about changes in the way, which is the one thing the two checkouts differ on:
// the data root is committed by rig, and the tool checkout is yours.
const how = (label, root) => label.startsWith('data root') ? ', run `rig save`' : ` — \`git -C ${root} status\` shows them`

function updateCheckout (label, root) {
  const state = co.describe(root)
  if (state.repo !== 'own') { say(`${C.dim('·')} ${C.dim(`${label}: ${root} is not a checkout of its own — nothing to update`)}`); return { status: 'current', clean: false } }
  if (!state.branch) { warn(`${label}: detached HEAD — not updated`); return { status: 'failed', clean: false } }
  // Two different questions about the same tree. `modified` is what stops a fast-forward.
  // `clean` is what `commitDataRoot` would sweep up, and that is `git add -A` — untracked
  // files included, so an unfinished note nobody staged makes the tree unsafe to migrate in.
  const clean = state.dirty === 0
  if (!state.upstream) { say(`${C.dim('·')} ${C.dim(`${label}: no upstream — nothing to update from`)}`); return { status: 'current', clean } }
  // Asked before the fetch, unlike `fastForward`'s own `blocked`: an update you ran is a
  // command that should say what is in the way rather than go quiet because there happened
  // to be nothing to bring down anyway.
  if (state.modified) {
    warn(`${label}: ${state.modified} uncommitted change(s) — not updated${how(label, root)}`)
    return { status: 'failed', clean }
  }
  const fetched = co.fetch(root)
  if (!fetched.ok) { warn(`${label}: could not fetch (${fetched.error}) — not updated`); return { status: 'failed', clean } }
  // Every outcome, named. The three that look impossible here — this checkout was read a
  // few lines ago — are reachable all the same: a fetch that prunes a renamed default
  // branch takes the upstream with it, and a catch-all would report that as a
  // fast-forward failure with no words in it and exit 1 on a checkout that is fine.
  const moved = co.fastForward(root)
  const behind = moved.state.behind
  switch (moved.outcome) {
    case 'moved': break
    case 'current':
      ok(`${label}: already up to date`); return { status: 'current', clean }
    case 'no-upstream': case 'detached': case 'not-a-checkout':
      say(`${C.dim('·')} ${C.dim(`${label}: nothing to update from`)}`); return { status: 'current', clean }
    case 'unmeasurable':
      warn(`${label}: could not measure the distance from its upstream — not updated`); return { status: 'failed', clean }
    // Divergence is only one reason a fast-forward does not happen. For the others — a
    // lock, a file in the way — git's own words are the actionable part, and "rebase it
    // by hand" is not.
    case 'diverged':
      warn(`${label}: ${behind} behind and ${moved.state.ahead} ahead of its upstream — not updated; merge or rebase it by hand in ${root}`)
      return { status: 'failed', clean }
    // Reachable only when the tree changes during the fetch, and it gets the same advice
    // as the check before it rather than a quieter version of the same news.
    case 'blocked':
      warn(`${label}: ${moved.state.modified} uncommitted change(s) — not updated${how(label, root)}`)
      return { status: 'failed', clean }
    default:
      warn(`${label}: could not fast-forward ${behind} commit(s) (${moved.error || 'no detail from git'}) — not updated`)
      return { status: 'failed', clean }
  }
  ok(`${label}: fast-forwarded ${behind} commit(s)`)
  const arrived = co.arrived(root, moved.from)
  for (const line of arrived.slice(0, 20)) say(`  ${C.dim(line)}`)
  if (arrived.length > 20) say(`  ${C.dim(`… and ${arrived.length - 20} more`)}`)
  return { status: 'moved', from: moved.from, clean }
}

cmds.update = ({ flags }) => {
  const cfg = config()
  let problems = 0
  const tool = toolState()
  if (tool.linked) {
    warn(`this is the copy in a worktree (${toolRoot()}) — updating it would move your work's branch, not the installation. Run \`rig update\` from the installed checkout.`)
    problems++
  } else {
    const moved = updateCheckout('tool', toolRoot())
    if (moved.status === 'failed') problems++
    // This process is running the code that was here a moment ago: its migration list, its
    // doctor checks and its version are all the old ones. Hand the rest of the update to what
    // just arrived. `--restarted` makes that exactly one hop — an argv flag rather than an
    // environment variable, because a variable the user happens to have exported would skip
    // the hop silently, and with it every migration that just landed.
    if (moved.status === 'moved' && !flags.restarted) {
      say(`${C.dim('·')} ${C.dim('the tool moved — continuing with the code that just arrived')}`)
      const again = spawnSync(process.execPath, [path.join(toolRoot(), 'bin', 'rig.mjs'), 'update', '--restarted'],
        { stdio: 'inherit', env: env() })
      // A non-zero exit here is usually the doctor checks reporting problems, which is a
      // healthy update. It means a broken release only when the arrived code cannot run at
      // all — so ask it for the one command that needs nothing, and believe that instead.
      if (again.status !== 0 && exec(process.execPath, [path.join(toolRoot(), 'bin', 'rig.mjs'), 'help']).code !== 0) {
        warn(`the update landed, but the rig that arrived does not run — \`git -C ${toolRoot()} reset --hard ${moved.from}\` puts the previous one back`)
      }
      current.exitCode = again.status ?? 1
      return
    }
  }

  // Every configured data root, not the one in hand. The write refusal is per data root, so
  // migrating only the current one leaves the others to refuse the next mutating command
  // mid-work — which is the whole reason this is one installation rather than three. Read
  // from the registry rather than `where`, so a broken `current` does not stop the roots that
  // are fine from being brought forward.
  const reg = registry(toolRoot(), env())
  const names = Object.keys(reg.roots)
  const base = { toolRoot: toolRoot(), localFile: reg.localFile, roots: reg.roots }
  const targets = names.length
    ? names.map(name => ({ name, loc: withDataRoot(base, reg.roots[name].path) }))
    : [{ name: null, loc: where() }]

  for (const { name, loc } of targets) {
    // Named only when there is more than one: a single-root installation has never had to
    // say which, and every message it prints would grow a word for nothing.
    const label = names.length > 1 ? `data root ${name}` : 'data root'
    const root = loc.dataRoot
    let ready = false
    if (!loc.split) { warn(`${label} is inside the tool checkout — not set up; run \`rig prompt setup\``); problems++ }
    else if (!exists(root)) { warn(`${label} ${root} is missing — check ${name ? `dataRoots.${name}` : 'dataRoot'} in ${reg.localFile}`); problems++ }
    else {
      const data = updateCheckout(label, root)
      if (data.status === 'failed') problems++
      // Clean and current, the two halves of "safe to migrate in".
      ready = data.clean && data.status !== 'failed'
    }

    if (!exists(loc.orgFile)) continue
    const pending = pendingMigrations(readOrg(loc) ?? {})
    if (pending.length && !ready) {
      // `commitDataRoot` stages the whole tree, so migrating a dirty data root would publish
      // whatever it was refused an update for — under a message claiming to be a migration.
      // And it rebases onto origin before it pushes, so migrating a diverged or unfetchable
      // one would replay the migration on top of records another machine may already have
      // migrated (docs/adr/0002).
      warn(`${label}: ${pending.length} migration(s) pending, not run — it has to be clean and current first`)
      problems++
    } else if (pending.length) {
      const { ran } = writeOrgMigrations(loc)
      for (const ranName of ran) ok(`${label} migrated: ${ranName}`)
      // Committed here rather than through `main`, because the doctor checks run below and a
      // health verdict must not report the data root dirty with the change just made.
      commitDataRoot(`rig update: record format ${MAJOR}`, loc)
    }
  }

  // The cache describes a checkout that may have just moved.
  const after = toolState()
  if (!skipReason(after)) writeFreshness(cfg, measureFreshness(after))

  say('')
  // The checks this update ends in are findings now, so their count is arithmetic rather than
  // an exit code read back off the process — an update that moved nothing and a doctor that
  // found nothing are two facts, added together here.
  problems += problemCount(cmds.doctor({ flags: {}, positional: [] }))
  if (problems) current.exitCode = 1
}

// Hidden: the detached child spawned at the end of a command. Fetches, measures, writes the
// cache, says nothing to anyone — the next command is what speaks.
cmds[REFRESH_COMMAND] = () => {
  const cfg = config()
  const state = toolState()
  if (skipReason(state)) return
  const fetched = co.fetch(toolRoot())
  // A failed check is still a check: stamping it means an unreachable remote is retried once
  // per interval rather than at the end of every command. What it must not do is forget a
  // distance that is still true — concurrent refreshes make each other's fetches fail on the
  // ref lock, and the loser erasing the winner's "3 commits behind" would go quiet for the
  // whole interval on the strength of a race.
  if (!fetched.ok) {
    const previous = readFreshness(cfg)
    const behind = previous?.sha === state.head ? previous.behind ?? null : null
    writeFreshness(cfg, { sha: state.head, remote: state.upstream, behind, checkedAt: new Date().toISOString() })
    return
  }
  writeFreshness(cfg, measureFreshness(state))
}

// Everything doctor asks of this machine and these records, in one plain object that
// `bin/doctor.mjs` turns into findings. The impure half, and the only half that can die on a
// probe — which is why the crippled-PATH tests still spawn the real command.
//
// It carries doctor's one mutation: the fetch and the freshness cache it writes. `doctor` is
// the command that refuses to report what the cache last saw, because a health check you
// asked for should answer about now.
function doctorFreshness (cfg, tool) {
  const skipped = skipReason(tool)
  if (skipped) return { skipped }
  const fetched = co.fetch(toolRoot())
  if (!fetched.ok) return { fetchError: fetched.error }
  const measured = measureFreshness(tool)
  writeFreshness(cfg, measured)
  return { behind: measured.behind, upstream: tool.upstream }
}

// The record-format reading, in the order the three answers exclude each other: a stamp
// nothing wrote cannot be compared, and a data root this rig may not write to has no
// migrations of ours to run.
function doctorStamp (written) {
  if (stampUnreadable(written)) return { unreadable: true, writtenBy: written.writtenBy }
  if (writesBlocked(written)) return { blocked: true, major: MAJOR, dataMajor: dataMajor(written) }
  return { pending: pendingMigrations(written).map(m => m.name), writtenBy: written.writtenBy, major: MAJOR }
}

// One work, as doctor sees it: what the record contradicts, and what is under its folder that
// rig did not put there. A closed work keeps its contradictions and loses the rest — its
// worktrees are gone on purpose. The record and the catalogue entry it reads are the data
// root's, and the work folder is the machine's, which is the whole shape of a shared work
// root: `cfg` answers where the tree is, `root` answers who has the paperwork for it.
function doctorWork (cfg, id, root) {
  const work = loadWork(cfg, id, root)
  const out = { id, closed: !!work.closedAt, contradictions: contradictions(work), folderMissing: false, strays: [], repos: [] }
  if (out.closed) return out
  const wd = workDir(cfg, id)
  if (!exists(wd)) return { ...out, folderMissing: true }
  const known = new Set([...work.repos.map(r => r.repo), ...WORK_FOLDER_ENTRIES])
  out.strays = fs.readdirSync(wd).filter(e => !known.has(e))
  out.repos = work.repos.map(r => {
    const cat = cfg.secrets?.[r.repo] === undefined ? findCatalog(r.repo, root) : null
    return {
      repo: r.repo,
      worktreeMissing: !exists(r.path),
      secretsUnconfigured: !!(cat?.body && /secrets|\.env/i.test(cat.body)),
    }
  })
  return out
}

// One data root, gathered: where it is, what git makes of it, the org half it carries and the
// catalogue in it. Everything here is answerable from this root alone — the work records are
// not, which is why they are collected into one list a level up.
function doctorRoot (name, loc, hasGit) {
  const root = loc.dataRoot
  const there = exists(root)
  const orgFileExists = exists(loc.orgFile)
  // The merged config of *this* root, for the two things that differ between them: the orgs
  // rig.json declares, and the identity per org, which a root may override for its own.
  const cfg = there ? load(loc) : null
  // Read once: both the draft list and the freshness measure are made of the same entries.
  const entries = there ? loadCatalog(root) : []
  return {
    name,
    path: root,
    split: loc.split,
    exists: there,
    state: loc.split && there && hasGit ? co.describe(root) : null,
    repoConfig: {
      path: loc.orgFile,
      exists: orgFileExists,
      orgs: cfg?.orgs.length ?? 0,
      stamp: orgFileExists ? doctorStamp(readOrg(loc) ?? {}) : null,
    },
    orgs: (cfg?.orgs ?? []).map(org => ({ org, identity: effectiveIdentity(cfg, org), tracker: cfg.tracker?.[org] || null })),
    drafts: entries.filter(e => e.draft).map(e => e.repo),
    catalogueFreshness: cfg ? catalogueFreshness(root, entries, cfg.mirrorRoot, hasGit) : [],
  }
}

// How far each catalogue entry is behind the repo it describes: commits on that repo's default
// branch since the entry's own last commit in the data root. `talks_to`, `setup` and `check` are
// facts about code that changes, and they were the fields decision 3's "durable facts only" rule
// let through — the only signal about them was `DRAFT: unreviewed`, which says nothing about an
// entry that was written, was right, and has been overtaken since.
//
// **Asked of the mirror, so it costs no network and no rate limit.** The alternative was a `gh`
// call per entry, which would have made `doctor` O(catalogue) requests and broken the property
// that every root check is answerable from that root alone. The cost is that a repo with no
// mirror answers null: that is every repo nobody has attached, and an entry for a repo this
// machine has never worked in is one nobody has had the chance to learn anything about anyway.
// A mirror is only as current as its last fetch, and every `attach` fetches (decision 9), so the
// measure is a floor — it never claims more drift than there is.
//
// Not an extension of `bin/freshness.mjs`: that module is about the tool checkout, down to the
// detached HEADs and upstreams `skipReason` reasons about. Two similar things are a coincidence,
// so the cache mechanism it documents waits for a third caller before anything is named.
function catalogueFreshness (root, entries, mirrorRoot, hasGit) {
  if (!hasGit || !mirrorRoot) return []
  const unmeasured = repo => ({ repo, writtenAt: null, commits: null })
  return entries.map(e => {
    // The mirror is asked about first, because the answer for a repo without one is null however
    // old its entry is — and a catalogue is mostly repos nobody has attached. Reading the file's
    // history first spent a git spawn per entry to compute a field the finding then discards.
    const mirror = path.join(mirrorRoot, e.org, `${e.repo}.git`)
    if (!exists(mirror)) return unmeasured(e.repo)
    const head = mirrorHead(mirror)
    if (!head) return unmeasured(e.repo)

    // The entry's own last commit, not the data root's: one file's history is what says when
    // anybody last looked at this repo. Asked about the file `loadCatalog` actually read, rather
    // than a path rebuilt from the frontmatter — an entry whose `repo:` or `org:` has drifted
    // from where the file sits would answer for nothing at all, silently and for good.
    const written = git(root, 'log', '-1', '--format=%cI', '--', path.relative(root, e.file)).out
    // An entry with no commit of its own has just been drafted and not saved yet. Not a
    // measurement, so not a zero.
    if (!written) return unmeasured(e.repo)

    // `--since` is `--max-age` and **inclusive**, so a commit stamped in the same second as the
    // entry's own commit counts — and an entry corrected the moment a commit landed would report
    // "1 commit since today", which is the zero-information line this measure drops. git stamps
    // to the second, so one second past the cutoff is exactly "after".
    const after = new Date(Date.parse(written) + 1000).toISOString()
    const count = git(mirror, 'rev-list', '--count', `--since=${after}`, head)
    const n = Number(count.out)
    return {
      repo: e.repo,
      writtenAt: written.slice(0, 10),
      commits: count.code === 0 && Number.isInteger(n) ? n : null,
    }
  })
}

// What the mirror last saw the repo's default branch at. **Not the mirror's own `HEAD`**, which
// is frozen at clone time: `bin/worktrees.mjs` gives a mirror the refspec
// `+refs/heads/*:refs/remotes/origin/*`, so every fetch after the first lands under
// `refs/remotes/origin/` and the local heads never move again. Measuring against `HEAD` would
// have reported the drift as of the day the repo was first attached and called it current.
//
// The fallback list is `remoteHead`'s, for the same reason: the main/master mix across orgs
// makes a global default wrong. A repo that answers for none of them is not measured, rather
// than measured against a guess.
//
// The symref is **resolved, not trusted**. `git remote set-head` is only re-run by
// `worktrees.fetched()`, and doctor never fetches, so after an upstream renames its default
// branch the symref still names the branch that is gone: `symbolic-ref` exits 0, the ref does
// not resolve, and taking its word for it means the fallback is never reached even though
// `refs/remotes/origin/main` is sitting right there.
function mirrorHead (mirror) {
  const resolves = r => git(mirror, 'rev-parse', '--verify', '--quiet', r).code === 0
  const symbolic = git(mirror, 'symbolic-ref', 'refs/remotes/origin/HEAD')
  if (symbolic.code === 0 && symbolic.out && resolves(symbolic.out)) return symbolic.out
  return ['main', 'master', 'develop'].map(b => `refs/remotes/origin/${b}`).find(resolves) || null
}

// Every data root this installation configures, in the order the machine file names them.
// Read from the registry and not from `where`, the way `rig update` visits them: a `current`
// pointing at nothing must not hide the roots that are fine. A machine that configures none
// falls back to the location doctor resolved, which is the not-set-up layout it reports on.
function doctorRootLocations (fallback) {
  const reg = registry(toolRoot(), env())
  const names = Object.keys(reg.roots)
  const base = { toolRoot: toolRoot(), localFile: reg.localFile, roots: reg.roots }
  if (!names.length) return [{ name: null, loc: fallback }]
  return names.map(name => ({ name, loc: withDataRoot(base, reg.roots[name].path, { name }) }))
}

// Which data root is in hand, or why there is none. Everywhere else an unresolvable selection
// is fatal, and rightly: a command that carried on would write a work's records into a root
// nobody chose. `doctor` is the exception, because a selection it cannot make is exactly the
// class of broken configuration it exists to report, and dying on it is the one way to report
// nothing at all. So the refusal is caught and carried as a finding.
//
// The fallback is the tool checkout, which is what `locate` already falls back to on a machine
// that configures no data root at all: the org half of a root nobody chose must not be guessed
// at, and everything the snapshot still reads off it — the work root, the mirror root, the
// secrets — is the machine half's to answer, which reads either way. `freshness` sits in
// both halves, so the fallback does drop a root's own policy; it costs nothing because
// `doctorFreshness` asks the tool checkout and never reads `cfg.freshness`. The roots
// themselves come from the registry (`doctorRootLocations`) wherever it has any.
function doctorSelection () {
  try { return { loc: where(), error: null } }
  catch (e) {
    if (!(e instanceof RigError)) throw e   // a bug: not doctor's to swallow
    const reg = registry(toolRoot(), env())
    return {
      loc: withDataRoot({ toolRoot: toolRoot(), localFile: reg.localFile, roots: reg.roots }, toolRoot(),
        { name: null, source: 'fallback', entry: null }),
      error: e.message,
    }
  }
}

// What is directly under the work root, minus the two things rig keeps there itself. Whether
// an entry is accounted for is `bin/doctor.mjs`'s to decide, over every root's work records
// at once — one work root, several places to look a folder up.
function workRootEntries (cfg) {
  if (!exists(cfg.workRoot)) return []
  const ours = new Set([WORK_FOLDER.marker])
  if (insideDir(cfg.mirrorRoot, cfg.workRoot)) ours.add(path.relative(cfg.workRoot, cfg.mirrorRoot).split(path.sep)[0])
  return fs.readdirSync(cfg.workRoot).filter(e => !ours.has(e))
}

function doctorSnapshot () {
  // The one command that gathers its location rather than asking for it, and then carries on
  // whether or not it got one.
  const { loc, error: selectionError } = doctorSelection()
  const localFile = loc.localFile
  // Nothing below can be asked of an installation that has no config at all, and `load` is
  // the first thing that would die trying.
  if (!exists(localFile)) return { setUp: false, localFile }

  const cfg = load(loc)
  const gv = onPath('git') ? exec('git', ['--version']) : { code: 1, out: '' }
  const hasGit = gv.code === 0
  const tool = toolState()
  // Which *release* this is, when the checkout stands on one — a version and a sha name the
  // same build twice and neither says whether it was ever published. The describe is asked
  // for here and not in `toolState`, which runs in every command's epilogue and is already
  // four spawns dear; doctor is the one caller that can afford a fifth.
  const describe = hasGit ? git(toolRoot(), 'describe', '--tags', '--long', '--match', 'v[0-9]*').out : null
  const roots = doctorRootLocations(loc).map(root => doctorRoot(root.name, root.loc, hasGit))
  const disk = freeSpace(cfg.workRoot)
  // Needed if *any* root tracks in Jira: twg is one tool on one machine, so the question is
  // about the installation and not about whichever knowledge happens to be in hand.
  const jiraTracked = roots.some(r => r.orgs.some(o => o.tracker?.kind === 'jira'))

  return {
    setUp: true,
    localFile,
    configFileExists: exists(localFile),
    // Asked of the files, not carried on `cfg`: which keys the org half owns is
    // bin/roots.mjs's to know, and a diagnostic riding on a config value had exactly one
    // reader — this one.
    strayOrgKeys: strayOrgKeys(loc),
    // Why there is no root in hand, when there is not. Carried rather than reworded:
    // bin/roots.mjs writes that sentence for a person and it already names the fix.
    selection: { error: selectionError },
    node: process.version,
    git: hasGit ? gv.out : null,
    rig: { recordFormat: MAJOR, root: toolRoot(), mark: releaseMark({ describe, head: tool.head }) },
    freshness: doctorFreshness(cfg, tool),
    gh: github().auth(),
    jira: { needed: jiraTracked, present: jiraTracked && jira().present() },
    // Skipped rather than attempted without git: doctor is the command you run *because*
    // something is wrong, so it has to reach the end and report everything it can.
    gitConfig: hasGit
      ? {
          longpaths: exec('git', ['config', '--global', 'core.longpaths']).out,
          symlinks: exec('git', ['config', '--get', 'core.symlinks']).out,
        }
      : null,
    workRoot: { path: cfg.workRoot, exists: exists(cfg.workRoot), entries: workRootEntries(cfg) },
    mirrorRoot: { path: cfg.mirrorRoot, exists: exists(cfg.mirrorRoot) },
    dataRoots: roots,
    // Every root's works in one list, because the two checks made of them are made of the work
    // root, which is shared. A work id is unique across the roots, so the union needs no
    // tie-breaking and the findings need not say which root a work came from.
    works: roots.filter(r => r.exists).flatMap(r => listWorkIds(r.path).map(id => doctorWork(cfg, id, r.path))),
    disk: disk ? { label: disk.label, freeGb: Math.round(disk.bytes / 1e9) } : null,
  }
}

// A finding, printed. The four verdicts are the four channels the output already had; only a
// passing check carries a dim detail, because a failing one has folded it into the sentence.
function render (finding) {
  switch (finding.verdict) {
    case 'ok': return ok(`${finding.says}${finding.dim ? ` ${C.dim(finding.dim)}` : ''}`)
    case 'warn': return warn(finding.says)
    case 'bad': return bad(finding.says)
    default: return say(`${C.dim('·')} ${C.dim(finding.says)}`)
  }
}

// Gather, decide, print, count — and return the findings, because `rig update` ends in these
// checks and counts them rather than reading an exit code back out of the process.
cmds.doctor = () => {
  const found = doctorFindings(doctorSnapshot())
  for (const finding of found) render(finding)
  const problems = problemCount(found)
  say('')
  say(problems ? C.yellow(`${problems} thing(s) to look at`) : C.green('all clear'))
  if (problems) current.exitCode = 1
  return found
}

cmds.help = () => {
  say(`${C.bold('rig')} — cross-repo work harness

  rig init                        one-time setup; "rig prompt setup" asks the questions
       --data-repo owner/name      join that private data repo, or create it if absent
       --name <name>               what to call this data root; it becomes the current one
       [--email x] [--work-root d] [--data-root d]            -> rig.local.json (this machine)
       [--orgs a,b] [--tracker a=github:owner/repo,b=jira:KEY] -> rig.json (the data root)
  rig new <id> --title "..."      create a work (reads a brief on stdin)
       --key K | --ticket [--org o] [--field k=v,...] [--dry-run] | --no-ticket
       one of the three is required whenever a tracker is configured (the ticket
       decision must be explicit); --key PROJ-42 fetches its brief from Jira;
       --ticket creates in the org's tracker (rig.json); --dry-run previews and
       creates nothing; --no-ticket records a declined ticket
       [--type feat] [--repos a,b] [--setup]
  rig use [<name>]                which knowledge is in hand; bare, it lists the data
                                  roots this machine knows and marks the current one
  rig ticket <key>                record an existing ticket (PROJ-123 or owner/repo#n)
  rig attach <repo> [--setup]     add a repo to the current work
  rig detach <repo> [--force]     remove a repo from the current work
  rig list [--json] [--quick]     every work, least recently touched first
       --json                      the records plus live PR timestamps, for a consumer
       --quick                     skip the git and GitHub lookups
  rig dash [--org o] [--since w]  render throughput and cycle time as one HTML page
       [--from payload.json]       render a payload captured earlier, instead of looking up
       [--quick]                   look nothing up; recorded work still renders in full
       [--no-open]                 write the page and print the path, open nothing
  rig demo [--example <work>]     render one interactive page explaining rig on this data
                                  root's own repos: the talks_to graph, and a real work
                                  walked through command by command
       [--out path.html]           write it elsewhere; the default is <data root>/demo/index.html
       [--no-open]                 write the page and print the path, open nothing
  rig status                      live detail for the current work
  rig next                        what is available now on the current work
  rig pr                          open one PR per repo, work branch to base branch
  rig stage [branch]              the stack, in branch order; with a branch, declare one
  rig stage <branch> --cut        and make the branch, here, on top of this repo's stack
  rig stage <branch> --key <k>    give the stage its own ticket, closed when the slice lands
       --delivers "..."            the one line of prose a stage carries
  rig setup [repo...]             run the catalogue's setup commands
  rig check [repo...] [--run]     print what verifies each repo — its test run, its lint,
                                  its build; --run runs them and exits non-zero on a failure
  rig catalog [repo] [--verbose]  the repo catalogue: index, or one entry
  rig impact <repo>               what else a change in that repo reaches: the repos one and
                                  two hops away in talks_to, each with what was said, which
                                  way it runs, and how far behind its entry is
  rig plan [--refresh]            scaffold the rollout & testing plan; --refresh
                                  re-renders its deploy order from the stack
  rig save [-m text] [--designed] commit edits made outside rig (the context doc);
                                  --designed records the "design agreed" gate
  rig close [--force]             safety-checked teardown
       --abandoned                 stop a work without finishing it: the did-it-land
                                   checks are dropped, uncommitted changes still refuse,
                                   the ticket is told and open PRs are left alone
  rig backfill [--work <id>] [--force]
                                  store each merged PR's terminal facts (number, url,
                                  openedAt, firstCommitAt, firstReviewAt, approvedAt,
                                  mergedAt) in work.json, so list/dash never re-ask GitHub
                                  for them; --force refreshes what is already stored
  rig doctor                      environment + consistency checks, over every data root
  rig update                      fast-forward the tool checkout and the data root,
                                  run pending record migrations, then the doctor checks
  rig prompt [name]               print an agent prompt

Commands that act on "the current work" find it by walking up from the cwd,
or take --work <id>. Every command that changes a work ends by committing the
whole data root, and pushing it when it has an upstream.

Which data root a command reads, first hit wins: --data <name>, RIG_DATA_ROOT,
the work folder the command runs in, then the current one (rig use).

rig record format ${MAJOR} — \`rig doctor\` names the release this checkout stands on and
how far it is behind its remote, \`rig update\` brings it forward.`)
}

// ----------------------------------------------------------------- one run

// What one invocation does, from the argv it was handed to the exit code it earns. Split from
// `run` below so that building the invocation and running a command inside it stay two
// things: everything here already has `current` to read, and nothing here decides what
// `current` is.
//
// A `RigError` is rig's own refusal and is printed; anything else is a bug and propagates,
// which is what stops the data root being committed — `pendingCommit` is never reached — and
// leaves it exactly as the failed command found it.
function invoke (argv) {
  const [cmdName, ...rest] = argv
  const cmd = cmds[cmdName || 'help']
  // Returned rather than exited on: an in-process run has no process to exit, and a command
  // nobody recognised has nothing after it to run either way.
  if (!cmd) {
    err(`unknown command "${cmdName}" — try \`rig help\`\n`)
    return 1
  }
  current.command = cmdName
  // What the data root was before the command ran, for the commit at the end of it.
  let prepared = null
  try {
    const args = parseArgs(rest)   // before the network: a typo is not worth a fetch
    // Before the first `where()`: the data root a command names decides every path it reads.
    if (args.flags.data === true) die('--data wants a data root name — `rig use` lists them')
    if (typeof args.flags.data === 'string') current.requestedData = args.flags.data
    // `rig new --repos a,b` is the one command that names repos before there is a work folder
    // to anchor it, and it is the command whose choice of root matters most — it is the one
    // that writes the record.
    if (typeof args.flags.repos === 'string') {
      current.requestedRepos = args.flags.repos.split(',').map(s => s.trim()).filter(Boolean)
    }
    if (MUTATING.has(cmdName)) prepared = prepareDataRoot()
    cmd(args)
  } catch (e) {
    if (!(e instanceof RigError)) throw e   // a bug: leave the data root as it is
    err(`${C.red('✗')} ${e.message}\n`)
    current.exitCode = 1
  } finally {
    persistFakeTrackers()
  }
  if (current.pendingCommit) commitDataRoot(current.pendingCommit, where(), prepared)
  freshnessEpilogue(cmdName)
  return current.exitCode
}

// Reading fd 0 blocks until whoever holds the other end closes it, so the CLI reads it when a
// command asks for it and never when nothing is piping in.
function readProcessStdin () {
  if (process.stdin.isTTY) return ''
  try { return fs.readFileSync(0, 'utf8').trim() } catch { return '' }
}

// The invocation `run` works in, with the CLI's answer for everything a caller left out —
// except the cwd, whose answer is left unasked until a command needs it (see `cwd` above).
// A function declaration and not an arrow, because the process's own invocation is built at
// the top of this file and needs it hoisted.
function invocationOf ({
  toolRoot = MODULE_ROOT,
  cwd,
  env = process.env,
  stdin = readProcessStdin,
  out = s => process.stdout.write(s),
  err = s => process.stderr.write(s),
  chdir = () => {},
} = {}) {
  return {
    toolRoot,
    cwd,
    env,
    stdin,
    out,
    err,
    chdir,
    github: adapterResolver('RIG_FAKE_GITHUB', githubViaGh, githubInMemory),
    jira: adapterResolver('RIG_FAKE_TWG', twgViaCli, twgInMemory),
    location: null,
    requestedData: null,
    requestedRepos: [],
    pendingCommit: null,
    command: null,
    exitCode: 0,
  }
}

// One invocation of rig. `argv` is the arguments alone — no node, no script path — and the
// second argument is everything of the machine this run may reach: which installation it is a
// run of, where it is standing, what environment its subprocesses get, where stdin comes from
// and where its two streams go. It returns the exit code; only a bug leaves as an exception.
//
// The defaults are the CLI's, which is why `main` is now one line. A caller that passes its
// own gets a run that cannot see the machine it is on — which is what the test suite was
// buying a process for: ~400 times, at a Node start and a module graph each.
//
// `chdir` is the one piece of the process an in-process run must not touch. The CLI's moves
// the process, because Windows will not delete a directory that is its cwd; another caller's
// does nothing, since the process is not the run's and the run's own cwd has already moved.
export function run (argv, io = {}) {
  // Put back rather than cleared, so a run that throws cannot leave a half-finished
  // invocation current for whatever its caller does next.
  const previous = current
  current = invocationOf(io)
  try {
    return invoke(argv)
  } finally {
    current = previous
  }
}

// Importable by tests: `run`, the pure helpers, and `listing` — the one machine-readable
// surface (decision 55), which is neither pure nor cheap, since it reads every record and may
// ask GitHub about every branch. Nothing below the guard runs on import.
export {
  parseArgs, parseFrontmatter, parseTrackerFlag, isJiraKey, isGithubKey, slug, trackerFor, BOOL_FLAGS, RigError,
  anyTrackerConfigured, orgForJiraKey, ticketsLabel, statusLine,
  activityAt, relativeAge, prTiming, terminalPr, branchFirstCommitAt, baseLabel, baseMoved, sinceFlag, resolveJiraFields,
  spawnDefaults, refreshSpawn, refreshArgv, effectiveIdentity, parseDf, bytesFree, freeSpace, realGitFor,
  directionSection, directionBody, directionIsTodo,
  spawnFailure,
  listing,
}

// Node realpaths the main module before evaluating it, so compare realpaths: through a
// symlink or junction (`ln -s bin/rig.mjs ~/.local/bin/rig`) argv[1] is the link.
const isMain = (() => {
  if (!process.argv[1]) return false
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
})()

// `process.exitCode` and never `process.exit`: the streams may still be draining, and an exit
// that cuts one is how the last lines of a long `rig list` go missing down a pipe.
//
// A reader that stops early — `rig list | head -1` — closes the pipe under every write after
// it, and a bare stream write reports that as an 'error' event with nobody listening, which
// Node turns into a stack trace and exit 1 once the command has already succeeded. Nobody is
// left to read what rig would have said, so a closed pipe is where the output ends.
if (isMain) {
  for (const stream of [process.stdout, process.stderr]) stream.on('error', e => { if (e.code !== 'EPIPE') throw e })
  process.exitCode = run(process.argv.slice(2), { chdir: dir => process.chdir(dir) })
}
