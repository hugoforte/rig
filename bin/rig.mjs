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
import { MAJOR, toolVersion, dataMajor, stampUnreadable, pendingMigrations, writesBlocked, applyMigrations } from './version.mjs'
import { skipReason, dueForRefresh, staleLine, announces } from './freshness.mjs'
import { releaseMark } from './release.mjs'
import { renderDash } from './dash.mjs'
import { workState } from './workstate.mjs'
import { phaseOf, phaseLabel, statusLine, gatesOf, contradictions } from './phase.mjs'
import { nextFor } from './next.mjs'
import { locate, withDataRoot, load, readOrg, writeMachine, writeOrg, strayOrgKeys, sameDir, insideDir } from './roots.mjs'

const RIG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------- primitives

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
}

const say = s => console.log(s)
// For the ambient freshness line alone: it is rig talking about itself, not part of any
// command's answer, so it must not land in a pipe someone is reading the answer out of.
const aside = s => console.error(s)
const step = s => console.log(`${C.cyan('·')} ${s}`)
const warn = s => console.log(`${C.yellow('!')} ${s}`)
const ok = s => console.log(`${C.green('✓')} ${s}`)
// A rung above `warn`, and `doctor` is the only caller: `!` is something for you to deal
// with, `✗` is something that should not be possible. Keeping them apart is what stops the
// one report that means "rig has a bug" reading like the eleven that mean "push your data
// root".
const bad = s => console.log(`${C.red('✗')} ${s}`)

// Where a `✗` sends you. rig's own tracker, because a contradiction is rig's bug and not the
// reader's — see `docs/agents/issue-tracker.md`.
const ISSUES_URL = 'https://github.com/hugoforte/rig/issues'

const die = msg => { throw new RigError(msg) }

// `windowsHide` is not cosmetic here and is not an internal choice: the freshness refresh is
// spawned DETACHED_PROCESS, so it has no console, and without this every `git` it runs
// allocates a console host — seconds each, a refresh that never finishes inside its deadline,
// and an orphan per command that buries the desktop in windows. A test asserts it, because
// the behavioural symptom only shows on a machine already under load.
const SPAWN_DEFAULTS = { encoding: 'utf8', windowsHide: true }

function run (cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { ...SPAWN_DEFAULTS, ...opts })
  if (r.error) die(`${cmd} not found on PATH (${r.error.message})`)
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

// Is the command on PATH at all? `run` dies when it is not, which is right for every caller
// that needs it — except the ones whose whole job is to report that it is missing.
const onPath = cmd => !spawnSync(cmd, ['--version'], SPAWN_DEFAULTS).error

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

// Free space is the one check with no portable form: PowerShell on Windows, `df` on
// everything POSIX. Returns null when this machine's probe is absent or says something
// unreadable — a check rig cannot make is dropped, never fatal, which is what it used to be
// (a `run` that died on a machine with no powershell, taking doctor's verdict with it).
function freeSpace (dir) {
  if (process.platform === 'win32') {
    if (!onPath('powershell')) return null
    const drive = dir.slice(0, 2)
    const r = run('powershell', ['-NoProfile', '-Command', `(Get-PSDrive ${drive[0]}).Free`])
    const bytes = Number(r.out)
    if (r.code !== 0 || !r.out || !Number.isFinite(bytes)) return null
    return { label: drive, bytes }
  }
  if (!onPath('df')) return null
  const r = run('df', ['-Pk', dir])
  return r.code === 0 ? parseDf(r.out) : null
}

function must (cmd, args, opts = {}) {
  const r = run(cmd, args, opts)
  if (r.code !== 0) die(`${cmd} ${args.join(' ')}\n${r.err || r.out}`)
  return r.out
}

const git = (dir, ...args) => run('git', ['-C', dir, ...args])
// A plain fetch of a whole remote, and it may never prompt: a fetch that stops for
// credentials hangs a command someone is watching, or — in the detached refresh, which has
// no terminal to answer on — leaves a stuck process behind for every command that armed one.
// Asserted by a test as an option, like the spawn options: the only symptom of dropping it
// is a hang, on a machine whose remote happens to want credentials.
const FETCH_ENV = { GIT_TERMINAL_PROMPT: '0' }
const gitFetch = dir => run('git', ['-C', dir, 'fetch', '-q'], { env: { ...process.env, ...FETCH_ENV } })
const gitMust = (dir, ...args) => must('git', ['-C', dir, ...args])

function readStdin () {
  if (process.stdin.isTTY) return ''
  try { return fs.readFileSync(0, 'utf8').trim() } catch { return '' }
}

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
const firstLine = s => (s || '').split('\n')[0]

// ------------------------------------------------------------------- config

// Where config lives, resolved on first use rather than at load: `help` and `prompt` never
// read config, and a broken rig.local.json should fail inside a command with the file
// named, not on import. `cmds.init` is the one thing that reassigns this, at its top, when
// the data root is moving in the command that is running — bin/roots.mjs owns everything
// else about the two files.
let location
const where = () => (location ??= locate(RIG_ROOT))
const dataRoot = () => where().dataRoot
const localConfigFile = () => where().localFile
const repoConfigFile = () => where().orgFile

// The tracker clients, each resolved on first use. Production shells to the real CLI.
// With the matching RIG_FAKE_* env var naming a JSON file, the in-memory adapter runs
// instead, loaded from that file and written back when the command ends, so a
// subprocess test sees the issues and comments rig made — one mechanism for both.
function adapterResolver (envVar, viaCli, inMemory) {
  let resolved, fake
  return {
    get () {
      if (resolved) return resolved
      const file = process.env[envVar]
      if (!file) return (resolved = viaCli())
      fake = { file, state: exists(file) ? readJson(file) : {} }
      return (resolved = inMemory(fake.state))
    },
    persist () { if (fake) writeJson(fake.file, fake.state) },
  }
}
const githubAdapter = adapterResolver('RIG_FAKE_GITHUB', githubViaGh, githubInMemory)
const jiraAdapter = adapterResolver('RIG_FAKE_TWG', twgViaCli, twgInMemory)
const github = () => githubAdapter.get()
const jira = () => jiraAdapter.get()
const persistFakeTrackers = () => { githubAdapter.persist(); jiraAdapter.persist() }

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
const recordDir = id => path.join(dataRoot(),'work', id)
const recordFile = id => path.join(recordDir(id), 'work.json')
const contextFile = id => path.join(recordDir(id), 'context.md')
const planFile = id => path.join(recordDir(id), 'rollout-testing-plan.md')

// ----------------------------------------------------- version & freshness

const packageFile = path.join(RIG_ROOT, 'package.json')
const version = () => toolVersion(exists(packageFile) ? readJson(packageFile) : {})
// rig.json as it sits on disk. `config()` merges it with the machine's file; the record
// format is a property of the data root alone, so the gate reads it unmerged.
const repoConfigJson = () => readOrg(where()) ?? {}

