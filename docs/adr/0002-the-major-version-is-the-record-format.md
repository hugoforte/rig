# 0002: The major version is the record format

## Status

Accepted, 2026-09-17. Introduces versioning to a tool that had none (hugoforte/rig#14).

## Context

A rig installation is a plain git checkout that nothing ever pulls. The tool drifts behind
its remote, and the data root — which rig pushes but never pulled — drifts behind on any
second machine, so commands run old code against stale records with no signal. Reporting
the distance from a remote (`rig doctor`, the ambient line, `rig update`) needs nothing
more than git.

Telling a human *what* they are running, and telling rig whether it may safely **write**,
does need a version. Those are two different jobs:

- A label to read: "rig 1.2.0", so an installation can be named in a bug report.
- A gate to decide by: may this rig write into this data root? A rig that writes a record in
  a format another installation cannot read is how a record becomes unreadable by both.

Two numbers were considered — a semver for reading plus a separate schema integer for
deciding — on the grounds that they move at different rates. Rejected: for a tool with one
author and no downstream API, one number with one written-down meaning is enough, and two
numbers means two things to keep honest.

The remaining risk with one number is forgetting to bump it. A forgotten cosmetic bump costs
nothing; a forgotten *format* bump silently corrupts records. That asymmetry is what this
decision is shaped around.

## Decision

**`major` is the record format** — the shape of `work.json`, the catalogue frontmatter and
`rig.json`. `minor` is everything else, bumped by hand in `package.json` as a label for
humans. A CLI breaking change (a removed flag) rides along in `major` rather than earning
its own axis.

**`major` is derived: `MAJOR = MIGRATIONS.length`** (`bin/version.mjs`). The format cannot
change without a migration being added, and adding one moves the major by construction, so
the number that gates writes is never a number anyone has to remember to type. A test
asserts `package.json` agrees, so the file is not left lying to whoever reads it.

**The data root records the format it was last migrated to** — `writtenBy` in `rig.json`.
It is a format stamp, not a log of the last rig to touch the data root: it moves when a
migration runs and at no other time, so a rig at 1.7.0 writing records leaves it reading
`1.0.0`, which is correct — the format has not changed. The stamp is written by
`applyMigrations`, never by an individual migration, because a stamp that only migration 1
knows how to write stops moving after migration 1 and every later major silently fails to
take. From it:

- data root major **>** tool major → the tool is old. Mutating commands (`new`, `ticket`,
  `attach`, `detach`, `plan`, `save`, `close`) refuse; read-only ones (`list`, `status`,
  `catalog`, `doctor`) carry on. Reading a newer record with an older rig is harmless, and a
  stale laptop can still answer "what work is open" on a plane.
- data root major **<** tool major → migrations are pending. `rig update` runs them, once the
  data root is clean and current — the migration commit stages the whole tree, so migrating a
  dirty data root would publish whatever it was refused an update for, under a message
  claiming to be a migration. `rig doctor` reports them and never runs them.
- `writtenBy` present but unreadable → writes are refused, and rig says so naming the file.
  Treating a stamp nobody can parse as "never migrated" would open the gate and then
  overwrite the only evidence anything was wrong.

**Migrations are record-only and idempotent.** Each rewrites files in the data root and
never touches a worktree, which is why a work in progress survives one — the gate on an
update is the migration, not whether anything is open. "Finish your open work first" was
rejected as both too weak (every record is in the old format, not just the open ones) and
too strong (there is almost always an open work, so an update gated on quiet worktrees never
happens). If a future migration genuinely must touch worktrees or branch names, that
migration declares itself unsafe and asks for open works to be closed — the cost paid where
it is earned, not on every update.

**Migration 1 is additive only.** It adds `writtenBy` and changes nothing else — it carries
no transform at all, because the format change *is* that the format is now recorded.

**A migration may only carry a hook rig can run.** Today that is `config`, a `rig.json`
transform. A migration carrying anything else — a `records:` hook for `work/*/work.json`,
say — is refused rather than reported as applied, because `work.json` and the catalogue
frontmatter are most of what the major means and neither has a migration mechanism yet.
Writing one is the price of the first migration that needs it.

## Why migration 1 is additive, specifically

This is the one major bump the write refusal cannot protect, and the reason looks arbitrary
without it written down.

A rig from before this change has never heard of `writtenBy` or of refusing to write. So the
moment the first machine runs `rig update` and stamps the data root at major 1, a second
machine still on 0.x does not refuse — it *cannot*, that code is not in it. It keeps writing.

Additive-only makes that safe: the old rig reads a data root that has been through migration
1, sees one key it does not know, ignores it, and stays correct. From major 2 onward the
guard exists in every installation that could be affected, so later migrations may be as
invasive as they need to be.

## Consequences

- Adding a format change means adding a migration to `MIGRATIONS` and bumping
  `package.json`'s major to match. The test fails until they agree.
- A machine that never runs `rig update` is warned on every mutating command that the data
  root is at an older format. That is the intended noise: `update` performs, `doctor`
  reports, and nothing migrates behind your back.
- With one data root shared by a team, a major bump is a coordination event — the first
  person to update locks everyone else out of writes until they update too. Deliberately out
  of scope here; hugoforte/rig#17 covers the expand/migrate/contract shape that removes the
  lockout when it is worth paying for.
