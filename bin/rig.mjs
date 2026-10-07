#!/usr/bin/env node
// rig — cross-repo work harness. Zero dependencies by design; see DESIGN.md §2.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { RigError, TrackerError } from './errors.mjs'
import { githubViaGh, githubInMemory } from './github.mjs'
import { twgViaCli, twgInMemory, fieldValue } from './jira.mjs'
import { worktrees, remotesOnGitHub, remotesInDirectory } from './worktrees.mjs'
import { checkouts, unreadable, REAL_MACHINE, LOCK_STALE_MS } from './checkouts.mjs'
import { NO_PROMPT_ENV, signIn } from './remote-env.mjs'
import { discover, notARepository, refSha, symref } from './gitfs.mjs'
import { MAJOR, FORMAT_STAMP, dataMajor, stampUnreadable, pendingMigrations, writesBlocked, applyMigrations } from './version.mjs'
import { REFRESH_COMMAND, skipReason, dueForRefresh, staleLine, announces } from './freshness.mjs'
import { impact, unattached } from './catalog-graph.mjs'
import { releaseMark, BRANCH_PREFIXES, bumpFor, releasesByBump } from './release.mjs'
import { renderDash } from './dash.mjs'
import { workState } from './workstate.mjs'
import { phaseOf, phaseLabel, statusLine, gatesOf, contradictions, STOPPABLE, STOP_WORDS } from './phase.mjs'
import { nextFor } from './next.mjs'
import { transcriptsFor, refusal } from './transcripts.mjs'
import { contextDocProblems, sectionOf, promoteHeadings } from './contextdoc.mjs'
import { doctorFindings, problemCount, ISSUES_URL } from './doctor.mjs'
import { stackOf, stageOrder, nextStage, unknownStages, stageBranchProblem, stageTable, renderPlanRegion, refreshedPlan, planIsStale, adriftNote, onLandedStage, backToWorkBranch, escapeRe, withdrawalOf, withdrawnLabel, stackState } from './stages.mjs'
import { locate, withDataRoot, load, readOrg, writeMachine, writeOrg, strayOrgKeys, sameDir, insideDir, registry, workIdAt, rootHoldingWork, rootsCataloguing, DEFAULT_ROOT_NAME, LOCAL_CONFIG_ENV } from './roots.mjs'

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
// For what rig says beside a command's answer rather than as part of it — the freshness line,
// a note about records it left out — so it never lands in a pipe someone reads the answer from.
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
// what its callers mean by it — `NO_PROMPT_ENV` goes on top of what is already there, and a
// replacement would drop everything an isolated run depends on.
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
const co = checkouts({ run: exec, env, machine: () => current.machine })

// Asked for at the moment a command wants it rather than when the run starts: reading fd 0
// blocks, and `rig help` must not wait on a terminal nobody is piping into.
const readStdin = () => current.stdin()

const exists = p => fs.existsSync(p)

