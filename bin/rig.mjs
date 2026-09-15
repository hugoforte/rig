#!/usr/bin/env node
// rig — cross-repo work harness. Zero dependencies by design; see DESIGN.md §2.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

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

class RigError extends Error {}
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
// Is a command on PATH at all? `run` dies when it is not; setup checks want to warn.
const has = cmd => !spawnSync(cmd, ['--version'], { encoding: 'utf8' }).error

function readStdin () {
  if (process.stdin.isTTY) return ''
  try { return fs.readFileSync(0, 'utf8').trim() } catch { return '' }
}

const exists = p => fs.existsSync(p)
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n')
}
const readText = p => fs.readFileSync(p, 'utf8')
const writeText = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, v)
}

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
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

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
  cfg.localOrgsIgnored = localOrgsIgnored
  return cfg
}

const workDir = (cfg, id) => path.join(cfg.workRoot, id)
const recordDir = id => path.join(dataRoot(),'work', id)
const recordFile = id => path.join(recordDir(id), 'work.json')
const contextFile = id => path.join(recordDir(id), 'context.md')
const planFile = id => path.join(recordDir(id), 'rollout-testing-plan.md')
const mirrorPath = (cfg, org, repo) => path.join(cfg.mirrorRoot, org, `${repo}.git`)

// --------------------------------------------------------------- work lookup

