// The roots, and the two config files that name them.
//
// rig reads config from two files, and they answer different questions:
//
//   rig.local.json  the machine half. Gitignored, beside the tool. The roots, an identity
//                   per org, secrets sources, and a per-machine freshness override.
//   rig.json        the org half. Committed in the data root, so it travels to every
//                   machine. Orgs, the tracker per org, the freshness policy, and the
//                   record-format stamp.
//
// A caller hands this module a **location** — where both files are — and gets one merged
// config value back. The location is resolved once, from the tool checkout and the
// environment; `rig init` is the only thing that ever moves it, when it is creating or
// joining a data root in that very command. Nothing outside this file builds a config
// path, reads either file, or writes one.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RigError } from './errors.mjs'
import { DEFAULT_FRESHNESS } from './freshness.mjs'

// Which key belongs to which file. This is the statement the rest of rig relies on, and it
// is made here and nowhere else. `freshness` is in both on purpose: the policy travels in
// the org half, and a machine that wants to handle updates its own way overrides one key
// locally rather than the whole object.
const MACHINE_KEYS = ['dataRoot', 'dataRoots', 'current', 'workRoot', 'mirrorRoot', 'identities', 'secrets', 'freshness']
const ORG_KEYS = ['orgs', 'tracker', 'writtenBy', 'freshness']
// The keys the org half owns outright. A copy in the machine file — `orgs` and `tracker`
// were both written there by older versions of `init` — is dropped before the merge rather
// than allowed to shadow the committed answer, and `rig doctor` says so.
const ORG_ONLY = ORG_KEYS.filter(k => !MACHINE_KEYS.includes(k))

// Relocates the machine half without relocating the tool. rig is driven as a subprocess, so
// an environment variable is the way a test — or a second installation sharing one checkout
// — says "the machine config is over here". The tool root is deliberately not overridable:
// freshness and `rig update` measure the checkout the running code came from, and a tool
// root that could lie about that would point `update` at someone else's clone.
export const LOCAL_CONFIG_ENV = 'RIG_LOCAL_CONFIG'

// Pins a shell to one data root by name, for the same reason `--data` pins one command. It
// selects among the roots the machine file already configures — it is deliberately not a
// second way to name a path, which would be a data root nothing else on the machine knows.
export const DATA_ROOT_ENV = 'RIG_DATA_ROOT'

// The name the one-root form answers to. A machine file with a bare `dataRoot` and no
// `dataRoots` reads as a registry of exactly one, so nothing below has to know which form
// the file is in; `rig init` normalises it the first time it writes. `default` rather than
// the directory's own name because every data repo is called `rig-data` by convention, so
// basenames collide across roots — the one thing a name may not do.
export const DEFAULT_ROOT_NAME = 'default'

// A work folder says which data root it belongs to, beside the `.rig/id` saying which work
// it is. Two markers, one folder, and neither duplicates a fact: the record lives in the
// data root this names. It is what makes `current` safe — a command run inside a work
// folder never consults it.
const MARKER_DIR = '.rig'
const DATA_ANCHOR = 'data'
export const dataAnchorFile = dir => path.join(dir, MARKER_DIR, DATA_ANCHOR)

// Paths compared as git sees them: real (8.3 short names on Windows expanded, links
// followed) and case-folded, since git prints the long real path and NTFS ignores case.
const realDir = p => {
  try { return fs.realpathSync.native(p).toLowerCase() } catch { return path.resolve(p).toLowerCase() }
}
export const sameDir = (a, b) => realDir(a) === realDir(b)
export const insideDir = (child, parent) => {
  const c = realDir(child)
  const p = realDir(parent)
  return c === p || c.startsWith(p + path.sep)
}

// Absent is `null`, not `{}`: "the file is not there yet" is a different answer from "the
// file says nothing", and `init` and the write refusal both need to tell them apart.
function readJsonFile (file) {
  if (!fs.existsSync(file)) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (e) { throw new RigError(`${file} is not valid JSON: ${e.message}`) }
}

