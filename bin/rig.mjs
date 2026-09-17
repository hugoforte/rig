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
import { MAJOR, toolVersion, dataMajor, pendingMigrations, writesBlocked, applyMigrations } from './version.mjs'
import { DEFAULT_FRESHNESS, skipReason, dueForRefresh, staleLine, announces } from './freshness.mjs'

const RIG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Two roots. RIG_ROOT is this checkout: the tool. The data root (`dataRoot()` below)
// holds the catalogue, the work records and rig.json (committed, org-level: orgs,
// tracker per org), and is set by `dataRoot` in rig.local.json (gitignored,
// machine-level: roots, identities, secrets). Unset, it falls back to RIG_ROOT so an
// old checkout keeps working — but that layout is "not set up": knowledge must not
// live inside a public tool's tree.
const LOCAL_CONFIG = path.join(RIG_ROOT, 'rig.local.json')

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
const step = s => console.log(`${C.cyan('·')} ${s}`)
const warn = s => console.log(`${C.yellow('!')} ${s}`)
const ok = s => console.log(`${C.green('✓')} ${s}`)

const die = msg => { throw new RigError(msg) }

function run (cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (r.error) die(`${cmd} not found on PATH (${r.error.message})`)
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

function must (cmd, args, opts = {}) {
  const r = run(cmd, args, opts)
  if (r.code !== 0) die(`${cmd} ${args.join(' ')}\n${r.err || r.out}`)
  return r.out
}

const git = (dir, ...args) => run('git', ['-C', dir, ...args])
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

// D:\ is the big drive on the machine this was built for; fall back to the
// profile so `rig init` still works on a machine without one.
const defaultWorkRoot = () => (exists('D:\\') ? 'D:\\w' : path.join(os.homedir(), 'w'))

function readLocalConfig () {
  if (!exists(LOCAL_CONFIG)) return {}
  try { return readJson(LOCAL_CONFIG) } catch (e) { die(`${LOCAL_CONFIG} is not valid JSON: ${e.message}`) }
}

// Resolved on first use, not at load: `help` and `prompt` never read config, and a
// broken rig.local.json should fail inside a command with the file named, not on import.
let resolvedDataRoot
function dataRoot () {
  if (resolvedDataRoot === undefined) {
    const { dataRoot: dr } = readLocalConfig()
    resolvedDataRoot = dr ? path.resolve(RIG_ROOT, dr) : RIG_ROOT
  }
  return resolvedDataRoot
}
const repoConfigFile = () => path.join(dataRoot(), 'rig.json')
// Paths compared as git sees them: real (8.3 short names on Windows expanded, links
// followed) and case-folded, since git prints the long real path and NTFS ignores case.
const realDir = p => {
  try { return fs.realpathSync.native(p).toLowerCase() } catch { return path.resolve(p).toLowerCase() }
}
const sameDir = (a, b) => realDir(a) === realDir(b)
const insideDir = (child, parent) => {
  const c = realDir(child)
  const p = realDir(parent)
  return c === p || c.startsWith(p + path.sep)
}

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

const DEFAULT_CONFIG = {
  workRoot: defaultWorkRoot(),
  orgs: [],   // org-level; comes from rig.json in the data root
  tracker: {},
  identities: {},
  secrets: {},
}

function config () {
  const repo = exists(repoConfigFile()) ? readJson(repoConfigFile()) : {}
  const local = readLocalConfig()
  // Orgs are org-level and come from rig.json only; a stale copy in the local
  // file (written by older versions of init) must not shadow it.
  const localOrgsIgnored = 'orgs' in local
  delete local.orgs
  const cfg = Object.assign({}, DEFAULT_CONFIG, repo, local)
  cfg.mirrorRoot = cfg.mirrorRoot || path.join(cfg.workRoot, '.mirrors')
  // Policy lives in the data root so it travels to every machine; a machine that wants to
  // handle updates its own way overrides one key locally, rather than the whole object.
  cfg.freshness = Object.assign({}, DEFAULT_FRESHNESS, repo.freshness, local.freshness)
  cfg.localOrgsIgnored = localOrgsIgnored
  return cfg
}

const workDir = (cfg, id) => path.join(cfg.workRoot, id)
const recordDir = id => path.join(dataRoot(),'work', id)
const recordFile = id => path.join(recordDir(id), 'work.json')
const contextFile = id => path.join(recordDir(id), 'context.md')
const planFile = id => path.join(recordDir(id), 'rollout-testing-plan.md')
const mirrorPath = (cfg, org, repo) => path.join(cfg.mirrorRoot, org, `${repo}.git`)

// ----------------------------------------------------- version & freshness

const packageFile = path.join(RIG_ROOT, 'package.json')
const version = () => toolVersion(exists(packageFile) ? readJson(packageFile) : {})
// rig.json as it sits on disk. `config()` merges it with the machine's file; the record
// format is a property of the data root alone, so the gate reads it unmerged.
const repoConfigJson = () => (exists(repoConfigFile()) ? readJson(repoConfigFile()) : {})

// What the tool checkout is, as far as freshness goes; freshness.mjs decides what that
// means. `linked` is the copy running from a work's worktree — its git dir sits under the
// main checkout's, which is how git itself tells the two apart.
function toolState () {
  // Ambient work on behalf of a command that has already run: no environment problem found
  // here is this function's to report. `git` missing at all makes `git()` die, and doctor
  // must live long enough to say so itself.
  if (run('git', ['--version']).code !== 0) return { repo: false }
  const top = git(RIG_ROOT, 'rev-parse', '--show-toplevel')
  if (top.code !== 0) return { repo: false }
  // A rig checked out *inside* another repo would otherwise report that repo's distance.
  if (!sameDir(top.out, RIG_ROOT)) return { repo: true, nested: true }
  const gitDir = git(RIG_ROOT, 'rev-parse', '--absolute-git-dir').out
  const commonDir = path.resolve(RIG_ROOT, git(RIG_ROOT, 'rev-parse', '--git-common-dir').out)
  const branch = git(RIG_ROOT, 'symbolic-ref', '-q', '--short', 'HEAD')
  const originHead = git(RIG_ROOT, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD')
  const upstream = git(RIG_ROOT, 'rev-parse', '--abbrev-ref', '@{u}')
  return {
    repo: true,
    linked: !sameDir(gitDir, commonDir),
    branch: branch.code === 0 ? branch.out : null,
    defaultBranch: originHead.code === 0 ? originHead.out.replace(/^origin\//, '') : null,
    upstream: upstream.code === 0 ? upstream.out : null,
    head: git(RIG_ROOT, 'rev-parse', 'HEAD').out,
  }
}

// Disposable state, so it lives with the other disposable state rather than in the config
// file the user owns: rig must not rewrite rig.local.json on a schedule, and a half-written
// config is a worse failure than a missing cache.
const freshnessCacheFile = cfg => path.join(cfg.workRoot, '.rig', 'freshness.json')
const readFreshness = cfg => {
  try { return readJson(freshnessCacheFile(cfg)) } catch { return null }   // absent or half-written: measure again
}
// Written through a temp file and renamed: two commands can end at once, and a half-written
// cache reads as due, which would put the refresh back in a loop. A cache nobody asked for
// must not turn every command into a complaint on a machine whose work root is read-only, so
// a failed write is dropped and the next run measures again — and it never creates the work
// root, which is a thing `rig doctor` checks for and `rig init` makes.
const writeFreshness = (cfg, measured) => {
  if (!exists(cfg.workRoot)) return
  const file = freshnessCacheFile(cfg)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(measured, null, 2) + '\n')
    fs.renameSync(tmp, file)
  } catch {
    try { fs.rmSync(tmp, { force: true }) } catch { /* nothing left to try */ }
  }
}

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
function refreshFreshnessInBackground () {
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'freshness-refresh'],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref()
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
    const line = announces(command, { enabled: cfg.freshness.enabled, tty: process.stdout.isTTY })
      ? staleLine(cache, head.out)
      : null
    if (!due && !line) return
    if (skipReason(toolState())) return
    if (line) say(C.dim(`· ${line}`))
    if (due) refreshFreshnessInBackground()
  } catch { /* ambient: a command that has already finished must not fail because of this */ }
}