// Two ref questions read from the files where `gitfs` places the repository and asked of
// git where it does not (hugoforte/rig#153): whether a ref resolves, and what HEAD is.
function refLives (dir, ref, place = discover(dir, env())) {
  const read = refSha(place, ref)
  if (read) return read.sha !== null
  return git(dir, 'rev-parse', '--verify', '--quiet', ref).code === 0
}
function headSha (dir, place = discover(dir, env())) {
  const read = refSha(place, 'HEAD')
  if (read) return read.sha
  const head = git(dir, 'rev-parse', 'HEAD')
  return head.code === 0 ? head.out : null
}
// A byte-order mark is how PowerShell 5.1 saves UTF-8, and a file saved that way is not damaged.
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
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
// The repo a remote URL names, as the catalogue files it: `org/repo` when the remote is hosted
// and its path is exactly two segments, which is what matches a repo to its own org's entry
// (`rootsCataloguing`). Anything else names the repo alone — a path on disk, whose parent
// folder is no org, and a host with a deeper path.
function repoOfRemote (url) {
  const u = url.replace(/\/+$/, '').replace(/\.git$/i, '')
  const hosted = /^(?!file:)[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(u) ?? /^(?:[^/\\@]+@)?[^/\\:]{2,}:(?!\/\/)(.+)$/.exec(u)
  const segments = (hosted ? hosted[1] : u).split(/[/\\]/).filter(Boolean)
  return (hosted && segments.length === 2 ? segments.join('/') : segments.pop()) || null
}

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
  if (url.code === 0 && url.out) return repoOfRemote(url.out)
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
// `requestedData`, `requestedWork` and `requestedRepos` are what the command line said, read
// before anything reads config. They sit on the invocation rather than being parameters of
// `where`, because every caller of `where` wants the same answer and threading it through all
// of them would be a second way to be wrong about which knowledge is in hand.
const where = () => (current.location ??= locate(toolRoot(), env(), {
  data: current.requestedData, work: current.requestedWork, repos: current.requestedRepos, repoAt: repoAtCwd, cwd: current.cwd,
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
// Beside the answer rather than in it, so `rig list --json` piped somewhere is the payload alone.
function sayCurrentRoot () {
  const w = where()
  if (CHOSE_QUIETLY[w.source] && Object.keys(w.roots).length > 1) {
    aside(C.dim(`· data root: ${w.name} (${CHOSE_QUIETLY[w.source]})`))
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
        const spawnCli = (args, { env: extra } = {}) =>
          spawnSync(CLI_FOR[envVar], args, { ...spawnDefaults(current.command), cwd: current.cwd, env: { ...env(), ...extra } })
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
    // four git spawns, or eight in a layout `gitfs` hands back to git (test/checkouts-read.test.mjs
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
    const place = discover(toolRoot(), env())
    if (notARepository(place)) return
    const sha = headSha(toolRoot(), place)
    if (!sha) return
    const line = speaks ? staleLine(cache, sha) : null
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
const MUTATING = new Set(['new', 'ticket', 'attach', 'detach', 'restore', 'plan', 'save', 'note', 'close', 'backfill'])
// `rig check` prints and writes nothing; `rig check --run` records what passed.
const mutates = (name, flags) => MUTATING.has(name) || (name === 'check' && !!flags.run)

// Before a mutating command reads anything. rig pushes the data root but never pulled it, so
// a second machine read stale records and wrote on top of them. Fast-forward only: a data
// root with commits of its own is left for `commitDataRoot`'s rebase at the end. Then the
// gate, which holds whether or not there is a remote to sync with.
//
// With several roots, every one is brought forward before the root is chosen, since which root
// holds a work is read from all of their records, and the choice is made again afterwards. A
// stale root stops the command only where it could matter (decision 192 says where).
//
// Answers the half of the chosen root's reading `commitDataRoot` may have at the end of the
// command, or null when there was nothing here to read.
function prepareDataRoot () {
  const all = doctorRootLocations(null).filter(r => r.name)
  const { loc: guess } = selection()
  const cfg = load(guess)
  const roots = all.length > 1 ? all.map(r => ({ label: `data root ${r.name}`, loc: r.loc })) : [{ label: 'data root', loc: guess }]
  const synced = roots.map(({ label, loc }) => ({ label, loc, ...syncDataRoot(label, loc, cfg, loc.dataRoot === guess.dataRoot) }))
  current.location = null
  const chosen = synced.find(r => r.loc.dataRoot === dataRoot())
  const work = synced.length > 1 && workInHand()
  const settled = !work || (chosen && !chosen.stale &&
    rootHoldingWork(where().roots, work).holders.some(h => h.open && h.name === where().name))
  const stopped = chosen?.stale === 'busy' ? chosen : !settled && synced.find(r => r.stale === 'busy')
  if (stopped) die(`${lockBusy(stopped.held, stopped.label)}; nothing was done. Run this again once it finishes. ${lockEscape(stopped.held)}`)
  const stale = settled ? [] : synced.filter(r => r.stale)
  if (stale.length) warn(`${stale.map(r => r.label).join(', ')} could not be brought forward, so data root "${where().name}" was chosen from this machine's records`)
  checkWriteGate()
  return chosen?.state ? stillTrueAtTheEnd(chosen.state) : null
}

// One root's reading (null for no data root this command could commit into) once it is brought
// forward, and why it is stale if it is: `busy`, `unfetched`, `diverged`, `blocked` or `failed`.
function syncDataRoot (label, loc, cfg, mine) {
  const root = loc.dataRoot
  if (!exists(root) || !loc.split) return { state: null }
  // The full reading, for three fields: what it costs over the identity questions is one
  // `status`, whose branch header carries the distance, and the network fetch dwarfs it.
  const before = co.describe(root)
  // `tracks` without `upstream` is an upstream whose ref is not here yet — a clone of an
  // empty remote that another machine has since pushed to — and only a fetch can say
  // whether it exists.
  if (before.repo !== 'own' || !before.branch || !before.tracks || !dataFetchDue(cfg, root)) return { state: before }
  // Held from the fetch to the fast-forward. A busy one is for `prepareDataRoot` to stop on or
  // go past, once it knows which root the command is about (decisions 161 and 192).
  const held = lockDataRoot(root, 'fast-forward', label, mine ? undefined : 0)
  if (held.outcome === 'busy') {
    say(C.dim(`· ${lockBusy(held, label)} — working from what is here`))
    return { state: before, stale: 'busy', held }
  }
  // `rig save` commits the work in hand, which is in another root when this one is not `mine`.
  const clear = mine ? 'run `rig save`' : `commit or stash the changes in ${root}`
  try {
    const fetched = co.fetch(root)
    noteDataFetch(cfg, root, fetched.ok)
    if (!fetched.ok) {
      say(C.dim(`· ${label}: could not fetch (${fetched.error})${signIn(fetched.error)} — working from what is here`))
      return { state: before, stale: 'unfetched' }
    }
    const { outcome, state, error } = co.fastForward(root)
    // Everything but these four is a data root with nothing to do, and a command about
    // to run is the wrong moment to be told about it.
    if (outcome === 'diverged') {
      warn(`${label}: ${state.behind} behind and ${state.ahead} ahead of origin — left alone; it is rebased when a command commits into it`)
    } else if (outcome === 'blocked') {
      warn(`${label}: ${state.behind} commit(s) behind origin with uncommitted changes — ${clear}, then it will fast-forward`)
    } else if (outcome === 'failed') {
      warn(`${label}: could not fast-forward (${error})`)
    } else if (outcome === 'moved') {
      say(C.dim(`· ${label}: fast-forwarded ${state.behind} commit(s) from origin`))
    }
    // The upstream the fetch found is the one the commit at the end pushes to. `state` is the
    // reading the fast-forward decided from, after the fetch, which is all the commit reads.
    return { state: before.upstream ? before : state, stale: ['diverged', 'blocked', 'failed'].includes(outcome) ? outcome : null }
  } finally { co.unlock(held.lock) }
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
// plane. Short enough that a second machine is never working from stale records for long. Kept
// per root, by path: one root's remote out of reach is no reason to stop fetching another's.
const DATA_FETCH_RETRY_MS = 15 * 60_000
const DATA_FETCH_CACHE = 'datafetch-roots.json'
const dataFetchDue = (cfg, root) => {
  const at = Date.parse(readCache(cfg, DATA_FETCH_CACHE)?.[root] ?? '')
  if (Number.isNaN(at)) return true
  return Date.now() - at >= DATA_FETCH_RETRY_MS || at > Date.now()
}
const noteDataFetch = (cfg, root, ok) => {
  const cached = readCache(cfg, DATA_FETCH_CACHE)
  const failed = isObject(cached) ? cached : {}
  if (ok && !(root in failed)) return
  if (ok) delete failed[root]
  else failed[root] = new Date().toISOString()
  writeCache(cfg, DATA_FETCH_CACHE, failed)
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
  return explicit || workIdAt(cwd()) || die('not inside a work (no .rig/id found). Pass --work <id> or cd into one.')
}

// What a record must be for every command to read it, or why it is not. Only what is iterated
// or dereferenced whatever the work's state, and every field may be absent, so a record written
// before stages, before `tickets` or before the phase still reads (decision 155).
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const isList = v => v === undefined || Array.isArray(v)
function recordShapeProblem (w) {
  if (!isObject(w)) return 'it is not an object'
  // The commands that read many records name and find each work by the `id` inside it.
  if (typeof w.id !== 'string' || !w.id) return 'it has no `id`'
  for (const field of ['repos', 'stages', 'tickets', 'jiraKeys']) {
    if (!isList(w[field])) return `\`${field}\` is not a list`
  }
  for (const [i, r] of (w.repos || []).entries()) {
    if (!isObject(r) || typeof r.repo !== 'string' || !r.repo) return `repo ${i + 1} has no \`repo\``
    if (!isList(r.branches) || !(r.branches || []).every(isObject)) return `\`branches\` of ${r.repo} is not a list of branches`
    for (const b of r.branches || []) {
      if (b.verified !== undefined && !(isObject(b.verified) && ['branch', 'head', 'base', 'patchId', 'at'].every(k => typeof b.verified[k] === 'string'))) {
        return `\`verified\` of ${r.repo} is not a pass with its branch, head, base, patch-id and date`
      }
    }
  }
  for (const [i, s] of (w.stages || []).entries()) {
    if (!isObject(s) || typeof s.branch !== 'string' || !s.branch) return `stage ${i + 1} has no \`branch\``
    if (!isList(s.tickets)) return `\`tickets\` of stage ${s.branch} is not a list`
  }
  if (w.outcome !== undefined && w.outcome !== null &&
    !(isObject(w.outcome) && typeof w.outcome.text === 'string' && typeof w.outcome.at === 'string')) {
    return '`outcome` is not a statement with its date'
  }
  for (const field of ['stops', 'agentDecided']) {
    // Null is absent, as it is for `outcome`, and is the shape `rig list --json` gives it. The
    // shape and not the names: a later rig may let another gate stop being a stop, and reading
    // its record must not need a major (ADR 0002). A name this rig does not know is passed over.
    if (w[field] !== undefined && w[field] !== null && !(Array.isArray(w[field]) && w[field].every(n => typeof n === 'string'))) {
      return `\`${field}\` is not a list of gate names`
    }
  }
  return null
}

// A work's record as it is on disk, or the sentence saying why it cannot be read: one that will
// not parse and one of the wrong shape alike (decisions 137 and 155). The reason is the error's
// `cause`, which is what the commands that leave a record out name it by (`readRecords`).
function readRecord (id, root = dataRoot()) {
  const file = recordFile(id, root)
  const unreadable = cause => new RigError(`work record for "${id}" at ${file} could not be read (${cause.message})`, { cause })
  let w
  try { w = readJson(file) } catch (e) { throw unreadable(e) }
  const shape = recordShapeProblem(w)
  if (shape) throw unreadable(new Error(shape))
  return w
}

function loadWork (cfg, id, root = dataRoot()) {
  if (!exists(recordFile(id, root))) {
    // A work id is unique across every root on the machine, so the one that has it is worth
    // naming: on a second machine the work in hand is often not in the current root.
    const { name, candidates } = rootHoldingWork(where().roots, id)
    const hint = name ? ` — data root "${name}" has it: add \`--data ${name}\``
      : candidates.length ? ` — data roots ${candidates.map(h => h.name).join(', ')} each hold it: add \`--data <name>\`` : ''
    die(`no work record for "${id}" at ${recordFile(id, root)}${hint}`)
  }
  const w = readRecord(id, root)
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

// Every work record in a root that reads, and for each one that does not, its id and why. For
// the commands that read many records to answer one question: the observed graph behind
// `rig impact`, the offer `rig attach` makes, and the works `list` and `dash` show. One
// unreadable record must not cost those their answer, and for `attach` it must not cost the
// command it follows: the offer runs after the worktree is cut and the record saved, and a throw
// there would skip the commit and leave the data root half-written. So a record that will not
// read is left out and named with the error it raised (its cause, when `loadWork` has wrapped it
// in a sentence that already names the record), never swallowed.
function readRecords (root, read = id => readRecord(id, root)) {
  const works = []
  const unreadable = []
  for (const id of listWorkIds(root)) {
    try { works.push(read(id)) } catch (e) { unreadable.push(`${id} (${(e.cause ?? e).message})`) }
  }
  return { works, unreadable }
}

// Said on stdout, or through `tell` when the caller's stdout is a payload.
const sayUnreadable = (records, tell = say) => {
  if (records.length) tell(C.dim(`· ${records.length} work record${records.length === 1 ? '' : 's'} could not be read and ${records.length === 1 ? 'was' : 'were'} left out: ${records.join(', ')}`))
}

// ---------------------------------------------------------------- catalogue

const catalogFile = (org, repo) => path.join(dataRoot(),'catalog', org, `${repo}.md`)

// Minimal purpose-built frontmatter reader. Handles scalars and the one list
// shape the catalogue uses (`talks_to:` / `setup:` / `check:` / `docs:`). Not a general YAML parser.
function parseFrontmatter (text) {
  // PowerShell 5.1 writes UTF-8 with a byte-order mark, which would hide the opening `---`.
  text = text.replace(/^﻿/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { data: {}, body: text }
  const data = {}
  let key = null
  let item = null
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const listItem = /^\s*-\s+(.*)$/.exec(raw)
    if (listItem && key) {
      // A key is followed by a space or the end of the line, as YAML has it, so a docs target
      // like `https://…` stays a string rather than becoming the key `https`.
      const kv = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(listItem[1])
      if (kv) { item = { [kv[1]]: strip(kv[2] ?? '') }; data[key].push(item) }
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

// ----------------------------------------------------------------- org docs

// What an org is trying to do, in its own words (hugoforte/rig#184). Absent means no
// constraints: nothing reads a missing doc as a problem, and nothing offers to write one
// except the lesson review.
const orgDocFile = org => path.join(dataRoot(), 'orgs', `${org}.md`)

// The orgs a work touches are its repos' orgs, in the order they were attached.
const orgsOf = work => [...new Set(work.repos.map(r => r.org))]

// The org's doc, or null when it has none. A file with nothing under its frontmatter says
// nothing, so it counts as none, and the lesson review still asks for one.
function readOrgDoc (org) {
  const file = orgDocFile(org)
  if (!exists(file)) return null
  const body = parseFrontmatter(readText(file)).body.trim()
  return body ? { file, body } : null
}

// An org doc's body as it sits under its org's `##`: every heading moved so the shallowest
// lands at `###`, capped at the `######` Markdown stops at. A line inside a fenced block is
// code rather than a heading, a fence closes only on its own kind, and one the doc leaves
// open is closed here, so it cannot swallow the rest of the generated file.
function nestedOrgDoc (body) {
  const lines = body.split(/\r?\n/)
  let fence = null
  const levels = lines.map(line => {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null
      return 0
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (open) { fence = open[1]; return 0 }
    return /^ {0,3}(#{1,6})(\s|$)/.exec(line)?.[1].length ?? 0
  })
  const shift = 3 - Math.min(...levels.filter(Boolean))
  const nested = lines.map((line, i) => levels[i]
    ? '#'.repeat(Math.min(6, levels[i] + shift)) + line.trimStart().slice(levels[i])
    : line)
  if (fence) nested.push(fence)
  return nested.join('\n')
}

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
        docs: (Array.isArray(data.docs) ? data.docs : (data.docs ? [data.docs] : [])).map(docsAddress),
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
// A docs target is an address. Written with a label, `- Help centre: https://…`, the address
// is what follows the label: a one-key object when the label is one word, a string otherwise.
// An address's own colon is never followed by a space, so a bare one is left alone.
const docsAddress = d => typeof d === 'string'
  ? d.replace(/^[^:]*:\s+/, '')
  : Object.values(d).find(v => typeof v === 'string') || ''

// A work's repo in the catalogue: the same org and repo, however the case of either was written.
const catalogEntryFor = (catalog, r) =>
  catalog.find(e => e.org.toLowerCase() === r.org.toLowerCase() && e.repo.toLowerCase() === r.repo.toLowerCase())

function draftEntries (work) {
  const attached = work?.repos || []
  if (!attached.length) return []
  const draft = new Set(loadCatalog().filter(e => e.draft).map(e => e.repo.toLowerCase()))
  return draft.size ? attached.filter(r => draft.has(r.repo.toLowerCase())).map(r => r.repo) : []
}

// Which org a repo belongs to: the catalogue first, then GitHub, org by org. The language
// comes along from GitHub for the catalogue stub `rig attach` drafts on first sight. Only "no
// such repo" moves on to the next org: one GitHub would not answer for may have the repo, and
// taking a later org's repo of the same name would be a confident wrong answer.
function resolveOrg (cfg, repo) {
  const cat = findCatalog(repo)
  if (cat) return { org: cat.org, repo: cat.repo }
  for (const org of cfg.orgs) {
    let found = null
    const error = trackerFailure(() => { found = github().repo(org, repo) })
    if (error) {
      die(`cannot resolve "${repo}": could not ask GitHub whether ${org}/${repo} exists (${error}) — ` +
        `authorise gh's token for ${org} (SAML SSO, for one), catalogue the repo, or list ${org} after the org that has it in \`orgs\``)
    }
    if (found) return { org, repo: found.name, language: found.language }
  }
  die(`cannot resolve "${repo}" in any of: ${cfg.orgs.join(', ')}`)
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
# Where this repo's user documentation lives: a path in the repo, or a page elsewhere.
# docs:
#   - docs/guide.md
#   - https://example.atlassian.net/wiki/spaces/HELP/pages/1
docs: []
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
  env,
})

// ------------------------------------------------------------------ helpers

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)

// Flags that never take a value, so `rig new --ticket my-id` keeps its positional.
const BOOL_FLAGS = new Set(['ticket', 'no-ticket', 'dry-run', 'designed', 'adversarial', 'no-adversarial', 'reviewed', 'learned', 'documented', 'abandoned', 'setup', 'cut', 'force', 'run', 'refresh', 'quick', 'verbose', 'help', 'restarted', 'json', 'no-open', 'tip', 'planned', 'link', 'land', 'by-agent', 'transcripts'])

// The short flags rig accepts, each an alias of the long name commands read.
const SHORT_FLAGS = { m: 'message', h: 'help' }
const isFlag = a => a.startsWith('--') || /^-[a-z]$/.test(a)

function parseArgs (argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // `--` ends the flags, as it does for git: a note may begin with a dash.
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (!isFlag(a)) { positional.push(a); continue }
    // `--flag`, `--flag=value`, `--flag value`; `-m value` is `--message value`.
    // Split at the first `=` only: a value may carry its own, as a title or a message can.
    const [raw, ...rest] = a.replace(/^-+/, '').split('=')
    const v = rest.length ? rest.join('=') : undefined
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

// The context doc's heading, as `rig new` scaffolded it: `# <id> — <title>`. Rewritten only
// when the title is corrected, and never by every save the way the header line is: a heading
// someone edited by hand is theirs until they ask for the title to change.
function retitleDoc (id, title) {
  const f = contextFile(id)
  if (!exists(f)) return
  const heading = new RegExp(`^# ${escapeRe(id)}(?: — .*)?$`, 'm')
  const text = readText(f)
  if (!heading.test(text)) return warn(`${f} has no \`# ${id} — …\` heading — the record has the new title, the doc does not`)
  writeText(f, text.replace(heading, () => `# ${id} — ${title}`))
}

// Where the work records live on GitHub, for linking issues back to context docs.
function dataRemoteUrl () {
  const r = git(dataRoot(), 'remote', 'get-url', 'origin')
  return r.code !== 0 || !r.out ? null : webUrlOf(r.out)
}

// A remote URL as a page to link to. Credentials in an http(s) URL come out whatever the host,
// since the link goes into Jira and GitHub bodies alike; every way git spells a GitHub remote
// (scp-style, `ssh://`, https) comes out as the page's URL.
const webUrlOf = remote => remote.replace(/\/+$/, '').replace(/\.git$/, '')
  .replace(/^(https?:\/\/)[^/@]+@/, '$1')
  .replace(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)/, 'https://github.com/')

// A file of a work's record on the data root's remote, or null when it has none.
const recordUrl = (id, file) => {
  const remote = dataRemoteUrl()
  return remote ? `${remote}/blob/main/work/${id}/${file}` : null
}

// A relative reference when the data root has no remote: a machine path in an
// issue body would leak into a tracker that may be public.
const contextDocRef = id => recordUrl(id, 'context.md') || `work/${id}/context.md in the rig data root`

// How widely a GitHub repo can be read, narrowest first.
const REACH = ['private', 'internal', 'public']

// A repo's visibility, or null when GitHub would not say.
function visibilityOf (spec) {
  const key = spec.toLowerCase()
  if (!current.visibilities.has(key)) {
    const [org, name] = spec.split('/')
    let found = null
    trackerFailure(() => { found = github().repo(org, name)?.visibility })
    current.visibilities.set(key, REACH.includes(found) ? found : null)
  }
  return current.visibilities.get(key)
}

// A data root with no remote is private: nobody but this machine can read it. One GitHub does
// not host answers `elsewhere`, since nothing says who can read it.
function dataRootVisibility () {
  const remote = dataRemoteUrl()
  if (!remote) return 'private'
  const spec = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(remote)?.[1]
  return spec ? visibilityOf(spec) : 'elsewhere'
}

// May text written into `spec`'s repo link the context doc? Only when that repo is no more
// visible than the data root (hugoforte/rig#202): the link names the private repo and the work's
// path in it, and GitHub keeps a body's edit history, so a link published cannot be taken back.
// A data root hosted elsewhere is never linked. Null when GitHub would not say for either side,
// which callers treat as no.
function mayLink (spec) {
  const [here, root] = [visibilityOf(spec), dataRootVisibility()]
  if (root === 'elsewhere') return false
  return here && root ? REACH.indexOf(here) <= REACH.indexOf(root) : null
}

// `mayLink` for text about to be written, saying once, of whichever side GitHub would not answer
// for, that the link is left out: a link left out costs a click.
function linkOrSay (spec) {
  const may = mayLink(spec)
  if (may !== null) return may
  // Named for the side GitHub would not answer for: the data root once, whatever the target.
  const rootUnknown = dataRootVisibility() === null
  const key = rootUnknown ? '' : spec.toLowerCase()
  if (!current.linkLeftOut.has(key)) {
    current.linkLeftOut.add(key)
    say(C.dim(`· context-doc link left out: GitHub would not say ${rootUnknown ? 'how visible the data root is' : `whether ${spec} is more visible than the data root`}`))
  }
  return false
}

// The context-doc line and the blank line above it, as lines to spread into a body.
const contextDocLines = (id, link) => (link ? ['', `Context doc: ${contextDocRef(id)}`] : [])

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
// create --field` wants. A single-value field takes a scalar in rig.json: a one-item list
// reaches twg as a list (DESIGN.md decision 147).
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
// second format (hugoforte/rig#54). `link` is false where the ticket is more visible than
// the data root (`mayLink`); a Jira ticket always has it.
const ticketBody = (work, prose, { link }) => [
  prose, ...(link ? ['', `The design lives in the work record: ${contextDocRef(work.id)}`] : []),
  '', `Opened by \`rig new ${work.id} --ticket\`.`,
].join('\n')

// Creates a ticket in the org's tracker, or previews it: `dryRun` prints what would be
// created and returns null without calling out. GitHub: the issue is the ticket, the
// context doc is the design (DESIGN.md §7.1) — a thin body, the brief's first paragraph,
// with a link back to it.
// Jira: `docs/adr/0001-jira-via-twg.md` (supersedes DESIGN.md decisions 29, 33).
function createTicket (cfg, work, brief, orgFlag, { dryRun = false, fields: fieldOverrides = [], parent } = {}) {
  const t = trackerFor(cfg, orgFlag)
  const summary = work.title || work.id

  if (t.kind === 'github') {
    if (!t.repo) die(`tracker for ${t.org} is GitHub but has no "repo" (owner/name) in rig.json`)
    if (fieldOverrides.length) warn('--field is ignored for a GitHub tracker (no per-field create options)')
    if (parent) warn('--parent is ignored for a GitHub tracker (a GitHub issue has no epic)')
    const firstParagraph = brief.split(/\n\s*\n/)[0] || summary
    if (dryRun) { say(`would create a GitHub issue in ${t.repo}:`); say(`  title  ${summary}`); say(`  body   ${firstParagraph}`); return null }
    const body = ticketBody(work, firstParagraph, { link: linkOrSay(t.repo) })
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
    const description = ticketBody(work, brief.trim() || summary, { link: true })
    if (dryRun) {
      say(`would create a ${t.type} in ${t.project}:`)
      say(`  summary      ${summary}`)
      say(`  assignee     ${assignee || '_none_'}`)
      if (parent) say(`  parent       ${parent}`)
      for (const [id, value] of Object.entries(fields)) say(`  ${id.padEnd(12)} ${fieldValue(value)}`)
      // Last, and verbatim: it is many lines, and what is printed is exactly the markdown
      // the real create sends — an indent that a reader can strip, not a summary of it.
      say('  description  (markdown, as sent):')
      for (const line of description.split('\n')) say(line ? `    ${line}` : '')
      return null
    }
    step(`creating Jira ${t.type} in ${t.project}`)
    const key = jira().createIssue({ project: t.project, type: t.type, summary, description, assignee, parent, fields })
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
  // A ticket a slice also holds is left to `stageWriteBack`, which says why.
  const sliceKeys = new Set(stages.flatMap(st => st.tickets || []))
  const githubKeys = keys.filter(k => isGithubKey(k) && !sliceKeys.has(k))
  const jiraKeys = keys.filter(k => isJiraKey(k) && !sliceKeys.has(k))
  // A work that declined a ticket can still have slices that carry one, so the stages are
  // written back either way.
  if (!keys.length) return stageWriteBack(work, stages, { abandoned })

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

  // Per ticket, because whether the context doc may be linked is a question about the repo the
  // ticket is in (`mayLink`).
  const githubBody = link => [
    opening,
    ...(prs.length ? ['', ...prs] : []),
    ...contextDocLines(work.id, link),
  ].join('\n')
  for (const key of githubKeys) {
    const [repo, n] = key.split('#')
    const notCommented = trackerFailure(() => github().commentIssue(repo, n, githubBody(linkOrSay(repo))))
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
    ...contextDocLines(work.id, true),
    '', 'rig does not transition Jira tickets — move this one yourself.',
  ].join('\n')
  for (const key of jiraKeys) {
    const notCommented = trackerFailure(() => jira().commentIssue(key, jiraBody))
    if (notCommented) warn(`${key}: could not comment (${notCommented})`)
    else step(`commented on ${key}`)
  }

  stageWriteBack(work, stages, { abandoned, landing: { done: merged, reason, prs } })
}

// A stage's own tickets, told what became of the slice they were opened for.
//
// This is the one moment rig speaks to a tracker, and a stage's ticket is written back here
// with every other rather than the moment its pull requests merge — one outward-facing act,
// not a new rule about when rig speaks. A slice that landed closes its ticket; one that did
// not is commented on and left open, because whether the slice is still wanted is not rig's
// answer any more than an abandoned work's is.
//
// **One comment per ticket, whatever roles it holds** (hugoforte/rig#229). A key two slices
// carry is told about both, and a key that is also one of the work's tickets is told here
// rather than by `ticketWriteBack` as well, with the work's PRs beside the slice's. It closes
// only when every role would close it: each slice landed, and, for a work ticket, the work did
// too (`landing`, the verdict `ticketWriteBack` reached). Otherwise the first thing that kept
// it open is what the comment says.
function stageWriteBack (work, stages, { abandoned, landing = null }) {
  const slicesOf = new Map()
  for (const st of stages) {
    for (const key of st.tickets || []) {
      if (!slicesOf.has(key)) slicesOf.set(key, [])
      slicesOf.get(key).push(st)
    }
  }
  // A forced close says so here as it does on the work's tickets (decision 77).
  const forced = work.forcedAt && !abandoned
  const ran = `\`rig close${abandoned ? ' --abandoned' : forced ? ' --force' : ''}\` ran on ${work.id}.${forced ? ' The blockers were overridden deliberately.' : ''}`
  for (const [key, slices] of slicesOf) {
    const asWork = landing && (work.tickets || []).includes(key)
    const stuck = slices.find(st => !st.landed)
    const closes = !abandoned && !stuck && (!asWork || landing.done)
    const names = slices.map(st => st.branch).join(', ')
    const slice = slices.length > 1 ? `The slice \`${stuck?.branch}\`` : 'This slice'
    const landed = `The slice${slices.length > 1 ? 's' : ''} this was opened for landed in \`${work.branch}\``
    let outcome
    if (closes) outcome = `${landed}, and ${ran}`
    else if (stuck?.withdrawn) outcome = `${ran} ${slice} was ${withdrawnLabel(stuck.withdrawn, b => `\`${b}\``)}. The issue stays open.`
    else if (stuck?.prUnknown) outcome = `${ran} GitHub would not say whether ${slices.length > 1 ? `the slice \`${stuck.branch}\`` : 'this slice'} landed, so the issue stays open.`
    else if (stuck) outcome = `${ran} ${slice} did not land, so the issue stays open.`
    else if (abandoned) outcome = `${ran} The work was stopped without finishing, so the issue stays open.`
    else outcome = `${ran} ${landed}, but the work has not: ${landing.reason} The issue stays open.`
    const prs = [...new Set([...slices.flatMap(st => st.prs.map(pr => `- ${pr.repo}: ${pr.url}`)), ...(asWork ? landing.prs : [])])]
    const body = link => [
      outcome,
      '', ...slices.map(st => `Stage: \`${st.branch}\`${st.delivers ? ` — ${st.delivers}` : ''}`),
      ...(prs.length ? ['', ...prs] : []),
      ...contextDocLines(work.id, link),
    ].join('\n')

    if (isJiraKey(key)) {
      const notCommented = trackerFailure(() => jira().commentIssue(key, `${body(true)}\n\nrig does not transition Jira tickets — move this one yourself.`))
      if (notCommented) warn(`${key}: could not comment (${notCommented})`)
      else step(`commented on ${key} (stage ${names})`)
      continue
    }
    if (!isGithubKey(key)) { warn(`ticket "${key}" is neither PROJ-123 nor owner/repo#n — skipped`); continue }
    const [repo, n] = key.split('#')
    const notCommented = trackerFailure(() => github().commentIssue(repo, n, body(linkOrSay(repo))))
    if (notCommented) { warn(`${key}: could not comment (${notCommented})`); continue }
    if (!closes) {
      const why = stuck?.prUnknown && !stuck.withdrawn ? `GitHub would not say whether stage ${stuck.branch} landed`
        : stuck ? `stage ${stuck.branch} did not land` : abandoned ? 'abandoned' : landing.reason
      step(`commented on ${key} (left open: ${why})`)
      continue
    }
    const notClosed = trackerFailure(() => github().closeIssue(repo, n))
    if (notClosed) warn(`${key}: commented, but could not close (${notClosed})`)
    else step(`closed ${key} (stage ${names} landed)`)
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
  lines.push('<!-- GENERATED by rig — do not edit. Source of truth: the context doc and any org doc named below. -->')
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
    const c = catalogEntryFor(cat, r)
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
    if (c?.docs?.length) lines.push(`- Docs: ${c.docs.map(s => `\`${s}\``).join(' · ')}`)
    lines.push('')
  }
  // Inlined in full rather than linked, because a link is what an agent skips, and the doc
  // is only worth writing if every session starts knowing it.
  for (const org of orgsOf(work)) {
    const doc = readOrgDoc(org)
    if (!doc) continue
    lines.push(`## ${org}`)
    lines.push('')
    lines.push(`What this org is trying to do. **Org doc (the only copy, edit it there):** \`${doc.file}\``)
    lines.push('')
    lines.push(nestedOrgDoc(doc.body))
    lines.push('')
  }
  lines.push('## Replying to the user')
  lines.push('')
  lines.push('Open every reply with a **TL;DR**: a few lines saying what happened, then the action items')
  lines.push('the user must take, if any — or "Nothing for you to do." Everything else follows below it,')
  lines.push('for whoever wants to read on.')
  lines.push('')
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
}

// ------------------------------------------------------ data root commits

// The work a command is about, for the lock's holder: the id `rig new` and `rig restore` are
// given, `--work`, or the work folder it runs in. Null for a command about no work — `init`,
// which locks only its commit, or `backfill` over every work — and for a run whose folder has gone from under it:
// the holder's work is a label, and no answer to it is worth failing a command for.
function workInHand () {
  const { flags = {}, positional = [] } = current.args ?? {}
  if (['new', 'restore'].includes(current.command) && positional[0]) return positional[0]
  if (typeof flags.work === 'string') return flags.work
  try { return findWorkId() } catch { return null }
}

// The data root's lock, for one of the two sections that move its git state (decisions
// 160–162): `fast-forward` or `commit and push`, which is how a waiter is told what it waits on.
// A lock that could not be taken at all is said and gone past, because the lock is advisory and
// rig without it is rig as it was. Answers the lock to let go of, or the busy outcome.
function lockDataRoot (root, section, label = 'data root', waitMs) {
  const r = co.lock(root, { command: `rig ${current.command}`, work: workInHand(), section }, { waitMs })
  if (r.outcome === 'failed') warn(`${label}: could not take its lock (${r.error}) — going on without it`)
  if (r.outcome === 'taken-over') {
    const why = {
      gone: 'which is no longer running',
      old: `after more than ${LOCK_STALE_MS / 60_000} minutes`,
      unreadable: 'which could not be read',
    }[r.stale.why]
    say(C.dim(`· ${label}: took over the lock held by ${lockHolder(r.stale.holder)}, ${why}`))
  }
  return r
}

const lockHolder = h => h ? `\`${h.command}\`${h.work ? ` for ${h.work}` : ''} (pid ${h.pid})` : 'another rig'

// The first half of a busy lock's refusal, about `subject` — `data root`, or `rig update`'s
// label for one of several; each section says what happens next.
const lockBusy = (r, subject = 'data root') =>
  `${subject} busy — ${lockHolder(r.holder)} has held it for ${Math.round(r.heldFor / 1000)} s${r.holder?.section ? ` to ${r.holder.section} it` : ''}`
const lockEscape = r => `If no rig is running, delete ${r.file}.`

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

  // Held from the stage to the push. A busy lock warns rather than dies, like everything here:
  // the command's work is done and its records are written, and they wait in the tree.
  const held = lockDataRoot(root, 'commit and push')
  if (held.outcome === 'busy') {
    warn(`${lockBusy(held)}; anything this command wrote waits in the tree for the next command, or \`rig save\` once it finishes. ${lockEscape(held)}`)
    return
  }
  try { commitHeld(root, message, state) } finally { co.unlock(held.lock) }
}

// The commit and push `commitDataRoot` makes once it holds the lock.
function commitHeld (root, message, state) {
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
  if (sent.outcome === 'fetch-failed') { warn(`data root: ${committed}, but could not fetch from origin (${sent.error})${signIn(sent.error)} — nothing pushed`); return }
  // Someone's rebase, and not rig's to finish or to throw away.
  if (sent.outcome === 'underway') { warn(`data root: ${committed}, but a rebase is already in progress in ${root} — finish or abort it, then \`rig save\`; nothing pushed`); return }
  if (sent.outcome === 'refused') { warn(`data root: ${committed}, but the rebase onto origin would not start (${sent.error}) — nothing pushed, nothing changed`); return }
  if (sent.outcome === 'conflict-stuck') { warn(`data root: ${committed}, but rebasing onto origin hit a conflict and the abort failed — sort ${root} out by hand (git status)`); return }
  if (sent.outcome === 'conflict') { warn(`data root: ${committed}, but rebasing onto origin hit a conflict — rebase aborted, tree left clean; pull, resolve and push by hand in ${root}`); return }
  // `sent.hash` is HEAD as the rebase left it, which is not what was committed above.
  if (sent.outcome === 'push-failed') { warn(`data root: ${committed} as ${sent.hash}, but the push failed (${sent.error})${signIn(sent.error)} — push it by hand`); return }
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
  if (refLives(target, 'HEAD')) return false
  if (!exists(path.join(target, 'README.md'))) {
    writeText(path.join(target, 'README.md'), `# ${name}

The data root for [rig](https://github.com/hugoforte/rig): the repo catalogue, the org docs, the work records and \`rig.json\`. Private — this is everything rig knows about these orgs.

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
    if (ensureFirstCommit(target, name) && origin) pushFirstCommit(target)
    return target
  }

  // Everything from here asks GitHub. A lookup gh could not answer throws rather than reading
  // as "does not exist", which would send an existing repo down the create path.
  let existing = false
  const unasked = trackerFailure(() => { existing = github().repoExists(spec) })
  if (unasked) die(`could not ask GitHub whether ${spec} exists (${unasked}) — joining or creating a data repo needs it`)

  if (existing) {
    step(`joining ${spec}: cloning to ${target}`)
    github().clone(spec, target)
    // A repo with no commits clones fine and is useless; give it its first commit.
    if (ensureFirstCommit(target, name)) {
      pushFirstCommit(target)
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

// A data root's first commit, pushed; a push refused for want of credentials names the fix.
function pushFirstCommit (target) {
  const r = exec('git', ['-C', target, 'push', '-q', '-u', 'origin', 'main'], { env: NO_PROMPT_ENV })
  const detail = r.err || r.out
  if (r.code !== 0) die(`could not push the first commit of ${target}${signIn(detail)}\n${detail}`)
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

// `--stops design`, `--stops repos,design` or `--stops none`: the gates the agent waits at for the
// human. Absent is undefined, which leaves the record's choice, or the default, as it was.
function stopsFlag (flags) {
  const v = flags.stops
  if (v === undefined) return undefined
  const named = typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : []
  if (!named.length) die(`--stops wants the gates to wait at: ${STOPPABLE.join(', ')}, or none`)
  if (named.includes('none')) {
    if (named.length > 1) die('--stops: none stands alone — it waits at neither gate')
    return []
  }
  const unknown = named.filter(n => !STOPPABLE.includes(n))
  if (unknown.length) die(`--stops: ${unknown.join(', ')} cannot stop being a stop — only ${STOPPABLE.join(' and ')} (or none)`)
  return STOPPABLE.filter(n => named.includes(n))
}

// `--by-agent`: the agent decided the gate this command records. The flag is the answer, so a
// value on it is refused, for the reason `--adversarial` refuses one: `--by-agent=false` would
// otherwise read as a yes.
function byAgentFlag (flags) {
  if (typeof flags['by-agent'] === 'string') die('--by-agent takes no value — the flag is the answer')
  return !!flags['by-agent']
}

cmds.new = ({ flags, positional }) => {
  sayCurrentRoot()
  const cfg = config()
  const id = positional[0] || die(`rig new wants a work id\n${usageOf('new')}`)

  const keys = (flags.key || '').toString().split(',').map(s => s.trim()).filter(Boolean)
  for (const k of keys) {
    if (!isJiraKey(k) && !isGithubKey(k)) die(`--key "${k}" is neither PROJ-123 nor owner/repo#n`)
  }
  // The branch prefix is the release check's bump (ADR 0004), so a type it does not know is
  // refused here, when the branch is named, rather than on the pull request.
  const type = flags.type || 'feat'
  if (!BRANCH_PREFIXES.includes(type)) {
    die(`--type wants a branch prefix the release check knows: ${BRANCH_PREFIXES.join(', ')}${typeof type === 'string' ? ` — not "${type}"` : ''}`)
  }
  const noTicket = !!flags['no-ticket']
  const dryRun = !!flags['dry-run']
  if (dryRun && !flags.ticket) die('--dry-run only makes sense with --ticket')
  if (keys.length && noTicket) die('--key and --no-ticket are alternatives; pass one')
  if (flags.ticket && noTicket) die('--ticket and --no-ticket are alternatives; pass one')
  // Checked here, before the record exists, so a typo never leaves a half-made work behind.
  const parent = flags.parent
  if (parent !== undefined) {
    if (!flags.ticket) die('--parent only makes sense with --ticket')
    if (typeof parent !== 'string' || !isJiraKey(parent)) {
      die(`--parent wants a Jira key like PROJ-123${typeof parent === 'string' ? ` — not "${parent}"` : ''}`)
    }
  }
  const stops = stopsFlag(flags)
  const byAgent = byAgentFlag(flags)
  if (byAgent && !flags.repos) die('--by-agent says the agent chose the repo set — pass it with --repos')
  const fieldOverrides = (flags.field || '').toString().split(',').map(s => s.trim()).filter(Boolean)
  // A parent is this one ticket's, never a field, however Jira or rig.json spells it
  // (DESIGN.md decision 146).
  const isParent = name => name.trim().toLowerCase() === 'parent'
  if (fieldOverrides.some(o => isParent(o.split('=')[0]))) die('--field parent is not a field rig sets — pass --parent <key> instead')
  if (flags.ticket) {
    const t = trackerFor(cfg, flags.org)
    if (Object.keys(t.fields || {}).some(isParent)) {
      die(`"parent" in ${t.org}'s rig.json fields is not a field rig sets — remove it, and pass --parent <key> to rig new`)
    }
  }
  // The ticket decision must be explicit whenever it could matter (DESIGN direction:
  // "gates, not stages"). A data root with no live tracker anywhere has no decision to make.
  if (!keys.length && !flags.ticket && !noTicket && anyTrackerConfigured(cfg)) {
    die('a tracker is configured — pass --key <key>, --ticket, or --no-ticket (see `rig prompt new-work`)')
  }

  const brief = readStdin()
  // Read the real record, if one already exists, so `--dry-run` doesn't preview a ticket
  // the real run would just warn-and-skip (an id that already has one).
  let existing = null
  if (exists(recordFile(id))) {
    try { existing = readRecord(id) } catch (e) { die(`work "${id}" already exists: ${e.message}`) }
  }
  // A work id is unique across the roots, folder or not, since another root's folder is one
  // `rig restore` away; asked before the preview, which would otherwise preview a refusal.
  const owner = rootHoldingWork(where().roots, id).holders.find(h => h.name !== where().name)?.name
  if (owner) die(`work "${id}" belongs to data root "${owner}" — pick another id`)
  if (dryRun) {
    if (existing?.tickets?.length) { warn(`${id} already has a ticket (${existing.tickets.join(', ')}) — nothing to preview`); return }
    createTicket(cfg, { id, title: flags.title || existing?.title || '' }, brief, flags.org, { dryRun: true, fields: fieldOverrides, parent })
    return
  }

  if (existing) die(`work "${id}" already exists (${recordFile(id)})`)

  // One work root, shared by every data root on this machine, so two roots can want the same
  // folder. Renaming a folder another root's records point at would break that work, so the
  // id is refused. This is the whole cost of not giving every data root a work root of its
  // own, and it is paid at the one moment a name is being chosen anyway.
  const folder = workDir(cfg, id)
  if (exists(folder)) die(`${folder} already exists — pick another id`)

  // A Jira `--key` needs no piped brief any more: rig fetches summary/description
  // itself, used as a default wherever `--title`/stdin didn't already supply one.
  let fetched = null
  const jiraKey = keys.find(isJiraKey)
  if (jiraKey && orgForJiraKey(cfg, jiraKey)) {
    try { fetched = jira().getIssue(jiraKey) } catch (e) { warn(`could not fetch ${jiraKey} from Jira: ${e.message}`) }
  }
  const title = flags.title || fetched?.title || ''

  const idKey = /^([A-Z][A-Z0-9]+-\d+)/.exec(id)?.[1] ?? ''
  // Only a Jira-shaped key goes in the branch name. GitHub keys carry `#` and `/`, and the
  // PR body names those instead: `Fixes` where its merge is the work landing (`closedByPr`),
  // `Tickets:` everywhere else.
  const branchKey = keys.find(isJiraKey) || idKey
  const branchSlug = flags.slug || slug(title || id.replace(/^[A-Z][A-Z0-9]+-\d+-?/, '') || id)
  const branch = flags.branch ||
    `${type}/${branchKey ? branchKey + '-' : ''}${branchSlug}`.replace(/-$/, '')

  const work = {
    id,
    title,
    tickets: keys.length ? keys : (idKey ? [idKey] : []),
    ...(noTicket ? { ticketsDeclined: true } : {}),
    ...(stops ? { stops } : {}),
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
    warn(`--ticket${parent ? ' and --parent' : ''} ignored: the work already has ${work.tickets.join(', ')}`)
  } else if (flags.ticket) {
    const created = createTicket(cfg, work, brief || fetched?.body || '', flags.org, { fields: fieldOverrides, parent })
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
    for (const r of repos) attachRepo(cfg, work, r, { setup: !!flags.setup, byAgent })
  } else {
    say('No repos attached yet. Run the selection interview:')
    say(C.dim('  rig prompt select-repos'))
    say(C.dim(`  rig attach <repo> --work ${id}`))
  }
}

// Attaches to the record it is given — `rig new --repos a,b` passes the one it just built.
// Answers whether the repo joined the work, which is what decides whether its neighbours are
// worth naming: a repo already in the record joined it some other day.
function attachRepo (cfg, work, repoName, { setup = false, byAgent = false } = {}) {
  const recorded = work.repos.find(r => r.repo.toLowerCase() === repoName.toLowerCase())
  if (recorded) {
    // The record is not the territory: a repo attached on another machine, or whose folder
    // was deleted, is put back rather than declared done (hugoforte/rig#99). Through the
    // restore, never a fresh cut, so the branch is the one the work carries and `attachedAt`
    // still says when the repo joined.
    if (exists(recorded.path)) say(`${repoName} already attached — nothing to do`)
    else if (restoreRepo(cfg, work, recorded, { setup })) regenerate(cfg, work)
    else current.exitCode = 1
    return false
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
  prepareWorktree(cfg, org, repo, dest)

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
  // The agent chose this repo where the repo set is not a stop. Only the human agreeing the
  // design clears it, since one repo attached by hand does not confirm the rest.
  if (byAgent) work.agentDecided = [...new Set([...(work.agentDecided || []), 'repos'])]
  saveWork(cfg, work)
  ok(`attached ${C.bold(repo)} at ${dest}`)
  offerSetup(cat, repo, dest, setup)
  return true
}

// What a worktree needs beyond its checkout, whether it was just cut or put back: the
// identity its commits go out under and the secrets its catalogue entry says it wants.
function prepareWorktree (cfg, org, repo, dest) {
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
}

// The catalogue's setup commands, printed unless `--setup` asked for them to run.
function offerSetup (cat, repo, dest, setup) {
  if (!cat?.setup?.length) return
  if (setup) runCatalogCommands(dest, cat.setup, 'setup')
  else {
    say(`  ${C.dim('setup (not run — `rig setup ' + repo + '` or --setup):')}`)
    for (const s of cat.setup) say(`    ${s}`)
  }
}

// ---------------------------------------------------------------- restore

// The highest branch of this work the repo carries, read out of a freshly fetched mirror: the
// top declared stage it has that has not landed, or the work branch when there is none — or
// when the work branch already holds that stage, which is what a stack merged down looks like.
// A landed stage is asked of its PR as well as of ancestry, because a stage squashed into the
// work branch is never an ancestor of it and its branch outlives the merge wherever the remote
// keeps head branches.
function topBranch (cfg, work, entry) {
  const t = trees(cfg)
  const { org, repo } = entry
  const stages = work.stages.map(s => s.branch)
  const chain = t.chain({ org, repo, branch: work.branch, base: entry.base, stages })
  const carried = new Set(chain.map(c => c.branch))
  const landed = b => {
    if (branchRecord(entry, b)?.pr) return true
    let pr = null
    trackerFailure(() => { pr = github().prForBranch(org, repo, b) })
    return pr?.state === 'MERGED'
  }
  const top = stageOrder(work, [chain]).filter(s => !withdrawalOf(s)).map(s => s.branch)
    .filter(b => carried.has(b)).reverse().find(b => !landed(b))
  if (!top || t.contains({ org, repo, branch: work.branch, other: top })) return work.branch
  return top
}

// The open pull requests stacked on `top` that the record does not know, followed up the
// stack while it is one line. Two landing on the same branch is a fork, returned as it is:
// which of them is the work is not something rig can tell.
function stackedAbove (work, entry, top) {
  const known = new Set([work.branch, ...work.stages.map(s => s.branch)])
  const line = []
  let fork = []
  for (let at = top; ;) {
    let onto = []
    const error = trackerFailure(() => { onto = github().prsOnto(entry.org, entry.repo, at) })
    if (error) return { line, fork, error }
    onto = onto.filter(pr => !known.has(pr.branch))
    if (onto.length !== 1) { fork = onto; break }
    line.push(onto[0])
    known.add(onto[0].branch)
    at = onto[0].branch
  }
  return { line, fork, error: null }
}

// Why a branch could not be put back, in its pull request's terms.
function whyAbsent (entry, branch) {
  let pr = null
  const error = trackerFailure(() => { pr = github().prForBranch(entry.org, entry.repo, branch) })
  if (error) return `GitHub would not say whether it had a PR (${error})`
  if (!pr) return 'it has no PR, so it was never pushed from the machine that made it'
  return `PR #${pr.number} ${pr.state} ${pr.url}`
}

// Put one recorded repo's worktree back, on the top of its stack, and write nothing down
// (hugoforte/rig#112). A restore is not an attach: the record already says which repo, which
// org and which branches, and a restore that wrote any of it again could only be less right.
// A branch gone from the remote and the mirror is named and left gone. Answers whether a
// worktree was checked out.
function restoreRepo (cfg, work, entry, { tip = false, setup = false } = {}) {
  const { org, repo, path: dest } = entry
  const t = trees(cfg)
  t.fetch({ org, repo })
  const top = topBranch(cfg, work, entry)
  const above = stackedAbove(work, entry, top)
  const tipBranch = above.line.at(-1)?.branch
  let branch = tip && tipBranch ? tipBranch : top
  let from = t.checkOut({ org, repo, branch, dest })
  if (!from && branch !== top) {
    warn(`${repo}: ${branch} is not on the remote — falling back to ${top}`)
    branch = top
    from = t.checkOut({ org, repo, branch, dest })
  }
  if (!from) {
    warn(`${repo}: ${branch} is on neither the remote nor the mirror — not recreated; ${whyAbsent(entry, branch)}`)
    return false
  }
  prepareWorktree(cfg, org, repo, dest)
  ok(`restored ${C.bold(repo)} on ${branch}`)

  const pr = p => `${p.branch} (#${p.number})`
  if (above.error) warn(`${repo}: GitHub would not say what is stacked on ${top} (${above.error})`)
  if (above.line.length) {
    if (branch !== tipBranch) {
      say(`  stacked on ${top}, not in the record: ${above.line.map(pr).join(' → ')}`)
      say(`    ${C.dim(`check out the top: git -C ${dest} switch ${tipBranch}`)}`)
    }
    say(`    ${C.dim(`record them as stages: ${above.line.map(p => `rig stage ${p.branch}`).join('; ')}`)}`)
  }
  if (above.fork.length) {
    const on = tipBranch || top
    say(`  ${above.fork.length} open PRs land on ${on} and are not in the record: ${above.fork.map(pr).join(', ')} — rig will not pick between them`)
  }
  offerSetup(findCatalog(repo), repo, dest, setup)
  return true
}

// Rebuild a work's folder from its record — every missing worktree, on the top of its stack,
// and the generated files beside them — on a machine that has only the data root. Present
// worktrees are left alone, so running it twice is running it once. Nothing is recorded and
// nothing is committed: `restore` is mutating only so the data root is brought forward first,
// and a second machine restores from the newest records rather than the ones it last pulled.
cmds.restore = ({ flags, positional }) => {
  const cfg = config()
  const work = loadWork(cfg, findWorkId(cfg, positional[0] || flags.work))
  if (work.closedAt) die(`${work.id} is ${work.abandonedAt ? 'abandoned' : 'closed'} — there is nothing to restore`)
  if (!work.repos.length) die(`${work.id} has no repos attached — there is nothing to restore`)
  const missing = work.repos.filter(r => !exists(r.path))
  for (const r of work.repos) if (!missing.includes(r)) step(`${r.repo} is already here`)
  // One repo git refuses — a diverged branch, a clone that failed — is said and the rest are
  // still put back, and the folder's generated files are still written. The exit code says a
  // refusal happened; a branch that is simply gone is a finding, reported and not a failure.
  const restored = missing.filter(r => {
    try {
      return restoreRepo(cfg, work, r, { tip: !!flags.tip, setup: !!flags.setup })
    } catch (e) {
      if (!(e instanceof RigError)) throw e
      warn(`${r.repo}: ${e.message}`)
      current.exitCode = 1
      return false
    }
  })
  regenerate(cfg, work)
  if (!missing.length) return ok(`${work.id}: every worktree is already here — ${workDir(cfg, work.id)}`)
  const left = missing.filter(r => !restored.includes(r))
  if (left.length) warn(`${work.id}: ${left.map(r => r.repo).join(', ')} could not be restored — see above`)
  ok(`${work.id}: restored ${restored.length} of ${missing.length} — cd ${workDir(cfg, work.id)}`)
}

// `from` becomes `to` in the record, in its place, or goes when there is no `to`. Wherever it
// is held: the work's own tickets and every stage's, because an issue that moved has a new
// number whichever list named it. Never the tracker: rig speaks to one only at `rig close`,
// and a ticket the record stops naming is told nothing.
function correctTicket (cfg, work, from, to) {
  const held = [...new Set([work.tickets, ...work.stages.map(s => s.tickets || [])].flat())]
  if (!held.includes(from)) die(`${from} is not recorded on ${work.id} — it has ${held.join(', ') || 'no tickets'}`)
  const hadIt = work.tickets.includes(from)
  const corrected = list => [...new Set(list.flatMap(k => (k !== from ? [k] : to ? [to] : [])))]
  work.tickets = corrected(work.tickets)
  for (const st of work.stages.filter(s => s.tickets)) {
    st.tickets = corrected(st.tickets)
    // A stage left with none goes back to the shape it was declared in without one.
    if (!st.tickets.length) delete st.tickets
  }
  const done = to ? `${to} replaces ${from}` : `removed ${from}`
  commitAs(work.id, done)
  saveWork(cfg, work)
  ok(`${work.id}: ${done} — the tracker was not told`)
  if (hadIt && !work.tickets.length) say(C.dim(`  ${work.id} has no ticket now — \`rig ticket <key>\` records one`))
}

cmds.ticket = ({ flags, positional }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  if (flags.remove !== undefined) {
    if (flags.remove === true) die('--remove needs the key to take off the record')
    if (positional.length || flags.replaces !== undefined) die('--remove takes the one key it removes, and nothing else')
    return correctTicket(cfg, work, flags.remove)
  }
  const key = positional[0] || die(`rig ticket wants a key\n${usageOf('ticket')}`)
  if (!isJiraKey(key) && !isGithubKey(key)) die(`"${key}" is neither PROJ-123 nor owner/repo#n`)
  if (flags.replaces !== undefined) {
    if (flags.replaces === true) die('--replaces needs the key it replaces')
    if (flags.replaces === key) die(`${key} cannot replace itself`)
    return correctTicket(cfg, work, flags.replaces, key)
  }
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
  const byAgent = byAgentFlag(flags)
  commitAs(work.id, name)
  if (attachRepo(cfg, work, name, { setup: !!flags.setup, byAgent })) offerNeighbours(work, name)
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
// `--learned` records the lesson review the same way, and `--reviewed` the adversarial review.
// `--title` corrects the title in the record and the two headings that show it, and never the
// branch or the id. `--outcome` records what landed and why it was worth doing.
cmds.save = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  if (flags.message === true) die('-m needs a message')
  const title = typeof flags.title === 'string' ? flags.title.trim() : flags.title
  if (title === true || title === '') die('--title needs the title')
  if (typeof title === 'string' && /[\r\n]/.test(title)) die('--title takes the title in one line — it is a heading and a PR title')
  const outcome = typeof flags.outcome === 'string' ? flags.outcome.trim() : flags.outcome
  // `rig next` and `rig close` offer `--outcome "…"`, and an offered command gets run as
  // written, so the placeholder is no outcome either.
  if (outcome === true || (typeof outcome === 'string' && /^[\s….]*$/.test(outcome))) die('--outcome needs the outcome: what changed for someone, and why that is good, in a sentence or two')
  if (typeof outcome === 'string' && /[\r\n]/.test(outcome)) die('--outcome takes one line — it is read as one entry in a list of what landed')
  const stops = stopsFlag(flags)
  // Whether the work's PRs get an adversarial review is decided at the design gate and nowhere
  // else, and decided explicitly, as `rig new` insists on the ticket decision (decision 168).
  // The flag is the answer, so a value on it is refused: `--adversarial=false` would otherwise
  // read as a yes.
  for (const f of ['adversarial', 'no-adversarial']) {
    if (typeof flags[f] === 'string') die(`--${f} takes no value — the flag is the answer`)
  }
  const choice = flags.adversarial ? true : flags['no-adversarial'] ? false : null
  if (flags.adversarial && flags['no-adversarial']) die('--adversarial or --no-adversarial, not both')
  // In one call the review would be dated a moment after the design it answers, and count as done
  // before any PR was opened.
  if (flags.reviewed && flags.designed) die('--reviewed records a review of the agreed design — record the design first, and the review once it is done')
  if (choice !== null && !flags.designed) die('the adversarial-review choice is made at the design gate — pass it with --designed')
  if (flags.designed && choice === null) die('--designed needs the adversarial-review choice: --adversarial or --no-adversarial')
  const byAgent = byAgentFlag(flags)
  if (byAgent && !flags.designed) die('--by-agent says the agent decided a gate — pass it with --designed')
  commitAs(id, flags.message || (title ? `title "${title}"` : outcome ? 'outcome' : stops ? `stops ${stops.join(',') || 'none'}` : undefined))
  if (flags.designed) {
    if (work.closedAt) die(`${id} is closed — its design gate is behind it`)
    if (work.abandonedAt) die(`${id} was abandoned — its design gate is behind it`)
    // Re-recorded rather than refused: agreeing the design a second time is a real thing to
    // do after a rethink, and the date that matters is the one the current design was agreed.
    // The review choice is re-recorded with it, for the same reason.
    // Who agreed it. The agent, where the design is not a stop; anyone else is the human, who
    // reads the repo table in the same Direction, so their agreement settles both marks. The
    // human going over what the agent decided, with the review choice it made, confirms that
    // design rather than agreeing another, so its date stands, and a review of it with it.
    // Only a design the agent agreed can be confirmed: one the human already agreed, agreed
    // again, is a rethink, whatever else the agent decided around it.
    const confirms = !byAgent && work.agentDecided?.includes('design') && work.designedAt && work.adversarial === choice
    if (!confirms) work.designedAt = new Date().toISOString()
    work.adversarial = choice
    if (byAgent) work.agentDecided = [...new Set([...(work.agentDecided || []), 'design'])]
    else delete work.agentDecided
    ok(`${id}: design ${confirms ? 'confirmed by the human' : 'agreed'}, ${choice ? 'with' : 'without'} an adversarial review`)
  }
  // The adversarial review. Recorded whatever the design chose, because it is a fact about what
  // happened; refused once the work has stopped, since its PRs are no longer in review.
  if (flags.reviewed) {
    if (work.closedAt && !work.abandonedAt) die(`${id} is closed — its review is behind it`)
    if (work.abandonedAt) die(`${id} was abandoned — there is no PR left to review`)
    // Before the design gate there is no choice it answers, and a review recorded then would
    // silence the one the design goes on to choose.
    if (!work.designedAt) die(`${id} has no design gate yet — the adversarial review answers its choice, so record that first`)
    work.reviewedAt = new Date().toISOString()
    ok(`${id}: adversarial review done`)
  }
  // The lesson review. Allowed on a closed work, unlike the design gate: `close` names an
  // unreviewed work on its way out, and the catalogue a lesson lands in is still there.
  if (flags.learned) {
    if (work.abandonedAt) die(`${id} was abandoned — there is no finished story to learn from`)
    work.learnedAt = new Date().toISOString()
    ok(`${id}: lessons reviewed`)
  }
  // The user docs, edited to say how the product works now that the work has landed. Allowed
  // after the close for the lesson review's reason: the docs outlive the work's trees.
  if (flags.documented) {
    if (work.abandonedAt) die(`${id} was abandoned — nothing landed for the user docs to describe`)
    work.documentedAt = new Date().toISOString()
    ok(`${id}: user docs updated`)
  }
  // What landed and why it was worth doing: a statement on a date, like a gate, and allowed on a
  // closed work for the lesson review's reason. Recording it again replaces it.
  if (outcome) {
    if (work.abandonedAt) die(`${id} was abandoned — nothing landed to say the outcome of`)
    work.outcome = { text: outcome, at: new Date().toISOString() }
    ok(`${id}: outcome recorded`)
  }
  // Which gates the agent waits at from here on. Read once, just before each stop fires, so a
  // choice changed late has nothing it could have gone stale against.
  // Refused once the work has stopped, since it has no stop left to wait at.
  if (stops) {
    if (work.abandonedAt) die(`${id} was abandoned — it has no stops left to wait at`)
    if (work.closedAt) die(`${id} is closed — it has no stops left to wait at`)
    work.stops = stops
    ok(`${id}: stops ${stopsLabel(stops)}`)
  }
  // After the gates, so a gate refused leaves the doc as untouched as the record.
  if (title) {
    work.title = title
    retitleDoc(id, title)
    ok(`${id}: titled "${title}"`)
  }
  saveWork(cfg, work)
  // The doc this save commits, checked against its template, said and never refused on.
  for (const f of contextDocFindings(work)) warn(f.text)
}

// A work's context doc against the template it was made from, each as `path:line: problem`, so
// an editor opens it where it is (decision 205), and whether it counts among doctor's things to
// look at: a lost or moved heading does, a placeholder left is a chore and does not. Nothing when
// there is no doc to check.
function contextDocFindings (work, root = dataRoot()) {
  const file = path.join(recordDir(work.id, root), 'context.md')
  if (!exists(file)) return []
  const template = readText(path.join(toolRoot(), 'templates', 'context.md'))
  return contextDocProblems(readText(file), { template, designed: !!work.designedAt })
    .map(p => ({ text: `${file}:${p.line}: ${p.problem}`, counts: p.kind === 'heading' }))
}

// A work's notes: one row per decision a session took along the way — what, why, and a pointer
// at the evidence — in `notes.tsv` beside the context doc (decision 204). Appended and never
// read to be written, so the hundredth costs what the first did. A row is the shape of the
// file: one line a cell, tab-separated, so a cell that would break that is refused.
const NOTE_COLUMNS = ['at', 'stage', 'note', 'why', 'evidence', 'result']
// What a reviewer can open: a SHA, a PR (`owner/repo#5`), a URL, or a path or `file:line`, which
// carries a `/`, a `\`, a `:` or a `.`. A word with none of those, like "done", is a claim and
// not a pointer, and neither is anything with a space in it: a path with one is written `%20`.
const isPointer = p => !/\s/.test(p) && (/^[0-9a-f]{7,40}$/i.test(p) || /^([\w.-]+\/[\w.-]+)?#\d+$/.test(p) || /[/\\:.]/.test(p))

// The notes file, made with its header only by the command that finds it missing or empty, so
// two sessions taking a work's first note at once cannot truncate each other's. A `.gitattributes`
// beside it merges two machines' appends as both rows, rather than as a conflict at the end.
function notesFile (id) {
  const file = path.join(recordDir(id), 'notes.tsv')
  try {
    fs.writeFileSync(file, `${NOTE_COLUMNS.join('\t')}\n`, { flag: 'wx' })
    fs.writeFileSync(path.join(recordDir(id), '.gitattributes'), 'notes.tsv merge=union\n', { flag: 'a' })
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    if (fs.statSync(file).size === 0) fs.writeFileSync(file, `${NOTE_COLUMNS.join('\t')}\n`)
  }
  return file
}

// Whether a file ends in a newline, read from its last byte alone, so a row is never glued onto
// the end of one a hand left unfinished and the file is still never read.
function endsInNewline (file) {
  const size = fs.statSync(file).size
  if (!size) return true
  const fd = fs.openSync(file, 'r')
  try {
    const last = Buffer.alloc(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally { fs.closeSync(fd) }
}

cmds.note = ({ flags, positional }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const cell = (name, value) => {
    if (value === true) die(`--${name} needs its text`)
    const text = typeof value === 'string' ? value.trim() : ''
    if (/[\r\n\t]/.test(text)) die(`--${name} takes one line, with no tab — a note is one row`)
    return text
  }
  const note = positional.join(' ').trim()
  if (!note) die('rig note wants the note: what was chosen or done, in one line')
  if (/[\r\n\t]/.test(note)) die('the note takes one line, with no tab — a note is one row')
  const why = cell('why', flags.why)
  if (!why) die('a note needs --why: the reason, in plain words')
  const pointers = cell('evidence', flags.evidence).split(',').map(p => p.trim()).filter(Boolean)
  if (!pointers.length) die('a note needs --evidence: a pointer a reviewer can open — a SHA, a PR, file:line, a path or a URL')
  if (!pointers.every(isPointer)) die('--evidence is a pointer — a SHA, a PR, file:line, a path or a URL, several split by commas — not prose')
  const stage = cell('stage', flags.stage)
  // Said, never refused: a stage may be noted before it is declared.
  if (stage && work.stages.length && !work.stages.some(s => s.branch === stage)) warn(`${stage} is not one of ${work.id}'s stages — \`rig stage\` lists them`)
  if (work.closedAt) warn(`${work.id} is ${work.abandonedAt ? 'abandoned' : 'closed'} — this note comes after its story`)
  const row = [new Date().toISOString(), stage, note, why, pointers.join(','), cell('result', flags.result)]
  commitAs(work.id, note.length > 72 ? `${note.slice(0, 71)}…` : note)
  const file = notesFile(work.id)
  fs.appendFileSync(file, `${endsInNewline(file) ? '' : '\n'}${row.join('\t')}\n`)
  ok(`${work.id}: noted`)
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
  sayLiveSessions(cfg, work, [entry.path])

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
  // A PR gh could not read throws, and one gh answered with nothing is null; neither is a PR
  // nobody reviewed. Left as a plain null, that work leaves the review figures without a trace.
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
// The merged pull request on one branch of a work, as `rig close` and `rig backfill` store it:
// `{ pr, base }` once it merged and its facts were read, `{}` while it has not merged, and
// `{ error }` when GitHub or git would not say.
function mergedPrRecord (entry, branch) {
  let pr = null
  const prError = trackerFailure(() => { pr = github().prForBranch(entry.org, entry.repo, branch) })
  if (prError) return { error: prError }
  if (!pr || pr.state !== 'MERGED') return {}
  const { record, error } = terminalPr(entry, pr)
  return error ? { error } : { pr: record, base: pr.base || null }
}

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
  stages: (work.stages || []).map(st => ({ branch: st.branch, delivers: st.delivers || '', withdrawn: withdrawalOf(st) })),
  createdAt: work.createdAt || null,
  designedAt: work.designedAt || null,
  adversarial: typeof work.adversarial === 'boolean' ? work.adversarial : null,
  reviewedAt: work.reviewedAt || null,
  learnedAt: work.learnedAt || null,
  documentedAt: work.documentedAt || null,
  outcome: work.outcome ? { text: work.outcome.text, at: work.outcome.at } : null,
  stops: work.stops || null,
  agentDecided: work.agentDecided || [],
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
    ...(br.verified ? { verified: { branch: br.verified.branch, head: br.verified.head, base: br.verified.base, patchId: br.verified.patchId, at: br.verified.at } } : {}),
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
  Object.assign(out, { missing: s.missing, dirty: s.dirty, ahead: s.ahead, behind: s.behind, unpushed: s.unpushed })
  // A repo GitHub could not answer for says so, rather than reading as a repo with no PR.
  if (s.prError) out.prUnknown = s.prError
  else if (s.pr) {
    // Its title and body are for `rig pr --refresh` to compare, and its labels for `rig pr` to
    // read a bump from, not for a listing.
    const { title: _title, body: _body, labels: _labels, ...pr } = s.pr
    out.pr = pr
  } else out.pr = null
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

// Every work, least recently touched first, and any record that would not read (`readRecords`).
// ISO-8601 exists so that byte order is chronological order; decorate once rather than
// recomputing the key inside the comparator.
const worksByActivity = cfg => {
  const { works, unreadable } = readRecords(dataRoot(), id => loadWork(cfg, id))
  return {
    works: works.map(work => [activityAt(work), work])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, work]) => work),
    unreadable,
  }
}

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
const listPayload = (cfg, live) => {
  const { works, unreadable } = worksByActivity(cfg)
  sayUnreadable(unreadable, aside)
  return {
    recordFormat: MAJOR,
    release: releaseHere(),
    generatedAt: new Date().toISOString(),
    live,
    works: works.map(w => workJson(cfg, w, live)),
  }
}

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
  const live = !flags.quick

  if (flags.json) return say(JSON.stringify(listPayload(cfg, live), null, 2))

  const { works, unreadable } = worksByActivity(cfg)
  if (!works.length && !unreadable.length) return say('no works yet — `rig new <id> --title "..."`')
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
    // Nor does it look for a session still at work in a worktree, which `close` names: one
    // transcript scan per work is not what a listing is either. Said only where this machine
    // could have looked, since without transcript patterns `close` cannot either.
    const notChecked = [work.stages.length && 'stages', looksForSessions(cfg) && 'sessions'].filter(Boolean)
    const unchecked = notChecked.length ? ` (${notChecked.join(' and ')} not checked)` : ''
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
  sayUnreadable(unreadable)
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

// The work's own session transcripts, one path a line on stdout and nothing else there, for the
// lesson review to read (decision 201). What is said about them goes to stderr beside it.
// The workspaces are the work folder and its worktrees, so nothing of another work is found.
function workTranscripts (cfg, work, workspaces = [workDir(cfg, work.id), ...work.repos.map(r => r.path)]) {
  return transcriptsFor({
    patterns: transcriptPatterns(cfg),
    workspaces,
    home: env().USERPROFILE || env().HOME || os.homedir(),
  })
}

// The machine's transcript patterns, and why they cannot be read when they cannot: a misshapen
// value is a mistake to name, never the same as having none. Named, not died on, except where
// the transcripts are the whole answer (`rig status --transcripts`): a listing or a close must
// not stop on a machine setting it only reads in passing. `rig doctor` names it too.
function transcriptConfig (cfg) {
  const t = cfg.transcripts
  if (t === undefined || t === null) return { patterns: [] }
  if (!Array.isArray(t) || !t.every(p => typeof p === 'string' && p.trim())) {
    return { patterns: [], problem: `\`transcripts\` in ${localConfigFile()} must be a list of patterns, such as ["~/.claude/projects/{slug}/*.jsonl"]` }
  }
  return { patterns: t }
}
const transcriptPatterns = cfg => transcriptConfig(cfg).patterns

// Whether this machine could look for a session at all: a pattern that is refused finds nothing.
const looksForSessions = cfg => transcriptPatterns(cfg).some(p => !refusal(p))

// How long a session counts as still at work after it last wrote. A constant, not a setting,
// until someone needs it to vary.
const LIVE_SESSION_HOURS = 2

// The sessions that wrote in one of `workspaces` lately, named before `close`, `detach` or
// `tidy` takes a worktree from under them, and never refused on (decision 66): a clean worktree
// a session is about to write into looks exactly like an abandoned one, and only the session can
// say which. Said at the teardown, since rig speaks unasked nowhere earlier. The session running
// this command is left out where the machine names the variable that carries its id
// (`transcriptSession`): a host names a session's transcript, or its folder, by it.
function sayLiveSessions (cfg, work, workspaces) {
  const self = typeof cfg.transcriptSession === 'string' ? env()[cfg.transcriptSession] : null
  const since = Date.now() - LIVE_SESSION_HOURS * 3600 * 1000
  const ours = t => self && t.path.split(/[\\/]/).some(part => part === self || path.parse(part).name === self)
  const { problem } = transcriptConfig(cfg)
  if (problem) return warn(`${problem} — sessions not checked`)
  const { found, refused } = workTranscripts(cfg, work, workspaces)
  for (const r of refused) warn(`transcripts: "${r.pattern}" finds nothing: ${r.why}`)
  const live = found.filter(t => Date.parse(t.modifiedAt) >= since && !ours(t))
  for (const t of live) {
    const where = work.repos.find(r => r.path === t.workspace)?.repo || 'the work folder'
    warn(`${where}: a session wrote ${path.basename(t.path)} ${relativeAge(t.modifiedAt)} — it may still be working there`)
  }
  if (live.length && !self) say(C.dim(`  one of them may be this session — \`transcriptSession\` in ${localConfigFile()} names the variable carrying its id`))
}

function sayTranscripts (cfg, work) {
  const { problem } = transcriptConfig(cfg)
  if (problem) die(problem)
  const { found, refused } = workTranscripts(cfg, work)
  for (const r of refused) aside(C.yellow(`! transcripts: "${r.pattern}" finds nothing: ${r.why}`))
  if (!transcriptPatterns(cfg).length) {
    aside(C.dim(`· no transcript locations on this machine — \`transcripts\` in ${localConfigFile()}, such as "~/.claude/projects/{slug}/*.jsonl"`))
  }
  for (const t of found) say(t.path)
}

// The gate lines `rig status` marks as the agent's: `designed` is the design stop.
const STOP_OF_GATE = { designed: 'design' }
const agentDecided = (work, gate) => (work.agentDecided || []).includes(STOP_OF_GATE[gate])
const stopsLabel = stops => {
  const skipped = STOPPABLE.filter(n => !stops.includes(n))
  const waits = stops.join(' and ') || 'none'
  return skipped.length ? `${waits} — the agent decides ${skipped.map(n => STOP_WORDS[n]).join(' and ')}` : waits
}

cmds.status = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  if (typeof flags.transcripts === 'string') die('--transcripts takes no value')
  if (flags.transcripts) return sayTranscripts(cfg, work)
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
  for (const { gate, at } of gatesOf(work)) say(`  ${gate} ${at.slice(0, 10)}${agentDecided(work, gate) ? ' (agent decided)' : ''}`)
  if (work.agentDecided?.includes('repos')) say('  repos chosen (agent decided)')
  // Said whether or not the work chose, since absent is both and silence would say neither.
  say(`stops ${stopsLabel(work.stops ?? STOPPABLE)}`)
  if (work.outcome) say(`outcome ${work.outcome.text} ${C.dim(`(${work.outcome.at.slice(0, 10)})`)}`)
  // Named, not enumerated: `rig stage` is where the stack is read, and a status that
  // reprinted it would be two places to keep saying the same thing.
  if (work.stages.length) say(`stages ${work.stages.length} — \`rig stage\` for the stack`)
  say(`tickets ${ticketsLabel(work)}`)
  say(`context ${contextFile(id)}`)
  // Named for the lesson review, which asks for a doc only where there is none and writes it
  // where this says, and which may run after the work folder that inlines them is gone.
  for (const org of orgsOf(work)) {
    const doc = readOrgDoc(org)
    say(`org ${org} ${doc ? doc.file : C.dim(`no org doc — ${orgDocFile(org)}`)}`)
  }
  // The handoff is read by the next session, which may be on another machine, so it is named
  // where every machine can reach it: on the data root's remote, which `rig save` pushed it to
  // (hugoforte/rig#171). This machine's path only when there is no remote, and said as such.
  const handoff = path.join(recordDir(id), 'handoff.md')
  if (exists(handoff)) say(`handoff ${recordUrl(id, 'handoff.md') || `${handoff} ${C.dim('(this machine only — the data root has no remote)')}`}`)
  // The QA evidence — what was walked on a deployed environment and what was seen — named the
  // same way, since the user-docs edit and the digest read it after the work has moved on.
  const qa = path.join(recordDir(id), 'qa.md')
  if (exists(qa)) say(`qa ${recordUrl(id, 'qa.md') || `${qa} ${C.dim('(this machine only — the data root has no remote)')}`}`)
  // And the notes, which the lesson review and a pickup read as part of the story.
  const notes = path.join(recordDir(id), 'notes.tsv')
  if (exists(notes)) say(`notes ${recordUrl(id, 'notes.tsv') || `${notes} ${C.dim('(this machine only — the data root has no remote)')}`}`)
  say('')
  const checked = checkedRepos(work)
  work.repos.forEach((r, i) => {
    const v = verdict.repos[i]
    say(`${C.bold(r.repo)} ${C.dim(`(${r.org}, base ${baseLabel(states[i])})`)}`)
    say(`  path    ${r.path}${v.missing ? C.red('  MISSING') : ''}`)
    if (!v.missing) {
      say(`  changes ${v.dirty || 'none'}`)
      say(`  commits ${v.distanceUnknown ? `unknown (${v.distanceUnknown})` : `${v.ahead} ahead · ${v.behind} behind`}`)
    }
    // Only for a repo the catalogue says how to verify: one with no `check` has nothing a run
    // could prove, and `rig check` names where to write one. Said of a missing worktree too, since
    // a pass recorded on another machine is what a pickup reads.
    if (checked.includes(r)) say(`  checks  ${verificationLabel(r.repo, verificationOf(cfg, r, work))}`)
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
    // A command that never started, or was killed before it could exit, is no verdict, so the
    // answer is null rather than a failure: a check run must not clear a pass it never tested.
    const r = spawnSync(c, { cwd: dir, shell: true, stdio: 'inherit', env: env() })
    if (r.error || r.status === null) { warn(`${label} command did not run: ${c}${r.error ? ` (${r.error.message})` : ''}`); return null }
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
// the moment that knowledge is cheap (AGENTS.md rule 4). The catalogue holds the command,
// never a verdict. What a run proved is the work's: a pass is recorded against the patch it
// ran at, a failure clears it and reaches the caller as the exit code (decision 199).
cmds.check = ({ flags, positional }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  // Repo selection reads like `setup`'s twice over on purpose: two are a coincidence, and
  // the third is when it earns a name of its own.
  const targets = positional.length
    ? work.repos.filter(r => positional.some(p => p.toLowerCase() === r.repo.toLowerCase()))
    : work.repos
  if (!targets.length) die('no matching attached repos')
  // A run records, so a stopped work refuses one, as `rig pr` refuses to open a PR on it.
  if (flags.run && work.closedAt) die(`${work.id} is ${work.abandonedAt ? 'abandoned' : 'closed'} — there is nothing left to verify`)
  const catalog = loadCatalog()
  const changed = { verified: [], cleared: [] }
  for (const r of targets) {
    const cat = catalogEntryFor(catalog, r)
    if (!cat?.check?.length) {
      warn(`${r.repo}: no check commands in the catalogue — add \`check:\` to ${catalogFile(r.org, r.repo)}`)
      continue
    }
    if (flags.run) {
      if (!exists(r.path)) {
        warn(`${r.repo}: not on this machine — \`rig restore ${work.id}\`, then run it; what was recorded stands`)
        current.exitCode = 1
        continue
      }
      // Read before the run, so what the run itself writes — a coverage folder, a regenerated
      // snapshot — neither blocks the record nor is taken for what was proved.
      const before = { uncommitted: git(r.path, 'status', '--porcelain', '--untracked-files=no').out, patch: trees(cfg).patch({ dir: r.path, base: r.base }) }
      const result = runCatalogCommands(r.path, cat.check, 'check')
      if (result !== true) current.exitCode = 1
      const change = recordVerification(r, work, result, before)
      if (change) changed[change].push(r.repo)
      continue
    }
    say(`${C.bold(r.repo)} ${C.dim(`(not run — \`rig check ${r.repo} --run\`)`)}`)
    for (const c of cat.check) say(`  ${c}`)
  }
  const said = Object.entries(changed).filter(([, repos]) => repos.length).map(([what, repos]) => `${what} ${repos.join(', ')}`)
  if (said.length) {
    commitAs(work.id, said.join('; '))
    saveWork(cfg, work)
  }
}

// When the work's `handoff.md` was last committed into the data root, as git has it, since a
// file's own date on a fresh clone is the clone's. Null with no handoff, or one never committed.
function handoffAt (id) {
  const file = path.join(recordDir(id), 'handoff.md')
  if (!exists(file)) return null
  // `icase`, since the file system found it whatever its case and git's pathspec would not.
  const r = git(dataRoot(), 'log', '-1', '--format=%cI', '--', `:(icase)${path.relative(dataRoot(), file).split(path.sep).join('/')}`)
  return r.code === 0 && r.out ? r.out : null
}

// The newest commit of the work's own on any branch checked out here: what HEAD has over the
// base it lands on. HEAD's own date would be the base's tip on a branch with nothing of its own
// yet, and a fast-forward of the base would read as the pickup having started. Null with none.
function lastWorkCommitAt (work, states) {
  return work.repos.map((r, i) => {
    if (!exists(r.path)) return null
    const base = states[i]?.base || r.base
    const own = git(r.path, 'log', '-1', '--format=%cI', `refs/remotes/origin/${base}..HEAD`)
    return own.code === 0 && own.out ? own.out : null
  }).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b)).pop() || null
}

// The attached repos whose catalogue entry says how to verify them, read in one scan; a repo
// with no `check` has nothing a run could prove.
function checkedRepos (work) {
  const catalog = loadCatalog()
  return (work.repos || []).filter(r => catalogEntryFor(catalog, r)?.check?.length)
}

// Whether what a repo carries now is what its checks last passed at: `verified` while the
// branch checked out is the one that passed and its patch-id is the one recorded, whatever
// happened to the head (a reworded commit, a rebase that left the diff alone); `stale` once the
// diff changed; `elsewhere` when the pass is for another branch than the one checked out;
// `unverified` with no pass recorded; `away` when the worktree is not on this machine, so the
// pass stands uncompared; `unknown`, with the reason, when git could not say what it carries.
function verificationOf (cfg, entry, work) {
  const recorded = workBranch(entry, work)?.verified
  if (!recorded) return { state: 'unverified' }
  if (!exists(entry.path)) return { state: 'away', recorded }
  // The same head on the same branch carries the same patch, so the diff is read and hashed only
  // when something moved: a work with a large binary in it pays for that once, not on every look.
  const head = git(entry.path, 'rev-parse', 'HEAD')
  const on = git(entry.path, 'symbolic-ref', '-q', '--short', 'HEAD')
  if (head.code === 0 && head.out === recorded.head && on.code === 0 && on.out === recorded.branch) return { state: 'verified', recorded }
  const now = trees(cfg).patch({ dir: entry.path, base: entry.base })
  if (now.error) return { state: 'unknown', recorded, error: now.error }
  if (now.branch !== recorded.branch) return { state: 'elsewhere', recorded, on: now.branch }
  return { state: now.patchId === recorded.patchId ? 'verified' : 'stale', recorded }
}

// What `rig next` is told: a pass for another branch is no pass for this one, and one it could
// not compare is not offered a run.
const verificationState = v => ({ elsewhere: 'unverified', away: 'unknown' })[v.state] || v.state

const verificationLabel = (repo, v) => ({
  verified: () => `verified at ${v.recorded.head.slice(0, 7)} on ${v.recorded.at.slice(0, 10)}`,
  stale: () => `stale — the diff changed since it passed at ${v.recorded.head.slice(0, 7)}; \`rig check ${repo} --run\``,
  elsewhere: () => `not verified on ${v.on || 'a detached HEAD'} — the pass recorded is for ${v.recorded.branch}; \`rig check ${repo} --run\``,
  unverified: () => `not verified — \`rig check ${repo} --run\``,
  away: () => `verified at ${v.recorded.head.slice(0, 7)} on ${v.recorded.at.slice(0, 10)}, not compared — the worktree is not on this machine`,
  unknown: () => `unknown — ${v.error}`,
})[v.state]()

// What a run proved, kept on the work branch's record as `verified`: the branch it ran on, the
// head, where that leaves the base, the patch-id of the diff between them, and the date —
// `before` is all of that read before the run, with whatever was uncommitted then. A pass is
// recorded only for what was committed, since uncommitted changes are in no patch anyone can
// compare with later, and only on a branch, since a detached HEAD is in no PR. A failure clears
// what passed, which is no longer the latest word on the repo; a run that never started is no
// word at all. Answers `verified`, `cleared`, or null when the record is as it was.
function recordVerification (entry, work, result, before) {
  const record = workBranch(entry, work)
  if (result === null) {
    say(C.dim(`  ${entry.repo}: the checks did not run — nothing recorded or cleared`))
    return null
  }
  if (result === false) {
    if (!record?.verified) return null
    delete record.verified
    say(C.dim(`  ${entry.repo}: the pass recorded before is cleared`))
    return 'cleared'
  }
  if (before.uncommitted) {
    // `XY path` a line; the output comes trimmed, so the status is read as a word, not columns.
    const files = before.uncommitted.split('\n').map(l => l.trim().replace(/^\S+\s+/, '')).filter(Boolean)
    say(C.dim(`  ${entry.repo}: passed with uncommitted changes (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}), which are in no patch — not recorded; commit, then run it again`))
    return null
  }
  const { patch } = before
  if (patch.error) {
    warn(`${entry.repo}: passed, but git could not say what it passed at (${patch.error}) — not recorded`)
    return null
  }
  if (!patch.branch) {
    say(C.dim(`  ${entry.repo}: passed on a detached HEAD, which is in no PR — not recorded; check out a branch of this work, then run it again`))
    return null
  }
  ensureBranchRecord(entry, work.branch, entry.base).verified = { ...patch, at: new Date().toISOString() }
  ok(`${entry.repo}: verified at ${patch.head.slice(0, 7)} on ${patch.branch}`)
  return 'verified'
}

// Catalogue only, exactly as decision 27 has it for the interview: no code is read, so the
// offer is visibly only as good as the catalogue, and a thin one produces a thin offer rather
// than a confident wrong answer. The traversal itself is `unattached` in bin/catalog-graph.mjs.
function unattachedNeighbours (work) {
  const catalog = loadCatalog()
  return catalog.length ? unattached(catalog, (work.repos || []).map(r => r.repo)) : []
}

// Where each attached repo's user docs live, from its catalogue entry. A repo with no entry
// carries the file one would go in, since `rig catalog` has nothing to name for it.
function docsTargets (work) {
  const catalog = loadCatalog()
  return (work.repos || []).map(r => {
    const entry = catalogEntryFor(catalog, r)
    return entry ? { repo: r.repo, targets: entry.docs } : { repo: r.repo, targets: [], missing: catalogFile(r.org, r.repo) }
  })
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
  // `workState` answers the verdict half and the worktree state answers `pushed` and `on`;
  // joined here rather than in either, because "is this branch on the remote" and "which
  // branch is checked out" are not questions about whether the work is finished.
  const repos = verdict.repos.map((v, i) => ({ ...v, pushed: !!states[i].pushed, on: states[i].on ?? null }))

  const doc = exists(contextFile(work.id)) ? readText(contextFile(work.id)) : ''
  const handedOff = handoffAt(work.id)
  const offers = nextFor({
    work,
    repos,
    // The scaffolded stub, still standing where the design should be.
    directionTodo: directionIsTodo(doc),
    prUnwritten: !pullRequestSaid(doc),
    planExists: exists(planFile(work.id)),
    // Never while a stage's PR is unknown: the refresh would write "PR state unknown" over a
    // deploy order that may be right.
    planStale: !unknownStages(stack).length && exists(planFile(work.id)) && planIsStale(readText(planFile(work.id)), stack),
    stack,
    // The comparison `rig pr --refresh` makes, and never while a stage's PR is unknown, which
    // is when the refresh would refuse. Nor for a repo whose visibility GitHub would not say: a
    // body without the context doc is then no evidence the PR is wrong.
    prStale: unknownStages(stack).length ? []
      : repos.filter((r, i) => {
        if (r.pr?.state !== 'OPEN') return false
        const spec = repoSpec(work.repos[i])
        const link = mayLink(spec)
        return link !== null && !prSaysRecord(r.pr, prText(work, stack, { spec, link }))
      }).map(r => r.repo),
    replaced: replacedStages(cfg, work, stack),
    leftover: leftHere(cfg, work),
    // Asked of a repo with no PR, which is the only kind the offer it goes beside can name.
    bumps: work.closedAt ? [] : repos.flatMap((r, i) => {
      const release = !r.pr && !r.merged && r.pushed ? releaseAsked(work.repos[i], work.branch) : null
      return release ? [{ repo: r.repo, release }] : []
    }),
    // Only this work's repos, not the whole catalogue: `doctor` reports every draft in the
    // root, and the question here is what is available on the work in hand.
    drafts: draftEntries(work),
    neighbours: unattachedNeighbours(work),
    verification: checkedRepos(work).map(r => ({ repo: r.repo, state: verificationState(verificationOf(cfg, r, work)) })),
    handoffAt: handedOff,
    lastCommitAt: handedOff ? lastWorkCommitAt(work, states) : null,
    // Only once everything has merged, the one time the offer it feeds is made.
    docs: repos.length && repos.every(r => r.merged) ? docsTargets(work) : [],
    // Only what `rig stage --link` would link: an answer GitHub will not give offers nothing.
    unstacked: work.repos.filter(entry => {
      const s = stageStack(stack, entry, work.branch)
      return !!s && !s.unknown && !s.problem && !s.linked
    }).map(entry => entry.repo),
    // One more lookup per open work-branch PR, and only here: `rig next` is the one command
    // that walks a PR through its review. Only while it is in review: a stopped work keeps its
    // PRs open by design and has nothing to ask.
    reviews: phaseOf(work, repos) !== 'reviewing' ? [] : repos.flatMap((r, i) => {
      if (r.pr?.state !== 'OPEN' || !r.pr.number) return []
      const { org, repo: name } = work.repos[i]
      const review = github().prReview(org, name, r.pr.number)
      const checks = review?.checks ?? null
      if (!['FAILURE', 'ERROR'].includes(checks)) return [{ repo: r.repo, unresolved: review?.unresolved ?? null, checks }]
      // Whether the base moved past the branch: `rig pr`'s base check (#208), asked here for a
      // failing PR only, since that is the one offer that turns on it. Against the PR's live
      // base, which a retargeted PR has moved off the recorded one. Fetched first, quietly and
      // never as a first clone; a count the fetch could not bring forward is no count.
      const entry = work.repos[i]
      const base = states[i].base || workBranch(entry, work)?.base || entry.base
      const t = trees(cfg)
      const standing = t.refresh({ org, repo: name }) ? t.standing({ org, repo: name, branch: work.branch, base }) : null
      return [{ repo: r.repo, unresolved: review?.unresolved ?? null, checks, base, behind: standing ? standing.behind : null }]
    }),
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
    for (const line of [].concat(o.command || [])) say(`    ${C.dim(line)}`)
  }
}

// What `worktrees.replaced` answers for each merged stage, asked about the stages above it that
// the same repo carries and has not merged. Only `rig next` asks, the one command that already
// reads the stack and offers what to do about it.
function replacedStages (cfg, work, stack) {
  const found = []
  stack.forEach((st, i) => {
    for (const pr of st.prs.filter(p => p.state === 'MERGED')) {
      const entry = work.repos.find(r => r.repo === pr.repo)
      const above = stack.slice(i + 1)
        .filter(up => up.repos.includes(pr.repo) && !up.prs.some(p => p.repo === pr.repo && p.state === 'MERGED'))
        .map(up => up.branch)
      if (!entry || !above.length) continue
      const r = trees(cfg).replaced({ org: entry.org, repo: entry.repo, work: work.branch, head: pr.head, merge: pr.merge, above })
      if (r) found.push({ repo: entry.repo, branch: st.branch, head: pr.head, ...r })
    }
  })
  // Two squashed stages in a row are both carried by the stage above them, and the higher one's
  // rebase is the one that replays only that stage's own commits, so the lower one is dropped.
  const overlap = (a, b) => a.repo === b.repo && (a.carriers || []).some(c => (b.carriers || []).includes(c))
  return found.filter((f, i) => !found.slice(i + 1).some(g => overlap(f, g)))
}

// The Direction section of a context doc. Measured against the real data root when slicing it
// by regex was found wrong (`sectionOf` says how): two of forty-six context docs truncated, one
// of them losing 6,300 of 17,500 characters at the word `listHostedZones`.
const directionSection = text => sectionOf(text, 'Direction')

// What a section actually says: its prose with the template's guidance comments stripped.
// Every reader below goes through this, so none can disagree with another about whether a
// section that is only a comment and a stub counts as written.
const sectionSaid = (text, name) => sectionOf(text, name).replace(/^\s*<!--[\s\S]*?-->\s*$/gm, '').trim()
const directionSaid = text => sectionSaid(text, 'Direction')

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

// What the work delivers, written for the reviewer and for whoever reads the release note: the
// context doc's `## Pull request` section, its own headings lifted a level so they head the
// body. The Direction is the design agreed at the gate, written for whoever builds it, and by
// the time a PR opens it reads as instructions to the implementer (hugoforte/rig#314). Empty
// when the doc has no such section, or one that says nothing: only the template's comment, or
// only `_TODO_`, which would publish a stub in place of the Direction.
const pullRequestSaid = text => {
  const said = sectionSaid(text, 'Pull request')
  return said === '_TODO_' ? '' : promoteHeadings(said)
}
const pullRequestProse = id => (exists(contextFile(id)) ? pullRequestSaid(readText(contextFile(id))) : '')

// The PR body rig writes: what the work is, the ticket, what it delivers, and what landed in
// which order. Everything in it is already recorded somewhere — the point is that it is
// assembled rather than retyped, and that the stage table is rendered from the stack rather
// than hand-maintained, which is the whole complaint against the rollout plan.
//
// Written for one repo, `spec`: which tickets its merge closes, and whether the context doc may
// be linked from it (`link`, from `mayLink`), are both questions about that repo.
function prBody (work, stack, { spec, link }) {
  const lines = []
  if (work.title) lines.push(work.title, '')
  const fixes = closedByPr(work, stack, spec)
  const named = (work.tickets || []).filter(k => !fixes.includes(k))
  if (fixes.length || named.length) {
    lines.push(...fixes.map(k => `Fixes ${k}`), ...(named.length ? [`Tickets: ${named.join(', ')}`] : []), '')
  }

  // The Pull request section in place of the Direction, never beside it: two accounts of one
  // work, written at different times, would disagree in the one place a reviewer reads first.
  const delivers = pullRequestProse(work.id)
  const direction = delivers ? '' : directionProse(work.id)
  if (delivers) lines.push(delivers, '')
  if (direction) lines.push('## Direction', '', direction, '')

  // The same renderer the rollout plan uses. Two generators would be two tables that disagree,
  // and a table that disagrees with itself is how this document got its reputation.
  if (stack.length) lines.push('## Stages', '', stageTable(stack), '')

  if (link) lines.push(`Context doc: ${contextDocRef(work.id)}`)
  return lines.join('\n').trimEnd()
}

// The tickets a work's PR into `spec` closes as it merges, with a `Fixes` line each: the work's
// own GitHub tickets in that repo, and only when it is the work's one repo, because then merging
// the PR is the work landing. In a work of several repos one PR's merge is not, and a keyword
// would close the ticket before `rig close` can say whether everything landed. A stage's own
// key merges into the work branch, where no keyword fires, and a work ticket that is also the
// key of a withdrawn slice is told why at `rig close` and left open (decision 126). None at all
// while a declared slice has not landed: merging then is not the work landing either, and
// `rig next` offers the refresh that adds them once every slice is in.
function closedByPr (work, stack, spec) {
  if (work.repos.length !== 1) return []
  if (stack.some(st => !st.landed && !st.withdrawn)) return []
  const withdrawn = work.stages.filter(withdrawalOf).flatMap(st => st.tickets || [])
  return (work.tickets || []).filter(k => isGithubKey(k) && !withdrawn.includes(k) &&
    k.split('#')[0].toLowerCase() === spec.toLowerCase())
}

const repoSpec = entry => `${entry.org}/${entry.repo}`

// Everything `rig pr` writes into one repo's pull request, rendered from the record as it
// stands. The one renderer for opening a PR, refreshing it, and asking whether an open one has
// gone stale, so the three cannot disagree about what the PR should say.
const prText = (work, stack, { spec, link }) => ({ title: work.title || work.id, body: prBody(work, stack, { spec, link }) })

// Which release a work PR asks for, and why — "a minor release (the branch prefix `feat/`)" —
// as the `version` check's own `bumpFor` reads it (decision 130). Null on a repo that does not
// release by bump (`releasesByBump`) or whose labels GitHub would not list, where the line
// could be false, and for a branch that names no bump.
function releaseAsked (entry, branch, prLabels = []) {
  let labels = null
  trackerFailure(() => { labels = github().labels(entry.org, entry.repo) })
  if (!labels || !releasesByBump(labels)) return null
  const { bump, reason } = bumpFor({ branch, labels: prLabels })
  if (!bump) return null
  return `${bump === 'none' ? 'no release' : `a ${bump} release`} (${reason})`
}

// Does an open PR still say what `rig pr` would write now? GitHub may hand a body back with
// CRLF line ends or without the trailing newline, and neither is a difference worth an edit.
const sameText = (a, b) => (a ?? '').replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim()
const prSaysRecord = (pr, text) => sameText(pr.title, text.title) && sameText(pr.body, text.body)

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
  if (flags.refresh) return refreshPrs(work, stack)
  // A body is public and GitHub keeps its edit history, so a stage table that would say "PR
  // state unknown" is not published (decision 171). Asked once, before anything is fetched.
  const unknown = unknownStages(stack).map(st => st.branch)
  if (unknown.length) return warn(`GitHub would not say what became of ${unknown.join(', ')} — not opening a PR`)

  const checked = checkedRepos(work)
  for (const entry of work.repos) {
    const state = repoState(cfg, entry, work.branch)
    // Said beside the PR rather than instead of it: the PR is opened from the remote's work
    // branch, which is right, and the worktree is what is behind.
    if (onLandedStage(stack, state.on)) warn(`${entry.repo}: the worktree is still on ${state.on}, a stage that has landed — ${backToWorkBranch(work).map(c => `\`${c}\``).join(', then ')}`)
    if (state.prError) { warn(`${entry.repo}: GitHub would not say whether a PR exists (${state.prError}) — not opening one`); continue }
    const sayRelease = labels => {
      const release = releaseAsked(entry, work.branch, labels)
      if (release) step(`${entry.repo}: this PR asks for ${release}`)
    }
    if (state.pr && state.pr.state === 'OPEN') {
      step(`${entry.repo}: PR #${state.pr.number} is already open — ${state.pr.url}`)
      // Worth saying of a PR already open too: a label can still change it before it merges.
      sayRelease(state.pr.labels)
      continue
    }
    if (state.pr && state.pr.state === 'MERGED') { step(`${entry.repo}: PR #${state.pr.number} already merged`); continue }
    if (!state.pushed) { warn(`${entry.repo}: ${work.branch} is not on the remote yet — push it first`); continue }

    // The base is the one this repo's work branch was cut from. A stage's PR is not rig's to
    // open: a stage is reviewed on its own, in the repo it touches, and rig would have to
    // guess which of the stack you meant.
    const base = workBranch(entry, work)?.base || entry.base
    sayStanding(cfg, entry, work.branch, base)
    // Said, never stopped at, like the base: a reviewer may well want the PR before the checks.
    const verified = checked.includes(entry) && verificationOf(cfg, entry, work)
    // The PR is the work branch's, so a pass the worktree recorded on a stage it has checked
    // out is no pass for it.
    const forThisPr = verified?.state === 'verified' && verified.recorded.branch !== work.branch
    if (verified && (forThisPr || ['stale', 'elsewhere', 'unverified'].includes(verified.state))) step(`${entry.repo}: no check has passed at this patch — \`rig check ${entry.repo} --run\``)
    if (verified?.state === 'unknown') step(`${entry.repo}: could not tell whether a check passed at this patch (${verified.error})`)
    const spec = repoSpec(entry)
    const text = prText(work, stack, { spec, link: linkOrSay(spec) })
    let made = null
    const failed = trackerFailure(() => { made = github().createPr(entry.org, entry.repo, { branch: work.branch, base, ...text }) })
    if (failed) { warn(`${entry.repo}: could not open a PR (${failed})`); continue }
    ok(`${entry.repo}: PR #${made.number} → ${base}  ${C.dim(made.url)}`)
    sayRelease([])
  }
}

// How far the base has moved past the work branch, and whether the branch conflicts with it,
// said before its PR is opened (hugoforte/rig#208). The mirror is fetched here, at the one
// moment the answer matters, because nothing else on the way to a PR fetches: the stack is read
// without a network round trip. Said and never stopped at (decision 66): the PR opens either way,
// and GitHub would say the same a minute later, only after review had begun. A base that moved
// is ordinary in a busy repo and is only said; a conflict is something to act on, and warned.
function sayStanding (cfg, entry, branch, base) {
  const t = trees(cfg)
  t.fetch({ org: entry.org, repo: entry.repo })
  const standing = t.standing({ org: entry.org, repo: entry.repo, branch, base })
  if (!standing) return
  const { behind, conflicts, error } = standing
  if (behind) step(`${entry.repo}: base moved — ${base} has ${behind} commit${behind === 1 ? '' : 's'} this branch does not`)
  if (error) warn(`${entry.repo}: could not test-merge ${branch} with ${base}: ${error}`)
  else if (conflicts.length) warn(`${entry.repo}: ${branch} conflicts with ${base} in ${conflicts.join(', ')} — \`git merge origin/${base}\` in the worktree, then push`)
}

// `rig pr --refresh`: each repo's open PR rewritten with `prText`. One that already says it is
// left alone, and a refresh never opens one. A stage GitHub would not answer for renders as
// "PR state unknown", so nothing is refreshed until it does, rather than writing that over a
// table that was right.
function refreshPrs (work, stack) {
  const unknown = unknownStages(stack).map(st => st.branch)
  if (unknown.length) return warn(`GitHub would not say what became of ${unknown.join(', ')} — nothing refreshed`)
  for (const entry of work.repos) {
    const { pr, prError } = prAndBase(entry, work.branch)
    if (prError) { warn(`${entry.repo}: GitHub would not say whether a PR is open (${prError}) — nothing refreshed`); continue }
    if (pr?.state !== 'OPEN') { step(`${entry.repo}: no open PR — nothing to refresh`); continue }
    const spec = repoSpec(entry)
    const text = prText(work, stack, { spec, link: linkOrSay(spec) })
    if (prSaysRecord(pr, text)) { step(`${entry.repo}: PR #${pr.number} is already up to date`); continue }
    const failed = trackerFailure(() => github().editPr(entry.org, entry.repo, pr.number, text))
    if (failed) { warn(`${entry.repo}: could not refresh PR #${pr.number} (${failed})`); continue }
    ok(`${entry.repo}: PR #${pr.number} refreshed from the record  ${C.dim(pr.url)}`)
  }
}

// Every branch of this work that every repo carries, flat: one `{ repo, branch, base, cutOn, pr }`
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
    // costs nothing extra, and a row survives only if a pull request answers for it — or GitHub
    // would not say, since it may have landed. That row is marked `absent`, and `stageState`
    // counts it as unknown and never as a branch this repo carries.
    for (const b of declared) if (!known.has(b)) known.set(b, { branch: b, base: null, absent: true })
    for (const b of known.values()) {
      let pr = null
      const prError = trackerFailure(() => { pr = github().prForBranch(entry.org, entry.repo, b.branch) })
      const recorded = b.pr ? { ...b.pr, state: 'MERGED', recorded: true } : null
      const absent = Boolean(b.absent && !pr && !recorded)
      if (absent && !prError) continue
      rows.push({
        repo: entry.repo,
        branch: b.branch,
        // The live base wins when GitHub answered; git, then the record, is the fallback.
        base: (!prError && pr?.base) || b.base,
        // What the branch sits on now, for the checks that refuse over it: an open pull request's
        // base, and git's otherwise. A closed one's base is where it sat when it closed, and a
        // rebase since is the usual reason it closed.
        cutOn: (!prError && pr?.state === 'OPEN' && pr.base) || b.base,
        pr: pr || recorded,
        prError: prError || null,
        absent,
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

  if (flags.land) return landStages(cfg, work, branch, flags)
  if (flags.link) return linkStages(cfg, work, branch, flags)
  if (flags.planned) return replanStage(cfg, work, branch, flags)
  if (flags.dropped !== undefined || flags['replaced-by'] !== undefined) return withdrawStage(cfg, work, branch, flags)

  if (branch) {
    if (typeof flags.delivers === 'string' && /[\r\n]/.test(flags.delivers)) die('--delivers takes one line — it goes in a table row')
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
    } else if (flags.cut && withdrawalOf(declared)) {
      die(`${branch} was withdrawn from the plan (${withdrawnLabel(withdrawalOf(declared))}) — there is nothing to cut`)
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
    const mark = st.landed ? C.green('✓') : st.withdrawn ? C.dim('✕') : st.open ? C.cyan('·') : st.started ? C.dim('·') : st.prUnknown ? C.yellow('?') : C.dim('○')
    say(`  ${mark} ${i + 1}. ${C.bold(st.branch)}${st === upNext ? C.dim('  ← next') : ''}`)
    if (st.delivers) say(`       ${st.delivers}`)
    if (st.tickets.length) say(`       ${C.dim(st.tickets.join(', '))}`)
    if (st.withdrawn) say(`       ${C.dim(`${withdrawnLabel(st.withdrawn)} (${st.withdrawn.at.slice(0, 10)})`)}`)
    if (st.started) say(`       ${C.dim(st.repos.join(', '))}`)
    // Not while GitHub would not say: the branch may be gone because the stage landed.
    else if (!st.withdrawn && !st.prUnknown) say(`       ${C.dim('not cut in any repo yet')}`)
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

// `--dropped` and `--replaced-by`: a declared stage withdrawn from the plan (decision 126). Only
// a stage with no pull request open or merged, so a withdrawn stage never has work in review or
// in the work branch that the record then says is gone.
function withdrawStage (cfg, work, branch, flags) {
  const { dropped, 'replaced-by': by } = flags
  if (!branch) die('--dropped and --replaced-by name the stage: `rig stage <branch> --dropped "why"`')
  if (dropped !== undefined && by !== undefined) die('--dropped and --replaced-by are alternatives; pass one')
  if (flags.cut || flags.key !== undefined || flags.delivers !== undefined) die('--dropped and --replaced-by withdraw a stage, and take nothing else')
  if (dropped === true || (dropped !== undefined && !dropped.trim())) die('--dropped needs the reason')
  if (dropped !== undefined && /[\r\n]/.test(dropped)) die('--dropped takes the reason in one line — it goes in a table row')
  if (by === true) die('--replaced-by needs the branch of the stage that replaced it')
  const declared = work.stages.find(s => s.branch === branch) || die(`${branch} is not a stage of ${work.id}`)
  if (by === branch) die(`${branch} cannot replace itself`)
  if (by !== undefined) {
    const replacement = work.stages.find(s => s.branch === by)
    if (!replacement) die(`${by} is not a stage of ${work.id} — declare it first: \`rig stage ${by} --delivers "..."\``)
    if (withdrawalOf(replacement)) die(`${by} was withdrawn itself (${withdrawnLabel(withdrawalOf(replacement))}) — name the stage that did the work`)
  }
  const replaced = work.stages.filter(s => s.replacedBy === branch && s.replacedAt).map(s => s.branch)
  if (replaced.length) die(`${replaced.join(', ')} was replaced by ${branch} — withdraw that first, or the record says the work went nowhere`)
  const rows = branchRows(cfg, work)
  const st = stackOf(work, rows).find(s => s.branch === branch)
  const merged = st.prs.filter(pr => pr.state === 'MERGED')
  const open = st.prs.filter(pr => pr.state === 'OPEN')
  if (merged.length) die(`${branch} has landed in ${merged.map(pr => pr.repo).join(', ')} — it is in ${work.branch}, so it cannot be withdrawn`)
  if (open.length) die(`${branch} has ${open.map(pr => `PR #${pr.number} open in ${pr.repo}`).join(', ')} — close it first, then withdraw the stage`)
  if (st.prUnknown) die(`GitHub would not say whether ${branch} has a PR in ${st.prUnknown.join(', ')} — nothing recorded`)
  // A stage cut on this one carries its commits, so they would land with it while the record
  // said they were gone.
  const live = new Set(work.stages.filter(s => !withdrawalOf(s)).map(s => s.branch))
  const above = rows.filter(r => r.cutOn === branch && live.has(r.branch))
  if (above.length) die(`${above.map(r => `${r.branch} is cut on it in ${r.repo}`).join(', ')} — rebase that off ${branch} first`)
  const reason = dropped?.trim()
  // A second withdrawal replaces the first: the date that matters is the current decision's.
  for (const k of ['droppedAt', 'reason', 'replacedAt', 'replacedBy']) delete declared[k]
  const at = new Date().toISOString()
  Object.assign(declared, by !== undefined ? { replacedAt: at, replacedBy: by } : { droppedAt: at, reason })
  const done = by !== undefined ? `${branch} replaced by ${by}` : `${branch} dropped`
  commitAs(work.id, done)
  saveWork(cfg, work)
  ok(`${work.id}: stage ${C.bold(branch)} ${withdrawnLabel(withdrawalOf(declared))}`)
}

// `--link`: each repo's open stage pull requests registered as one GitHub stack on the work
// branch, with `gh stack link` (decision 152). It writes nothing into the record, so it commits
// nothing, and every repo is a report: a repo that cannot be linked is said and the next is
// tried. Without `gh stack` the base branches still carry the stack, so its absence is said and
// never fatal. A repo whose stacks GitHub would not list is linked all the same: a link only
// ever makes a stack or grows the one that holds these PRs.
function linkStages (cfg, work, branch, flags) {
  if (branch) die('--link registers every stage at once, and takes no branch: `rig stage --link`')
  const others = ['dropped', 'replaced-by', 'cut', 'key', 'delivers', 'planned'].filter(k => flags[k] !== undefined)
  if (others.length) die(`--link registers the stages as they are, and takes nothing else (${others.map(k => `--${k}`).join(', ')})`)
  if (!work.stages.length) die(`${work.id} has no stages — there is nothing to link`)
  const stack = stackOf(work, branchRows(cfg, work))
  let tool = null
  for (const entry of work.repos) {
    const s = stageStack(stack, entry, work.branch)
    if (!s) { step(`${entry.repo}: fewer than two stage PRs open — nothing to stack`); continue }
    if (s.problem) { warn(`${entry.repo}: not linked — ${s.problem}`); continue }
    const numbers = s.prs.map(pr => `#${pr.number}`).join(', ')
    if (s.linked) { step(`${entry.repo}: already GitHub stack #${s.stack.number}`); sayStackMerge(s.stack.number); continue }
    // Asked once, at the first repo that needs it, and said once; every later repo is still
    // reported, and none of them can be linked either.
    if (!tool) {
      const failed = trackerFailure(() => { tool = github().stackTool() })
      if (failed) tool = 'unasked'
      if (failed) warn(`could not ask gh about gh stack (${failed})`)
      else if (tool === 'missing') warn('gh stack is not installed — `gh extension install github/gh-stack`; the base branches already carry the stack')
      else if (tool === 'old') warn('gh stack has no `link` — `gh extension upgrade gh-stack`; the base branches already carry the stack')
    }
    if (tool !== 'ok') { step(`${entry.repo}: ${numbers} not linked`); continue }
    const failed = trackerFailure(() => github().linkStack(entry.org, entry.repo, { base: work.branch, urls: s.prs.map(pr => pr.url) }))
    if (failed) { warn(`${entry.repo}: could not link ${numbers} (${failed})`); continue }
    // Read back rather than trusted: `gh stack link` can succeed and leave a PR out.
    const made = stageStack(stack, entry, work.branch)
    if (made.linked) {
      ok(`${entry.repo}: ${numbers} are GitHub stack #${made.stack.number}`)
      sayStackMerge(made.stack.number)
    } else if (made.unknown) {
      ok(`${entry.repo}: ${numbers} linked; GitHub would not list its stacks to say which`)
      sayStackMerge('<n>')
    } else warn(`${entry.repo}: gh stack link ran, and ${numbers} are still not one stack${made.problem ? ` — ${made.problem}` : ''}`)
  }
}

// `--land`: the stages merged down into the work branch, with a merge commit, and never past it
// (decision 207). With a branch, that stage and every stage below it; without, every stage
// still to land. Anything may merge into a work branch, and nothing merges out of one but the
// human merging the work PR, so the lowest PR in each repo must be based on the work branch,
// and the work PR is never asked about.
//
// Every repo is checked before any repo merges, because a stage spans repos: a refusal in one
// lands nothing anywhere. A stage PR is refused while it is a draft, while its checks have not
// passed, while changes are requested on it, and while a review asked for is not given, since
// a human reviewing a stage makes its merge theirs. Two or more open stage PRs in a repo land as
// GitHub's atomic stack merge, linked first when they are not one stack yet, which is why
// `stageStack`'s problems refuse here as they are named by `--link`; one lands on its own. Like
// `--link`, it writes nothing into the record: the merged PRs' terminal facts are `rig close`'s.
function landStages (cfg, work, branch, flags) {
  const others = ['dropped', 'replaced-by', 'cut', 'key', 'delivers', 'planned', 'link'].filter(k => flags[k] !== undefined)
  if (others.length) die(`--land merges the stages as they are, and takes nothing else (${others.map(k => `--${k}`).join(', ')})`)
  // A value, or a branch that came out empty, would otherwise read as "every stage".
  if (flags.land !== true) die('--land takes no value — name the stage before it: `rig stage <branch> --land`')
  if (branch === '') die('the stage named for --land is empty — name one, or name none to land them all')
  if (!work.stages.length) die(`${work.id} has no stages — there is nothing to land`)
  const stack = stackOf(work, branchRows(cfg, work))
  const unknown = unknownStages(stack).map(st => st.branch)
  if (unknown.length) die(`GitHub would not say what became of ${unknown.join(', ')} — nothing landed`)
  const live = stack.filter(st => !st.landed && !st.withdrawn)
  if (!live.length) die(`every stage of ${work.id} has landed — there is nothing to land`)
  const upTo = branch ? live.slice(0, live.findIndex(st => st.branch === branch) + 1) : live
  if (!upTo.length) die(`${branch} is not a stage of ${work.id} still to land`)

  const problems = upTo.filter(st => !st.started).map(st => `${st.branch} is not cut in any repo yet`)
  const plans = []
  const needs = new Set()
  for (const entry of work.repos) {
    const prs = []
    for (const st of upTo.filter(s => s.repos.includes(entry.repo))) {
      const pr = st.prs.find(p => p.repo === entry.repo)
      if (pr?.state === 'MERGED') continue
      if (pr?.state === 'OPEN') prs.push({ ...pr, branch: st.branch })
      else problems.push(`${st.branch} has no open PR in ${entry.repo}`)
    }
    if (!prs.length) continue
    const base = workBranch(entry, work)?.base || entry.base
    if (base === work.branch) { problems.push(`${entry.repo}: ${work.branch} is the base branch itself — rig lands a stage into the work branch and never further`); continue }
    // A merge queue picks its own merge method and may land a stack in parts, so neither the
    // merge commit nor the all-or-nothing could be kept.
    let queued = null
    const unasked = trackerFailure(() => { queued = github().mergeQueue(entry.org, entry.repo, work.branch) })
    if (unasked) { problems.push(`${entry.repo}: GitHub would not say whether ${work.branch} has a merge queue (${unasked})`); continue }
    if (queued) { problems.push(`${entry.repo}: ${work.branch} has a merge queue, which picks its own merge method and may land the stages in parts`); continue }
    const s = stageStack(stack, entry, work.branch)
    if (s?.problem) { problems.push(`${entry.repo}: ${s.problem}`); continue }
    // A stack merges into its own base, so one GitHub would not list is one whose base nobody
    // has checked: it may already hold these PRs on top of the work PR, on the base branch.
    if (s?.unknown) { problems.push(`${entry.repo}: GitHub would not list its stacks, so where a stack merge would land cannot be checked`); continue }
    if (!s && prs[0].base !== work.branch) {
      problems.push(`${entry.repo}: #${prs[0].number} (${prs[0].branch}) is based on ${prs[0].base}, not ${work.branch} — rig lands a stage into the work branch and never further`)
      continue
    }
    // One open stage PR may still sit in the stack the stages below it merged from, and
    // GitHub merges a stacked PR only with its stack. One GitHub would not list stacks for goes
    // through `gh pr merge`, which lands on the PR's base, checked above, or refuses.
    const held = s ? null : heldIn(entry, prs[0].number, work.branch)
    if (held?.problem) { problems.push(`${entry.repo}: ${held.problem}`); continue }
    for (const pr of prs) {
      const ready = github().prReadiness(entry.org, entry.repo, pr.number)
      const says = unready(ready)
      if (says) problems.push(`${entry.repo}: #${pr.number} (${pr.branch}): ${says}`)
      pr.checked = ready?.head || null
    }
    if (s || held) needs.add('merge')
    if (s && !s.linked) needs.add('link')
    plans.push({ entry, prs, stacked: s, held })
  }
  // Asked once per subcommand, whichever repos need it.
  const tools = [...needs].map(c => [c, github().stackTool(c)])
  const old = tools.filter(([, t]) => t === 'old').map(([c]) => c)
  if (tools.some(([, t]) => t === 'missing')) problems.push('gh stack is not installed — `gh extension install github/gh-stack`; a stack of stage PRs lands only as one')
  else if (old.length) problems.push(`gh stack has no \`${old.join('` or `')}\` — \`gh extension upgrade gh-stack\``)
  if (problems.length) die(`nothing landed:\n${problems.map(p => `  - ${p}`).join('\n')}`)

  const numbers = prs => prs.map(pr => `#${pr.number}`).join(', ')
  for (const { entry, stacked } of plans.filter(p => p.stacked && !p.stacked.linked)) {
    const failed = trackerFailure(() => github().linkStack(entry.org, entry.repo, { base: work.branch, urls: stacked.prs.map(pr => pr.url) }))
    if (failed) die(`${entry.repo}: could not link ${numbers(stacked.prs)} (${failed}) — nothing landed`)
    // Read back rather than trusted, as `--link` does: a stack missing a PR would merge
    // what sits below it without what it was cut on.
    const made = stageStack(stack, entry, work.branch)
    if (made.unknown) die(`${entry.repo}: ${numbers(stacked.prs)} were linked, and GitHub would not list its stacks to say where — nothing landed`)
    if (!made.linked) die(`${entry.repo}: gh stack link ran, and ${numbers(stacked.prs)} are still not one stack — nothing landed`)
  }
  const landed = []
  for (const { entry, prs, stacked, held } of plans) {
    const top = prs[prs.length - 1]
    // Asked again just before the merge, since linking and the repos before this one take time:
    // a check failing or a review asked for since is no less a refusal, and `gh stack merge`
    // takes no head to match, so a push since would land what nothing checked. A window stays,
    // a short one.
    const changed = prs.flatMap(pr => {
      const ready = github().prReadiness(entry.org, entry.repo, pr.number)
      const says = unready(ready) || (ready.head !== pr.checked ? 'it was pushed to since it was checked' : null)
      return says ? [`#${pr.number} (${pr.branch}): ${says}`] : []
    })
    if (changed.length) die(`${entry.repo}: ${changed.join('; ')} — run it again${landed.length ? ` — ${landed.join('; ')} landed already` : ' — nothing landed'}`)
    const failed = trackerFailure(() => stacked || held
      ? github().mergeStack(entry.org, entry.repo, top.number)
      : github().mergePr(entry.org, entry.repo, top.number, { head: top.checked }))
    if (failed) die(`${entry.repo}: could not land ${numbers(prs)} (${failed})${landed.length ? ` — ${landed.join('; ')} landed already` : ''}`)
    ok(`${entry.repo}: landed ${numbers(prs)} in ${work.branch}`)
    landed.push(`${numbers(prs)} in ${entry.repo}`)
    const on = trees(cfg).state({ dir: entry.path, base: entry.base, recordedBase: entry.base, branch: work.branch }).on
    if (prs.some(pr => pr.branch === on)) say(`  ${C.dim(`the worktree is still on ${on} — ${backToWorkBranch(work).map(c => `\`${c}\``).join(', then ')}`)}`)
  }
}

// The open GitHub stack a lone stage PR sits in, or null: in none, or GitHub would not list
// them. `problem` where merging it with that stack would land something else, past the work
// branch or below the PR.
function heldIn (entry, number, workBranch) {
  let stacks = null
  trackerFailure(() => { stacks = github().stacks(entry.org, entry.repo) })
  const held = stacks?.find(s => s.open && s.prs.includes(number))
  if (!held) return null
  const below = held.prs.slice(0, held.prs.indexOf(number)).filter(n => held.openPrs.includes(n))
  const problem = held.base !== workBranch ? `#${number} sits in GitHub stack #${held.number}, which is on ${held.base}, not ${workBranch}`
    : below.length ? `#${number} sits in GitHub stack #${held.number} on ${below.map(n => `#${n}`).join(', ')}, which is no stage still to land`
      : null
  return { ...held, problem }
}

// Why a stage PR is not one to merge, or null when it is. `ready` is `prReadiness`'s answer.
// A rollup of null is a head with no checks set up, which the hand-over reads the same way.
function unready (ready) {
  if (!ready) return 'GitHub would not say whether it is ready'
  // The head is what the merge is pinned to, so one not said is a merge nothing pins.
  if (!ready.head) return 'GitHub would not say which commit it is at'
  if (ready.draft) return 'it is a draft'
  if (ready.mergeable === 'CONFLICTING') return 'it conflicts with the branch it merges into'
  if (['FAILURE', 'ERROR'].includes(ready.checks)) return 'its checks are failing'
  if (ready.checks && ready.checks !== 'SUCCESS') return 'its checks have not passed yet'
  if (ready.decision === 'CHANGES_REQUESTED') return 'changes are requested'
  if (ready.decision === 'REVIEW_REQUIRED') return 'it needs an approving review before it can merge'
  if (ready.requested > 0) return 'a review is requested and not given — that merge is the reviewer\'s'
  return null
}

// One repo's open stage pull requests as a GitHub stack: `stackState` over the stacks GitHub
// lists, and `unknown` when it would not list them. Null, with no lookup, where fewer than two
// are open. `rig next` and `rig stage --link` both read it, so the offer and the command never
// disagree about what there is to link.
function stageStack (stack, entry, workBranch) {
  if (!stackState(stack, entry.repo, workBranch, [])) return null
  let stacks = null
  trackerFailure(() => { stacks = github().stacks(entry.org, entry.repo) })
  return { ...stackState(stack, entry.repo, workBranch, stacks || []), unknown: stacks === null }
}

// A stage merges into the work branch with a merge commit (decision 75), and a stack records no
// merge method, so it is said wherever a stack is made or found (decision 153). All at once
// rewrites no head; bottom-up is fine too, and `rig close` compares what GitHub rewrote by patch.
// `rig stage --land` merges it that way (decision 207), so it is named first.
function sayStackMerge (number) {
  say(`  ${C.dim(`land it with \`rig stage --land\`; by hand, with a merge commit, never a squash — gh stack merge ${number} --merge`)}`)
}

// `--planned`: a withdrawn stage put back in the plan (decision 140). A stage cut on another that
// is still withdrawn stays out, because it carries that one's commits and would land them.
function replanStage (cfg, work, branch, flags) {
  if (!branch) die('--planned names the stage: `rig stage <branch> --planned`')
  const others = ['dropped', 'replaced-by', 'cut', 'key', 'delivers'].filter(k => flags[k] !== undefined)
  if (others.length) die(`--planned puts a withdrawn stage back, and takes nothing else (${others.map(k => `--${k}`).join(', ')})`)
  const declared = work.stages.find(s => s.branch === branch) || die(`${branch} is not a stage of ${work.id}`)
  if (!withdrawalOf(declared)) die(`${branch} is not withdrawn — there is nothing to put back`)
  const withdrawn = new Set(work.stages.filter(s => withdrawalOf(s)).map(s => s.branch))
  const on = branchRows(cfg, work).find(r => r.branch === branch && withdrawn.has(r.cutOn))
  if (on) die(`${branch} is cut on ${on.cutOn} in ${on.repo}, which was withdrawn — put that back first, or rebase ${branch} off it`)
  for (const k of ['droppedAt', 'reason', 'replacedAt', 'replacedBy']) delete declared[k]
  commitAs(work.id, `${branch} back in the plan`)
  saveWork(cfg, work)
  ok(`${work.id}: stage ${C.bold(branch)} back in the plan`)
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
    .filter(st => st.branch !== branch && st.repos.includes(entry.repo) && !st.withdrawn)
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
  // A plan is committed and read back, so a deploy order that would say "PR state unknown" is
  // neither written nor refreshed (decision 171).
  const unknown = unknownStages(stack).map(st => st.branch)
  if (unknown.length) die(`GitHub would not say what became of ${unknown.join(', ')} — nothing ${flags.refresh ? 'refreshed' : 'written'}`)

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
  // Closed already: the close ran on another machine and this one pulled its record. What is
  // left is this machine's copy, and nothing else about the work is this command's any more.
  if (work.closedAt) return closeHere(cfg, work, flags)
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
  // are what being abandoned *looks like*, not a reason to refuse. `dirty` and `unbranched`
  // survive, because what exists only in a tree is the one thing this command can destroy
  // whatever it is called.
  const abandoned = !!flags.abandoned
  const blockers = abandoned ? verdict.blockers.filter(b => IN_TREE_ONLY.has(b.kind)) : verdict.blockers
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
  // Each stage that landed is recorded too, as `rig backfill` would: a stage is reviewed on its
  // own and its merge is as terminal as the work branch's, and `rig dash` links every PR.
  // The declared stages are walked rather than the record's branches, because a stage cut by
  // hand is in the stack and not yet in the record.
  for (const s of stack.filter(s => !s.withdrawn)) {
    for (const r of work.repos.filter(r => s.repos.includes(r.repo))) {
      if (branchRecord(r, s.branch)?.pr) continue
      const { pr, base, error } = mergedPrRecord(r, s.branch)
      if (pr) ensureBranchRecord(r, s.branch, base).pr = pr
      else if (error) warn(`${r.repo} ${s.branch}: ${error} — not recorded; \`rig backfill --work ${id}\` once GitHub answers again`)
    }
  }
  sayLiveSessions(cfg, work)
  removeWorktrees(cfg, work, { force: !!flags.force })
  // A work that landed has no use for its branches, and every one it leaves in the mirror is
  // one the next `rig attach` on that name has to step round (#149). Only when it all landed:
  // `done` is every PR merged with nothing in the way, which a forced or abandoned close is not.
  if (verdict.done && !abandoned) dropMergedBranches(cfg, work, states, stack)
  commitAs(id)
  removeWorkFolder(cfg, id)
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
  // dies with "not inside a work". `--data` too where another root keeps a copy, since two
  // closed copies are a pick `rig save` will not make (decision 191).
  const save = `rig save --work ${id}${rootHoldingWork(where().roots, id).holders.length > 1 ? ` --data ${where().name}` : ''}`
  const stillDraft = draftEntries(work)
  if (stillDraft.length) {
    say(C.dim(`  catalogue still a draft for ${stillDraft.join(', ')} — correct ${stillDraft.length > 1 ? 'them' : 'it'} and \`${save} -m "catalogue corrections"\``))
  }
  // The lesson review, named the same way and for the same reason. An abandoned work is not
  // asked: `rig save --learned` refuses one, so naming it would hand over a command that dies.
  if (!abandoned && !work.learnedAt) {
    say(C.dim(`  lessons never reviewed — the rig-learn skill, then \`${save} -m "lessons reviewed" --learned\``))
  }
  // And the outcome, which `rig save --outcome` refuses an abandoned work for the same reason,
  // and which a work that merged nothing has none of.
  const landedAll = verdict.repos.length > 0 && verdict.repos.every(v => v.merged)
  if (!abandoned && !work.outcome && landedAll) {
    say(C.dim(`  no outcome recorded — what changed for someone, and why that is good: \`${save} --outcome "…"\``))
  }
  // And the user docs, where a repo says where they live: after the close is when a work is
  // verified where it was deployed, and nothing else names them once the work is closed.
  if (!abandoned && !work.documentedAt && landedAll && docsTargets(work).some(d => d.targets.length)) {
    say(C.dim(`  user docs never updated — the rig-docs skill, then \`${save} -m "user docs updated" --documented\``))
  }
  if (abandoned) {
    const open = verdict.repos.filter(v => v.pr && v.pr.state === 'OPEN')
    // Named rather than closed: closing someone's pull request is an outward-facing act, and
    // an abandoned work is exactly the case where someone else may still want what is on it.
    for (const v of open) say(`  ${C.dim(`${v.repo}: PR #${v.pr.number} left open — ${v.pr.url}`)}`)
  }
}

// The teardown both kinds of close share. Out of the work folder before anything in it is
// removed: Windows refuses to remove a directory that is some process's cwd — including ours.
// Everywhere else git removes it regardless, and a run handed its cwd rather than inheriting it
// would then start every later subprocess in a directory that is not there, which Node refuses
// to do.
// Each answers whether it did all it set out to.
function removeWorktrees (cfg, work, { force }) {
  if (standingIn(workDir(cfg, work.id))) chdir(toolRoot())
  let removedAll = true
  for (const r of work.repos) {
    if (!exists(r.path)) continue
    const failed = trees(cfg).remove({ org: r.org, repo: r.repo, dir: r.path, force })
    if (failed) { warn(`${r.repo}: ${failed}`); removedAll = false }
    else step(`removed worktree ${r.repo}`)
  }
  return removedAll
}

function removeWorkFolder (cfg, id) {
  const wd = workDir(cfg, id)
  if (!exists(wd)) return true
  try {
    fs.rmSync(wd, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
    return true
  } catch (e) {
    warn(`worktrees removed, but ${wd} could not be deleted: ${e.code || e.message}`)
    warn('something still has it open (a shell, an editor). Close it, then `rig tidy`.')
    return false
  }
}

// A closed work whose folder is still on this machine: closed on another one, or closed here
// while something held the folder open. The one test `doctor`, `tidy`, `close` and `next` all
// ask, so the four agree about which works are left over. A root holding an open record of the
// same id makes the folder that work's, whichever copy was read: a work moved to another root
// leaves a closed copy behind, and its folder is live.
const leftHere = (cfg, work, roots = where().roots) =>
  !!work.closedAt && exists(workDir(cfg, work.id)) && !rootHoldingWork(roots, work.id).holders.some(h => h.open)

// `String`: a hand-edited date is `contradictions`' to report, not a reason to crash.
const stoppedOn = work => `${work.abandonedAt ? 'abandoned' : 'closed'} on ${String(work.closedAt).slice(0, 10)}`

// What a removed worktree takes with it, whatever its PR says.
const IN_TREE_ONLY = new Set(['dirty', 'unbranched'])

// What would lose something that exists only on this machine. A first close also refuses over
// an open pull request and an unknown PR state, and those are questions about the work; a
// leftover's work is settled, and its pull requests are on GitHub, not on this disk.
const LOCAL_BLOCKERS = new Set([...IN_TREE_ONLY, 'unpushed', 'distance-unknown'])

// This machine's copy of a closed work, cleared: its worktrees, its folder and its mirror's
// copies of the branches that landed. The close itself ran elsewhere and settled the record,
// the tickets and the remote, so nothing here writes to any of them (DESIGN.md decision 164).
// It asks GitHub what merged, read-only, because a squash merge leaves commits that look
// unpushed and only a merged PR says they are safe to lose.
//
// Answers the blockers it found, and whether it cleared anything: a dry run never does, and
// neither does a run with blockers unless it was forced past them.
function clearLeftover (cfg, work, { force = false, dryRun = false } = {}) {
  const states = work.repos.map(r => repoState(cfg, r, work.branch))
  const stack = work.stages.length ? stackOf(work, branchRows(cfg, work)) : []
  const verdict = workState(work, states, { stages: stack })
  // Anything in the folder that is not the record's — a repo detached on the other machine
  // before it closed, notes of your own — is nobody's copy but this one (decision 165).
  const known = new Set([...work.repos.map(r => r.repo), ...WORK_FOLDER_ENTRIES])
  const strays = fs.readdirSync(workDir(cfg, work.id)).filter(e => !known.has(e))
    .map(e => ({ repo: e, kind: 'stray', message: `${e}: not one of the work's repos, so rig cannot say what it holds` }))
  const blockers = [...verdict.blockers.filter(b => LOCAL_BLOCKERS.has(b.kind)), ...strays]
  if (dryRun || (blockers.length && !force)) return { blockers, cleared: false }
  // A session still at work here, on the machine whose copy this is, is named as `close` names one.
  sayLiveSessions(cfg, work)
  // A worktree git refused to remove is not deleted from under it.
  if (!removeWorktrees(cfg, work, { force })) return { blockers, cleared: false }
  // The mirror only: the remote was the first close's to decide, and it already has. A stage
  // GitHub would not answer for may not have landed, so its work's branches are kept, and said
  // to be, rather than dropped on a guess or kept in silence.
  if (!blockers.length && !work.abandonedAt) {
    const onlyUnknown = verdict.blockers.length && verdict.blockers.every(b => b.kind === 'stage-pr-unknown') && verdict.repos.every(v => v.merged)
    if (verdict.done) dropMergedBranches(cfg, work, states, stack, { remote: false })
    else if (onlyUnknown) warn(`kept the mirror's copies of ${work.id}'s branches — GitHub would not say whether ${unknownStages(stack).map(st => st.branch).join(', ')} landed`)
  }
  return { blockers, cleared: removeWorkFolder(cfg, work.id) }
}

// `rig close` on a work that is already closed.
function closeHere (cfg, work, flags) {
  const open = rootHoldingWork(where().roots, work.id).holders.find(h => h.open)
  if (open && exists(workDir(cfg, work.id))) {
    die(`${work.id} is ${stoppedOn(work)} here, but data root "${open.name}" holds a record of ${work.id} that does not say it is closed, and the folder on this machine is that work's — delete the copy that is wrong`)
  }
  if (!leftHere(cfg, work)) return ok(`${work.id} was already ${stoppedOn(work)} — nothing of it is on this machine`)
  const force = !!flags.force
  const { blockers, cleared } = clearLeftover(cfg, work, { force })
  if (!cleared && (force || !blockers.length)) {
    warn(`${work.id} is not fully cleared — see above`)
    current.exitCode = 1
    return
  }
  if (!cleared) {
    warn(`not clearing ${work.id} — it was ${stoppedOn(work)}, but this machine has work that is nowhere else:`)
    for (const b of blockers) say(`    ${C.red('•')} ${b.message}`)
    say('')
    say(C.dim('Push or commit it, or pass --force if you genuinely want to discard it.'))
    current.exitCode = 1
    return
  }
  ok(`cleared this machine's copy of ${work.id} — it was ${stoppedOn(work)}, and its record is unchanged`)
}

// Every leftover on this machine, cleared the way `rig close` clears one. Over every data root,
// because the work root is shared, and over the records as they stand: `rig update` brings
// every root forward first. A leftover that would lose something is skipped and named, never
// forced — forcing is a decision about one work, and `rig close --force` is where it is made.
cmds.tidy = ({ flags }) => {
  const { loc } = selection()
  const cfg = load(loc)
  const dryRun = !!flags['dry-run']
  const leftovers = []
  const unreadable = []
  // The first root whose copy reads is the one whose record is read, as it is for doctor
  // (`oneCopyEach`); `leftHere` asks every root, so an open copy anywhere keeps the folder.
  const seen = new Set()
  for (const { name, loc: rootLoc } of doctorRootLocations(loc)) {
    if (!exists(rootLoc.dataRoot)) continue
    for (const id of listWorkIds(rootLoc.dataRoot)) {
      if (seen.has(id) || !exists(workDir(cfg, id))) continue
      let work
      try { work = loadWork(cfg, id, rootLoc.dataRoot) } catch (e) {
        if (!(e instanceof RigError)) throw e
        unreadable.push(`${id} (${(e.cause ?? e).message})`)
        continue
      }
      seen.add(id)
      // `--data` only where the rule cannot place the work by itself (decision 191).
      if (leftHere(cfg, work, loc.roots)) leftovers.push({ work, root: rootHoldingWork(loc.roots, id).name ? null : name })
    }
  }
  sayUnreadable(unreadable)
  if (!leftovers.length) return ok('nothing to tidy — no closed work has a folder on this machine')

  let notCleared = 0
  for (const { work, root } of leftovers) {
    const { blockers, cleared } = clearLeftover(cfg, work, { dryRun })
    if (blockers.length) {
      notCleared++
      const data = root ? ` --data ${root}` : ''
      warn(`${dryRun ? 'would skip' : 'skipped'} ${work.id} — ${stoppedOn(work)}, but this machine has work that is nowhere else:`)
      for (const b of blockers) say(`    ${C.red('•')} ${b.message}`)
      say(C.dim(`    push or commit it, or \`rig close --work ${work.id}${data} --force\` to discard it`))
    } else if (cleared) ok(`cleared ${work.id} — ${stoppedOn(work)}`)
    else if (dryRun) say(`  would clear ${work.id} — ${stoppedOn(work)}`)
    else { notCleared++; warn(`${work.id} is not fully cleared — see above`) }
  }
  if (notCleared && !dryRun) current.exitCode = 1
}

// Every branch of a finished work whose PR merged — the work branch in each repo, and each
// stage that landed — deleted wherever its copies are safe to delete. A PR known only from
// the record has no head to check against, so its branch is named and left. `remote: false`
// is a leftover's: its mirror copies only.
function dropMergedBranches (cfg, work, states, stack, { remote = true } = {}) {
  const merged = [
    ...work.repos.map((entry, i) => ({ entry, branch: work.branch, pr: states[i].pr })),
    ...stack.flatMap(st => st.prs.map(pr => ({ entry: work.repos.find(r => r.repo === pr.repo), branch: st.branch, pr }))),
  ].filter(b => b.entry && b.pr?.state === 'MERGED')
  for (const { entry, branch, pr } of merged) {
    if (!pr.head) {
      say(`  ${C.dim(`${entry.repo}: kept ${branch} — GitHub did not say which commit PR #${pr.number} merged`)}`)
      continue
    }
    const copies = trees(cfg).dropMerged({ org: entry.org, repo: entry.repo, branch, head: pr.head, number: pr.number, remote })
    const gone = [copies.local === 'deleted' && 'mirror', copies.remote === 'deleted' && 'remote'].filter(Boolean)
    if (gone.length) step(`deleted branch ${branch} from ${entry.repo} (${gone.join(' and ')})`)
    for (const [where, what] of [['mirror', copies.local], ['remote', copies.remote]]) {
      if (what.startsWith('kept')) say(`  ${C.dim(`${entry.repo}: ${where} copy of ${branch} ${what}`)}`)
    }
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
  // One record that will not read costs the scan nothing but itself, as it does `list`; named
  // with `--work`, it is the whole question, and dies saying so.
  const { works, unreadable } = flags.work ? { works: [loadWork(cfg, flags.work)], unreadable: [] }
    : readRecords(dataRoot(), id => loadWork(cfg, id))
  let filled = 0
  let touchedWorks = 0
  const unresolved = []
  for (const work of works) {
    const id = work.id
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
        const { pr, error } = mergedPrRecord(entry, b.branch)
        if (error) { unresolved.push(`${id}/${entry.repo} ${b.branch}: ${error}`); continue }
        if (!pr) continue   // not terminal — nothing to store, nothing to report
        b.pr = pr
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
  sayUnreadable(unreadable)
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
      for (const t of e.talks_to) say(`  ${C.dim('→')} ${typeof t === 'string' ? t : t.repo}: ${t.how || ''}${t.direction ? C.dim(` [${t.direction}]`) : ''}`)
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
    // "Keeps happening" is a claim that the pair repeats. The observed graph has no threshold
    // (decision 95), so the wording is what tells the reader how strong the evidence is.
    const quiet = answer.observed.filter(o => !o.declared)
    if (quiet.length) {
      const one = quiet.length === 1
      const gap = quiet.every(o => o.works.length > 1)
        ? `${one ? 'that pair keeps' : 'those pairs keep'} happening and the catalogue does not say why`
        : `the catalogue does not say why ${one ? 'that pair was' : 'those pairs were'} worked on together`
      say('')
      say(C.dim(`${gap} — ${answer.catalogued
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
  // An upstream whose ref is not here yet is still one to fetch: the fast-forward below reads
  // the checkout again, and says "nothing to update from" if the fetch did not find it either.
  if (!state.tracks) { say(`${C.dim('·')} ${C.dim(`${label}: no upstream — nothing to update from`)}`); return { status: 'current', clean } }
  // Asked before the fetch, unlike `fastForward`'s own `blocked`: an update you ran is a
  // command that should say what is in the way rather than go quiet because there happened
  // to be nothing to bring down anyway.
  if (state.modified) {
    warn(`${label}: ${state.modified} uncommitted change(s) — not updated${how(label, root)}`)
    return { status: 'failed', clean }
  }
  // A data root's fetch and fast-forward are locked as a mutating command's are, and a busy
  // lock is that root not updated, the way every other reason here is. The tool checkout is
  // yours and nothing of rig's commits into it, so it takes no lock.
  const held = label.startsWith('data root') ? lockDataRoot(root, 'fast-forward', label) : null
  if (held?.outcome === 'busy') {
    warn(`${lockBusy(held, label)}; not updated. ${lockEscape(held)}`)
    return { status: 'failed', clean }
  }
  try { return fetchAndForward(label, root, clean) } finally { co.unlock(held?.lock) }
}

// The half of `updateCheckout` that moves the checkout, once nothing stands in its way.
function fetchAndForward (label, root, clean) {
  const fetched = co.fetch(root)
  if (!fetched.ok) { warn(`${label}: could not fetch (${fetched.error})${signIn(fetched.error)} — not updated`); return { status: 'failed', clean } }
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
    case 'no-upstream': case 'detached': case 'not-a-checkout': {
      // An upstream the fetch did not find either: gone from the remote, or never pushed.
      const missing = moved.state.tracks ? `${moved.state.tracks} is not on the remote — ` : ''
      say(`${C.dim('·')} ${C.dim(`${label}: ${missing}nothing to update from`)}`); return { status: 'current', clean }
    }
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
  const inHand = selection().loc
  const cfg = load(inHand)
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
    : [{ name: null, loc: inHand }]

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
// worktrees are gone on purpose — bar whether its folder is still on this machine. The record
// and the catalogue entry it reads are the data root's, and the work folder is the machine's,
// which is the whole shape of a shared work root: `cfg` answers where the tree is, `root`
// answers who has the paperwork for it.
function doctorWork (cfg, id, root, roots) {
  const holders = rootHoldingWork(roots, id).holders.map(h => h.name)
  let work
  try { work = loadWork(cfg, id, root) } catch (e) {
    if (e instanceof RigError) return { id, unreadable: e.message, holders }
    throw e
  }
  const out = { id, closed: !!work.closedAt, contradictions: contradictions(work), folderMissing: false, strays: [], repos: [], holders }
  if (out.closed) return leftHere(cfg, work, roots) ? { ...out, leftover: stoppedOn(work) } : out
  out.contextDoc = contextDocFindings(work, root)
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
  const place = discover(mirror, env())
  const resolves = r => refLives(mirror, r, place)
  const read = symref(place, 'refs/remotes/origin/HEAD')
  const symbolic = read ? { code: 0, out: read.target ?? '' } : git(mirror, 'symbolic-ref', 'refs/remotes/origin/HEAD')
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
// nobody chose. `doctor` and `update` are the exceptions, because neither answers about one
// root's contents: doctor reports on the installation, and `update` brings every root forward.
// So the refusal is caught. Doctor carries it as a finding, and `update` leaves it to the
// doctor checks it ends in, so it is said once.
//
// The fallback is the tool checkout, which is what `locate` already falls back to on a machine
// that configures no data root at all: the org half of a root nobody chose must not be guessed
// at, and everything the two commands still read off it — the work root, the mirror root, the
// secrets, the freshness cache — is the machine half's to answer, which reads either way.
// `freshness` sits in both halves, so the fallback does drop a root's own policy; it costs
// nothing because `doctorFreshness` asks the tool checkout and never reads `cfg.freshness`.
// The roots themselves come from the registry wherever it has any.
function selection () {
  try { return { loc: where(), error: null } }
  catch (e) {
    if (!(e instanceof RigError)) throw e   // a bug: not ours to swallow
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

// One copy of each work whose record reads, and every copy that does not. A work in two roots
// has one folder, and each readable copy would repeat every finding about it; but a copy that
// will not read is its own file to fix (decision 157). The open copy is the readable one kept
// when only one is closed, because the folder is that work's, and the closed copy would call it
// a leftover (decision 167).
const oneCopyEach = works => {
  const readable = works.filter(w => !w.unreadable)
  const kept = id => readable.find(o => o.id === id && !o.closed) ?? readable.find(o => o.id === id)
  return works.filter(w => w.unreadable || kept(w.id) === w)
}

function doctorSnapshot () {
  // Gathers its location rather than asking for it, and carries on whether or not it got one.
  const { loc, error: selectionError } = selection()
  const localFile = loc.localFile
  // Nothing below can be asked of an installation that has no config at all, and `load` is
  // the first thing that would die trying.
  if (!exists(localFile)) return { setUp: false, localFile, linkedCopyNeeds: linkedCopyNeeds() }

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
    // A `transcripts` value that is not a list of patterns, which close and list only warn of.
    transcriptsProblem: transcriptConfig(cfg).problem || null,
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
    works: oneCopyEach(roots.filter(r => r.exists).flatMap(r => listWorkIds(r.path).map(id => doctorWork(cfg, id, r.path, loc.roots)))),
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

// Every command's usage, written once: the lines that start with its name and the indented
// lines under each. `rig help` prints all of it, `rig <command> --help` prints that command's
// own lines, and the flags those lines name are the flags the command takes.
const USAGE = `  rig init                        one-time setup; "rig prompt setup" asks the questions
       --data-repo owner/name      join that private data repo, or create it if absent
       --name <name>               what to call this data root; it becomes the current one
       [--email x] [--work-root d] [--data-root d]            -> rig.local.json (this machine)
       [--orgs a,b] [--tracker a=github:owner/repo,b=jira:KEY] -> rig.json (the data root)
  rig new <id> --title "..."      create a work (reads a brief on stdin)
       --key K | --ticket [--org o] [--field k=v,...] [--parent KEY] [--dry-run] | --no-ticket
       one of the three is required whenever a tracker is configured (the ticket
       decision must be explicit); --key PROJ-42 fetches its brief from Jira;
       --ticket creates in the org's tracker (rig.json); --parent PROJ-7 files a
       Jira ticket under that epic; --dry-run previews and creates nothing;
       --no-ticket records a declined ticket
       [--type feat] [--slug s | --branch b] [--repos a,b] [--setup]
       [--stops repos,design | none]  the gates the agent waits at for the human;
                                   absent, it waits at both
       [--by-agent]                with --repos: the agent chose them, not the human
  rig use [<name>]                which knowledge is in hand; bare, it lists the data
                                  roots this machine knows and marks the current one
  rig ticket <key>                record an existing ticket (PROJ-123 or owner/repo#n)
       --replaces <old>            put it in place of a key the record holds, on the work
                                   or a stage; the tracker is not told
  rig ticket --remove <key>       take a key off the record, wherever it is held; the
                                  tracker is not told
  rig attach <repo> [--setup]     add a repo to the current work
       [--by-agent]                the agent chose it, where the repo set is not a stop
  rig detach <repo> [--force]     remove a repo from the current work
  rig restore [<id>] [--setup]    put a work's missing worktrees back from its record, each
                                  on the top of its stack; a branch the remote and the
                                  mirror have both lost is named, never recreated
       --tip                       check out the top of an unrecorded PR stack instead
  rig list [--json] [--quick]     every work, least recently touched first
       --json                      the records plus live PR timestamps, for a consumer
       --quick                     skip the git and GitHub lookups
  rig dash [--org o] [--since w]  render throughput, cycle time and what landed as one page
       [--from payload.json]       render a payload captured earlier, instead of looking up
       [--quick]                   look nothing up; recorded work still renders in full
       [--no-open]                 write the page and print the path, open nothing
  rig status                      live detail for the current work
       [--transcripts]             only the work's own session transcripts, a path a line,
                                   from the patterns in rig.local.json
  rig next                        what is available now on the current work
  rig pr                          open one PR per repo, work branch to base branch
       [--refresh]                 rewrite each open PR's title and body from the record
                                   as it stands; opens nothing
  rig stage [branch]              the stack, in branch order; with a branch, declare one
  rig stage <branch> --cut        and make the branch, here, on top of this repo's stack
  rig stage <branch> --key <k>    give the stage its own ticket, closed when the slice lands
       --delivers "..."            the one line of prose a stage carries
       --dropped "why"             withdraw it from the plan: kept, dated, never deleted
       --replaced-by <stage>       withdraw it as done under another declared stage
       --planned                   put a withdrawn stage back in the plan
  rig stage --link                register each repo's open stage PRs as one GitHub stack
                                  on the work branch, with gh stack link
  rig stage [branch] --land       merge the stages, up to that one, into the work branch with
                                  a merge commit, and never past it; refused while a stage PR
                                  is a draft, conflicts, has checks not passed, has changes
                                  requested or needs approval, or awaits a review asked for
  rig setup [repo...]             run the catalogue's setup commands
  rig check [repo...] [--run]     print what verifies each repo — its test run, its lint,
                                  its build; --run runs them and exits non-zero on a failure,
                                  and records each pass against the patch it ran at
  rig catalog [repo] [--verbose]  the repo catalogue: index, or one entry
  rig impact <repo>               what else a change in that repo reaches: the repos one and
                                  two hops away in talks_to, each with what was said, which
                                  way it runs, and how far behind its entry is
  rig plan [--refresh]            scaffold the rollout & testing plan; --refresh
                                  re-renders its deploy order from the stack
       [--force]                   write it again over the one that exists
  rig save [-m text] [--designed] commit edits made outside rig (the context doc);
       [--adversarial]             --designed records the "design agreed" gate and
       [--no-adversarial]          needs one of the two: does this work get an
       [--reviewed] [--learned]    adversarial review; --reviewed records that review,
                                   --learned the lesson review (the rig-learn skill)
       [--documented]              the user docs updated (the rig-docs skill)
       [--title "..."]             correct the work's title: the record, the context doc's
                                   heading and AGENTS.md — never the branch or the id
       [--outcome "..."]           what landed and why it was worth doing, in a sentence
                                   or two; again replaces it
       [--stops repos,design | none]  change the gates the agent waits at for the human
       [--by-agent]                with --designed: the agent agreed it, not the human;
                                   agreed again without it, the human has seen it
  rig note "..."                  append a row to the work's notes: a decision taken along the
       --why "..."                 way, why, and a pointer at the evidence; commits the data root
       --evidence <pointer,...>    a SHA, a PR, file:line, a path or a URL — never prose
       [--stage <branch>] [--result "..."]
  rig close [--force]             safety-checked teardown; a work that landed also loses
                                  its merged branches, in the mirror and on the remote
       --abandoned                 stop a work without finishing it: the did-it-land
                                   checks are dropped, uncommitted changes still refuse,
                                   the ticket is told and open PRs are left alone
       on a work already closed: clears this machine's copy and
                                   nothing else — no record, ticket or remote is touched
  rig tidy [--dry-run]            clear every closed work whose folder is still on this
                                  machine; one with work that exists only here is skipped
                                  and named; --dry-run changes nothing
  rig backfill [--work <id>] [--force]
                                  store each merged PR's terminal facts (number, url,
                                  openedAt, firstCommitAt, firstReviewAt, approvedAt,
                                  mergedAt) in work.json, so list/dash never re-ask GitHub
                                  for them; --force refreshes what is already stored
  rig doctor                      environment + consistency checks, over every data root
  rig update                      fast-forward the tool checkout and the data root,
                                  run pending record migrations, then the doctor checks
  rig prompt [name]               print an agent prompt`

// Flags any command may be given, said once in the prose under the usage rather than on each
// line. A command that acts on no work still reads its data root from the one `--work` names.
const COMMON_FLAGS = ['data', 'work', 'help']

// Flags rig passes to itself and a person never types: `rig update`'s one hop into the code
// that just arrived.
const INTERNAL_FLAGS = { update: ['restarted'] }

function usageOf (name) {
  const lines = []
  let mine = false
  for (const line of USAGE.split('\n')) {
    const starts = /^ {2}rig (\S+)/.exec(line)
    if (starts) mine = starts[1] === name
    if (mine) lines.push(line)
  }
  return lines.join('\n')
}

// `--flag` in a command's usage, and `-m` read as the long name it stands for.
const flagsOf = name => new Set([
  ...COMMON_FLAGS,
  ...INTERNAL_FLAGS[name] ?? [],
  ...[...usageOf(name).matchAll(/(?<![\w-])(?:--([a-z][a-z-]*)|-([a-z])\b)/g)].map(([, long, short]) => long ?? SHORT_FLAGS[short]),
])

cmds.help = () => {
  say(`${C.bold('rig')} — cross-repo work harness

${USAGE}

Every command takes --help (or -h), which prints its own lines above and runs
nothing. A flag its lines do not name is refused, before anything runs.

Commands that act on "the current work" find it by walking up from the cwd,
or take --work <id>. Every command that changes a work ends by committing the
whole data root, and pushing it when it has an upstream.

Which data root a command reads, first hit wins: --data <name>, RIG_DATA_ROOT,
the work folder the command runs in, the repos named by --repos, the data root
checkout it runs in, the repo checkout it runs in, then the current one (rig use).

rig record format ${MAJOR} — \`rig doctor\` names the release this checkout stands on and
how far it is behind its remote, \`rig update\` brings it forward.`)
}

// A work on rig itself runs the work's own copy — a linked worktree, with no machine file beside
// it. Every default it would fall back to is some other installation's, so a command there would
// work in data roots nobody chose, and `rig prompt setup` would write a second machine file into
// the worktree. So it says what it needs instead (decision 158). Asked only when the machine file
// is missing, so the git calls that tell a linked worktree cost an installation nothing.
function linkedCopyNeeds () {
  const localFile = registry(toolRoot(), env()).localFile
  if (exists(localFile) || !toolState().linked) return null
  if (env()[LOCAL_CONFIG_ENV]) return `${LOCAL_CONFIG_ENV} names ${localFile}, which does not exist — point it at the installed rig's rig.local.json`
  return `this is a work's copy of rig, in a linked worktree, and it has no machine config of its own (no ${localFile}) — set RIG_LOCAL_CONFIG to the installed rig's rig.local.json`
}
// The commands that run without one: the two that only print, `init`, which is how an
// installation gets one, `doctor`, which reports it, and the detached refresh, which has nobody
// to tell.
const MACHINELESS = new Set(['help', 'prompt', 'init', 'doctor', REFRESH_COMMAND])

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
  const [first, ...rest] = argv
  const cmdName = !first || first === '--help' || first === '-h' ? 'help' : first
  const cmd = cmds[cmdName]
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
    // Asking how a command is used never runs it, and neither does a flag its usage does not
    // name.
    const usage = usageOf(cmdName)
    if (args.flags.help) {
      if (usage) say(usage)
      else cmds.help()
      return 0
    }
    const takes = flagsOf(cmdName)
    const unknown = Object.keys(args.flags).filter(k => !takes.has(k))
    if (unknown.length) die(`rig ${cmdName} takes no ${unknown.map(k => `--${k}`).join(', ')}${usage ? `\n${usage}` : ''}`)
    // Before the first `where()`: the data root a command names decides every path it reads.
    if (args.flags.data === true) die('--data wants a data root name — `rig use` lists them')
    if (typeof args.flags.data === 'string') current.requestedData = args.flags.data
    // The work a command names is in the root that holds it, whatever folder it runs in.
    const named = cmdName === 'restore' ? args.positional[0] || args.flags.work : args.flags.work
    if (typeof named === 'string') current.requestedWork = named
    // `rig new --repos a,b` is the one command that names repos before there is a work folder
    // to anchor it, and it is the command whose choice of root matters most — it is the one
    // that writes the record.
    if (typeof args.flags.repos === 'string') {
      current.requestedRepos = args.flags.repos.split(',').map(s => s.trim()).filter(Boolean)
    }
    if (!MACHINELESS.has(cmdName)) {
      const needs = linkedCopyNeeds()
      if (needs) die(needs)
    }
    current.args = args
    if (mutates(cmdName, args.flags)) prepared = prepareDataRoot()
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
  // What the data root's lock asks of the machine: the time, a sleep, whether a pid runs.
  machine = REAL_MACHINE,
} = {}) {
  return {
    toolRoot,
    cwd,
    env,
    stdin,
    out,
    err,
    chdir,
    machine,
    github: adapterResolver('RIG_FAKE_GITHUB', githubViaGh, githubInMemory),
    jira: adapterResolver('RIG_FAKE_TWG', twgViaCli, twgInMemory),
    location: null,
    requestedData: null,
    requestedWork: null,
    requestedRepos: [],
    args: null,
    pendingCommit: null,
    command: null,
    exitCode: 0,
    // Each repo's visibility on GitHub as this run found it, and the repos it has already said
    // it could not find one for: `rig close` writes to every ticket, and most share a repo.
    visibilities: new Map(),
    linkLeftOut: new Set(),
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
  parseArgs, parseFrontmatter, parseTrackerFlag, isJiraKey, isGithubKey, slug, trackerFor, BOOL_FLAGS, RigError, repoOfRemote, webUrlOf,
  anyTrackerConfigured, orgForJiraKey, ticketsLabel,
  activityAt, relativeAge, prTiming, terminalPr, branchFirstCommitAt, baseLabel, baseMoved, sinceFlag, resolveJiraFields,
  spawnDefaults, refreshSpawn, refreshArgv, effectiveIdentity, parseDf, bytesFree, freeSpace, realGitFor,
  directionSection, directionBody, directionIsTodo, pullRequestSaid,
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
