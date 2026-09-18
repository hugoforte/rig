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
const MACHINE_KEYS = ['dataRoot', 'workRoot', 'mirrorRoot', 'identities', 'secrets', 'freshness']
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
// file says nothing", and `init` and the write gate both need to tell them apart.
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
export function withDataRoot (location, dataRoot) {
  const root = path.resolve(dataRoot)
  return Object.freeze({
    toolRoot: location.toolRoot,
    localFile: location.localFile,
    dataRoot: root,
    orgFile: path.join(root, 'rig.json'),
    // The one place split-vs-not-split is decided. Nested counts as not split: knowledge
    // anywhere inside a public tool's tree is one `git add` from a leak (DESIGN §3).
    split: !insideDir(root, location.toolRoot),
  })
}

// Where both files are. An unset `dataRoot` still falls back to the tool checkout, so an
// old install keeps working — `doctor` is what reports that layout as not set up. A
// relative `dataRoot` resolves against the machine file's own directory.
export function locate (toolRoot, env = process.env) {
  const override = env[LOCAL_CONFIG_ENV]
  const localFile = override ? path.resolve(override) : path.join(toolRoot, 'rig.local.json')
  const configured = readJsonFile(localFile)?.dataRoot
  return withDataRoot({ toolRoot, localFile },
    configured ? path.resolve(path.dirname(localFile), configured) : toolRoot)
}

// Both files, merged into one value. The org half first, then the machine half over it —
// minus the keys the org half owns outright.
export function load (location) {
  const machine = readJsonFile(location.localFile) ?? {}
  const org = readJsonFile(location.orgFile) ?? {}
  const cfg = { workRoot: defaultWorkRoot(), orgs: [], tracker: {}, identities: {}, secrets: {} }
  Object.assign(cfg, org)
  for (const [key, value] of Object.entries(machine)) if (!ORG_ONLY.includes(key)) cfg[key] = value
  cfg.dataRoot = location.dataRoot   // resolved, not whatever relative form the file used
  cfg.mirrorRoot = cfg.mirrorRoot || path.join(cfg.workRoot, '.mirrors')
  cfg.freshness = { ...DEFAULT_FRESHNESS, ...org.freshness, ...machine.freshness }
  // A bad interval is the difference between one fetch a day and one at the end of every
  // command, so it is corrected rather than believed.
  const hours = Number(cfg.freshness.everyHours)
  if (!Number.isFinite(hours) || hours <= 0) cfg.freshness.everyHours = DEFAULT_FRESHNESS.everyHours
  return cfg
}

// rig.json as it sits on disk, unmerged: the record format is a property of the data root
// alone, so the write gate and the migrations ask this rather than `load`.
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
