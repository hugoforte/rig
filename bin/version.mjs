// Versioning and record-format migrations.
//
// One semver, and `major` means one thing: the shape of the records in the data root
// (`work.json`, catalogue frontmatter, `rig.json`). `minor` is everything else, bumped by
// hand as a label for humans. Major is *derived* — it is the number of migrations — because
// a forgotten major bump means silently writing a record neither version can read, and that
// is not a thing to leave to memory: the format cannot change without a migration being
// added here, and adding one moves the major. See
// docs/adr/0002-the-major-version-is-the-record-format.md.
//
// Migrations are record-only and idempotent. Each transforms files in the data root and
// never touches a worktree, which is why a work in progress survives one.

import { RigError } from './errors.mjs'

// The hooks a migration may carry: `config` transforms `rig.json`, and a migration with no
// hook at all is one whose only effect is the format stamp `applyMigrations` writes.
const HOOKS = new Set(['name', 'config'])

// The key a migration carries that rig has no way to run, or null when it is runnable. A
// `records:` hook for `work/*/work.json` would otherwise sit there being reported as applied
// while doing nothing — and the shape of `work.json` is most of what the major even means,
// so that gap is worth failing on rather than papering over.
export const unrunnableHook = migration => Object.keys(migration).find(k => !HOOKS.has(k)) ?? null

export const MIGRATIONS = [
  {
    // No hook: the format change *is* that the format is now recorded, and the stamp is
    // written by `applyMigrations` for every migration rather than by this one. Additive on
    // purpose. This is the one major bump the write gate cannot protect: a rig from before
    // this check has never heard of `writtenBy`, so when the first machine migrates, the
    // second does not refuse — that code is not in it. Adding a key and changing nothing
    // else means the old rig reads a field it ignores and stays correct.
    name: 'stamp the data root with the version that wrote it',
  },
]

export const MAJOR = MIGRATIONS.length

// `package.json` carries the whole version for anyone reading the file, but only its minor
// and patch are believed here; a test asserts the two agree on the major.
export function toolVersion (pkg = {}) {
  const [, minor = '0', patch = '0'] = String(pkg.version || '0.0.0').split('.')
  return `${MAJOR}.${minor}.${patch}`
}

// The major in a version rig wrote, 0 when there is no stamp at all, and `null` when there
// is one rig could not have written. Null is not zero: guessing "never migrated" at a stamp
// nobody can read would open the write gate and then overwrite the evidence on the next
// `rig update`.
export function majorOf (version) {
  if (version === undefined || version === null) return 0
  const s = String(version)
  if (!/^\d+(\.\d+)*$/.test(s)) return null
  return Number(s.split('.')[0])
}

// The record format the data root is in: what the last migration stamped, or 0 for a data
// root written before stamping existed.
export const dataMajor = repoConfig => majorOf(repoConfig?.writtenBy)

// A `writtenBy` that is present but unreadable — the caller reports it and stops, naming the
// file, rather than treating the data root as pristine.
export const stampUnreadable = repoConfig => dataMajor(repoConfig) === null

export const pendingMigrations = repoConfig => {
  const major = dataMajor(repoConfig)
  return major === null ? [] : MIGRATIONS.slice(major)
}

// True when this rig must not write to that data root: its records are in a format this
// version has never seen. Reading a newer record with an older rig is harmless — writing
// one is how a record becomes unreadable by both. An unreadable stamp blocks too: it is the
// safe direction to fail in.
export const writesBlocked = repoConfig => {
  const major = dataMajor(repoConfig)
  return major === null || major > MAJOR
}

// Runs every pending migration over `rig.json`, returning the new config and the names of
// what ran. The stamp is written here, once, whenever anything ran — never by an individual
// migration, because a stamp that only migration 1 writes stops moving after migration 1
// and every later major silently fails to take.
// Idempotent: on a data root already at this major, nothing runs and nothing is stamped.
export function applyMigrations (repoConfig, version) {
  const ran = []
  let cfg = repoConfig
  for (const m of pendingMigrations(repoConfig)) {
    const unrunnable = unrunnableHook(m)
    if (unrunnable) {
      throw new RigError(`migration "${m.name}" carries \`${unrunnable}\`, which rig has no way to run — only \`config\` (a rig.json transform) is implemented. Records under work/ and the catalogue have no migration mechanism yet; write one before writing a migration that needs it.`)
    }
    if (m.config) cfg = m.config(cfg, version)
    ran.push(m.name)
  }
  if (ran.length) cfg = { ...cfg, writtenBy: version }
  return { config: cfg, ran }
}
