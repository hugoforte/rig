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
    // purpose. This is the one major bump the write refusal cannot protect: a rig from before
    // this check has never heard of `writtenBy`, so when the first machine migrates, the
    // second does not refuse — that code is not in it. Adding a key and changing nothing
    // else means the old rig reads a field it ignores and stays correct.
    name: 'stamp the data root with the version that wrote it',
  },
  {
    // No hook, and no transform of any file: the field this adds (`repos[].pr`, a merged
    // PR's terminal facts — DESIGN.md decision 60) is optional, and its absence already means
    // "not yet known", which is exactly what `rig backfill` looks for. So the migration's only
    // job, like migration 1's, is moving the major — a work.json with `pr` on some entries and
    // not others is valid on both sides of this bump, so an old rig reading a backfilled
    // record ignores a key it does not know and stays correct. Additive is not forced here the
    // way it was on migration 1 — every installation refuses to write below its format now
    // (ADR-0002) — it is just what this change needs.
    name: 'allow repos[].pr, the terminal PR facts backfill and close record',
  },
  {
    // **Two record changes, one migration, because they shipped together.** The SDLC epic
    // (hugoforte/rig#9) moved `work.json` twice — the phase replacing `status`, and stages
    // giving every branch its own base and PR — and both landed in one release. A migration
    // is a *format someone's data root can be in*, not a changelog of shape edits, and there
    // is no reachable format between these two: nothing was ever stamped with it, because the
    // intermediate state existed only on a work branch. Two entries here would claim four
    // formats when only three are reachable, and would leave a hole in the published majors
    // where nothing ever lived. So they are one, named for both.
    //
    // No hook, for the reason migration 2 had none and one this repo has to live with: there
    // is no mechanism to transform `work/*/work.json` (see `unrunnableHook`), and both
    // changes are entirely in that file. So the record moves on the read path, in `loadWork`,
    // losslessly:
    //
    //   - `status` is dropped and its one meaningful value (`designed`) becomes the
    //     `designedAt` gate; the other three were observable facts and `phaseOf` reproduces
    //     them exactly.
    //   - `repos[].base` and `repos[].pr` become the first entry of `repos[].branches[]`, and
    //     `work.stages` defaults to empty — a work with no stages is exactly the work rig
    //     modelled before stages existed.
    //
    // What this migration is *for* is moving the major, and the major is what stops an older
    // rig **writing**. Reading the new shape would survive; writing it back would reintroduce
    // `status` and drop `branches[]` and `stages[]` on the floor, because an old rig spreads
    // the entry it read and knows none of those keys on the way out. Additive on the read side
    // is not enough when the write side is lossy, which is precisely what the write refusal is
    // for.
    name: 'phase replaces status, and stages give every branch its own base and PR',
  },
]

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
