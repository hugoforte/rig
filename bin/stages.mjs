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
// **Stored (intent):** the branch and one line of what it delivers, and once a stage is
// withdrawn from the plan, when and why: dropped with a reason, or replaced by another stage.
// **Derived (state):** started (does the branch exist), up for review (is there a PR), landed
// (did it merge), which repos it touches (where the branch is found), and what it sits on
// (what it was cut from, read live — decision 63) — and whether what it was cut from is part
// of this stack at all, which is the one thing that can contradict the order being shown.
//
// Pure, like `phase.mjs`, `workstate.mjs`, `dash.mjs` and `freshness.mjs`: no fs, no git, no
// gh. Which is what makes a five-deep stack across three repos a fixture rather than a
// scenario someone has to build.

const MERGED = 'MERGED'
const OPEN = 'OPEN'

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
  //
  // `adrift` is the separate question: does any repo put this stage on something that is not
  // part of this stack at all? That is a **contradiction** — the branches naming a place the
  // stack does not contain — and it is the only thing the order being shown can be measured
  // against. It is deliberately `any repo`, not the first to answer: which repo was attached
  // first is not something a reader should be able to feel, and a stage rebased off the stack
  // in one repo is genuinely adrift there whatever the others say.
  const below = new Map()
  const adrift = new Set()
  const inStack = b => b === work?.branch || declared.has(b)
  for (const chain of chains) {
    for (const { branch, base } of chain || []) {
      if (!declared.has(branch) || !base) continue
      if (!below.has(branch)) below.set(branch, base)
      if (!inStack(base)) adrift.add(branch)
    }
  }

  // Walk up from the work branch: whatever sits on it is next, then whatever sits on that.
  const ordered = []
  const seen = new Set()
  let current = work?.branch
  for (let guard = 0; guard <= declared.size; guard++) {
    const next = [...declared.keys()].find(b => !seen.has(b) && below.get(b) === current)
    if (!next) break
    ordered.push({ ...declared.get(next), adrift: adrift.has(next) })
    seen.add(next)
    current = next
  }

  // Anything the chain could not place goes last, in declaration order. A stage whose branch
  // nobody has cut yet has no base to be found by, and a stage cut from somewhere unexpected
  // is a fact about the repo rather than a reason to drop it off the list.
  //
  // **Not reaching a stage is not evidence against it.** The walk stops for reasons that are
  // the ordinary life of a sliced work: a stage's pull request points at the work branch, which
  // is decision 75's convention and makes every stage with a PR report the same base; the stage
  // below has landed and its branch is gone, so nothing surviving is an ancestor of the one
  // above. Both leave the walk short and neither means anything is wrong. `adrift` is the fact
  // that can be said instead — the branches naming a place this stack does not contain.
  for (const [branch, stage] of declared) if (!seen.has(branch)) ordered.push({ ...stage, adrift: adrift.has(branch) })
  return ordered
}