// The work id is anchored by D:\w\<id>\.rig\id — a marker, not a duplicated fact.
// The authoritative record lives in the rig repo (DESIGN.md §7.1).
function findWorkId (cfg, explicit) {
  if (explicit) return explicit
  let dir = process.cwd()
  for (;;) {
    const marker = path.join(dir, '.rig', 'id')
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
  // A worktree's path is derived from this machine's work root, never stored:
  // the same record must work on every machine that shares the data root.
  for (const r of w.repos || []) r.path = path.join(workDir(cfg, id), r.repo)
  return w
}

const saveWork = w => writeJson(recordFile(w.id),
  { ...w, repos: (w.repos || []).map(({ path: _derived, ...r }) => r) })

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

function resolveOrg (cfg, repo) {
  const cat = findCatalog(repo)
  if (cat) return { org: cat.org, repo: cat.repo }
  for (const org of cfg.orgs) {
    const r = run('gh', ['api', `repos/${org}/${repo}`, '--jq', '.name'])
    if (r.code === 0 && r.out) return { org, repo: r.out }
  }
  die(`cannot resolve "${repo}" in any of: ${cfg.orgs.join(', ')} (is gh authenticated?)`)
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
const BOOL_FLAGS = new Set(['ticket', 'setup', 'force', 'quick', 'verbose', 'help'])

function parseArgs (argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=')
      if (v !== undefined) flags[k] = v
      else if (!BOOL_FLAGS.has(k) && argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]
      else flags[k] = true
    } else positional.push(a)
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

// GitHub: rig creates the issue itself via gh, which it already shells out to.
// Jira: the agent creates it; rig authenticates to nothing but git (DESIGN.md §2).
function createTicket (cfg, work, brief, orgFlag) {
  const t = trackerFor(cfg, orgFlag)
  if (t.kind === 'jira') {
    warn(`tracker for ${t.org} is Jira${t.project ? ` (${t.project})` : ''} — rig does not talk to Jira`)
    say(C.dim('  create the ticket with your Jira tooling, then `rig new … --key <KEY>`; see `rig prompt new-work`'))
    return null
  }
  if (t.kind !== 'github') die(`unknown tracker kind "${t.kind}" for ${t.org}`)
  if (!t.repo) die(`tracker for ${t.org} is GitHub but has no "repo" (owner/name) in rig.json`)
  // Thin body: the issue is the ticket, the context doc is the design (DESIGN.md §7.1).
  const body = [
    brief.split(/\n\s*\n/)[0] || work.title || work.id,
    '',
    `The design lives in the work record: ${contextDocRef(work.id)}`,
    '',
    `Opened by \`rig new ${work.id} --ticket\`.`,
  ].join('\n')
  step(`creating GitHub issue in ${t.repo}`)
  const out = must('gh', ['issue', 'create', '--repo', t.repo, '--title', work.title || work.id, '--body', body])
  const n = /\/issues\/(\d+)\s*$/.exec(out)?.[1]
  if (!n) die(`could not read the issue number from gh output:\n${out}`)
  ok(`ticket ${t.repo}#${n}`)
  return `${t.repo}#${n}`
}

// Ticket keys: Jira `PROJ-42`, or GitHub `owner/repo#n`. Only the Jira shape is
// safe in a branch name.
const isJiraKey = k => /^[A-Z][A-Z0-9]+-\d+$/.test(k)
const isGithubKey = k => /^[\w.-]+\/[\w.-]+#\d+$/.test(k)

// The context doc header is the one place a key appears in prose.
function setTicketsInDoc (id, tickets) {
  const f = contextFile(id)
  if (!exists(f)) return
  const shown = tickets.join(', ') || '_none_'
  writeText(f, readText(f).replace(/^Tickets: .*?( · Status:.*)$/m, `Tickets: ${shown}$1`))
}

// On close, GitHub tickets get a comment, and are closed when every PR is merged.
// `states` covers every attached repo, missing worktrees included.
function ticketWriteBack (work, states) {
  const keys = work.tickets || []
  for (const k of keys) {
    if (!isJiraKey(k) && !isGithubKey(k)) warn(`ticket "${k}" is neither PROJ-123 nor owner/repo#n — skipped`)
  }
  const github = keys.filter(isGithubKey)
  if (!github.length) return

  let reason = ''
  if (!work.repos.length) reason = 'No repos were attached, so there are no PRs to check; the issue stays open.'
  else {
    const unmerged = states.filter(s => !s.pr || s.pr.state !== 'MERGED').map(s =>
      `${s.repo} (${s.missing ? 'worktree missing' : s.pr ? `PR #${s.pr.number} ${s.pr.state.toLowerCase()}` : 'no PR'})`)
    if (unmerged.length) reason = `Not every PR is merged — ${unmerged.join(', ')} — so the issue stays open.`
  }
  const merged = reason === ''
  const prs = states.filter(s => s.pr).map(s => `- ${s.repo}: ${s.pr.url}`)
  const body = [
    `Closed by \`rig close\`.${merged ? '' : ' ' + reason}`,
    ...(prs.length ? ['', ...prs] : []),
    '',
    `Context doc: ${contextDocRef(work.id)}`,
  ].join('\n')
  for (const key of github) {
    const [repo, n] = key.split('#')
    const c = run('gh', ['issue', 'comment', n, '--repo', repo, '--body', body])
    if (c.code !== 0) { warn(`${key}: could not comment (${c.err.split('\n')[0]})`); continue }
    if (!merged) { step(`commented on ${key} (left open: ${reason.replace(/; the issue stays open\.$| — so the issue stays open\.$/, '')})`); continue }
    const cl = run('gh', ['issue', 'close', n, '--repo', repo])
    if (cl.code === 0) step(`closed ${key}`)
    else warn(`${key}: commented, but could not close (${cl.err.split('\n')[0]})`)
  }
}

// ------------------------------------------------- generated work AGENTS.md

function regenerate (cfg, work) {
  const wd = workDir(cfg, work.id)
  if (!exists(wd)) return
  const cat = loadCatalog()
  const lines = []
  lines.push('<!-- GENERATED by rig — do not edit. Source of truth: the context doc below. -->')
  lines.push('')
  lines.push(`# ${work.id}${work.title ? ` — ${work.title}` : ''}`)
  lines.push('')
  if (work.title) lines.push(work.title)
  if (work.tickets?.length) lines.push(`Tickets: ${work.tickets.join(', ')}`)
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
  writeText(path.join(wd, 'AGENTS.md'), lines.join('\n'))
  writeText(path.join(wd, 'CLAUDE.md'), `See [AGENTS.md](./AGENTS.md).\n`)
  writeText(path.join(wd, '.rig', 'id'), work.id + '\n')
}

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
  if (!exists(path.join(target, 'rig.json'))) writeJson(path.join(target, 'rig.json'), { orgs: [], tracker: {} })
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

  if (run('gh', ['repo', 'view', spec, '--json', 'name']).code === 0) {
    step(`joining ${spec}: cloning to ${target}`)
    must('gh', ['repo', 'clone', spec, target])
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
  const cr = run('gh', ['repo', 'create', spec, '--private', '--source', target, '--push',
    '--description', 'rig data root: repo catalogue and work records'])
  if (cr.code !== 0) {
    fs.rmSync(target, { recursive: true, force: true })
    die(`could not create ${spec}: ${cr.err.split('\n')[0]}\n` +
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
    const next = repoJson || { orgs: [], tracker: {} }
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
  if (!has('gh')) warn('gh not found on PATH — org resolution, PR state and --ticket need it')
  else if (run('gh', ['auth', 'status']).code !== 0) {
    warn('gh is not authenticated — org resolution and PR state need it (gh auth login)')
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
  const id = positional[0] || die('usage: rig new <work-id> --title "..." [--key K | --ticket [--org o]] [--repos a,b]')
  if (exists(recordFile(id))) die(`work "${id}" already exists (${recordFile(id)})`)

  const title = flags.title || ''
  const keys = (flags.key || flags.keys || '').toString().split(',').map(s => s.trim()).filter(Boolean)
  for (const k of keys) {
    if (!isJiraKey(k) && !isGithubKey(k)) die(`--key "${k}" is neither PROJ-123 nor owner/repo#n`)
  }
  const idKey = /^([A-Z][A-Z0-9]+-\d+)/.exec(id)?.[1] ?? ''
  // Only a Jira-shaped key goes in the branch name. GitHub keys carry `#` and `/`;
  // the PR links those with "Fixes #n" instead.
  const branchKey = keys.find(isJiraKey) || idKey
  const type = flags.type || 'feat'
  const branchSlug = flags.slug || slug(title || id.replace(/^[A-Z][A-Z0-9]+-\d+-?/, '') || id)
  const branch = flags.branch ||
    `${type}/${branchKey ? branchKey + '-' : ''}${branchSlug}`.replace(/-$/, '')
  const brief = readStdin()

  const work = {
    id,
    title,
    tickets: keys.length ? keys : (idKey ? [idKey] : []),
    type,
    branch,
    repos: [],
    createdAt: new Date().toISOString(),
  }

  // The complete record first — a work with no ticket is a valid state — then
  // the ticket. If gh fails, `rig ticket <key>` attaches one later; nothing is
  // half-built and no issue is orphaned.
  fs.mkdirSync(workDir(cfg, id), { recursive: true })
  saveWork(work)

  // Context doc — scaffolded minimal, not eleven empty sections (DESIGN.md §7.2).
  const tpl = readText(path.join(RIG_ROOT, 'templates', 'context.md'))
  writeText(contextFile(id), tpl
    .replace(/\{\{ID\}\}/g, id)
    .replace(/\{\{TITLE\}\}/g, title || id)
    .replace(/\{\{KEYS\}\}/g, work.tickets.join(', ') || '_none_')
    .replace(/\{\{DATE\}\}/g, new Date().toISOString().slice(0, 10))
    .replace(/\{\{BRIEF\}\}/g, brief || '_TODO: one line, then the narrative. State scope explicitly._'))
  regenerate(cfg, work)

  if (flags.ticket && work.tickets.length) {
    warn(`--ticket ignored: the work already has ${work.tickets.join(', ')}`)
  } else if (flags.ticket) {
    const created = createTicket(cfg, work, brief, flags.org)
    if (created) {
      work.tickets.push(created)
      saveWork(work)
      setTicketsInDoc(id, work.tickets)
      regenerate(cfg, work)
    }
  }

  ok(`created work ${C.bold(id)}`)
  say(`  record   ${recordFile(id)}`)
  say(`  context  ${contextFile(id)}`)
  say(`  folder   ${workDir(cfg, id)}`)
  say(`  branch   ${branch}`)
  say(`  tickets  ${work.tickets.join(', ') || 'none'}`)
  say('')

  const repos = (flags.repos || '').toString().split(',').map(s => s.trim()).filter(Boolean)
  if (repos.length) {
    for (const r of repos) await attachRepo(cfg, id, r, { setup: !!flags.setup })
  } else {
    say('No repos attached yet. Run the selection interview:')
    say(C.dim('  rig prompt select-repos'))
    say(C.dim(`  rig attach <repo> --work ${id}`))
  }
}

async function attachRepo (cfg, id, repoName, { setup = false } = {}) {
  const work = loadWork(cfg, id)
  if (work.repos.some(r => r.repo.toLowerCase() === repoName.toLowerCase())) {
    say(`${repoName} already attached — nothing to do`)
    return
  }
  const { org, repo } = resolveOrg(cfg, repoName)
  const mirror = ensureMirror(cfg, org, repo)
  const base = defaultBranch(mirror)
  const dest = path.join(workDir(cfg, id), repo)
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

  const langR = run('gh', ['api', `repos/${org}/${repo}`, '--jq', '.language'])
  if (draftCatalogEntry(org, repo, langR.code === 0 ? langR.out : '')) {
    warn(`drafted catalogue entry ${catalogFile(org, repo)} — correct it while this is fresh`)
  }

  const cat = findCatalog(repo)
  work.repos.push({ repo, org, path: dest, base, role: cat?.role || '', attachedAt: new Date().toISOString() })
  saveWork(work)
  regenerate(cfg, work)
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
  const id = findWorkId(cfg, flags.work)
  const work = loadWork(cfg, id)
  const key = positional[0] || die('usage: rig ticket <PROJ-123 | owner/repo#n>')
  if (!isJiraKey(key) && !isGithubKey(key)) die(`"${key}" is neither PROJ-123 nor owner/repo#n`)
  if (work.tickets.includes(key)) return say(`${key} already recorded — nothing to do`)
  work.tickets.push(key)
  saveWork(work)
  setTicketsInDoc(id, work.tickets)
  regenerate(cfg, work)
  ok(`recorded ${key} on ${id}`)
}

cmds.attach = async ({ flags, positional }) => {
  const cfg = config()
  const id = findWorkId(cfg, flags.work)
  const name = positional[0] || die('usage: rig attach <repo>')
  await attachRepo(cfg, id, name, { setup: !!flags.setup })
}

cmds.detach = ({ flags, positional }) => {
  const cfg = config()
  const id = findWorkId(cfg, flags.work)
  const work = loadWork(cfg, id)
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
  saveWork(work)
  regenerate(cfg, work)
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
  const pr = run('gh', ['pr', 'list', '--repo', `${entry.org}/${entry.repo}`, '--head', branch,
    '--state', 'all', '--json', 'number,state,url', '--limit', '1'])
  if (pr.code === 0 && pr.out) {
    try { s.pr = JSON.parse(pr.out)[0] || null } catch { /* gh not available */ }
  }
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
      if (s.pr) bits.push(s.pr.state === 'MERGED' ? C.green(`PR #${s.pr.number} merged`) : `PR #${s.pr.number} ${s.pr.state.toLowerCase()}`)
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
  const id = findWorkId(cfg, flags.work)
  const work = loadWork(cfg, id)
  say(`${C.bold(work.id)} — ${work.title || ''}`)
  say(`branch ${work.branch}`)
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
    say(`  pr      ${s.pr ? `#${s.pr.number} ${s.pr.state} ${s.pr.url}` : 'none'}`)
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
  const id = findWorkId(cfg, flags.work)
  const work = loadWork(cfg, id)
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
  const id = findWorkId(cfg, flags.work)
  const work = loadWork(cfg, id)
  if (exists(planFile(id)) && !flags.force) die(`${planFile(id)} already exists`)
  const tpl = readText(path.join(RIG_ROOT, 'templates', 'rollout-testing-plan.md'))
  writeText(planFile(id), tpl
    .replace(/\{\{ID\}\}/g, id)
    .replace(/\{\{TITLE\}\}/g, work.title || id)
    .replace(/\{\{KEYS\}\}/g, work.tickets.join(', ') || id)
    .replace(/\{\{DATE\}\}/g, new Date().toISOString().slice(0, 10)))
  regenerate(cfg, work)
  ok(`created ${planFile(id)}`)
}

cmds.close = ({ flags }) => {
  const cfg = config()
  const id = findWorkId(cfg, flags.work)
  const work = loadWork(cfg, id)
  const blockers = []
  const states = []
  for (const r of work.repos) {
    const s = repoState(cfg, r, work.branch)   // handles a missing worktree itself
    states.push(s)
    if (s.missing) continue
    if (s.dirty) blockers.push(`${r.repo}: ${s.dirty} uncommitted change(s)`)
    if (s.ahead) blockers.push(`${r.repo}: ${s.ahead} unpushed commit(s)`)
    if (s.pr && s.pr.state === 'OPEN') blockers.push(`${r.repo}: PR #${s.pr.number} still open`)
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
  const wd = workDir(cfg, id)
  // Windows refuses to remove a directory that is some process's cwd — including ours.
  if (process.cwd().toLowerCase().startsWith(wd.toLowerCase())) process.chdir(RIG_ROOT)
  work.closedAt = new Date().toISOString()
  saveWork(work)
  ticketWriteBack(work, states)
  if (exists(wd)) {
    try {
      fs.rmSync(wd, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
    } catch (e) {
      warn(`worktrees removed, but ${wd} could not be deleted: ${e.code || e.message}`)
      warn('something still has it open (a shell, an editor). Delete it by hand.')
      ok(`closed ${id} — context doc kept at ${contextFile(id)}`)
      return
    }
  }
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

  check('node', true, { ok: process.version })
  const gv = run('git', ['--version'])
  check('git', gv.code === 0, { ok: gv.out })
  const ghPresent = has('gh')
  check('gh authenticated', ghPresent && run('gh', ['auth', 'status']).code === 0,
    { bad: ghPresent ? 'PR state and org resolution will not work' : 'gh not on PATH' })

  const lp = run('git', ['config', '--global', 'core.longpaths'])
  check('core.longpaths', lp.out === 'true',
    { bad: 'run `rig init`; deep node_modules paths will break without it' })

  const sym = run('git', ['config', '--get', 'core.symlinks'])
  if (sym.out === 'false') say(`${C.dim('·')} ${C.dim('core.symlinks=false — by design, rig never symlinks')}`)

  check('config file', exists(LOCAL_CONFIG), { bad: `${LOCAL_CONFIG} missing — run \`rig init\`` })
  check('work root', exists(cfg.workRoot), { ok: cfg.workRoot, bad: `${cfg.workRoot} missing` })
  check('mirror root', exists(cfg.mirrorRoot), { ok: cfg.mirrorRoot, bad: `${cfg.mirrorRoot} missing` })
  const split = !sameDir(dataRoot(), RIG_ROOT)
  check('data root', split && exists(dataRoot()), {
    ok: dataRoot(),
    bad: split
      ? `${dataRoot()} missing — check dataRoot in rig.local.json`
      : 'is the tool checkout — not set up; knowledge must not live inside a public tool\'s tree. Run `rig prompt setup`',
  })
  if (split && exists(dataRoot())) {
    const inRepo = git(dataRoot(), 'rev-parse', '--is-inside-work-tree').out === 'true'
    check('data root is a git checkout', inRepo, { bad: 'records written there are not versioned' })
    if (inRepo) {
      // Records commit straight to main; nothing else reminds anyone.
      const dirty = git(dataRoot(), 'status', '--porcelain').out.split('\n').filter(Boolean).length
      const up = git(dataRoot(), 'rev-list', '--count', '@{u}..HEAD')   // fails without an upstream
      if (dirty) warn(`data root has ${dirty} uncommitted change(s) — records commit straight to main`)
      if (up.code !== 0) say(`${C.dim('·')} ${C.dim('data root has no upstream — local only; push it to a private repo when ready')}`)
      else if (Number(up.out)) warn(`data root has ${up.out} unpushed commit(s)`)
      else if (!dirty) ok('data root is committed and pushed')
    }
  }
  check('rig.json', exists(repoConfigFile()),
    { ok: repoConfigFile(), bad: `missing in ${dataRoot()} — not set up; run \`rig prompt setup\`` })
  if (exists(repoConfigFile()) && !cfg.orgs.length) {
    warn('rig.json has no orgs — not set up; run `rig prompt setup`'); problems++
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
    const known = new Set([...work.repos.map(r => r.repo), '.rig', 'AGENTS.md', 'CLAUDE.md'])
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
       [--type feat] [--key PROJ-42 | --ticket [--org o]] [--repos a,b] [--setup]
       --ticket creates the issue in the org's tracker (rig.json) and records it
  rig ticket <key>                record an existing ticket (PROJ-123 or owner/repo#n)
  rig attach <repo> [--setup]     add a repo to the current work
  rig detach <repo> [--force]     remove a repo from the current work
  rig list [--quick]              every work, with staleness signals
  rig status                      live detail for the current work
  rig setup [repo...]             run the catalogue's setup commands
  rig catalog [repo] [--verbose]  the repo catalogue: index, or one entry
  rig plan                        scaffold the rollout & testing plan
  rig close [--force]             safety-checked teardown
  rig doctor                      environment + consistency checks
  rig prompt [name]               print an agent prompt

Commands that act on "the current work" find it by walking up from the cwd,
or take --work <id>.`)
}

// --------------------------------------------------------------------- main

// Pure helpers, importable by tests. Nothing below the guard runs on import.
export { parseArgs, parseFrontmatter, parseTrackerFlag, isJiraKey, isGithubKey, slug, trackerFor, BOOL_FLAGS, RigError }

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
  try {
    await cmd(parseArgs(rest))
  } catch (e) {
    if (e instanceof RigError) { console.error(`${C.red('✗')} ${e.message}`); process.exit(1) }
    throw e
  }
}