// Commands that write records. The distinction drives the write gate — an old rig must not
// write a record format it has never seen — and the sync below.
const MUTATING = new Set(['new', 'ticket', 'attach', 'detach', 'plan', 'save', 'close'])

// Before a mutating command reads anything. rig pushes the data root but never pulled it, so
// a second machine read stale records and wrote on top of them. Fast-forward only: a data
// root with commits of its own is left for `commitDataRoot`'s rebase at the end. Then the
// gate, which holds whether or not there is a remote to sync with.
function prepareDataRoot () {
  const root = dataRoot()
  if (exists(root) && !insideDir(root, RIG_ROOT)) {
    const before = checkoutState(root)
    if (before.repo === 'own' && before.branch && before.upstream) {
      const fetched = git(root, 'fetch', '-q')
      if (fetched.code !== 0) {
        say(C.dim(`· data root: could not fetch (${firstLine(fetched.err) || 'no detail from git'}) — working from what is here`))
      } else {
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
  const cfgJson = repoConfigJson()
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
  // Records written before the status gate existed carry no `status`; infer one from
  // what the record already shows rather than defaulting everything to "planning".
  w.repos = w.repos || []
  if (w.status === undefined) w.status = w.closedAt ? 'closed' : (w.repos.length ? 'in-progress' : 'planning')
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
// shape the catalogue uses (`talks_to:` / `setup:`). Not a general YAML parser.
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
---

<!-- DRAFT: unreviewed — drafted by \`rig attach\`. Correct this while the repo is
     loaded in your head; that is where the catalogue's value comes from. -->

TODO: what this repo actually is, its gotchas, and the expensive-to-rediscover facts.
`)
  return true
}

// ------------------------------------------------------------------ mirrors

function ensureMirror (cfg, org, repo) {
  const mp = mirrorPath(cfg, org, repo)
  if (!exists(mp)) {
    step(`mirroring ${org}/${repo} (first use)`)
    fs.mkdirSync(path.dirname(mp), { recursive: true })
    must('git', ['clone', '--bare', `https://github.com/${org}/${repo}.git`, mp])
    // A --bare clone has no fetch refspec; give it one so remote branches land
    // in refs/remotes/origin/* and never collide with our work branches.
    gitMust(mp, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
  }
  step(`fetching ${org}/${repo}`)
  const f = git(mp, 'fetch', '--prune', 'origin')
  if (f.code !== 0) warn(`fetch failed for ${org}/${repo}: ${f.err.split('\n')[0]}`)
  git(mp, 'remote', 'set-head', 'origin', '-a')
  return mp
}

function defaultBranch (mirror) {
  const r = git(mirror, 'symbolic-ref', 'refs/remotes/origin/HEAD')
  if (r.code === 0 && r.out) return r.out.replace('refs/remotes/origin/', '')
  for (const b of ['main', 'master', 'develop']) {
    if (git(mirror, 'rev-parse', '--verify', `refs/remotes/origin/${b}`).code === 0) return b
  }
  die(`cannot determine default branch for ${mirror}`)
}

const remoteHas = (mirror, branch) =>
  git(mirror, 'rev-parse', '--verify', `refs/remotes/origin/${branch}`).code === 0

// ------------------------------------------------------------------ helpers

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)

// Flags that never take a value, so `rig new --ticket my-id` keeps its positional.
const BOOL_FLAGS = new Set(['ticket', 'no-ticket', 'dry-run', 'designed', 'setup', 'force', 'quick', 'verbose', 'help'])

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
const STATUS_LABEL = { planning: 'Planning', 'in-progress': 'In progress', designed: 'Designed', closed: 'Closed' }
const statusLabel = status => STATUS_LABEL[status] || status

// The context doc header, rewritten from the record's tickets and status in one place.
function syncDocHeader (id, work) {
  const f = contextFile(id)
  if (!exists(f)) return
  writeText(f, readText(f).replace(/^Tickets: .*? · Status: .*$/m,
    `Tickets: ${ticketsLabel(work)} · Status: ${statusLabel(work.status)}`))
}

// The only status transition `attach` makes: planning -> in-progress, on the first repo.
// Already past planning (in-progress, designed, closed) is left alone.
const nextStatusAfterAttach = work =>
  (work.status === 'planning' && work.repos.length === 0) ? 'in-progress' : work.status

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
// customfield_* id for every name. Field and allowed-value ids are discovered through
// `field create-metadata`, never hardcoded — see docs/adr/0001-jira-via-twg.md for the
// KTLO ids that must never be pasted in here as a shortcut.
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

// `key`/`value` from `t.fields` (rig.json), translated to a customfield_* id and a
// Jira-ready value: `components` resolves each name to its allowed-value id via the
// project/type's field metadata (fetched once, on first need, and cached in `metadata`).
function resolveJiraField (jiraClient, t, metadata, key, value) {
  const name = NAMED_JIRA_FIELDS[key] || key
  metadata.current = metadata.current || jiraClient.fieldMetadata(t.project, t.type)
  const field = metadata.current.find(f => f.name.toLowerCase() === name.toLowerCase()) ||
    die(`no field named "${name}" for ${t.project}/${t.type} — check rig.json or the name in Jira`)
  if (key !== 'components') return { id: field.id, value }
  const names = Array.isArray(value) ? value : [value]
  // A name that matches nothing dies here — passing it through would let a typo or a
  // renamed/removed component reach `twg` unresolved (ADR-0001: fail loudly, don't guess).
  const ids = names.map(n => {
    const allowed = field.allowedValues.find(a => a.name.toLowerCase() === String(n).toLowerCase() || a.id === String(n))
    return allowed ? allowed.id :
      die(`"${n}" is not a value for "${field.name}" (${t.project}/${t.type}) — known: ${field.allowedValues.map(a => a.name).join(', ') || 'none'}`)
  })
  return { id: field.id, value: ids }
}

// Resolves an org's Jira create defaults (rig.json `tracker.<org>.fields`, `--field`
// overrides applied on top) to `{ assignee, fields }`: `fields` maps customfield_* ids
// to the values `twg jira workitem create --field` wants.
function resolveJiraFields (jiraClient, t, overrides) {
  const configured = mergeFieldOverrides(t.fields, overrides)
  configured.sprint = resolveActiveSprint(jiraClient, t, configured.sprint)

  let assignee
  const fields = {}
  const metadata = {}   // lazily fetched at most once, shared across every field lookup
  for (const [key, value] of Object.entries(configured)) {
    if (value === null || value === undefined) continue
    if (key === 'assignee') { assignee = value; continue }
    if (/^customfield_/.test(key)) { fields[key] = value; continue }
    const { id, value: resolved } = resolveJiraField(jiraClient, t, metadata, key, value)
    fields[id] = resolved
  }
  return { assignee, fields }
}

// Creates a ticket in the org's tracker, or previews it: `dryRun` prints what would be
// created and returns null without calling out. GitHub: the issue is the ticket, the
// context doc is the design (DESIGN.md §7.1) — a thin body with a link back to it.
// Jira: `docs/adr/0001-jira-via-twg.md` (supersedes DESIGN.md decisions 29, 33).
function createTicket (cfg, work, brief, orgFlag, { dryRun = false, fields: fieldOverrides = [] } = {}) {
  const t = trackerFor(cfg, orgFlag)
  const summary = work.title || work.id
  const description = brief.split(/\n\s*\n/)[0] || summary

  if (t.kind === 'github') {
    if (!t.repo) die(`tracker for ${t.org} is GitHub but has no "repo" (owner/name) in rig.json`)
    if (fieldOverrides.length) warn('--field is ignored for a GitHub tracker (no per-field create options)')
    const body = [description, '', `The design lives in the work record: ${contextDocRef(work.id)}`,
      '', `Opened by \`rig new ${work.id} --ticket\`.`].join('\n')
    if (dryRun) { say(`would create a GitHub issue in ${t.repo}:`); say(`  title  ${summary}`); say(`  body   ${description}`); return null }
    step(`creating GitHub issue in ${t.repo}`)
    const n = github().createIssue(t.repo, summary, body)
    ok(`ticket ${t.repo}#${n}`)
    return `${t.repo}#${n}`
  }

  if (t.kind === 'jira') {
    if (!t.project || !t.type) die(`tracker for ${t.org} is Jira but is missing "project" or "type" in rig.json`)
    const { assignee, fields } = resolveJiraFields(jira(), t, fieldOverrides)
    if (dryRun) {
      say(`would create a ${t.type} in ${t.project}:`)
      say(`  summary      ${summary}`)
      say(`  description  ${description}`)
      say(`  assignee     ${assignee || '_none_'}`)
      for (const [id, value] of Object.entries(fields)) say(`  ${id.padEnd(12)} ${JSON.stringify(value)}`)
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
// not rig's). `states` covers every attached repo, missing worktrees included.
function ticketWriteBack (work, states) {
  const keys = work.tickets || []
  for (const k of keys) {
    if (!isJiraKey(k) && !isGithubKey(k)) warn(`ticket "${k}" is neither PROJ-123 nor owner/repo#n — skipped`)
  }
  const githubKeys = keys.filter(isGithubKey)
  const jiraKeys = keys.filter(isJiraKey)
  if (!githubKeys.length && !jiraKeys.length) return

  let reason = ''
  if (!work.repos.length) reason = 'No repos were attached, so there are no PRs to check.'
  else {
    const unmerged = states.filter(s => !s.pr || s.pr.state !== 'MERGED').map(s =>
      `${s.repo} (${s.missing ? 'worktree missing' : s.prError ? 'PR state unknown' : s.pr ? `PR #${s.pr.number} ${s.pr.state.toLowerCase()}` : 'no PR'})`)
    if (unmerged.length) reason = `Not every PR is merged — ${unmerged.join(', ')}.`
  }
  const merged = reason === ''
  const prs = states.filter(s => s.pr).map(s => `- ${s.repo}: ${s.pr.url}`)

  const githubBody = [
    `Closed by \`rig close\`.${merged ? '' : ` ${reason} The issue stays open.`}`,
    ...(prs.length ? ['', ...prs] : []),
    '', `Context doc: ${contextDocRef(work.id)}`,
  ].join('\n')
  for (const key of githubKeys) {
    const [repo, n] = key.split('#')
    const notCommented = trackerFailure(() => github().commentIssue(repo, n, githubBody))
    if (notCommented) { warn(`${key}: could not comment (${notCommented})`); continue }
    if (!merged) { step(`commented on ${key} (left open: ${reason})`); continue }
    const notClosed = trackerFailure(() => github().closeIssue(repo, n))
    if (notClosed) warn(`${key}: commented, but could not close (${notClosed})`)
    else step(`closed ${key}`)
  }

  const jiraBody = [
    `\`rig close\` ran.${merged ? ' Every attached PR is merged.' : ` ${reason}`}`,
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
  lines.push(`Tickets: ${ticketsLabel(work)} · Status: ${statusLabel(work.status)}`)
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
    lines.push(`- Base: \`${r.base}\`${c?.stack ? ` · Stack: ${c.stack}` : ''}`)
    if (c?.setup?.length) lines.push(`- Setup: ${c.setup.map(s => `\`${s}\``).join(' · ')}`)
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
  if (insideDir(root, RIG_ROOT)) { warn(`data root ${root} is inside the tool checkout — not committing knowledge into it`); return }
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

  const fetch = git(root, 'fetch', '-q')
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
  // must not greet its owner with a pending migration.
  if (!exists(path.join(target, 'rig.json'))) writeJson(path.join(target, 'rig.json'), { orgs: [], tracker: {}, writtenBy: version() })
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

  const { dataRoot: current } = readLocalConfig()
  const currentRoot = current ? path.resolve(RIG_ROOT, current) : RIG_ROOT
  if (!sameDir(currentRoot, RIG_ROOT) && !sameDir(currentRoot, target)) {
    die(`dataRoot is already ${currentRoot}. Switching data roots is deliberate: use --data-root.`)
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
  // The data root may be changing in this very command, so resolve from the flag
  // rather than the cached value.
  const targetDataRoot = flags['data-root'] ? path.resolve(RIG_ROOT, flags['data-root']) : dataRoot()
  const isSplit = !sameDir(targetDataRoot, RIG_ROOT)
  // A separate data root is always a git checkout with a first commit (local or not).
  if (isSplit) ensureDataRootCheckout(targetDataRoot)

  // rig.json is org-level and lives in the data root; --orgs adds, --tracker merges.
  const repoCfg = path.join(targetDataRoot, 'rig.json')
  let repoJson = exists(repoCfg) ? readJson(repoCfg) : null
  if (typeof flags.orgs === 'string' || typeof flags.tracker === 'string') {
    const next = repoJson || { orgs: [], tracker: {}, writtenBy: version() }
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
    writeJson(repoCfg, next)
    repoJson = next
    ok(`wrote ${repoCfg}`)
    commitAs('', 'rig.json')
  }
  const orgs = repoJson?.orgs || []
  const email = typeof flags.email === 'string' ? flags.email : ''

  if (!exists(LOCAL_CONFIG)) {
    const workRoot = flags['work-root'] ? path.resolve(flags['work-root']) : defaultWorkRoot()
    // Only the machine-level half goes here: roots, and an identity per org.
    writeJson(LOCAL_CONFIG, {
      workRoot,
      ...(isSplit ? { dataRoot: targetDataRoot } : {}),
      identities: Object.fromEntries(orgs.map(o => [o, email])),
      secrets: {},
    })
    ok(`wrote ${LOCAL_CONFIG}`)
  } else {
    // Merge into the existing file: a new data root, and identities for orgs
    // that have none yet. Nothing already set is touched.
    const local = readLocalConfig()
    const changes = []
    const currentRoot = local.dataRoot ? path.resolve(RIG_ROOT, local.dataRoot) : RIG_ROOT
    if (flags['data-root'] && !sameDir(currentRoot, targetDataRoot)) { local.dataRoot = targetDataRoot; changes.push('dataRoot') }
    if (email) {
      local.identities = local.identities || {}
      for (const o of orgs) if (!local.identities[o]) { local.identities[o] = email; changes.push(`identity for ${o}`) }
    }
    if (changes.length) { writeJson(LOCAL_CONFIG, local); ok(`updated ${LOCAL_CONFIG}: ${changes.join(', ')}`) }
    else say(`${LOCAL_CONFIG} already exists — nothing to change`)
  }
  resolvedDataRoot = targetDataRoot   // the rest of this command sees the new root

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
  const missing = orgs.filter(o => !identityFor(cfg, o))
  if (missing.length) {
    say(`Still to do in ${LOCAL_CONFIG}:`)
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
    status: 'planning',
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
  const mirror = ensureMirror(cfg, org, repo)
  const base = defaultBranch(mirror)
  const dest = path.join(workDir(cfg, work.id), repo)
  if (exists(dest)) die(`${dest} already exists`)

  if (remoteHas(mirror, work.branch)) {
    warn(`branch ${work.branch} already exists on ${org}/${repo} — checking it out (not creating)`)
    must('git', ['-C', mirror, 'worktree', 'add', '--track', '-b', work.branch, dest,
      `refs/remotes/origin/${work.branch}`])
  } else {
    step(`worktree ${repo} → ${work.branch} (base ${base})`)
    must('git', ['-C', mirror, 'worktree', 'add', '-b', work.branch, dest,
      `refs/remotes/origin/${base}`])
  }

  const email = identityFor(cfg, org)
  if (email) {
    gitMust(dest, 'config', 'user.email', email)
    step(`identity ${email}`)
  } else {
    warn(`no identity configured for org "${org}" — commits will use your global user.email`)
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
  work.status = nextStatusAfterAttach(work)
  work.repos.push({ repo, org, path: dest, base, role: cat?.role || '', attachedAt: new Date().toISOString() })
  saveWork(cfg, work)
  ok(`attached ${C.bold(repo)} at ${dest}`)

  if (cat?.setup?.length) {
    if (setup) runSetup(dest, cat.setup)
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
// is the "design agreed" gate: the one status change no other command makes.
cmds.save = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  if (flags.message === true) die('-m needs a message')
  commitAs(id, flags.message)
  if (flags.designed) {
    if (work.closedAt) die(`${id} is closed — its design gate is behind it`)
    work.status = 'designed'
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

  const dirty = git(entry.path, 'status', '--porcelain').out
  if (dirty && !flags.force) die(`${entry.repo} has uncommitted changes — commit, or pass --force`)

  const mirror = mirrorPath(cfg, entry.org, entry.repo)
  const args = ['-C', mirror, 'worktree', 'remove', entry.path]
  if (flags.force) args.push('--force')
  const r = run('git', args)
  if (r.code !== 0) die(r.err || r.out)
  git(mirror, 'worktree', 'prune')

  work.repos = work.repos.filter(r => r !== entry)
  commitAs(id, entry.repo)
  saveWork(cfg, work)
  ok(`detached ${entry.repo}`)
}

function repoState (cfg, entry, branch) {
  const s = { repo: entry.repo, missing: !exists(entry.path), dirty: 0, ahead: 0, behind: 0, pr: null }
  if (s.missing) return s
  s.dirty = git(entry.path, 'status', '--porcelain').out.split('\n').filter(Boolean).length
  const up = git(entry.path, 'rev-parse', '--abbrev-ref', '@{u}')
  const ref = up.code === 0 ? '@{u}' : `refs/remotes/origin/${entry.base}`
  const counts = git(entry.path, 'rev-list', '--left-right', '--count', `${ref}...HEAD`)
  if (counts.code === 0) {
    const [behind, ahead] = counts.out.split(/\s+/).map(Number)
    s.behind = behind || 0
    s.ahead = ahead || 0
  }
  // One repo GitHub cannot answer for must not take the whole listing down; the caller
  // shows the state as unknown, and `close` treats unknown as a blocker.
  s.prError = trackerFailure(() => { s.pr = github().prForBranch(entry.org, entry.repo, branch) })
  return s
}

cmds.list = ({ flags }) => {
  const cfg = config()
  const ids = listWorkIds()
  if (!ids.length) return say('no works yet — `rig new <id> --title "..."`')
  const live = flags.prs !== false && !flags.quick
  for (const id of ids) {
    const work = loadWork(cfg, id)
    const wd = workDir(cfg, id)
    const open = exists(wd)
    const head = `${C.bold(id)} ${C.dim(work.branch)}${work.closedAt ? C.dim(' [closed]') : ''}`
    say(head)
    if (work.title) say(`  ${work.title}`)
    if (work.tickets?.length) say(`  ${C.dim(work.tickets.join(', '))}`)
    if (work.closedAt) {
      say(`  ${C.dim(`${work.repos.length} repo(s) · context kept at ${contextFile(id)}`)}`)
      say('')
      continue
    }
    if (!open) warn('  work folder is missing but the work is not closed')
    let allMerged = work.repos.length > 0
    let anyDirty = false
    for (const r of work.repos) {
      const s = live ? repoState(cfg, r, work.branch) : { repo: r.repo, dirty: 0, ahead: 0, behind: 0, pr: null, missing: !exists(r.path) }
      const bits = []
      if (s.missing) bits.push(C.red('missing'))
      if (s.dirty) { bits.push(C.yellow(`${s.dirty} dirty`)); anyDirty = true }
      if (s.ahead) bits.push(`${s.ahead} ahead`)
      if (s.behind) bits.push(C.dim(`${s.behind} behind`))
      if (s.prError) bits.push(C.yellow('PR state unknown'))
      else if (s.pr) bits.push(s.pr.state === 'MERGED' ? C.green(`PR #${s.pr.number} merged`) : `PR #${s.pr.number} ${s.pr.state.toLowerCase()}`)
      if (!s.pr || s.pr.state !== 'MERGED') allMerged = false
      say(`  ${r.repo.padEnd(34)} ${bits.join(' · ') || C.dim('clean')}`)
    }
    if (live && allMerged && !anyDirty && !work.closedAt) {
      say(`  ${C.green('→ all PRs merged, nothing uncommitted — safe to `rig close`')}`)
    }
    say('')
  }
}

cmds.status = ({ flags }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  say(`${C.bold(work.id)} — ${work.title || ''}`)
  say(`branch ${work.branch}`)
  say(`status ${statusLabel(work.status)}`)
  say(`tickets ${ticketsLabel(work)}`)
  say(`context ${contextFile(id)}`)
  say('')
  for (const r of work.repos) {
    const s = repoState(cfg, r, work.branch)
    say(`${C.bold(r.repo)} ${C.dim(`(${r.org}, base ${r.base})`)}`)
    say(`  path    ${r.path}${s.missing ? C.red('  MISSING') : ''}`)
    if (!s.missing) {
      say(`  changes ${s.dirty || 'none'}`)
      say(`  commits ${s.ahead} ahead · ${s.behind} behind`)
    }
    say(`  pr      ${s.pr ? `#${s.pr.number} ${s.pr.state} ${s.pr.url}` : s.prError ? `unknown — ${s.prError}` : 'none'}`)
    say('')
  }
}

function runSetup (dir, commands) {
  for (const c of commands) {
    step(`${c}  ${C.dim(`(in ${path.basename(dir)})`)}`)
    const r = spawnSync(c, { cwd: dir, shell: true, stdio: 'inherit' })
    if (r.status !== 0) { warn(`setup command failed: ${c}`); return false }
  }
  return true
}

cmds.setup = ({ flags, positional }) => {
  const cfg = config()
  const work = openWork(cfg, flags)
  const id = work.id
  const targets = positional.length
    ? work.repos.filter(r => positional.some(p => p.toLowerCase() === r.repo.toLowerCase()))
    : work.repos
  if (!targets.length) die('no matching attached repos')
  for (const r of targets) {
    const cat = findCatalog(r.repo)
    if (!cat?.setup?.length) { warn(`${r.repo}: no setup commands in the catalogue`); continue }
    runSetup(r.path, cat.setup)
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
  const blockers = []
  const states = []
  for (const r of work.repos) {
    const s = repoState(cfg, r, work.branch)   // handles a missing worktree itself
    states.push(s)
    if (s.missing) continue
    if (s.dirty) blockers.push(`${r.repo}: ${s.dirty} uncommitted change(s)`)
    if (s.ahead) blockers.push(`${r.repo}: ${s.ahead} unpushed commit(s)`)
    if (s.pr && s.pr.state === 'OPEN') blockers.push(`${r.repo}: PR #${s.pr.number} still open`)
    if (s.prError) blockers.push(`${r.repo}: PR state unknown (${s.prError})`)
  }
  if (blockers.length && !flags.force) {
    warn('not closing — unfinished business:')
    for (const b of blockers) say(`    ${C.red('•')} ${b}`)
    say('')
    say(C.dim('Resolve these, or pass --force if you genuinely want to discard them.'))
    process.exitCode = 1
    return
  }
  for (const r of work.repos) {
    if (!exists(r.path)) continue
    const mirror = mirrorPath(cfg, r.org, r.repo)
    const args = ['-C', mirror, 'worktree', 'remove', r.path]
    if (flags.force) args.push('--force')
    const res = run('git', args)
    if (res.code !== 0) warn(`${r.repo}: ${res.err || res.out}`)
    else step(`removed worktree ${r.repo}`)
    git(mirror, 'worktree', 'prune')
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
  work.closedAt = new Date().toISOString()
  work.status = 'closed'
  saveWork(cfg, work)   // regenerates only if the folder outlived the delete, so it reads as closed
  ticketWriteBack(work, states)
  ok(`closed ${id} — context doc kept at ${contextFile(id)}`)
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
function updateCheckout (label, root) {
  const state = checkoutState(root)
  if (state.repo !== 'own') { say(`${C.dim('·')} ${C.dim(`${label}: ${root} is not a checkout of its own — nothing to update`)}`); return false }
  if (!state.branch) { warn(`${label}: detached HEAD — not updated`); return false }
  if (!state.upstream) { say(`${C.dim('·')} ${C.dim(`${label}: no upstream — nothing to update from`)}`); return false }
  if (state.dirty) { warn(`${label}: ${state.dirty} uncommitted change(s) — not updated${label === 'data root' ? ', run `rig save`' : ''}`); return false }
  const fetched = git(root, 'fetch', '-q')
  if (fetched.code !== 0) { warn(`${label}: could not fetch (${firstLine(fetched.err) || 'no detail from git'}) — not updated`); return false }
  const from = git(root, 'rev-parse', 'HEAD').out
  const fetchedState = checkoutState(root)
  if (fetchedState.behind === null) { warn(`${label}: could not measure the distance from its upstream — not updated`); return false }
  if (fetchedState.behind === 0) { ok(`${label}: already up to date`); return false }
  const ff = git(root, 'merge', '--ff-only', '@{u}')
  if (ff.code !== 0) {
    warn(`${label}: ${fetchedState.behind} commit(s) behind but the branch has diverged — not updated; merge or rebase it by hand in ${root}`)
    return false
  }
  ok(`${label}: fast-forwarded ${fetchedState.behind} commit(s)`)
  for (const line of git(root, 'log', '--oneline', '--no-decorate', `${from}..HEAD`).out.split('\n').filter(Boolean)) {
    say(`  ${C.dim(line)}`)
  }
  return true
}

cmds.update = () => {
  const cfg = config()
  const tool = toolState()
  if (tool.linked) {
    warn(`this is the copy in a worktree (${RIG_ROOT}) — updating it would move your work's branch, not the installation. Run \`rig update\` from the installed checkout.`)
  } else if (updateCheckout('tool', RIG_ROOT) && !process.env.RIG_UPDATE_RESTARTED) {
    // This process is running the code that was here a moment ago: its migration list, its
    // doctor checks and its version are all the old ones. Hand the rest of the update to what
    // just arrived. RIG_UPDATE_RESTARTED makes that exactly one hop.
    say(`${C.dim('·')} ${C.dim('the tool moved — continuing with the code that just arrived')}`)
    const again = spawnSync(process.execPath, [path.join(RIG_ROOT, 'bin', 'rig.mjs'), 'update'],
      { stdio: 'inherit', env: { ...process.env, RIG_UPDATE_RESTARTED: '1' } })
    process.exitCode = again.status ?? 1
    return
  }

  const root = dataRoot()
  if (insideDir(root, RIG_ROOT)) warn('data root is inside the tool checkout — not set up; run `rig prompt setup`')
  else if (!exists(root)) warn(`data root ${root} is missing — check dataRoot in rig.local.json`)
  else updateCheckout('data root', root)

  if (exists(repoConfigFile())) {
    const { config: migrated, ran } = applyMigrations(repoConfigJson(), version())
    if (ran.length) {
      writeJson(repoConfigFile(), migrated)
      for (const name of ran) ok(`migrated: ${name}`)
      // Committed here rather than through `main`, because the doctor checks run below and a
      // health verdict must not report the data root dirty with the change just made.
      commitDataRoot(`rig update: record format ${MAJOR}`)
    }
  }

  // The cache describes a checkout that may have just moved.
  const moved = toolState()
  if (!skipReason(moved)) writeFreshness(cfg, measureFreshness(moved))

  say('')
  cmds.doctor({ flags: {}, positional: [] })
}

// Hidden: the detached child spawned at the end of a command. Fetches, measures, writes the
// cache, says nothing to anyone — the next command is what speaks.
cmds['freshness-refresh'] = () => {
  const cfg = config()
  const state = toolState()
  if (skipReason(state)) return
  // No terminal to prompt on: a fetch that stopped for credentials would leave one stuck
  // process behind per command.
  const fetched = run('git', ['-C', RIG_ROOT, 'fetch', '-q'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  // A failed check is still a check: stamping it means an unreachable remote is retried once
  // per interval rather than at the end of every command.
  if (fetched.code !== 0) {
    writeFreshness(cfg, { sha: state.head, remote: state.upstream, behind: null, checkedAt: new Date().toISOString() })
    return
  }
  writeFreshness(cfg, measureFreshness(state))
}

cmds.doctor = () => {
  if (!exists(LOCAL_CONFIG)) {
    warn(`not set up — no ${LOCAL_CONFIG}. Run \`rig prompt setup\` and follow it; it ends in one \`rig init\`.`)
    process.exitCode = 1
    return
  }
  const cfg = config()
  let problems = 0
  if (cfg.localOrgsIgnored) {
    warn(`${LOCAL_CONFIG} has an "orgs" key — ignored; orgs live in rig.json. Remove it.`); problems++
  }
  // detail.ok shows when the check passes, detail.bad when it fails.
  const check = (label, good, detail = {}) => {
    if (good) ok(`${label}${detail.ok ? ` ${C.dim(detail.ok)}` : ''}`)
    else { warn(`${label}${detail.bad ? ` — ${detail.bad}` : ''}`); problems++ }
  }

  const tool = toolState()
  say(`${C.dim('·')} ${C.dim(`rig ${version()} at ${RIG_ROOT}${tool.head ? ` (${tool.head.slice(0, 7)})` : ''}`)}`)
  // The one command that fetches before answering: a health check you asked for should
  // report now, not what the cache last saw.
  const skipped = skipReason(tool)
  if (skipped) say(`${C.dim('·')} ${C.dim(`freshness not checked — ${skipped}`)}`)
  else {
    const fetched = git(RIG_ROOT, 'fetch', '-q')
    if (fetched.code !== 0) {
      say(`${C.dim('·')} ${C.dim(`freshness not checked — could not fetch (${firstLine(fetched.err) || 'no detail from git'})`)}`)
    } else {
      const measured = measureFreshness(tool)
      writeFreshness(cfg, measured)
      if (measured.behind === null) {
        say(`${C.dim('·')} ${C.dim(`freshness not checked — git could not measure the distance from ${tool.upstream}`)}`)
      } else {
        check('installed rig', measured.behind === 0, {
          ok: `up to date with ${tool.upstream}`,
          bad: `${measured.behind} commit(s) behind ${tool.upstream} — run \`rig update\``,
        })
      }
    }
  }

  check('node', true, { ok: process.version })
  const gv = run('git', ['--version'])
  check('git', gv.code === 0, { ok: gv.out })
  const auth = github().auth()
  check('gh authenticated', auth === 'ok',
    { bad: auth === 'missing' ? 'gh not on PATH' : 'PR state and org resolution will not work' })
  if (Object.values(cfg.tracker || {}).some(t => t.kind === 'jira')) {
    check('twg present', jira().present(), { bad: 'Jira ticket creation, fetch and write-back will not work' })
  }

  const lp = run('git', ['config', '--global', 'core.longpaths'])
  check('core.longpaths', lp.out === 'true',
    { bad: 'run `rig init`; deep node_modules paths will break without it' })

  const sym = run('git', ['config', '--get', 'core.symlinks'])
  if (sym.out === 'false') say(`${C.dim('·')} ${C.dim('core.symlinks=false — by design, rig never symlinks')}`)

  check('config file', exists(LOCAL_CONFIG), { bad: `${LOCAL_CONFIG} missing — run \`rig init\`` })
  check('work root', exists(cfg.workRoot), { ok: cfg.workRoot, bad: `${cfg.workRoot} missing` })
  check('mirror root', exists(cfg.mirrorRoot), { ok: cfg.mirrorRoot, bad: `${cfg.mirrorRoot} missing` })
  const split = !insideDir(dataRoot(), RIG_ROOT)
  check('data root', split && exists(dataRoot()), {
    ok: dataRoot(),
    bad: split
      ? `${dataRoot()} missing — check dataRoot in rig.local.json`
      : 'is inside the tool checkout — not set up; knowledge must not live inside a public tool\'s tree. Run `rig prompt setup`',
  })
  if (split && exists(dataRoot())) {
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
      if (state.behind) warn(`data root is ${state.behind} commit(s) behind origin — \`rig update\` fast-forwards it`)
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
    if (writesBlocked(written)) {
      warn(`data root is at record format ${dataMajor(written)}, this rig writes ${MAJOR} — mutating commands refuse until this rig is updated`); problems++
    } else {
      const pending = pendingMigrations(written)
      if (pending.length) {
        warn(`${pending.length} pending migration(s) — run \`rig update\`: ${pending.map(m => m.name).join('; ')}`); problems++
      } else {
        say(`${C.dim('·')} ${C.dim(`record format ${MAJOR}, last written by rig ${written.writtenBy}`)}`)
      }
    }
  }

  for (const org of cfg.orgs) {
    check(`identity for ${org}`, !!identityFor(cfg, org),
      { ok: identityFor(cfg, org), bad: 'commits will use your global user.email' })
    const t = cfg.tracker?.[org]
    const desc = t?.kind ? `${t.kind}${t.repo ? ' ' + t.repo : ''}${t.project ? ' ' + t.project : ''}` : 'none — `rig new --ticket` unavailable (rig.json)'
    say(`${C.dim('·')} ${C.dim(`tracker for ${org}: ${desc}`)}`)
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

  const drive = cfg.workRoot.slice(0, 2)
  const df = run('powershell', ['-NoProfile', '-Command',
    `(Get-PSDrive ${drive[0]}).Free`])
  if (df.code === 0 && df.out) {
    const freeGb = Math.round(Number(df.out) / 1e9)
    check(`disk on ${drive}`, freeGb > 20,
      { ok: `${freeGb} GB free`, bad: `only ${freeGb} GB free` })
  }

  say('')
  say(problems ? C.yellow(`${problems} thing(s) to look at`) : C.green('all clear'))
  process.exitCode = problems ? 1 : 0
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
  rig list [--quick]              every work, with staleness signals
  rig status                      live detail for the current work
  rig setup [repo...]             run the catalogue's setup commands
  rig catalog [repo] [--verbose]  the repo catalogue: index, or one entry
  rig plan                        scaffold the rollout & testing plan
  rig save [-m text] [--designed] commit edits made outside rig (the context doc);
                                  --designed records the "design agreed" gate
  rig close [--force]             safety-checked teardown
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
  anyTrackerConfigured, orgForJiraKey, ticketsLabel, statusLabel, nextStatusAfterAttach, checkoutState,
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