// One stage, as it actually stands. `perRepo` is `{ repo, branch, base, pr }` for every repo
// that carries this stage's branch — absent repos simply do not appear, which is what "a
// stage exists only in the repos it touches" means in data.
export function stageState (stage, perRepo = []) {
  const rows = perRepo.filter(r => r.branch === stage.branch)
  // A row marked `absent` is a branch gone from here whose lookup failed: it may have landed,
  // so it counts as unknown, and nothing carries it, so it is not where the stage is.
  const repos = rows.filter(r => !r.absent)
  const prs = repos.filter(r => r.pr)
  // A lookup GitHub refused, with nothing recorded to fall back on. Carried rather than
  // dropped, because a stage rig could not ask about must never read as one nobody has
  // opened anything on — the `prUnknown` rule the rest of rig already follows.
  const unknown = rows.filter(r => r.prError && !r.pr).map(r => r.repo)
  return {
    branch: stage.branch,
    delivers: stage.delivers || '',
    // A stage's own tickets, if it was given any. GitHub fires a closing keyword only for a
    // pull request that merges into the default branch, and a stage's never does — so a
    // slice's ticket cannot close itself, and rig is the only thing that can.
    tickets: stage.tickets || [],
    withdrawn: withdrawalOf(stage),
    repos: repos.map(r => r.repo),
    // Started the moment the branch exists somewhere. Nothing is stored for this: a stage
    // nobody has cut yet is simply one no repo reports.
    started: repos.length > 0,
    // Do the branches put this stage somewhere this stack does not contain? Set by
    // `stageOrder`, which is the only thing that knows; a stage handed here on its own has no
    // chain to have contradicted it, so it is taken at its word.
    adrift: stage.adrift === true,
    // Up for review while any repo's PR is **open**, and landed only when every repo that
    // carries the stage has merged it — the same all-or-nothing rule `workState` uses for a
    // work, scoped to one slice of it. CLOSED is neither: a stage somebody gave up on is not
    // one waiting for a reviewer, which is what "not merged" said before.
    open: prs.some(r => r.pr.state === OPEN),
    landed: repos.length > 0 && repos.every(r => r.pr && r.pr.state === MERGED),
    prUnknown: unknown.length ? unknown : null,
    prs: prs.map(r => ({ repo: r.repo, number: r.pr.number, state: r.pr.state, url: r.pr.url, base: r.pr.base ?? null, head: r.pr.head ?? null, merge: r.pr.merge ?? null })),
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

// A declared stage withdrawn from the plan (decision 126): `{ at, reason }` when it was dropped,
// `{ at, by }` when another stage replaced it, and null while it is still planned.
export const withdrawalOf = stage => (stage.droppedAt ? { at: stage.droppedAt, reason: stage.reason || '' }
  : stage.replacedAt ? { at: stage.replacedAt, by: stage.replacedBy } : null)

// What became of a withdrawn stage, in a few words. `mark` is how the caller writes a branch
// name, as for `adriftNote`.
export const withdrawnLabel = (w, mark = b => b) => (w.by ? `replaced by ${mark(w.by)}` : `dropped: ${w.reason}`)

// The next stage to look at: the first that has neither landed nor been withdrawn. Null when
// every stage is in or withdrawn, which is what makes the work branch's own PR the thing that
// is available next.
export const nextStage = stack => stack.find(s => !s.landed && !s.withdrawn) || null

// The live stages whose pull request GitHub would not say anything about. A withdrawn one is
// meant to land nothing and renders as withdrawn whatever GitHub says, so it is never asked
// about (decisions 170 and 172).
export const unknownStages = stack => stack.filter(s => s.prUnknown && !s.withdrawn)

// Is `branch` a stage that has landed? A worktree stays on the last stage it worked on after
// GitHub merges that stage and deletes its branch, while the work branch it merged into moves on
// without it (hugoforte/rig#200).
export const onLandedStage = (stack, branch) => stack.some(s => s.landed && s.branch === branch)

// The commands that put such a worktree back on the work branch, brought up to what merged into
// it on the remote. Two lines, run in order, because Windows PowerShell does not take `&&`.
// `git pull` names the branch because a work branch's upstream is its base. Named and never run,
// like `attach --setup` and `check --run`.
export const backToWorkBranch = work => [`git switch ${work.branch}`, `git pull --ff-only origin ${work.branch}`]

// The one line of honesty under an order that is partly a guess, or null when nothing
// contradicts it. `mark` is how the caller writes a branch name — backticked for markdown,
// bare for a terminal — because a branch name is not plain prose in either.
//
// **The condition is a contradiction, not an absence.** A stage is named here only when the
// branches put it on something this stack does not contain: cut from the base branch, or
// rebased off the stack. The order shown for it is then the order somebody declared it in and
// nothing else, and the branches say so rather than merely failing to say otherwise.
//
// Everything quieter than that stays quiet, and that is the point. A stage nobody has cut is
// unplaced and ordinary; so is one whose pull request points at the work branch, which is
// decision 75's convention rather than a fault; so is one whose neighbour below has landed and
// taken its branch with it. Those are the steady state of every sliced work, and they are also
// indistinguishable from the squash this began as a net for — so rig says nothing about them,
// on its own rule that an unknown is not a fact.
//
// It says what happened and not why. "Outside the stack" is what the branches report; "somebody
// squashed the branch below" is a guess about a merge button, and a rebase does the same thing.
// One note rather than a mark per row, and it names the branches, so being quieter than a
// column costs no precision.
export function adriftNote (stack, mark = b => b) {
  const lost = stack.filter(st => st.adrift)
  if (!lost.length) return null
  return `Outside the stack, so shown in declaration order: ${lost.map(st => mark(st.branch)).join(', ')}`
}

// Where one repo's open stage pull requests stand as a GitHub stack (hugoforte/rig#224), given
// `stacks`, every stack GitHub has for the repo. Null where the repo has fewer than two, and
// there is nothing to stack. Otherwise `{ prs, stack, problem }`: `prs` bottom to top, `stack`
// the open stack that holds any of them, and `problem` why linking them as they stand would
// move something. Only a chain is linked, the lowest PR based on the work branch and each next
// on the branch below, because `gh stack link` retargets anything else. And only onto a stack
// on the work branch whose open PRs are a bottom run of the chain, in order, since the rest go
// on top of whatever it holds. `linked` says the stack already holds them all. A stack's
// `openPrs` are the numbers of its PRs still open, whoever's they are.
export function stackState (stack, repo, workBranch, stacks) {
  const prs = stack.filter(st => !st.withdrawn)
    .flatMap(st => st.prs.filter(pr => pr.repo === repo && pr.state === OPEN).map(pr => ({ ...pr, branch: st.branch })))
  if (prs.length < 2) return null
  const numbers = prs.map(pr => pr.number)
  const found = stacks.find(s => s.open && s.prs.some(n => numbers.includes(n))) || null
  const held = found ? found.prs.filter(n => numbers.includes(n)) : []
  const others = found ? found.openPrs.filter(n => !numbers.includes(n)) : []
  const problem = chainProblem(prs, workBranch) || (!found ? null
    : found.base !== workBranch ? `GitHub stack #${found.number} is on ${found.base}, not ${workBranch}`
    : others.length ? `GitHub stack #${found.number} also holds ${others.map(n => `#${n}`).join(', ')}, which is not a stage PR of this chain`
    : held.some((n, i) => n !== numbers[i]) ? `GitHub stack #${found.number} holds them in another order`
    : null)
  return { prs, stack: found, problem, linked: !problem && !!found && held.length === numbers.length }
}

// Why `prs` are not a chain on the work branch, or null. Only a PR sitting on the work branch
// itself, beside the stage below rather than on it, is offered the retarget that would chain
// it. A PR on any other branch is named and left: when that branch is a stage with no open PR,
// retargeting past it would fold that stage's commits into this one.
function chainProblem (prs, workBranch) {
  const below = i => (i ? prs[i - 1].branch : workBranch)
  const off = prs.findIndex((pr, at) => pr.base !== below(at))
  if (off < 0) return null
  const pr = prs[off]
  const says = `#${pr.number} (${pr.branch}) is based on ${pr.base}, not ${below(off)}`
  return pr.base === workBranch ? `${says} — \`gh pr edit ${pr.number} --base ${below(off)}\` if it belongs on it` : says
}

// The deploy-order table, rendered. One renderer, two readers — the PR body (`rig pr`) and the
// rollout plan (`rig plan`) — because the whole complaint against the rollout plan was that
// its table was typed by hand, and two generators would be two tables that disagree.
//
// The note goes **inside** this output rather than beside it at each call site: `planIsStale`
// compares the rendered region against the live stack, so a note rendered outside would leave a
// plan that says one thing and a stack that says another, with nothing able to tell.
//
// Every cell that carries text from the record goes through `cell`, because a `|` in one splits
// the row (decision 139): what a stage delivers is prose, a dropped stage's reason is too, and git
// allows a `|` in a branch name. GFM reads `\|` as a pipe inside a code span as well, so one
// escape covers all of them. A line break ends the row whatever is escaped, and the input refuses
// one, so one a record already holds — written before that, or by hand — becomes a space.
export function stageTable (stack) {
  const where = st => st.landed ? 'landed'
    : st.withdrawn ? withdrawnLabel(st.withdrawn, b => `\`${b}\``)
      : st.open ? 'up for review' : st.prUnknown ? 'PR state unknown' : st.started ? 'in progress' : 'not started'
  const prs = st => st.prs.length ? st.prs.map(pr => `#${pr.number}`).join(', ') : '—'
  const cell = s => s.replaceAll('|', '\\|').replace(/\r?\n/g, ' ')
  const note = adriftNote(stack, b => `\`${b}\``)
  return [
    '| Order | Stage | Delivers | Repos | PR | State |',
    '|------:|-------|----------|-------|----|-------|',
    ...stack.map((st, i) => `| ${i + 1} | ${cell(`\`${st.branch}\``)} | ${cell(st.delivers || '—')} | ${st.repos.join(', ') || '—'} | ${prs(st)} | ${cell(where(st))} |`),
    ...(note ? ['', `_${note}._`] : []),
  ].join('\n')
}

// The region of the rollout plan rig owns. Everything outside these markers is yours — the
// prose that earns the document, which is *why* the order is mandatory, the rejection window,
// the per-tenant prerequisites, the verification queries and the rollback. Everything inside is
// rendered from the stack and rewritten whole, because a table of derived state maintained by
// hand is the thing this whole epic exists to stop.
export const PLAN_MARK = {
  open: '<!-- rig:deploy-order — generated. `rig plan --refresh` rewrites it; edit the prose around it. -->',
  close: '<!-- /rig:deploy-order -->',
}

const planRegion = () => new RegExp(`${escapeRe(PLAN_MARK.open)}[\\s\\S]*?${escapeRe(PLAN_MARK.close)}`, 'm')
export const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const renderPlanRegion = stack => [
  PLAN_MARK.open,
  stack.length ? stageTable(stack) : '_No stages declared — `rig stage <branch> --delivers "..."` records one._',
  PLAN_MARK.close,
].join('\n')

// The plan with its generated region brought up to date, or null when the file has no region
// to rewrite — a plan written before this existed, or one someone deleted the markers from.
// Null rather than an append: putting a table back somewhere arbitrary in a document someone
// has been editing is worse than saying the markers are gone.
export function refreshedPlan (text, stack) {
  const re = planRegion()
  if (!re.test(text)) return null
  // A function replacer, because `String.replace` reads `$&` and `$1` in a *string*
  // replacement as the match and its groups — so a branch or a `delivers` line containing one
  // pasted the old region back inside the new one, and the corruption compounded on every
  // refresh.
  return text.replace(re, () => renderPlanRegion(stack))
}

// Does the plan's rendered table still say what the stack says? This is the read-back the whole
// epic is tested against: an artifact nothing reads is how v1 ended up with a dead table
// containing one blank row, and `rig plan` failed that test for its entire existence.
export function planIsStale (text, stack) {
  const found = planRegion().exec(text)
  return found ? found[0].trim() !== renderPlanRegion(stack).trim() : false
}

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
