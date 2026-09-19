// One definition of "is this work finished", and the only place that decides it.
//
// `repoState` in rig.mjs gathers the facts about one attached repo — dirty, ahead, behind,
// the PR, whether the worktree is still there. Until this module existed, four readers each
// turned those facts into a judgement with a different rule: `list` said done when every PR
// was merged and nothing was dirty, `close` refused on dirty/ahead/OPEN and shrugged at a
// repo with no PR at all, the ticket write-back counted a missing worktree as unmerged, and
// `status` printed the raw fields. So `rig list` could decline to say "safe to close" for a
// work `rig close` then closed, and a third rule left the issue open afterwards.
//
// Everything here is a decision about state someone else gathered — no fs, no git, no gh,
// no spawning — the same contract as `bin/dash.mjs` and `bin/freshness.mjs`. That is what
// makes the table below testable from fixtures, with no network and no temp checkout.
//
// The table (DESIGN.md decision 62):
//
//   | situation                       | blocks close          | counts as done |
//   | uncommitted changes             | yes                   | no             |
//   | ahead > 0                       | yes                   | no             |
//   | distance unknown                | yes                   | no             |
//   | PR OPEN                         | yes                   | no             |
//   | PR state unknown                | yes                   | no             |
//   | PR MERGED, live or recorded     | no — it settles the branch | yes       |
//   | no PR at all, tree clean        | no                    | no             |
//   | worktree missing                | no, on its own        | judged on its PR |
//
// Two rows carry the whole design:
//
//   1. **A merged PR settles the branch.** `main` requires linear history, so every PR lands
//      as a squash and GitHub deletes the head branch: the upstream ref disappears, the
//      pre-squash commits are nowhere on the base, and the distance reads either as unpushed
//      commits or as unmeasurable, forever. Both are the same false refusal (#52), and once
//      the PR is `MERGED` neither is a question worth asking. Working-tree cleanliness is
//      *not* settled by a merge — a merge says where the commits went, not what is still
//      unsaved in the tree — so `dirty` blocks regardless.
//   2. **A missing worktree is not a verdict.** It means the tree is gone; judge the PR.
//      Nothing local can be measured, so nothing local blocks, and "worktree missing" is
//      never the reason a ticket is left open.
//
// Facts stay facts: `distanceUnknown` is still reported when a merged PR makes it moot, so
// `rig status` can say what git could not measure. Only the *blocker* it would raise is
// dropped.

const MERGED = 'MERGED'

// A record under `repos[].branches[].pr` exists only for a merged PR (DESIGN.md decision 60),
// so reading it back needs no lookup and no stored `state` — the reader knows it. Presented in
// the live PR's shape, `recorded: true` and all, so no caller learns a second shape.
//
// `branch` is the scope stages made necessary: a repo now carries several branches of one
// work, each with its own PR, and "did it merge" is a question about one of them. The verdict
// this module reaches is about the **work branch** — stages merge *down* into it, so a work is
// finished when that branch landed, whatever route its commits took to get there.
const recordedPr = (entry, branch) => {
  const rec = (entry.branches || []).find(b => b.branch === branch)?.pr
  return rec ? { ...rec, state: MERGED, recorded: true } : null
}

// One repo's verdict. `s` is what `repoState` answered for it; `entry` is its record, which
// is where a merged PR's terminal facts live; `branch` says which of its branches is being
// judged.
function repoVerdict (entry, s, branch) {
  const recorded = recordedPr(entry, branch)
  // The live lookup wins when it answered: a branch can carry a second PR after the first
  // merged, and an OPEN one must still block even though a record exists. A lookup that
  // *failed* is settled by the record instead — `repoEntryJson` already treats a stored
  // record as having nothing left to refuse, and this agrees with it.
  const merged = s.pr ? s.pr.state === MERGED : Boolean(recorded)
  const pr = s.pr || recorded
  const prUnknown = s.prError && !merged ? s.prError : null
  const repo = s.repo || entry.repo
  const blockers = []
  const block = (kind, message) => blockers.push({ repo, kind, message })

  const v = {
    repo,
    missing: !!s.missing,
    dirty: s.dirty || 0,
    ahead: s.ahead ?? null,
    behind: s.behind ?? null,
    distanceUnknown: s.distanceUnknown || null,
    pr,
    merged,
    prUnknown,
    blockers,
  }

  // Unsaved work is the one thing `close` could destroy, so it blocks whatever the PR says.
  if (v.dirty) block('dirty', `${repo}: ${v.dirty} uncommitted change(s)`)
  if (!merged) {
    if (v.ahead) block('unpushed', `${repo}: ${v.ahead} unpushed commit(s)`)
    if (v.distanceUnknown) block('distance-unknown', `${repo}: commits unknown (${v.distanceUnknown})`)
    if (pr && pr.state === 'OPEN') block('pr-open', `${repo}: PR #${pr.number} still open`)
    if (prUnknown) block('pr-unknown', `${repo}: PR state unknown (${prUnknown})`)
  }
  return v
}

// Why a ticket is not being closed, in the PR's own terms. A missing worktree is never the
// answer here (rule 2): what is asked of a repo is what happened to its pull request.
const describe = v =>
  `${v.repo} (${v.prUnknown ? 'PR state unknown' : v.pr ? `PR #${v.pr.number} ${v.pr.state.toLowerCase()}` : 'no PR'})`

// One line, for the ticket write-back. Empty exactly when the work is done, so a caller can
// print it without deciding anything again.
function reasonFor (repos, blockers, done) {
  if (done) return ''
  if (!repos.length) return 'No repos were attached, so there are no PRs to check.'
  const unmerged = repos.filter(v => !v.merged)
  if (unmerged.length) return `Not every PR is merged — ${unmerged.map(describe).join(', ')}.`
  // Every PR landed and something is still in the way — an uncommitted change, in practice.
  return `Every PR is merged, but ${blockers.map(b => b.message).join(', ')}.`
}

// The verdict for a whole work. `states` is what `repoState` returns, one per entry of
// `work.repos`, in the same order.
//
//   repos       per-repo facts plus `merged` and that repo's blockers
//   blockers    every blocker, in repo order: { repo, kind, message }
//               kind: dirty | unpushed | distance-unknown | pr-open | pr-unknown
//   safeToClose nothing is in the way of `rig close`
//   done        safe to close *and* every attached repo landed a PR
//   reason      one line saying why not done, empty when it is
//
// A work with nothing attached is safe to close and is not done: there is no unfinished
// business, and equally nothing that landed.
export function workState (work, states = []) {
  const entries = work.repos || []
  const repos = entries.map((entry, i) => repoVerdict(entry, states[i] || {}, work.branch))
  const blockers = repos.flatMap(v => v.blockers)
  const safeToClose = blockers.length === 0
  const done = safeToClose && repos.length > 0 && repos.every(v => v.merged)
  return { repos, blockers, safeToClose, done, reason: reasonFor(repos, blockers, done) }
}