// Writes only when the content differs, so an unchanged file does not churn its mtime under
// the `git add -A` every mutating command ends with.
function writeJsonFile (file, value) {
  const text = JSON.stringify(value, null, 2) + '\n'
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return value
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return value
}

// D:\ is the big drive on the machine this was built for; fall back to the profile so
// `rig init` still works on a machine without one.
const defaultWorkRoot = () => (fs.existsSync('D:\\') ? 'D:\\w' : path.join(os.homedir(), 'w'))

// The same place with a different data root. `init` is the caller: the data root may be
// changing in the command that is running, and every path below it moves with it.
export function withDataRoot (location, dataRoot, selected = {}) {
  const root = path.resolve(dataRoot)
  return Object.freeze({
    toolRoot: location.toolRoot,
    localFile: location.localFile,
    // Every root the machine knows, carried so that the one command with all of them to
    // visit — `update` — does not read the file again behind this value's back.
    roots: location.roots ?? {},
    // Which one this is, and what chose it. `source` is what the rootless commands report: a
    // root chosen by `current` was chosen invisibly, and saying so is the price of the
    // pointer existing at all.
    name: selected.name ?? null,
    source: selected.source ?? 'explicit',
    entry: selected.entry ?? null,
    dataRoot: root,
    orgFile: path.join(root, 'rig.json'),
    // The one place split-vs-not-split is decided. Nested counts as not split: knowledge
    // anywhere inside a public tool's tree is one `git add` from a leak (DESIGN §3).
    split: !insideDir(root, location.toolRoot),
  })
}

// Every data root this machine knows, by name, with paths resolved against the machine
// file's own directory.
function rootsOf (machine, localFile) {
  const base = path.dirname(localFile)
  const declared = machine?.dataRoots
  if (declared && typeof declared === 'object') {
    const out = {}
    for (const [name, value] of Object.entries(declared)) {
      const spec = typeof value === 'string' ? { path: value } : (value || {})
      if (!spec.path) throw new RigError(`dataRoots.${name} in ${localFile} has no "path"`)
      out[name] = { ...spec, path: path.resolve(base, spec.path) }
    }
    return out
  }
  if (machine?.dataRoot) return { [DEFAULT_ROOT_NAME]: { path: path.resolve(base, machine.dataRoot) } }
  return {}
}

// The machine file's answer to "what does this machine know", with nothing selected yet.
// Read on its own by the two commands that must work when the selection itself is broken:
// `rig use`, which is how a `current` naming a root that has gone gets fixed, and `rig
// update`, which has every root to bring forward rather than one.
export function registry (toolRoot, env = process.env) {
  const override = env[LOCAL_CONFIG_ENV]
  const localFile = override ? path.resolve(override) : path.join(toolRoot, 'rig.local.json')
  const machine = readJsonFile(localFile)
  return { toolRoot, localFile, roots: rootsOf(machine, localFile), current: machine?.current ?? null }
}

const dirEntries = dir => {
  try { return fs.readdirSync(dir) } catch { return [] }   // absent, or a file where a directory was expected
}

// Every catalogue entry each configured root holds, by root name, lower-cased because the
// file is named for the repo and NTFS does not distinguish. One traversal, because two
// questions are asked of it: which root catalogues a given repo, and whether any root
// catalogues anything at all.
const catalogued = roots => Object.fromEntries(Object.entries(roots).map(([name, entry]) => {
  const catalog = path.join(entry.path, 'catalog')
  return [name, dirEntries(catalog).flatMap(org => dirEntries(path.join(catalog, org)).map(f => f.toLowerCase()))]
}))

// Whether any configured root could place a repo at all. An installation with nothing
// catalogued — one that has only just run `rig init` — has no repo-shaped answer to give,
// which is what makes finding the repo the cwd is in not worth the subprocess it costs.
const placesRepos = roots => Object.values(catalogued(roots)).some(files => files.length)

