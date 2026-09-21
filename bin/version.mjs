// Versioning and record-format migrations.
//
// One semver, and `major` means one thing: the shape of the records in the data root
// (`work.json`, catalogue frontmatter, `rig.json`). `minor` is everything else, bumped by
// hand as a label for humans. Major is *derived* — it is the number of migrations — because
// a forgotten major bump means silently writing a record neither version can read, and that
// is not a thing to leave to memory: the format cannot change without a migration being
// added to `bin/migrations`, and adding one moves the major. See
// docs/adr/0002-the-major-version-is-the-record-format.md.
//
// Migrations are record-only and idempotent. Each transforms files in the data root and
// never touches a worktree, which is why a work in progress survives one.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RigError } from './errors.mjs'

// The hooks a migration may carry: `config` transforms `rig.json`, and a migration with no
// hook at all is one whose only effect is the format stamp `applyMigrations` writes.
const HOOKS = new Set(['name', 'config'])

// The key a migration carries that rig has no way to run, or null when it is runnable. A
// `records:` hook for `work/*/work.json` would otherwise sit there being reported as applied
// while doing nothing — and the shape of `work.json` is most of what the major even means,
// so that gap is worth failing on rather than papering over.
export const unrunnableHook = migration => Object.keys(migration).find(k => !HOOKS.has(k)) ?? null

// Every migration in `bin/migrations`, in order. One file each, numbered, and the number *is*
// the record format that migration produces — `0003-…` is the third, and a data root stamped 3
// has been through it.
//
// The order comes from the file names rather than from a list anyone maintains, so adding a
// migration is adding a file and touching nothing else. What that gives up is git telling two
// pull requests they collided: two branches that each add an `0004-` merge cleanly, because
// they are different files. What catches it instead is `test/version.test.mjs`, which asserts
// the numbers are unique and contiguous — a *semantic* conflict rather than a textual one, so
// catching it needs something that runs the suite against the state a change lands in. `main`'s
// up-to-date rule is that something: the second branch must update onto the first, and the test
// then fails on its own pull request. A merge queue would do the same across a group, and `main`
// does not have one (ADR-0005). The guard moved from git to the tests; it did not go away.
//
// Loaded with a top-level await so that everything downstream stays synchronous. There is no
// synchronous `import` in ESM, and `MAJOR` is read at module scope all over this tool.
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

// `0004-what-it-does.mjs`: four digits, a dash, a slug. Anything else in the directory is not a
// migration and is not counted — a stray file must not be able to move the record format.
export const MIGRATION_FILES = fs.readdirSync(DIR).filter(f => /^\d{4}-.+\.mjs$/.test(f)).sort()

export const migrationNumber = file => Number(String(file).slice(0, 4))

export const MIGRATIONS = await Promise.all(
  MIGRATION_FILES.map(f => import(pathToFileURL(path.join(DIR, f)).href).then(m => m.default)),
)

export const MAJOR = MIGRATIONS.length

// What a migration stamps into the data root as `writtenBy`. Derived, and `package.json` is
// not consulted: the stamp is a *record format*, not a note of which rig last touched the data
// root (ADR 0002), so the minor and the patch never meant anything in it. Reading them from
// `package.json` is also how the placeholder there would have become an unparseable stamp and
// refused every mutating command (ADR 0004) — this is the line that makes the placeholder
// inert.
//
// Old data roots carry a stamp with a real minor and patch (`3.7.0`). `majorOf` reads the major
// out of either shape, so no migration is needed to move between them.
export const FORMAT_STAMP = `${MAJOR}.0.0`

// The major in a version rig wrote, 0 when there is no stamp at all, and `null` when there
// is one rig could not have written. Null is not zero: guessing "never migrated" at a stamp
// nobody can read would slip past the write refusal and then overwrite the evidence on the next
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
