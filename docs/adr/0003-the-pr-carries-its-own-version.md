# 0003: The PR carries its own version

## Status

Accepted, 2026-09-18. Automates what ADR 0002 left to hand (hugoforte/rig#30).

## Context

ADR 0002 derives the major — `MAJOR = MIGRATIONS.length` — precisely because a number kept
by hand is a number that goes wrong. It then left the minor as "a label bumped by hand in
`package.json`", which is the same bet, taken again, on the half nobody has a test for.

It went wrong at the first opportunity. #29 merged without touching `package.json`, so every
installation reported `rig 1.0.0` while running a commit past the `v1.0.0` release, with a
behaviour change — offline data roots no longer migrated — that no release note mentioned.
The only history of 1.0.0 was #19's description, copied into the GitHub release by hand.

Three things were missing, and only the first is a version: a bump that happens without
anyone remembering, a tag and notes per version, and a way for an installation to say which
*release* it is running rather than which commit.

## Decision

**The PR carries its own version.** `.github/workflows/version.yml` is a required status
check that computes what the PR will land as and fails until `package.json` says it, naming
the value to write. `.github/workflows/release.yml` runs on the merge and only tags the
commit and publishes the notes.

The adjacent design — a workflow that bumps, commits and tags on `main` after the merge —
was rejected on two counts:

- `main` carries a ruleset (`pull_request`, `required_status_checks`,
  `required_linear_history`) with **no bypass actors**. That design's first requirement is a
  hole cut in it for a bot.
- It puts a second commit on `main` per PR, and distance from `origin/main` is exactly what
  the freshness check measures (decisions 45–49). Every installation would report itself
  behind twice per merge, half of it for commits that changed no code.

Keeping the bump in the PR costs neither. `main` gains tags and nothing else, and
`package.json` is truthful at every commit on it rather than at every other one.

**The bump is read off what rig already writes.** A head branch is `feat/…` or `fix/…`
because `rig new --type` put it there: `feat` → minor, `fix` → patch. A
`release:minor|patch|none` label overrides it, for the docs-only PR on a `feat/` branch or
the branch whose prefix lies. Conventional-commit prefixes were rejected as a new convention
for a repo whose PR titles are sentences; a mandatory label was rejected as a second thing to
remember when a correct signal already exists.

**The major is still never asked for.** `release:major` is refused as a label. A PR that adds
a migration lands as `MAJOR.0.0` however it is labelled — the record format changing *is* the
release, and ADR 0002 exists to keep that number out of anyone's memory.

**A release is a tag and a GitHub release, and its body is the merged PR descriptions since
the previous tag.** They are already written, already reviewed, and already say why. A
committed `CHANGELOG.md` was considered and rejected *for now*: with the bump in the PR, an
in-repo changelog is an entry each PR writes by hand — the failure mode this ADR exists to
remove. It is worth revisiting when #16 publishes a package without a checkout and an offline
history starts to earn its keep.

**Freshness still measures `origin/main`** (decision 45 stands). With a release per merge the
tag and `main` track each other, so measuring against the tag instead would only hide
unreleased commits. What changes is naming: `rig doctor` reports the release a checkout
stands on (`rig 1.1.0 at C:\rig (v1.1.0)`) or the distance past it (`(3 past v1.1.0,
abc1234)`), from one `git describe --long` it asks for itself — never in `toolState`, which
runs in every command's epilogue and is already six spawns dear.

## Consequences

- Every PR must set `package.json` before it can merge. The check prints the exact value, so
  the cost is one line, and a PR that should not move the version says `release:none`.
- Two PRs open at once compute the same next version. The ruleset requires a branch to be up
  to date with `main` before merging (`strict_required_status_checks_policy`), which is what
  stops it; if one lands anyway, the release workflow **fails** rather than skipping, because
  skipping would drop that PR's notes silently.
- A release is only as good as the PR descriptions it is made of. That is the intended
  pressure: the description is the release note, written while the change is in hand.
- The rules live in `bin/release.mjs` as pure decisions — no git, no fs, no network above the
  CLI seam — so they are testable without a checkout, a tag or a PR, the same split
  `bin/freshness.mjs` uses. The workflows gather; they do not decide.