// Which configured roots hold a catalogue entry for a repo. A repo is catalogued in exactly
// one data root — `rig attach` drafts the entry the first time it sees the repo, in whichever
// root the work was in — so this is a binding that already exists rather than a new thing to
// configure. Returned as a list because two roots cataloguing one repo is a real state, and
// guessing between them would put a work's records in the wrong repo.
export function rootsCataloguing (roots, repo) {
  const wanted = `${String(repo).toLowerCase()}.md`
  return Object.entries(catalogued(roots)).filter(([, files]) => files.includes(wanted)).map(([name]) => name)
}

// The data root the work folder above the cwd belongs to, or null outside one. Walks up
// exactly as `findWorkId` does, and reads the marker beside the one it reads.
export function anchoredRoot (from) {
  let dir = path.resolve(from)
  for (;;) {
    const file = dataAnchorFile(dir)
    if (fs.existsSync(file)) {
      const name = fs.readFileSync(file, 'utf8').trim()
      if (name) return name
    }
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

// The root a set of repos places this command in, or null when none of them is catalogued
// anywhere. Every repo that *is* catalogued has to agree: a work spanning two roots is not a
// thing rig can assemble, and picking one of them silently is how half a work's records end
// up somewhere nobody looks.
function fromRepos (reg, repos, said) {
  let chosen = null
  for (const repo of repos) {
    const hits = rootsCataloguing(reg.roots, repo)
    if (!hits.length) continue
    if (hits.length > 1) {
      throw new RigError(`"${repo}" is catalogued in more than one data root (${hits.join(', ')}) — pass --data <name> to say which`)
    }
    if (chosen && chosen.name !== hits[0]) {
      throw new RigError(`${chosen.repo} is catalogued in data root "${chosen.name}" and ${repo} in "${hits[0]}" — one work cannot span two data roots`)
    }
    chosen ??= { name: hits[0], repo, source: 'repo', said }
  }
  return chosen && { name: chosen.name, source: chosen.source }
}

// Which root is in hand, and what decided it. First hit wins, and the order is the point:
// what the command said, then what the shell said, then the work folder the command runs
// in, and only then the stored pointer. `current` is never read where the cwd had an
// answer — which is most commands, and what keeps a mutable pointer from being invisible
// state.
//
// A name nothing configures is fatal wherever it came from. The alternative is resolving to
// some other root and writing this work's records into it.
function chooseRoot (reg, env, opts) {
  const names = Object.keys(reg.roots)
  const known = (name, source, said) => {
    if (reg.roots[name]) return { name, source }
    throw new RigError(`${said} names data root "${name}", which ${reg.localFile} does not configure` +
      (names.length ? ` — it has ${names.join(', ')}` : ' — it configures none'))
  }
  if (typeof opts.data === 'string' && opts.data) return known(opts.data, 'flag', '--data')
  const pinned = env[DATA_ROOT_ENV]
  if (pinned) return known(pinned, 'env', DATA_ROOT_ENV)
  const anchored = anchoredRoot(opts.cwd ?? process.cwd())
  if (anchored) return known(anchored, 'cwd', `${MARKER_DIR}/${DATA_ANCHOR} in the work folder above the current directory`)
  // The repos the command named, then the repo the command is standing in. Both answer the
  // same question — which knowledge is this repo's — and both are asked before `current`,
  // because a repo that has been attached once already said where it belongs and having to
  // remember it afterwards is the thing this is for.
  const byRepos = fromRepos(reg, opts.repos ?? [], 'named on the command')
  if (byRepos) return byRepos
  // A function, not a value: finding the repo the cwd is in costs a subprocess, and by here
  // it is the only question left unanswered — every cheaper one has already missed. And it is
  // only worth the subprocess where a catalogue exists to answer it: what places a command by
  // its repo is that repo's catalogue entry, so an installation with none has already said no.
  const here = placesRepos(reg.roots) ? opts.repoAt?.() : null
  const byCwd = here ? fromRepos(reg, [here], 'the repo the current directory is in') : null
  if (byCwd) return byCwd
  if (reg.current) return known(reg.current, 'current', `"current" in ${reg.localFile}`)
  if (names.length === 1) return { name: names[0], source: 'only' }
  if (names.length > 1) {
    throw new RigError(`${reg.localFile} configures ${names.length} data roots (${names.join(', ')}) and none is current — run \`rig use <name>\`, or pass --data <name>`)
  }
  return null
}

// Where both files are, and which knowledge is in hand. No data root configured at all
// still falls back to the tool checkout, so an old install keeps working — `doctor` is what
// reports that layout as not set up.
export function locate (toolRoot, env = process.env, opts = {}) {
  const reg = registry(toolRoot, env)
  const chosen = chooseRoot(reg, env, opts)
  const entry = chosen ? reg.roots[chosen.name] : null
  return withDataRoot({ toolRoot, localFile: reg.localFile, roots: reg.roots },
    entry ? entry.path : toolRoot,
    chosen ? { ...chosen, entry } : { name: null, source: 'fallback', entry: null })
}

// Both files, merged into one value. The org half first, then the machine half over it —
// minus the keys the org half owns outright.
export function load (location) {
  const machine = readJsonFile(location.localFile) ?? {}
  const org = readJsonFile(location.orgFile) ?? {}
  const cfg = { workRoot: defaultWorkRoot(), orgs: [], tracker: {}, identities: {}, secrets: {} }
  Object.assign(cfg, org)
  for (const [key, value] of Object.entries(machine)) if (!ORG_ONLY.includes(key)) cfg[key] = value
  // The registry is the location's to answer, never the merged config's: two copies of
  // "which roots are there" is one more than can be kept true.
  delete cfg.dataRoots
  delete cfg.current
  cfg.dataRoot = location.dataRoot   // resolved, not whatever relative form the file used
  cfg.dataRootName = location.name
  // An identity is per org *and* per data root: the same org name means a different person
  // in a personal root and a paid one, which is the normal case rather than the odd one. The
  // machine-wide map is the fallback, so a machine with one identity per org says it once.
  cfg.identities = { ...(machine.identities ?? {}), ...(location.entry?.identities ?? {}) }
  cfg.mirrorRoot = cfg.mirrorRoot || path.join(cfg.workRoot, '.mirrors')
  cfg.freshness = { ...DEFAULT_FRESHNESS, ...org.freshness, ...machine.freshness }
  // A bad interval is the difference between one fetch a day and one at the end of every
  // command, so it is corrected rather than believed.
  const hours = Number(cfg.freshness.everyHours)
  if (!Number.isFinite(hours) || hours <= 0) cfg.freshness.everyHours = DEFAULT_FRESHNESS.everyHours
  return cfg
}

// rig.json as it sits on disk, unmerged: the record format is a property of the data root
// alone, so the write refusal and the migrations ask this rather than `load`.
export const readOrg = location => readJsonFile(location.orgFile)

// The two writers. `edit` is handed the file as it is — `null` when it does not exist yet,
// which is the distinction that decides whether a stamp is written — and returns what
// should be there.
export const writeMachine = (location, edit) => writeJsonFile(location.localFile, edit(readJsonFile(location.localFile)))
export const writeOrg = (location, edit) => writeJsonFile(location.orgFile, edit(readJsonFile(location.orgFile)))

// Keys in the machine file that are the org half's to answer. Asked by `doctor` rather than
// carried as a field on the config value: a diagnostic is a question about the files, not a
// setting, and it had one reader.
export const strayOrgKeys = location =>
  Object.keys(readJsonFile(location.localFile) ?? {}).filter(k => ORG_ONLY.includes(k))