// What the tool checkout is, as far as freshness goes; freshness.mjs decides what that
// means. `linked` is the copy running from a work's worktree — its git dir sits under the
// main checkout's, which is how git itself tells the two apart.
function toolState () {
  // Ambient work on behalf of a command that has already run: no environment problem found
  // here is this function's to report. So the probe must not be `run`, which dies when git is
  // absent — doctor calls this before it reaches its own `git` check, and has to live long
  // enough to make it.
  if (!onPath('git')) return { repo: false }
  const top = git(RIG_ROOT, 'rev-parse', '--show-toplevel')
  if (top.code !== 0) return { repo: false }
  // A rig checked out *inside* another repo would otherwise report that repo's distance.
  if (!sameDir(top.out, RIG_ROOT)) return { repo: true, nested: true }
  const gitDir = git(RIG_ROOT, 'rev-parse', '--absolute-git-dir').out
  const commonDir = path.resolve(RIG_ROOT, git(RIG_ROOT, 'rev-parse', '--git-common-dir').out)
  const branch = git(RIG_ROOT, 'symbolic-ref', '-q', '--short', 'HEAD')
  // `origin/HEAD` is written once, at clone time, and git never refreshes it. Once the remote
  // renames its default branch the ref names one that no longer exists, so it is believed
  // only when the branch it points at is still there.
  const originHead = git(RIG_ROOT, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD')
  const defaultBranch = originHead.code === 0 ? originHead.out.replace(/^origin\//, '') : null
  const defaultBranchLives = defaultBranch !== null &&
    git(RIG_ROOT, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${defaultBranch}`).code === 0
  const upstream = git(RIG_ROOT, 'rev-parse', '--abbrev-ref', '@{u}')
  // On an unborn HEAD git exits 128 and echoes the token `HEAD`, which would be printed as
  // though it were a sha and stamped into the cache as one.
  const head = git(RIG_ROOT, 'rev-parse', 'HEAD')
  return {
    repo: true,
    linked: !sameDir(gitDir, commonDir),
    branch: branch.code === 0 ? branch.out : null,
    defaultBranch: defaultBranchLives ? defaultBranch : null,
    upstream: upstream.code === 0 ? upstream.out : null,
    head: head.code === 0 ? head.out : null,
  }
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

// A commit count, or null when git could not answer. Never 0 for "we do not know": a green
// "up to date" on the strength of a failed command is the kind of quiet wrong answer this
// whole feature exists to prevent.
function countCommits (dir, range) {
  const r = git(dir, 'rev-list', '--count', range)
  if (r.code !== 0) return null
  const n = Number(r.out)
  return Number.isFinite(n) ? n : null
}

// Distance from the upstream *as last fetched* — the caller decides whether to fetch first.
// `behind: null` means unmeasurable, and reads as "nothing to say" everywhere downstream.
const measureFreshness = state => ({
  sha: state.head,
  remote: state.upstream,
  behind: countCommits(RIG_ROOT, 'HEAD..@{u}'),
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
// it fast — `detached` means DETACHED_PROCESS, so a console-less child allocates a console
// host per spawn unless told not to, and the six in `toolState` alone cost twenty seconds.
// Asserted by a test rather than left to a comment: every field is load-bearing, and each
// failure it prevents is invisible until it is expensive. `detached` lets the fetch outlive
// the command; `stdio: 'ignore'` stops a piped `rig prompt` hanging on a child holding the
// pipe; `cwd` keeps the child out of a worktree `rig close` must remove; `windowsHide` is why
// the child is not paying for a console per git call.
const REFRESH_SPAWN = { cwd: RIG_ROOT, detached: true, stdio: 'ignore', windowsHide: true }

function refreshFreshnessInBackground () {
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'freshness-refresh'],
      REFRESH_SPAWN).unref()
  } catch { /* a refresh that will not spawn is not worth a word to the user */ }
}

// The end of every command: one dim line read from the cache — never a fetch, so it cannot
// add latency — and then, at most once per configured interval, the refresh that makes the
// next run's line true. Runs outside the command's own error handling, so nothing in here may
// throw: a freshness check has no business turning a command that worked into a stack trace.
function freshnessEpilogue (command) {
  // The refresh is the check. If it armed another, a remote nobody can reach would spawn a
  // chain of detached processes with no one to stop it.
  if (command === 'freshness-refresh') return
  try {
    const cfg = config()
    if (!cfg.freshness.enabled) return
    // Cheap first: most runs have nothing to say and nothing to do, and toolState costs six
    // git spawns.
    const head = git(RIG_ROOT, 'rev-parse', 'HEAD')
    if (head.code !== 0) return
    const cache = readFreshness(cfg)
    const due = dueForRefresh(cache, cfg.freshness.everyHours)
    const line = announces(command, { enabled: cfg.freshness.enabled })
      ? staleLine(cache, head.out)
      : null
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
const MUTATING = new Set(['new', 'ticket', 'attach', 'detach', 'plan', 'save', 'close', 'backfill'])

// Before a mutating command reads anything. rig pushes the data root but never pulled it, so
// a second machine read stale records and wrote on top of them. Fast-forward only: a data
// root with commits of its own is left for `commitDataRoot`'s rebase at the end. Then the
// gate, which holds whether or not there is a remote to sync with.
function prepareDataRoot () {
  const root = dataRoot()
  if (exists(root) && where().split) {
    const before = checkoutState(root)
    if (before.repo === 'own' && before.branch && before.upstream && dataFetchDue()) {
      const fetched = gitFetch(root)
      if (fetched.code !== 0) {
        stampDataFetchFailure()
        say(C.dim(`· data root: could not fetch (${firstLine(fetched.err) || 'no detail from git'}) — working from what is here`))
      } else {
        clearDataFetchFailure()
        const state = checkoutState(root)
        if (state.behind && state.ahead) {
          warn(`data root: ${state.behind} behind and ${state.ahead} ahead of origin — left alone; it is rebased when this command commits`)
        } else if (state.behind && state.dirty) {
          warn(`data root: ${state.behind} commit(s) behind origin with uncommitted changes — run \`rig save\`, then it will fast-forward`)
        } else if (state.behind) {
          const ff = git(root, 'merge', '--ff-only', '@{u}')
          if (ff.code !== 0) warn(`data root: could not fast-forward (${firstLine(ff.err) || 'no detail from git'})`)
          else say(C.dim(`· data root: fast-forwarded ${state.behind} commit(s) from origin`))
        }
      }
    }
  }
  checkWriteGate()
}

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
function writeOrgMigrations () {
  let ran = []
  writeOrg(where(), prev => {
    const result = applyMigrations(prev ?? {}, version())
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
  let dir = process.cwd()
  for (;;) {
    const marker = path.join(dir, WORK_FOLDER.marker, 'id')
    if (exists(marker)) return readText(marker).trim()
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  die('not inside a work (no .rig/id found). Pass --work <id> or cd into one.')
}

function loadWork (cfg, id) {
  if (!exists(recordFile(id))) die(`no work record for "${id}" at ${recordFile(id)}`)
  const w = readJson(recordFile(id))
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
  // A worktree's path is derived from this machine's work root, never stored:
  // the same record must work on every machine that shares the data root.
  for (const r of w.repos) r.path = path.join(workDir(cfg, id), r.repo)
  return w
}

// The current work — `--work <id>`, else the folder the command runs in — as a record.
const openWork = (cfg, flags) => loadWork(cfg, findWorkId(cfg, flags.work))

// Committing a work: the record, the context doc header and the generated work folder
// are three views of one fact, written together so no caller can forget one (AGENTS.md
// rule 2). `repos[].path` is derived by `loadWork` and stripped here — it never reaches
// disk (DESIGN.md decision 37).
function saveWork (cfg, work) {
  writeJson(recordFile(work.id), { ...work, repos: (work.repos || []).map(({ path: _derived, ...r }) => r) })
  syncDocHeader(work.id, work)
  if (exists(workDir(cfg, work.id))) regenerate(cfg, work)
  else if (!work.closedAt) warn(`${work.id}: work folder ${workDir(cfg, work.id)} is missing — its AGENTS.md was not regenerated`)
}

function listWorkIds () {
  const root = path.join(dataRoot(),'work')
  if (!exists(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && exists(recordFile(d.name)))
    .map(d => d.name)
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

function loadCatalog () {
  const root = path.join(dataRoot(),'catalog')
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

const findCatalog = (name) =>
  loadCatalog().find(e => e.repo.toLowerCase() === name.toLowerCase())

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
  remotes: process.env.RIG_FAKE_REMOTES ? remotesInDirectory(process.env.RIG_FAKE_REMOTES) : remotesOnGitHub(),
  run,
  step,
  warn,
})

// ------------------------------------------------------------------ helpers

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)

// Flags that never take a value, so `rig new --ticket my-id` keeps its positional.
const BOOL_FLAGS = new Set(['ticket', 'no-ticket', 'dry-run', 'designed', 'abandoned', 'setup', 'force', 'run', 'quick', 'verbose', 'help', 'restarted', 'json', 'no-open'])

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
function ticketWriteBack (work, states, { abandoned = false } = {}) {
  const keys = work.tickets || []
  for (const k of keys) {
    if (!isJiraKey(k) && !isGithubKey(k)) warn(`ticket "${k}" is neither PROJ-123 nor owner/repo#n — skipped`)
  }
  const githubKeys = keys.filter(isGithubKey)
  const jiraKeys = keys.filter(isJiraKey)
  if (!githubKeys.length && !jiraKeys.length) return

  const { done: merged, reason, repos } = workState(work, states)
  const prs = repos.filter(v => v.pr).map(v => `- ${v.repo}: ${v.pr.url}`)
  // An abandoned work never closes its ticket, whatever the PRs say: stopping is a decision
  // about this attempt, and whether the *problem* is still worth solving is not rig's to
  // answer. A slice that did land is still listed — it is on the base branch either way.
  const opening = abandoned
    ? 'Abandoned — `rig close --abandoned` ran. The work was stopped without finishing; the issue stays open.'
    : `Closed by \`rig close\`.${merged ? '' : ` ${reason} The issue stays open.`}`

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
      : `\`rig close\` ran.${merged ? ' Every attached PR is merged.' : ` ${reason}`}`,
    ...(prs.length ? ['', ...prs] : []),
    '', `Context doc: ${contextDocRef(work.id)}`,
    '', 'rig does not transition Jira tickets — move this one yourself.',
  ].join('\n')
  for (const key of jiraKeys) {
    const notCommented = trackerFailure(() => jira().commentIssue(key, jiraBody))
    if (notCommented) warn(`${key}: could not comment (${notCommented})`)
    else step(`commented on ${key}`)
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
}

// ------------------------------------------------------ data root commits

// How the data root stands as a git checkout, read once for both the commit below and
// The three questions asked of either checkout an installation is made of — the data root
// and the tool itself. `repo` is 'none' (not versioned), 'nested' (a directory inside some
// other checkout, whose top is `top` — `git add -A` there would stage all of it) or 'own';
// `branch` is null on a detached HEAD; `ahead` and `behind` are measured against the
// upstream as last fetched, so a caller that wants them current fetches first.
function checkoutState (root) {
  const top = git(root, 'rev-parse', '--show-toplevel')
  if (top.code !== 0) return { repo: 'none' }
  if (!sameDir(top.out, root)) return { repo: 'nested', top: top.out }
  const branch = git(root, 'symbolic-ref', '-q', '--short', 'HEAD')
  const upstream = git(root, 'rev-parse', '--abbrev-ref', '@{u}').code === 0
  return {
    repo: 'own',
    branch: branch.code === 0 ? branch.out : null,
    upstream,
    ahead: upstream ? countCommits(root, '@{u}..HEAD') : 0,
    behind: upstream ? countCommits(root, 'HEAD..@{u}') : 0,
    dirty: git(root, 'status', '--porcelain').out.split('\n').filter(Boolean).length,
  }
}

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
function commitDataRoot (message) {
  const root = dataRoot()
  if (!where().split) { warn(`data root ${root} is inside the tool checkout — not committing knowledge into it`); return }
  const state = checkoutState(root)
  if (state.repo === 'none') { say(C.dim(`· data root ${root} is not a git checkout — nothing committed`)); return }
  if (state.repo === 'nested') { warn(`data root ${root} is a directory inside another checkout (${state.top}) — not committing, that would stage all of it`); return }

  const add = git(root, 'add', '-A')
  if (add.code !== 0) { warn(`data root: could not stage (${firstLine(add.err)}) — commit it by hand`); return }
  const staged = git(root, 'diff', '--cached', '--quiet').code !== 0
  if (staged) {
    const commit = git(root, 'commit', '-q', '-m', message)
    if (commit.code !== 0) { warn(`data root: could not commit (${firstLine(commit.err || commit.out)}) — the change waits for the next command`); return }
  }
  const hash = git(root, 'rev-parse', '--short', 'HEAD').out || '(unborn)'
  const committed = staged ? `committed ${hash}` : 'nothing to commit'
  if (!state.branch) { warn(`data root: ${committed} on a detached HEAD — check out a branch and cherry-pick it`); return }
  if (!state.upstream) {
    if (staged) ok(`data root: ${committed} (no upstream — not pushed)`)
    else say(C.dim(`· data root: ${committed}`))
    return
  }
  if (!staged && !state.ahead) { say(C.dim('· data root: nothing to commit, nothing to push')); return }

  const fetch = gitFetch(root)
  if (fetch.code !== 0) { warn(`data root: ${committed}, but could not fetch from origin (${firstLine(fetch.err) || 'no detail from git'}) — nothing pushed`); return }
  const rebase = git(root, 'rebase', '-q', '@{u}')
  if (rebase.code !== 0) {
    const abort = git(root, 'rebase', '--abort')
    if (abort.code !== 0) warn(`data root: ${committed}, but rebasing onto origin hit a conflict and the abort failed — sort ${root} out by hand (git status)`)
    else warn(`data root: ${committed}, but rebasing onto origin hit a conflict — rebase aborted, tree left clean; pull, resolve and push by hand in ${root}`)
    return
  }
  const pushed = git(root, 'rev-parse', '--short', 'HEAD').out   // rewritten by the rebase
  const push = git(root, 'push', '-q')
  if (push.code !== 0) { warn(`data root: ${committed} as ${pushed}, but the push failed (${firstLine(push.err)}) — push it by hand`); return }
  ok(`data root: ${staged ? `committed ${pushed}` : `pushed ${pushed}, committed earlier`} and pushed`)
}

// A mutating command's registration of what it is committing as. Called as soon as the
// command has written anything worth committing; `main` does the rest.
let pendingCommit = null
let currentCommand = null
const commitAs = (subject, detail) =>
  { pendingCommit = `rig ${currentCommand}${subject ? ` ${subject}` : ''}${detail ? `: ${detail}` : ''}` }

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
  writeOrg(withDataRoot(where(), target), prev => prev ?? { orgs: [], tracker: {}, writtenBy: version() })
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
  must('git', ['-C', target, 'add', '-A'])
  must('git', ['-C', target, 'commit', '-q', '-m', 'Initialise rig data root'])
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
function joinOrCreateDataRepo (spec) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(spec) || /\/\.\.?$/.test(spec)) die(`--data-repo wants owner/name, got "${spec}"`)
  const [owner, name] = spec.split('/')
  const target = path.join(path.dirname(RIG_ROOT), name)

  // Already pointed somewhere else? Switching data roots is deliberate, not a side effect
  // of joining a repo.
  if (where().split && !sameDir(dataRoot(), target)) {
    die(`dataRoot is already ${dataRoot()}. Switching data roots is deliberate: use --data-root.`)
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
    flags['data-root'] = joinOrCreateDataRepo(flags['data-repo'])
  }
  // The data root is decided here, before anything reads config, and the location every
  // helper below resolves against moves with it. This is the only reassignment there is:
  // `init` used to poke the resolved root half-way through itself, which left everything
  // after that line depending on a line you had to read the whole command to find.
  const previousRoot = dataRoot()
  if (flags['data-root']) location = withDataRoot(where(), path.resolve(RIG_ROOT, flags['data-root']))
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
      const next = prev || { orgs: [], tracker: {}, writtenBy: version() }
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

  // Only the machine-level half goes in rig.local.json: the roots, and an identity per org.
  // An existing file is merged into — a new data root, and identities for orgs that have
  // none yet — and nothing already set is touched.
  let created = false
  const changes = []
  writeMachine(where(), prev => {
    if (!prev) {
      created = true
      return {
        workRoot: flags['work-root'] ? path.resolve(flags['work-root']) : config().workRoot,
        ...(isSplit ? { dataRoot: targetDataRoot } : {}),
        identities: Object.fromEntries(orgs.map(o => [o, email])),
        secrets: {},
      }
    }
    const next = { ...prev }
    if (flags['data-root'] && !sameDir(previousRoot, targetDataRoot)) { next.dataRoot = targetDataRoot; changes.push('dataRoot') }
    if (email) {
      next.identities = { ...next.identities }
      for (const o of orgs) if (!next.identities[o]) { next.identities[o] = email; changes.push(`identity for ${o}`) }
    }
    return next
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

  const lp = run('git', ['config', '--global', 'core.longpaths'])
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

cmds.new = async ({ flags, positional }) => {
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
  const tpl = readText(path.join(RIG_ROOT, 'templates', 'context.md'))
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
    for (const r of repos) await attachRepo(cfg, work, r, { setup: !!flags.setup })
  } else {
    say('No repos attached yet. Run the selection interview:')
    say(C.dim('  rig prompt select-repos'))
    say(C.dim(`  rig attach <repo> --work ${id}`))
  }
}

// Attaches to the record it is given — `rig new --repos a,b` passes the one it just built.
async function attachRepo (cfg, work, repoName, { setup = false } = {}) {
  if (work.repos.some(r => r.repo.toLowerCase() === repoName.toLowerCase())) {
    say(`${repoName} already attached — nothing to do`)
    return
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
  work.repos.push({ repo, org, path: dest, base, role: cat?.role || '', attachedAt: new Date().toISOString() })
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

cmds.attach = async ({ flags, positional }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const name = positional[0] || die('usage: rig attach <repo>')
  commitAs(work.id, name)
  await attachRepo(cfg, work, name, { setup: !!flags.setup })
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
  if (entry.pr) {
    out.pr = {
      number: entry.pr.number,
      state: 'MERGED',
      url: entry.pr.url,
      openedAt: entry.pr.openedAt,
      firstReviewAt: entry.pr.firstReviewAt ?? null,
      approvedAt: entry.pr.approvedAt ?? null,
      mergedAt: entry.pr.mergedAt,
      recorded: true,
    }
    out.firstCommitAt = entry.pr.firstCommitAt
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

// The one machine-readable surface (decision 55). `rig list --json` prints it; `rig dash`
// renders it; neither reads the records a second way.
const listPayload = (cfg, live) => ({
  rig: version(),
  recordFormat: MAJOR,
  generatedAt: new Date().toISOString(),
  live,
  works: worksByActivity(cfg).map(w => workJson(cfg, w, live)),
})

cmds.list = ({ flags }) => {
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
    if (live && verdict.done) {
      say(`  ${C.green('→ all PRs merged, nothing uncommitted — safe to `rig close`')}`)
    } else if (live && verdict.safeToClose && verdict.repos.length) {
      // The disagreement #2 was filed for: `list` used to stay silent here while `close`
      // would have closed the work without a murmur. Said plainly instead, and not as a
      // recommendation — nothing landed, so this is not finished work.
      say(`  ${C.dim('→ nothing outstanding, but nothing merged either — `rig close` would not refuse')}`)
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
  const r = onPath(cmd) ? run(cmd, [...args, out]) : { code: 1, err: `${cmd} is not on PATH` }
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
}

// The catalogue's commands for one repo, in that repo's worktree. `label` is the
// frontmatter key they came from, so a failure names the thing that failed.
function runCatalogCommands (dir, commands, label) {
  for (const c of commands) {
    step(`${c}  ${C.dim(`(in ${path.basename(dir)})`)}`)
    const r = spawnSync(c, { cwd: dir, shell: true, stdio: 'inherit' })
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
      if (!runCatalogCommands(r.path, cat.check, 'check')) process.exitCode = 1
      continue
    }
    say(`${C.bold(r.repo)} ${C.dim(`(not run — \`rig check ${r.repo} --run\`)`)}`)
    for (const c of cat.check) say(`  ${c}`)
  }
}

// The "what now" answer. Read-only, and a command you run — never a hook, and never fired
// off the back of another command (decision 66). The gathering lives here; every decision
// about what is worth offering is `bin/next.mjs`'s.
cmds.next = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const states = work.repos.map(r => repoState(cfg, r, work.branch))
  const verdict = workState(work, states)
  // `workState` answers the verdict half and the worktree state answers `pushed`; joined
  // here rather than in either, because "is this branch on the remote" is not a question
  // about whether the work is finished.
  const repos = verdict.repos.map((v, i) => ({ ...v, pushed: !!states[i].pushed }))

  const doc = exists(contextFile(work.id)) ? readText(contextFile(work.id)) : ''
  const offers = nextFor({
    work,
    repos,
    // The scaffolded stub, still standing where the design should be.
    directionTodo: /^## Direction$[\s\S]*?^_TODO_$/m.test(doc),
    planExists: exists(planFile(work.id)),
  })

  say(`${C.bold(work.id)} ${C.dim(`— ${phaseLabel(phaseOf(work, repos))}`)}`)
  if (!offers.length) {
    say(C.dim(work.closedAt ? '  nothing — this work is done' : '  nothing to suggest'))
    return
  }
  say('')
  for (const o of offers) {
    say(`  ${C.cyan('→')} ${o.says}`)
    if (o.command) say(`    ${C.dim(o.command)}`)
  }
}

cmds.plan = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  if (exists(planFile(id)) && !flags.force) die(`${planFile(id)} already exists`)
  const tpl = readText(path.join(RIG_ROOT, 'templates', 'rollout-testing-plan.md'))
  writeText(planFile(id), tpl
    .replace(/\{\{ID\}\}/g, id)
    .replace(/\{\{TITLE\}\}/g, work.title || id)
    .replace(/\{\{KEYS\}\}/g, work.tickets.join(', ') || id)
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
  const verdict = workState(work, states)
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
    process.exitCode = 1
    return
  }
  // Every PR left is terminal by now — blockers above already refused an open one — so this
  // is the one moment to record it, before the worktree the branch fallback would read from
  // is removed below. A record for a different PR number is re-taken: the branch carried a
  // second PR after the first was recorded, and the newest is the one that finished the work.
  // An abandoned work can still have landed a slice or two; `merged` below is what decides,
  // so those terminal facts are recorded here exactly as they would be for any other close.
  work.repos.forEach((r, i) => {
    const s = states[i]
    if (!verdict.repos[i].merged || !s.pr || r.pr?.number === s.pr.number) return
    const { record, error } = terminalPr(r, s.pr)
    if (record) r.pr = record
    // Said out loud: a close that could not record looks identical to one that did, and the
    // work is about to lose the worktree its first commit could have been read from.
    else warn(`${error} — not recorded; \`rig backfill --work ${id}\` once GitHub answers again`)
  })
  for (const r of work.repos) {
    if (!exists(r.path)) continue
    const failed = trees(cfg).remove({ org: r.org, repo: r.repo, dir: r.path, force: !!flags.force })
    if (failed) warn(`${r.repo}: ${failed}`)
    else step(`removed worktree ${r.repo}`)
  }
  commitAs(id)
  const wd = workDir(cfg, id)
  // Windows refuses to remove a directory that is some process's cwd — including ours.
  if (insideDir(process.cwd(), wd)) process.chdir(RIG_ROOT)
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
  ticketWriteBack(work, states, { abandoned })
  ok(`${abandoned ? 'abandoned' : 'closed'} ${id} — context doc kept at ${contextFile(id)}`)
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
      const already = !!entry.pr
      if (already && !flags.force) continue
      let pr = null
      const prError = trackerFailure(() => { pr = github().prForBranch(entry.org, entry.repo, work.branch) })
      if (prError) { unresolved.push(`${id}/${entry.repo}: ${prError}`); continue }
      if (!pr || pr.state !== 'MERGED') continue   // not terminal — nothing to store, nothing to report
      const { record, error } = terminalPr(entry, pr)
      if (error) { unresolved.push(`${id}/${entry.repo}: ${error}`); continue }
      entry.pr = record
      changed = true
      filled++
      step(`${id}/${entry.repo}: ${already ? 'refreshed' : 'recorded'} PR #${pr.number}`)
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
  const entries = loadCatalog().sort((a, b) => a.repo.localeCompare(b.repo))
  if (positional[0]) {
    const e = entries.find(x => x.repo.toLowerCase() === positional[0].toLowerCase())
    if (!e) die(`no catalogue entry for "${positional[0]}"`)
    return process.stdout.write(readText(e.file))
  }
  if (!entries.length) return say('catalogue is empty — entries are drafted on `rig attach`')
  for (const e of entries) {
    const flag = e.draft ? C.yellow(' [draft]') : ''
    say(`${e.repo.padEnd(34)} ${C.dim(e.org.padEnd(15))} ${e.role}${flag}`)
    if (flags.verbose && e.talks_to.length) {
      for (const t of e.talks_to) say(`  ${C.dim('→')} ${t.repo}: ${t.how || ''}`)
    }
  }
}

cmds.prompt = ({ positional }) => {
  const name = positional[0]
  const dir = path.join(RIG_ROOT, 'prompts')
  if (!name) {
    say('available prompts:')
    for (const f of fs.readdirSync(dir)) say(`  ${f.replace(/\.md$/, '')}`)
    return
  }
  const f = path.join(dir, `${name}.md`)
  if (!exists(f)) die(`no prompt "${name}" (see \`rig prompt\`)`)
  process.stdout.write(readText(f))
}

// Fast-forwards one of the two checkouts an installation is made of. Never merges and never
// rebases: a diverged tree is yours to sort out, and moving it silently is how a commit gets
// lost. A tree that cannot move is reported, not fatal — the other one still updates.
// `clean` is reported separately from `status`: a tree with nothing to update is not the
// same as a tree that is safe to commit into, and `rig update` migrates only when it is
// both. A local-only data root reaches 'current' without the question ever being asked.
function updateCheckout (label, root) {
  const state = checkoutState(root)
  if (state.repo !== 'own') { say(`${C.dim('·')} ${C.dim(`${label}: ${root} is not a checkout of its own — nothing to update`)}`); return { status: 'current', clean: false } }
  if (!state.branch) { warn(`${label}: detached HEAD — not updated`); return { status: 'failed', clean: false } }
  // Only tracked changes are counted. An untracked scratch file stops a fast-forward only
  // when the merge would overwrite it, and git says so itself in that case — refusing on any
  // untracked file means one stray file wedges the installation, and for the data root the
  // advice that follows would `git add -A` it and manufacture the divergence being avoided.
  const modified = git(root, 'status', '--porcelain', '--untracked-files=no').out.split('\n').filter(Boolean)
  // Two different questions. `modified` is what stops a fast-forward. `clean` is what
  // `commitDataRoot` would sweep up, and that is `git add -A` — untracked files included,
  // so an unfinished note nobody staged makes the tree unsafe to migrate in.
  const clean = state.dirty === 0
  if (!state.upstream) { say(`${C.dim('·')} ${C.dim(`${label}: no upstream — nothing to update from`)}`); return { status: 'current', clean } }
  if (modified.length) {
    const how = label === 'data root' ? ', run `rig save`' : ` — \`git -C ${root} status\` shows them`
    warn(`${label}: ${modified.length} uncommitted change(s) — not updated${how}`)
    return { status: 'failed', clean }
  }
  const fetched = gitFetch(root)
  if (fetched.code !== 0) { warn(`${label}: could not fetch (${firstLine(fetched.err) || 'no detail from git'}) — not updated`); return { status: 'failed', clean } }
  const from = git(root, 'rev-parse', 'HEAD').out
  const fetchedState = checkoutState(root)
  if (fetchedState.behind === null) { warn(`${label}: could not measure the distance from its upstream — not updated`); return { status: 'failed', clean } }
  if (fetchedState.behind === 0) { ok(`${label}: already up to date`); return { status: 'current', from, clean } }
  const ff = git(root, 'merge', '--ff-only', '@{u}')
  if (ff.code !== 0) {
    // Divergence is only one reason a fast-forward fails. For the others — a lock, a file in
    // the way — git's own words are the actionable part, and "rebase it by hand" is not.
    if (fetchedState.ahead) warn(`${label}: ${fetchedState.behind} behind and ${fetchedState.ahead} ahead of its upstream — not updated; merge or rebase it by hand in ${root}`)
    else warn(`${label}: could not fast-forward ${fetchedState.behind} commit(s) (${firstLine(ff.err) || 'no detail from git'}) — not updated`)
    return { status: 'failed', clean }
  }
  ok(`${label}: fast-forwarded ${fetchedState.behind} commit(s)`)
  const arrived = git(root, 'log', '--oneline', '--no-decorate', `${from}..HEAD`).out.split('\n').filter(Boolean)
  for (const line of arrived.slice(0, 20)) say(`  ${C.dim(line)}`)
  if (arrived.length > 20) say(`  ${C.dim(`… and ${arrived.length - 20} more`)}`)
  return { status: 'moved', from, clean }
}

cmds.update = ({ flags }) => {
  const cfg = config()
  let problems = 0
  const tool = toolState()
  if (tool.linked) {
    warn(`this is the copy in a worktree (${RIG_ROOT}) — updating it would move your work's branch, not the installation. Run \`rig update\` from the installed checkout.`)
    problems++
  } else {
    const moved = updateCheckout('tool', RIG_ROOT)
    if (moved.status === 'failed') problems++
    // This process is running the code that was here a moment ago: its migration list, its
    // doctor checks and its version are all the old ones. Hand the rest of the update to what
    // just arrived. `--restarted` makes that exactly one hop — an argv flag rather than an
    // environment variable, because a variable the user happens to have exported would skip
    // the hop silently, and with it every migration that just landed.
    if (moved.status === 'moved' && !flags.restarted) {
      say(`${C.dim('·')} ${C.dim('the tool moved — continuing with the code that just arrived')}`)
      const again = spawnSync(process.execPath, [path.join(RIG_ROOT, 'bin', 'rig.mjs'), 'update', '--restarted'],
        { stdio: 'inherit' })
      // A non-zero exit here is usually the doctor checks reporting problems, which is a
      // healthy update. It means a broken release only when the arrived code cannot run at
      // all — so ask it for the one command that needs nothing, and believe that instead.
      if (again.status !== 0 && run(process.execPath, [path.join(RIG_ROOT, 'bin', 'rig.mjs'), 'help']).code !== 0) {
        warn(`the update landed, but the rig that arrived does not run — \`git -C ${RIG_ROOT} reset --hard ${moved.from}\` puts the previous one back`)
      }
      process.exitCode = again.status ?? 1
      return
    }
  }

  const root = dataRoot()
  let dataRootReady = false
  if (!where().split) { warn('data root is inside the tool checkout — not set up; run `rig prompt setup`'); problems++ }
  else if (!exists(root)) { warn(`data root ${root} is missing — check dataRoot in rig.local.json`); problems++ }
  else {
    const data = updateCheckout('data root', root)
    if (data.status === 'failed') problems++
    // Clean and current, the two halves of "safe to migrate in".
    dataRootReady = data.clean && data.status !== 'failed'
  }

  if (exists(repoConfigFile())) {
    const pending = pendingMigrations(repoConfigJson())
    if (pending.length && !dataRootReady) {
      // `commitDataRoot` stages the whole tree, so migrating a dirty data root would publish
      // whatever it was refused an update for — under a message claiming to be a migration.
      // And it rebases onto origin before it pushes, so migrating a diverged or unfetchable
      // one would replay the migration on top of records another machine may already have
      // migrated (docs/adr/0002).
      warn(`${pending.length} migration(s) pending, not run — the data root has to be clean and current first`)
      problems++
    } else if (pending.length) {
      const { ran } = writeOrgMigrations()
      for (const name of ran) ok(`migrated: ${name}`)
      // Committed here rather than through `main`, because the doctor checks run below and a
      // health verdict must not report the data root dirty with the change just made.
      commitDataRoot(`rig update: record format ${MAJOR}`)
    }
  }

  // The cache describes a checkout that may have just moved.
  const after = toolState()
  if (!skipReason(after)) writeFreshness(cfg, measureFreshness(after))

  say('')
  cmds.doctor({ flags: {}, positional: [] })
  if (problems) process.exitCode = 1
}

// Hidden: the detached child spawned at the end of a command. Fetches, measures, writes the
// cache, says nothing to anyone — the next command is what speaks.
cmds['freshness-refresh'] = () => {
  const cfg = config()
  const state = toolState()
  if (skipReason(state)) return
  const fetched = gitFetch(RIG_ROOT)
  // A failed check is still a check: stamping it means an unreachable remote is retried once
  // per interval rather than at the end of every command. What it must not do is forget a
  // distance that is still true — concurrent refreshes make each other's fetches fail on the
  // ref lock, and the loser erasing the winner's "3 commits behind" would go quiet for the
  // whole interval on the strength of a race.
  if (fetched.code !== 0) {
    const previous = readFreshness(cfg)
    const behind = previous?.sha === state.head ? previous.behind ?? null : null
    writeFreshness(cfg, { sha: state.head, remote: state.upstream, behind, checkedAt: new Date().toISOString() })
    return
  }
  writeFreshness(cfg, measureFreshness(state))
}

cmds.doctor = () => {
  if (!exists(localConfigFile())) {
    warn(`not set up — no ${localConfigFile()}. Run \`rig prompt setup\` and follow it; it ends in one \`rig init\`.`)
    process.exitCode = 1
    return
  }
  const cfg = config()
  let problems = 0
  // Asked of the files, not carried on `cfg`: which keys the org half owns is bin/roots.mjs's
  // to know, and a diagnostic riding on a config value had exactly one reader — this one.
  for (const key of strayOrgKeys(where())) {
    warn(`${localConfigFile()} has "${key}" — ignored; it lives in rig.json. Remove it.`); problems++
  }
  // detail.ok shows when the check passes, detail.bad when it fails.
  const check = (label, good, detail = {}) => {
    if (good) ok(`${label}${detail.ok ? ` ${C.dim(detail.ok)}` : ''}`)
    else { warn(`${label}${detail.bad ? ` — ${detail.bad}` : ''}`); problems++ }
  }

  // The two things everything below needs, reported before anything that needs them: doctor
  // used to reach `toolState` first and die there when git was absent, saying nothing at all.
  check('node', true, { ok: process.version })
  const gv = onPath('git') ? run('git', ['--version']) : { code: 1, out: '' }
  check('git', gv.code === 0, { ok: gv.out, bad: 'not on PATH' })

  const tool = toolState()
  // Which *release* this is, when the checkout stands on one — a version and a sha name the
  // same build twice and neither says whether it was ever published. The describe is asked
  // for here and not in `toolState`, which runs in every command's epilogue and is already
  // six spawns dear; doctor is the one caller that can afford a seventh.
  const describe = gv.code === 0 ? git(RIG_ROOT, 'describe', '--tags', '--long', '--match', 'v[0-9]*').out : null
  const mark = releaseMark({ describe, head: tool.head })
  say(`${C.dim('·')} ${C.dim(`rig ${version()} at ${RIG_ROOT}${mark ? ` (${mark})` : ''}`)}`)
  // The one command that fetches before answering: a health check you asked for should
  // report now, not what the cache last saw.
  const skipped = skipReason(tool)
  if (skipped) say(`${C.dim('·')} ${C.dim(`freshness not checked — ${skipped}`)}`)
  else {
    const fetched = gitFetch(RIG_ROOT)
    if (fetched.code !== 0) {
      warn(`freshness not checked — could not fetch (${firstLine(fetched.err) || 'no detail from git'})`); problems++
    } else {
      const measured = measureFreshness(tool)
      writeFreshness(cfg, measured)
      if (measured.behind === null) {
        warn(`freshness not checked — git could not measure the distance from ${tool.upstream}`); problems++
      } else {
        check('installed rig', measured.behind === 0, {
          ok: `up to date with ${tool.upstream}`,
          bad: `${measured.behind} commit(s) behind ${tool.upstream} — run \`rig update\``,
        })
      }
    }
  }

  const auth = github().auth()
  check('gh authenticated', auth === 'ok',
    { bad: auth === 'missing' ? 'gh not on PATH' : 'PR state and org resolution will not work' })
  if (Object.values(cfg.tracker || {}).some(t => t.kind === 'jira')) {
    check('twg present', jira().present(), { bad: 'Jira ticket creation, fetch and write-back will not work' })
  }

  // Skipped rather than attempted without git: doctor is the command you run *because*
  // something is wrong, so it has to reach the end and report everything it can.
  if (gv.code === 0) {
    const lp = run('git', ['config', '--global', 'core.longpaths'])
    check('core.longpaths', lp.out === 'true',
      { bad: 'run `rig init`; deep node_modules paths will break without it' })

    const sym = run('git', ['config', '--get', 'core.symlinks'])
    if (sym.out === 'false') say(`${C.dim('·')} ${C.dim('core.symlinks=false — by design, rig never symlinks')}`)
  }

  check('config file', exists(localConfigFile()), { bad: `${localConfigFile()} missing — run \`rig init\`` })
  check('work root', exists(cfg.workRoot), { ok: cfg.workRoot, bad: `${cfg.workRoot} missing` })
  check('mirror root', exists(cfg.mirrorRoot), { ok: cfg.mirrorRoot, bad: `${cfg.mirrorRoot} missing` })
  const split = where().split
  check('data root', split && exists(dataRoot()), {
    ok: dataRoot(),
    bad: split
      ? `${dataRoot()} missing — check dataRoot in rig.local.json`
      : 'is inside the tool checkout — not set up; knowledge must not live inside a public tool\'s tree. Run `rig prompt setup`',
  })
  if (split && exists(dataRoot()) && gv.code === 0) {
    const state = checkoutState(dataRoot())
    check('data root is a git checkout of its own', state.repo === 'own', {
      bad: state.repo === 'nested'
        ? `it is a directory inside ${state.top} — rig will not commit there, since \`git add -A\` would stage all of it`
        : 'records written there are not versioned',
    })
    if (state.repo === 'own') {
      // rig commits after its own commands; an edit made outside rig waits for `rig save`.
      const dirty = git(dataRoot(), 'status', '--porcelain').out.split('\n').filter(Boolean).length
      if (dirty) warn(`data root has ${dirty} uncommitted change(s) — \`rig save\` commits edits made outside rig`)
      if (!state.branch) { warn('data root is on a detached HEAD — rig commits there go nowhere; check out main'); problems++ }
      else if (!state.upstream) say(`${C.dim('·')} ${C.dim('data root has no upstream — local only; push it to a private repo when ready')}`)
      else if (state.ahead) warn(`data root has ${state.ahead} unpushed commit(s)`)
      else if (!dirty) ok('data root is committed and pushed')
      // Measured against the last fetch, which a mutating command does for itself.
      if (state.behind) { warn(`data root is ${state.behind} commit(s) behind origin — \`rig update\` fast-forwards it`); problems++ }
    }
  }
  check('rig.json', exists(repoConfigFile()),
    { ok: repoConfigFile(), bad: `missing in ${dataRoot()} — not set up; run \`rig prompt setup\`` })
  if (exists(repoConfigFile()) && !cfg.orgs.length) {
    warn('rig.json has no orgs — not set up; run `rig prompt setup`'); problems++
  }
  // Reported, never run: doctor does not mutate, which is what makes it the command you can
  // always run to ask a question without answering it.
  if (exists(repoConfigFile())) {
    const written = repoConfigJson()
    if (stampUnreadable(written)) {
      warn(`data root records writtenBy ${JSON.stringify(written.writtenBy)}, which is not a record format any rig wrote — mutating commands refuse until it is fixed by hand`); problems++
    } else if (writesBlocked(written)) {
      warn(`data root is at record format ${dataMajor(written)}, this rig writes ${MAJOR} — mutating commands refuse until this rig is updated`); problems++
    } else {
      const pending = pendingMigrations(written)
      if (pending.length) {
        warn(`${pending.length} pending migration(s) — run \`rig update\`: ${pending.map(m => m.name).join('; ')}`); problems++
      } else {
        say(`${C.dim('·')} ${C.dim(`record format ${MAJOR}, stamped by rig ${written.writtenBy ?? 'from before stamping existed'}`)}`)
      }
    }
  }

  for (const org of cfg.orgs) {
    const id = effectiveIdentity(cfg, org)
    if (id.source === 'unknown') {
      say(`${C.dim('·')} ${C.dim(`identity for ${org}: no mirror yet — git decides once one is cloned`)}`)
    } else {
      check(`identity for ${org}`, !!id.email,
        { ok: `${id.email}${id.source === 'git' ? ' — from git, not rig' : ''}`,
          bad: 'git has no user.email to commit with' })
    }
    const t = cfg.tracker?.[org]
    const desc = t?.kind ? `${t.kind}${t.repo ? ' ' + t.repo : ''}${t.project ? ' ' + t.project : ''}` : 'none — `rig new --ticket` unavailable (rig.json)'
    say(`${C.dim('·')} ${C.dim(`tracker for ${org}: ${desc}`)}`)
  }

  // Contradictions: a recorded gate that reality denies. Since the phase is derived, drift is
  // no longer possible — the only way one of these fires is a bug in rig or a hand-edited
  // record, which is why they are `✗` and say so. Omissions are deliberately *not* here: a
  // work with no design gate recorded is an ordinary work, `rig next` is where the offer to
  // record one belongs, and a doctor that warns about every one of them is a doctor nobody
  // reads.
  //
  // Asked of the records alone, with no PR lookup: doctor already fetches once and runs over
  // every work, and a GitHub call per repo per work would make the command too slow to be the
  // one you reach for. The contradictions that need live state are caught by `rig status`,
  // which looks them up anyway.
  for (const id of listWorkIds()) {
    for (const message of contradictions(loadWork(cfg, id))) {
      bad(`${message} — this should not be possible; please file an issue at ${ISSUES_URL}`)
      problems++
    }
  }

  // Strays: anything directly under a work folder that rig did not create.
  for (const id of listWorkIds()) {
    const work = loadWork(cfg, id)
    if (work.closedAt) continue
    const wd = workDir(cfg, id)
    if (!exists(wd)) { warn(`${id}: work folder missing but not closed`); problems++; continue }
    const known = new Set([...work.repos.map(r => r.repo), ...WORK_FOLDER_ENTRIES])
    for (const e of fs.readdirSync(wd)) {
      if (known.has(e)) continue
      warn(`${id}: unmanaged entry "${e}" under the work root — rig owns this folder`)
      problems++
    }
    for (const r of work.repos) {
      if (!exists(r.path)) { warn(`${id}: ${r.repo} is attached but its worktree is gone`); problems++ }
      if (cfg.secrets?.[r.repo] === undefined) {
        const cat = findCatalog(r.repo)
        if (cat?.body && /secrets|\.env/i.test(cat.body)) {
          warn(`${id}: ${r.repo} mentions secrets in its catalogue entry but has no source in rig.local.json`)
          problems++
        }
      }
    }
  }

  const drafts = loadCatalog().filter(e => e.draft)
  if (drafts.length) say(`${C.yellow('!')} ${drafts.length} draft catalogue entr${drafts.length === 1 ? 'y' : 'ies'}: ${drafts.map(d => d.repo).join(', ')}`)

  // The label comes from the probe, not from the path: a drive letter on Windows, the mount
  // point the work root actually sits on anywhere else.
  const disk = freeSpace(cfg.workRoot)
  if (disk) {
    const freeGb = Math.round(disk.bytes / 1e9)
    check(`disk on ${disk.label}`, freeGb > 20,
      { ok: `${freeGb} GB free`, bad: `only ${freeGb} GB free` })
  }

  say('')
  say(problems ? C.yellow(`${problems} thing(s) to look at`) : C.green('all clear'))
  if (problems) process.exitCode = 1
}

cmds.help = () => {
  say(`${C.bold('rig')} — cross-repo work harness

  rig init                        one-time setup; "rig prompt setup" asks the questions
       --data-repo owner/name      join that private data repo, or create it if absent
       [--email x] [--work-root d] [--data-root d]            -> rig.local.json (this machine)
       [--orgs a,b] [--tracker a=github:owner/repo,b=jira:KEY] -> rig.json (the data root)
  rig new <id> --title "..."      create a work (reads a brief on stdin)
       --key K | --ticket [--org o] [--field k=v,...] [--dry-run] | --no-ticket
       one of the three is required whenever a tracker is configured (the ticket
       decision must be explicit); --key PROJ-42 fetches its brief from Jira;
       --ticket creates in the org's tracker (rig.json); --dry-run previews and
       creates nothing; --no-ticket records a declined ticket
       [--type feat] [--repos a,b] [--setup]
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
  rig status                      live detail for the current work
  rig next                        what is available now on the current work
  rig setup [repo...]             run the catalogue's setup commands
  rig check [repo...] [--run]     print what verifies each repo — its test run, its lint,
                                  its build; --run runs them and exits non-zero on a failure
  rig catalog [repo] [--verbose]  the repo catalogue: index, or one entry
  rig plan                        scaffold the rollout & testing plan
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
  rig doctor                      environment + consistency checks
  rig update                      fast-forward the tool checkout and the data root,
                                  run pending record migrations, then the doctor checks
  rig prompt [name]               print an agent prompt

Commands that act on "the current work" find it by walking up from the cwd,
or take --work <id>. Every command that changes a work ends by committing the
whole data root, and pushing it when it has an upstream.

rig ${version()} — the major is the record format; \`rig doctor\` reports how far
this installation is behind its remote, \`rig update\` brings it forward.`)
}

// --------------------------------------------------------------------- main

// Pure helpers, importable by tests. Nothing below the guard runs on import.
export {
  parseArgs, parseFrontmatter, parseTrackerFlag, isJiraKey, isGithubKey, slug, trackerFor, BOOL_FLAGS, RigError,
  anyTrackerConfigured, orgForJiraKey, ticketsLabel, statusLine, checkoutState, countCommits,
  activityAt, relativeAge, prTiming, terminalPr, branchFirstCommitAt, baseLabel, baseMoved, sinceFlag, resolveJiraFields,
  SPAWN_DEFAULTS, REFRESH_SPAWN, FETCH_ENV, effectiveIdentity, parseDf,
}

// Node realpaths the main module before evaluating it, so compare realpaths: through a
// symlink or junction (`ln -s bin/rig.mjs ~/.local/bin/rig`) argv[1] is the link.
const isMain = (() => {
  if (!process.argv[1]) return false
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
})()

if (isMain) {
  const [, , cmdName, ...rest] = process.argv
  const cmd = cmds[cmdName || 'help']
  if (!cmd) {
    console.error(`unknown command "${cmdName}" — try \`rig help\``)
    process.exit(1)
  }
  currentCommand = cmdName
  try {
    const args = parseArgs(rest)   // before the network: a typo is not worth a fetch
    if (MUTATING.has(cmdName)) prepareDataRoot()
    await cmd(args)
  } catch (e) {
    if (!(e instanceof RigError)) throw e   // a bug: leave the data root as it is
    console.error(`${C.red('✗')} ${e.message}`)
    process.exitCode = 1
  } finally {
    persistFakeTrackers()
  }
  if (pendingCommit) commitDataRoot(pendingCommit)
  freshnessEpilogue(cmdName)
}
