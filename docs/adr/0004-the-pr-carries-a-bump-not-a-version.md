# 0004: The PR carries a bump, not a version

## Status

Accepted, 2026-09-20. Reverses one decision in ADR 0003 (hugoforte/rig#105).

## Context

ADR 0003 put the version in the pull request: a required check computes what the PR lands as
and fails until `package.json` says it. That was right for the problem it was solving — a
minor nobody remembered to bump — and it named its own cost in its Consequences:

> Two PRs open at once compute the same next version. The ruleset requires a branch to be up
> to date with `main` before merging, which is what stops it; if one lands anyway, the release
> workflow **fails** rather than skipping.

That cost was acceptable at one pull request at a time. It does not survive many. Three rules
now make pull requests merge one at a time, and they multiply:

1. `package.json`'s version line. Every PR edits the same line, and the correct value moves
   each time anyone lands.
2. `main`'s up-to-date rule. Every merge puts every other PR behind, and each must rebase and
   re-run its checks.
3. `releaseVerdict` failing on a version below the latest tag.

With N pull requests the up-to-date rule alone costs on the order of N²/2 check runs, and the
version check is guaranteed red on every PR that is not first.

**The third rule is the dangerous one, because it is silent.** Two pull requests that compute
the same next version write the *same text*. Git sees one change made identically on both
sides and merges it clean — no conflict, nothing red on either PR. The collision surfaces only
afterwards, on `main`, as a failed release with one PR's notes dropped. ADR 0003 chose to fail
there rather than skip, which was correct, but it means the only signal arrives on the trunk
after both merges, and never on the thing that could have been stopped.

## Decision

**A pull request is only ever gated on questions about itself.** This is the rule the rest
follows from. A required check whose answer changes when a *different* pull request merges is
not a check; it is a queue, and it will serialise merges however fast the checks run.
`version.yml` was one, because "what version does this PR land as" is a question about the
whole set.

**The version is worked out at the release, from the bumps of the pull requests it contains.**
`release.yml` already assembles the set: it walks `git rev-list previous..HEAD` and asks
`repos/{repo}/commits/{sha}/pulls` per commit. Add `headRefName` and `labels` to that `--jq`,
fold the existing `bumpFor()` over the result, take the strongest bump, and hand it to the
existing `expectedVersion()`. Neither function changes — `bumpFor` was already pure and already
per-pull-request. What changes is *where it is called*: at the release, where the set is known,
instead of in a branch that cannot see the other branches.

**The strongest bump wins, and a set that cannot be read fails the release.** A release
containing a feature is a minor release, so the fold is `max`. The failure case is the part worth
deciding: a commit in `previous..HEAD` that resolves to no pull request, or a pull request that
names no bump, would quietly produce a smaller bump than the truth and ship a feature inside a
patch release. The workflow therefore **fails and names what it could not read**, rather than
folding what came back. ADR 0003 made this same call once — it chose to fail rather than skip
when two PRs computed one version, because "skipping would drop that PR's notes silently" — and
the argument is unchanged. Nothing is tagged before the set is known, so re-running after a
transient API failure is safe and idempotent.

**`version.yml` survives, asking one question: does this PR name a bump?** That is a question
about the PR alone. No merge elsewhere can change the answer, so the check never goes stale and
a landing never sends anyone back to rebase.

It stays **required**, and the vocabulary widens to make that affordable: `docs/`, `chore/`,
`test/`, `ci/` and `refactor/` map to `none` explicitly, alongside `feat/` → minor and `fix/` →
patch. Anything unrecognised still fails. The alternative — defaulting an unrecognised branch to
`none` and deleting the check — was rejected because it trades the guarantee for convenience: a
feature branched `chore/add-retry` would contribute nothing and ship inside somebody else's patch
release, silently, which is the failure this ADR is about. The cost accepted in exchange is a
second list of prefixes to keep in step with what `rig new --type` accepts.

Because it asks about one pull request, `version.yml` is a **branch-protection check that gates
entry to the merge queue, never a merge-queue check**. A merge group holds several PRs and the
question does not apply to it. `test.yml` is the one that must run on both `pull_request` and
`merge_group` (ADR 0005).

**`package.json` reads `0.0.0-development` and the record-format stamp stops reading it —
in that order.** The placeholder is the one semantic-release documents, and its FAQ gives the
reason to prefer a suffixed value over a bare `0.0.0`: it "makes it clear to contributors that
the version is not kept up to date". rig cannot take it naively, and the order is the whole
point.

`toolVersion()` takes the major from `MIGRATIONS` but the *minor and patch from `package.json`*,
and `version()` writes its result into the data root as `writtenBy` — the record-format stamp.
Left as it is, the placeholder stamps `3.0.0-development`, which `majorOf()` cannot parse, which
makes `writesBlocked()` true: every mutating command refuses, on every data root the build
touched, and `rig update` cannot repair it because updating is itself a write.

So the stamp changes first. `toolVersion()` and `version()` both go, replaced by one derived
constant — `FORMAT_STAMP = \`${MAJOR}.0.0\`` in `bin/version.mjs` — which stops pretending the
stamp ever needed a minor and a patch. ADR 0002 already says it "moves when a migration runs and
at no other time", so the major is the only part that means anything. A constant reads nothing,
so once it is in place the contents of `package.json` cannot reach a data root at all, and the
documented placeholder is inert rather than dangerous.

**The stamp then carries the format and nothing else, and `doctor` stops claiming otherwise.**
`writtenBy` becomes a constant per format, so `record format 3, stamped by rig 3.0.0` would be
saying the same thing twice and calling the second one a rig. It becomes `record format 3`. This
needs no migration: existing data roots carry `writtenBy: "3.0.0"` and `majorOf()` reads the
major out of either shape, so the write refusal cannot tell old stamps from new ones.

**`version()` retires, because there is no third fact for it to report.** After the above there
are exactly two things true of an installation: the **record format** — an integer, derived,
free, and the thing that gates writes — and the **release it stands on**, a tag and a distance
that costs one `git describe --long`. `version()` was neither; it was a hybrid wearing a semver's
shape, and `listPayload` already carried `recordFormat` beside it, so the machine-readable
surface was publishing one fact twice.

So `list --json` (decision 55, the one machine-readable surface) keeps `recordFormat` and gains
`release`, read from `git describe` where the payload is built. `doctor` prints `rig at C:\rig
(v3.7.0)` — the mark is the version, said once. `dash` renders the release from the payload like
everything else it shows.

The one constraint here is ADR 0003's, and it holds: `releaseMark` stays out of `toolState()`,
"which runs in every command's epilogue and is already six spawns dear". A spawn inside
`list --json`, which already makes live GitHub calls, is a different bargain from a spawn on
every command.

**ADR 0003's other four decisions stand**, unamended: the bump is read off the branch prefix
rig already writes with a `release:` label as the override; the major is never asked for; a
release is a tag and notes made of the merged PR descriptions; freshness measures `origin/main`.
Only the location of the computation moves.

### Rejected

- **Changeset or news-fragment files** — `changelog.d/`, towncrier, scriv, changesets. The
  standard answer to this problem, and a correct one: a unique file per change cannot collide.
  Rejected because `release.yml` already collects the pull requests and `bumpFor` already reads
  a bump from one, so a fragment file would be a second convention adopted to obtain a signal
  that already exists on every PR.
- **A bot that bumps and commits on `main`.** Rejected by ADR 0003 and rejected again for the
  same two reasons, which this ADR does not weaken: `main`'s ruleset admits no bypass actors,
  and a second commit per merge is measured by every installation as distance from
  `origin/main` (decision 45).
- **`merge=union` on `package.json`.** GitHub does not run merge drivers when it computes
  mergeability, so the pull requests still read as conflicting; locally it hides the collision
  instead of removing it. It fails at both ends.
- **Keeping the version in the branch and loosening the check** — assert only that it is above
  the latest tag. Half a fix: the check still reads a tag that other merges move, so it still
  answers a question about the set.

## Consequences

- `releaseVerdict()` loses the case it was written for. No branch carries a version, so a merge
  cannot land one below the latest tag, and the failure that existed to catch two PRs computing
  the same number has nothing left to catch.
- **The tests that read `package.json`'s version all move.** `test/version.test.mjs`'s
  "package.json agrees with the derived major" is the assertion this decision retires;
  `test/dash.test.mjs`, `test/smoke.test.mjs` and `test/harness.mjs` each read that version too
  and must take the derived value or the tag instead. This is the bulk of the work in the
  change, not the workflow edit.
- **A release is only as good as the bumps it contains, and the strongest wins.** A
  `release:none` PR merged alongside a `feat/` PR lands in a minor release. That is correct —
  the release describes the set — but it means `release:none` says "this PR asks for nothing",
  never "hold the release".
- If every pull request since the tag says `release:none`, there is no release. `releaseVerdict`
  already reports that case and it keeps its meaning.
- **Issue #16 changes the sum.** Publishing rig without a checkout removes `git describe`, so
  the version must be injected at publish time by the release workflow. The two decisions should
  be designed together rather than in sequence.
- The merge queue (ADR 0005) is independent of this and lands separately. When it does, a merge
  group becomes one push, so `release.yml` runs once per group and cuts one release containing
  it — "every merge is a release" becomes "every merge group is a release" with no further
  decision to make.
