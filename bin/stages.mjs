// Stages: the delivery slices of a work, and the stacked branches that carry them.
//
// rig already had a stage model and it was dead prose. `templates/rollout-testing-plan.md`
// opens with a `## The PRs (deploy order)` table — ordered slices, each with a branch, a PR
// and a reason — hand-maintained, in a document nothing ever read back. That is this concept
// exactly, sitting in the one place DESIGN.md decision 3 forbids, which is the failure mode
// that killed v1. So this is not a new idea; it is the idea moved into the record, where
// nothing can hand-edit it stale.
//
// The model:
//
//     base branch (main/develop) ◄──────────────── one PR per repo, at the end
//       └─ work branch ◄─────────────────────────┐
//            └─ stage 1 ──►┐                     │  stages merge down
//                 └─ stage 2 ──►┐                │  into the work branch
//                      └─ stage 3 ──►────────────┘
//
// - The **work branch** is cut from the base branch in every attached repo, one shared name.
//   A work with no stages behaves exactly as it did before any of this existed.
// - A **stage** is a delivery slice carried by a branch and reviewed on its own. Stages are
//   stacked: the first on the work branch, each one after it on the stage before.
// - **Base is a relation, never a name for a branch.** The work branch's base is
//   `main`/`develop`; a stage's base is the branch below it in the stack.
// - A stage exists only in the repos it touches, so **the chain is per-repo while the stage
//   list is per-work**. Same branch name in two repos means the same stage — that is the join,
//   and it is why the branch name *is* the stage's identity rather than a field beside it.
//
// **Stored (intent):** the branch and one line of what it delivers. That is all.
// **Derived (state):** started (does the branch exist), up for review (is there a PR), landed
// (did it merge), which repos it touches (where the branch is found), and what it sits on
// (what it was cut from, read live — decision 63).
//
// Pure, like `phase.mjs`, `workstate.mjs`, `dash.mjs` and `freshness.mjs`: no fs, no git, no
// gh. Which is what makes a five-deep stack across three repos a fixture rather than a
// scenario someone has to build.

const MERGED = 'MERGED'

// The stages a work has declared, in the order the branches are actually stacked — never in
// the order the array happens to be in. `chains` is one entry per repo: the branches that
// repo carries, each `{ branch, base }`, with `base` read live.
//
// Order is derived because a stored order is a second answer to a question the branches
// already answer, and the two drift the moment anyone rebases. What the array gives is the
// set and the intent; the stack gives the sequence.
export function stageOrder (work, chains = []) {
  const declared = new Map((work?.stages || []).map(s => [s.branch, s]))
  if (!declared.size) return []

  // Every `base -> branch` edge any repo knows about. A stage that exists in three repos says
  // the same thing three times, which is the join doing its job rather than a conflict.
  const below = new Map()
  for (const chain of chains) {
    for (const { branch, base } of chain || []) {
      if (declared.has(branch) && base && !below.has(branch)) below.set(branch, base)
    }
  }

  // Walk up from the work branch: whatever sits on it is next, then whatever sits on that.
  const ordered = []
  const seen = new Set()
  let current = work?.branch
  for (let guard = 0; guard <= declared.size; guard++) {
    const next = [...declared.keys()].find(b => !seen.has(b) && below.get(b) === current)
    if (!next) break
    ordered.push(declared.get(next))
    seen.add(next)
    current = next
  }

  // Anything the chain could not place goes last, in declaration order. A stage whose branch
  // nobody has cut yet has no base to be found by, and a stage cut from somewhere unexpected
  // is a fact about the repo rather than a reason to drop it off the list.
  for (const [branch, stage] of declared) if (!seen.has(branch)) ordered.push(stage)
  return ordered
}

// One stage, as it actually stands. `perRepo` is `{ repo, branch, base, pr }` for every repo
// that carries this stage's branch — absent repos simply do not appear, which is what "a
// stage exists only in the repos it touches" means in data.
export function stageState (stage, perRepo = []) {
  const repos = perRepo.filter(r => r.branch === stage.branch)
  const prs = repos.filter(r => r.pr)
  return {
    branch: stage.branch,
    delivers: stage.delivers || '',
    repos: repos.map(r => r.repo),
    // Started the moment the branch exists somewhere. Nothing is stored for this: a stage
    // nobody has cut yet is simply one no repo reports.
    started: repos.length > 0,
    // Up for review while any repo's PR is open, and landed only when every repo that carries
    // the stage has merged it — the same all-or-nothing rule `workState` uses for a work,
    // scoped to one slice of it.
    open: prs.some(r => r.pr.state !== MERGED),
    landed: repos.length > 0 && repos.every(r => r.pr && r.pr.state === MERGED),
    prs: prs.map(r => ({ repo: r.repo, number: r.pr.number, state: r.pr.state, url: r.pr.url })),
  }
}

// The whole stack, ordered and with its state — what `rig stage` prints and what the rollout
// plan is rendered from. `perRepo` is the flat list of every `{ repo, branch, base, pr }` the
// work knows about, across every repo.
export function stackOf (work, perRepo = []) {
  const chains = groupByRepo(perRepo)
  return stageOrder(work, chains).map(s => stageState(s, perRepo))
}

const groupByRepo = perRepo => {
  const by = new Map()
  for (const r of perRepo) {
    if (!by.has(r.repo)) by.set(r.repo, [])
    by.get(r.repo).push(r)
  }
  return [...by.values()]
}

// The next stage to look at: the first that has not landed. Null when every stage is in, which
// is what makes the work branch's own PR the thing that is available next.
export const nextStage = stack => stack.find(s => !s.landed) || null

// A branch name a stage can actually be carried on. The work's own branch is refused because
// a stage stacked on itself is the one shape the chain walk cannot represent — and because it
// would make the work branch its own slice, which is not what a slice is.
export function stageBranchProblem (work, branch) {
  const b = String(branch || '').trim()
  if (!b) return 'a stage needs a branch name — it is the stage\'s identity, and the join across repos'
  if (b === work?.branch) return `${b} is the work branch itself; a stage is a slice *of* it, cut on top`
  if ((work?.stages || []).some(s => s.branch === b)) return `${b} is already a stage of this work`
  if (/\s/.test(b) || b.startsWith('/') || b.endsWith('/') || b.includes('..')) return `${b} is not a valid branch name`
  return null
}
