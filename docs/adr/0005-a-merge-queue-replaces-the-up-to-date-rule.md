# 0005: A merge queue replaces the up-to-date rule

## Status

Accepted 2026-09-20 as stage 2 of hugoforte/rig#105, following ADR 0004. **Blocked on 2026-09-21:
GitHub will not enable a merge queue on this repository** — and the block is **dissolvable and not
priced in, as the same day established** (hugoforte/rig#114). Everything below stands as the
decision, and none of it is reachable yet. The two sections written after the attempt are "Why this
is not on" and "Revisited", both at the end; read them in that order.

## Context

ADR 0004 removed one of the three rules that made pull requests merge one at a time. This is
the second, and the expensive one.

`main` carries `strict_required_status_checks_policy: true` — a branch must be up to date with
`main` before it can merge. The rule it enforces is correct and worth keeping: **nothing merges
without having been tested in the state it will land in.** What it costs is that the state
changes every time anybody merges, so each merge puts every other open pull request behind,
each of those must update and re-run, and whoever lands next invalidates them all again. With N
pull requests that is on the order of N²/2 check runs, serialised.

There are exactly two ways to satisfy the rule. The author rebases — which is this. Or the
forge builds the merged state and tests it, which is a merge queue: GitHub creates a
`gh-readonly-queue/main/…` branch combining `main`, everything ahead in the queue, and this
pull request, and runs the checks against that. Pull request C is tested against `main + A + B`,
which is the state C lands in. GitHub's own documentation says this supersedes "require branches
to be up to date".

### What was measured first

The generic advice is to batch 2–5 and no more, because a flaky suite makes one bad test fail a
whole group. That advice is calibrated for a failure this repository does not have:

- **Zero flakes in 98 distinct commits.** No sha has ever failed and then passed; every run is
  `run_attempt: 1` and nothing has ever been re-run. The four failures in that window were
  broken code, fixed by pushing again.
- **The first-attempt green rate — 94 of 98 — does not size a queue**, and was the wrong thing
  to measure. It counts commits pushed to a branch, and a pull request only enters a queue
  *after* its own checks pass, so broken code never reaches a group. What sizes a queue is the
  rate at which an already-green pull request fails against `main + others`: flakes, plus
  semantic conflicts between changes landing together.
- **The semantic-conflict rate here is unmeasured and unmeasurable**, because this repository
  has never had two pull requests in flight at once.

### What the queue is worth today

Nothing, and that is worth stating plainly. The queue's value is proportional to concurrency:

| concurrent PRs | up-to-date rule | merge queue |
|---|---|---|
| 1 | already up to date, no re-run | one extra full run (3m33s on Windows) before merging |
| 2 | one extra run for the loser | one group run |
| 3+ | O(N²) | ⌈N/B⌉ runs |

It is being turned on now anyway, and the reason is not throughput. It is that a merge queue
has four ways to be misconfigured that all present as "the queue is broken", and the moment to
find them is while one person is watching, not when the pull requests arrive.

## Decision

**The merge queue goes on `main`, and `strict_required_status_checks_policy` comes off.**
Leaving both on keeps the author-rebase serialisation the queue exists to remove, since a pull
request would still have to be up to date before it could be queued.

**`test` becomes a required status check.** It was not one. `main`'s ruleset required exactly
one context — `version` — so the matrix suite was advisory and a red pull request could merge.
That is a hole on its own, independent of the queue, and it is also the check that has to gate
the merge group: a queue whose only required check is one that cannot answer for a group would
be ceremony.

**Group size 5, `ALLGREEN` grouping, squash.** Five is GitHub's own default guidance, and with a
zero flake rate it is the conservative end rather than the risky one — there is room to raise it
once concurrency produces data about semantic conflicts, and no data to justify raising it yet.
Squash matches the convention already written down for this tool: a stage's pull request merges
into the work branch with a merge commit, and the work branch is squashed into the base branch.
`required_linear_history` stays, which squash satisfies.

**Every required check triggers on `merge_group`, including the one with nothing to ask.** This
is the decision most likely to be undone by someone tidying up, so the reason belongs here.

GitHub keeps **one** list of required status checks and applies it to both the pull request and
the merge group. There is no PR-only required check. A required check that never reports against
the group's ref does not fail the entry — it leaves it stalled until `check_response_timeout_minutes`
ejects it, and the symptom is a queue that appears broken rather than a missing trigger. So
`test.yml` gains `merge_group` and keeps one set of job definitions for both events, because the
check names have to be identical across the two events and they are identical by coming from the
same jobs. (It began as one job id and one matrix; since hugoforte/rig#155 the Windows check is a
gate job named for it that waits on the shard jobs, and the names still come from the same file.)

`version.yml` gains `merge_group` too, and there it reports success in one line. ADR 0004 said
it was "deliberately not a merge-queue check", which was a preference GitHub does not offer;
that sentence is corrected in this stage. The honest position is that every pull request in a
group answered the question on the way in, and `main` admits no bypass actors, so there is no
other way in and nothing is left to ask.

Re-folding the bumps across the group instead was considered and rejected — not on taste, but
because it cannot work: the queue builds **new** commits on a temporary branch, so the
commit-to-pull-request association `release.yml` reads the set by does not exist for them.

## Consequences

- **Every merge now costs one extra full CI run** before landing, until concurrency makes the
  batching pay. At one pull request in flight that is pure added latency, and it is the price of
  having the configuration proven before it is needed.
- **A stalled queue has one likely cause and it is named above.** If entries sit and are ejected
  after the timeout, a required check is not reporting on `merge_group` — check the names match
  between the two events before looking anywhere else.
- **`release.yml` rests on an association this work has not yet observed.** It reads the set of a
  release by asking the API for each commit's pull requests, and after a queued merge those
  commits are the queue's own squash commits. GitHub documents `commits/{sha}/pulls` as listing
  the merged pull request that introduced a commit to the default branch, so it should hold —
  but it is untested here, and the failure mode is loud rather than silent: `verdict` refuses a
  set it cannot read (ADR 0004), so the first queued merge either releases correctly or fails
  naming the commits, and nothing wrong is published either way. **Watch the first one.**
- A merge group produces one push to `main`, so `release.yml` runs once per group and cuts one
  release containing it. "Every merge is a release" becomes "every merge group is a release",
  which is the batching ADR 0004 predicted and needs no further decision.
- The ruleset change is not a pull request. It is repository configuration, applied separately,
  and it is the one part of this work that cannot be reviewed as a diff.

## Why this is not on

Written 2026-09-21, after trying to apply it. The ruleset update was refused:

```
422 Validation Failed — Invalid rule 'merge_queue':
```

The message names nothing, and the reason is not in the rule. GitHub's own gated-features data
says: *"Pull request merge queues are available in any public repository **owned by an
organization**, or in private repositories owned by organizations using GitHub Enterprise
Cloud."* `hugoforte/rig` is public and owned by a **user account**, so it meets one of the two
conditions and the API refuses the rule.

This was not checked before the stage was designed, and the cost of that is this section.
Nothing was half-applied — the ruleset PUT is atomic, so `strict_required_status_checks_policy`
is still `true` and `main` is exactly as it was.

What survives, and what does not:

- **The up-to-date rule stays on**, so the N²/2 serialisation this ADR exists to remove is still
  there. That is the whole loss, and it is the throughput half.
- **`test` being a required check stands.** That was applied on its own and closed a real hole —
  before it, the matrix suite was advisory and a red pull request could merge.
- **The `merge_group` triggers stay.** They are inert without a queue and cost nothing, and
  removing them would guarantee the stall they exist to prevent on the day one is switched on.
- **Decision 87's guard is not lost, and this ADR overstated the dependency.** One file per
  migration made the two-branches-same-number case a semantic conflict rather than a textual
  one, which needs *something* to test a change in the state it lands in. A merge queue is one
  such thing; **the up-to-date rule is the other**, and it is the one that is on. A second
  migration branch must update onto the first before it can merge, and the contiguity test then
  fails on its own pull request. The guard holds today.

Three ways forward, none of them free:

1. **Move the repository to an organization.** The only route to a native queue, and a change to
   where the project lives rather than to how it builds.
2. **A third-party queue** — Mergify, Aviator, Trunk — which run as GitHub Apps and do not have
   GitHub's ownership gate. A service and a dependency for a repository that has neither.
3. **Leave it.** With one author and rarely two open pull requests, the serialisation costs
   almost nothing today. The reason to act is the fleet this work anticipated, not the present.

**"None of them free" is wrong about the first route**, as the next section establishes. The rest
of this section stands.

## Revisited: the gate is ownership, and leaving it costs nothing

Written 2026-09-21 under hugoforte/rig#114, which went looking for the price of route 1 above and
did not find one. "None of them free" was wrong, and so is every restatement of this block as
permanent.

- **The gate carries no plan condition.** The gated-features file quoted above conditions merge
  queues on ownership and visibility and on nothing else. **GitHub Free for organizations is $0 a
  month**, with unlimited public repositories and a full feature set.
- **Actions stays free.** Public repositories on standard GitHub-hosted runners are unmetered; the
  2,000 minutes a month a free organization advertises is the *private*-repo allowance and never
  applies here. The Windows jobs are not at risk.
- **Every feature `main` depends on survives**, rulesets included — checked one at a time against
  `data/reusables/gated-features/`. Multiple pull request reviewers are *gained*, since free user
  accounts do not have them.
- **Converting the `hugoforte` account itself is not a route.** GitHub deprecated user-to-org
  conversion on GitHub.com in January 2026, and its side effects were severe regardless — the
  account could never be signed into again and every commit stopped being linked to it. The
  supported shape is a new organization with the repository transferred into it.

**Decision: create a free organization and transfer this repository into it.** That does not turn
the queue on. The throughput case has not changed and is still worth nothing at one pull request in
flight, exactly as measured above; what the move removes is the reason the queue *could not* be
turned on. It is being done now rather than later because the packaging work (hugoforte/rig#16)
publishes an install address containing the owner, and `raw.githubusercontent.com` URLs never
redirect — so the cost of moving grows with every installation made in between. The transfer is its
own change and is not part of this ADR.

One thing that transfer must not miss: **OAuth app access restrictions are on by default in a new
organization, and `gh` is an OAuth app.** rig shells out to `gh` for every ticket, pull request and
catalogue operation, and it will fail without naming this as the cause.

A method note, because it generalises past this question: **the rendered GitHub docs pages cannot
be trusted about gating.** Availability notes are reusables that the HTML-to-markdown conversion
drops, so a gated feature reads as ungated. Ask the source instead —
`gh api repos/github/docs/contents/data/reusables/gated-features/<feature>.md`.
