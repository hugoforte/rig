// The stage model over fixtures: the chain walk that derives order, the join across repos,
// and what a stage's state adds up to. Pure, so a five-deep stack across three repos is an
// object literal rather than a scenario anyone has to build.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  stageOrder, stageState, stackOf, nextStage, stageBranchProblem,
  stageTable, adriftNote, renderPlanRegion, refreshedPlan, planIsStale, PLAN_MARK,
} from '../bin/stages.mjs'

const work = (over = {}) => ({ id: 'w', branch: 'feat/work', repos: [], stages: [], ...over })
const stage = (branch, delivers = '') => ({ branch, delivers })
// One `{ repo, branch, base, pr }` row, which is what a repo reports for each branch it carries.
const on = (repo, branch, base, pr = null) => ({ repo, branch, base, pr })
const merged = n => ({ number: n, state: 'MERGED', url: `https://x/${n}` })
const open = n => ({ number: n, state: 'OPEN', url: `https://x/${n}` })
const names = stages => stages.map(s => s.branch)

// ---------------------------------------------------------------- order, derived

test('a work with no stages has no stack', () => {
  assert.deepEqual(stageOrder(work()), [])
  assert.deepEqual(stackOf(work(), []), [])
})

test('order comes from the chain, not from the order the stages were declared in', () => {
  const w = work({ stages: [stage('feat/three'), stage('feat/one'), stage('feat/two')] })
  const chain = [
    on('a', 'feat/one', 'feat/work'),
    on('a', 'feat/two', 'feat/one'),
    on('a', 'feat/three', 'feat/two'),
  ]
  assert.deepEqual(names(stageOrder(w, [chain])), ['feat/one', 'feat/two', 'feat/three'])
})

test('the first stage is the one sitting on the work branch', () => {
  const w = work({ stages: [stage('feat/one'), stage('feat/two')] })
  const chain = [on('a', 'feat/two', 'feat/one'), on('a', 'feat/one', 'feat/work')]
  assert.equal(stageOrder(w, [chain])[0].branch, 'feat/one')
})

test('a stage nobody has cut yet keeps its place at the end rather than disappearing', () => {
  const w = work({ stages: [stage('feat/one'), stage('feat/planned')] })
  const chain = [on('a', 'feat/one', 'feat/work')]
  assert.deepEqual(names(stageOrder(w, [chain])), ['feat/one', 'feat/planned'])
})

test('a stage cut from somewhere unexpected is reported, not dropped', () => {
  // A fact about the repo, not a reason to lose the stage off the list.
  const w = work({ stages: [stage('feat/one'), stage('feat/odd')] })
  const chain = [on('a', 'feat/one', 'feat/work'), on('a', 'feat/odd', 'main')]
  assert.deepEqual(names(stageOrder(w, [chain])), ['feat/one', 'feat/odd'])
})

test('a stage the branches put outside the stack is marked, and the rest of the list is not', () => {
  // The fallback is right; it was invisible. `feat/odd` sits on the base branch, which this
  // stack does not contain, so its place in the list is the order it was declared in.
  const w = work({ stages: [stage('feat/one'), stage('feat/odd')] })
  const chain = [on('a', 'feat/one', 'feat/work'), on('a', 'feat/odd', 'main')]
  const [one, odd] = stageOrder(w, [chain])
  assert.equal(one.adrift, false)
  assert.equal(odd.adrift, true)
})

test('an uncut stage is not adrift — there is no base saying otherwise', () => {
  const w = work({ stages: [stage('feat/one'), stage('feat/planned')] })
  const chain = [on('a', 'feat/one', 'feat/work')]
  assert.equal(stageOrder(w, [chain])[1].adrift, false)
})

test('any repo is enough to call a stage adrift, so attach order cannot decide it', () => {
  // First-repo-wins still picks the base the walk uses, but which repo answered first must
  // never be something a reader can feel in the output.
  const w = work({ stages: [stage('feat/one')] })
  const chains = [[on('a', 'feat/one', 'feat/work')], [on('b', 'feat/one', 'main')]]
  assert.equal(stageOrder(w, chains)[0].adrift, true)
  assert.equal(stageOrder(w, [...chains].reverse())[0].adrift, true)
})

test('the chain is per repo while the stage list is per work', () => {
  // Two repos, each carrying part of the same stack. Either one is enough to place a stage.
  const w = work({ stages: [stage('feat/one'), stage('feat/two')] })
  const chains = [
    [on('a', 'feat/one', 'feat/work')],
    [on('b', 'feat/two', 'feat/one')],
  ]
  assert.deepEqual(names(stageOrder(w, chains)), ['feat/one', 'feat/two'])
})

test('two repos agreeing about a stage is the join working, not a conflict', () => {
  const w = work({ stages: [stage('feat/one')] })
  const chains = [[on('a', 'feat/one', 'feat/work')], [on('b', 'feat/one', 'feat/work')]]
  assert.deepEqual(names(stageOrder(w, chains)), ['feat/one'])
})

test('a cycle in the chain terminates rather than spinning', () => {
  const w = work({ stages: [stage('feat/one'), stage('feat/two')] })
  const chain = [on('a', 'feat/one', 'feat/two'), on('a', 'feat/two', 'feat/one')]
  assert.deepEqual(names(stageOrder(w, [chain])).sort(), ['feat/one', 'feat/two'])
})

// ---------------------------------------------------------------- one stage's state

test('a stage exists only in the repos that carry its branch', () => {
  const s = stageState(stage('feat/one'), [on('a', 'feat/one', 'feat/work'), on('b', 'feat/other', 'feat/work')])
  assert.deepEqual(s.repos, ['a'])
})

test('a stage nobody has cut has not started', () => {
  assert.equal(stageState(stage('feat/one'), []).started, false)
})

test('a stage is up for review while any of its PRs is open', () => {
  const s = stageState(stage('feat/one'), [
    on('a', 'feat/one', 'feat/work', merged(1)),
    on('b', 'feat/one', 'feat/work', open(2)),
  ])
  assert.equal(s.open, true)
  assert.equal(s.landed, false)
})

test('a stage has landed only when every repo carrying it has merged', () => {
  const s = stageState(stage('feat/one'), [
    on('a', 'feat/one', 'feat/work', merged(1)),
    on('b', 'feat/one', 'feat/work', merged(2)),
  ])
  assert.equal(s.landed, true)
  assert.equal(s.open, false)
})

test('a repo carrying the branch with no PR at all holds the stage back', () => {
  const s = stageState(stage('feat/one'), [
    on('a', 'feat/one', 'feat/work', merged(1)),
    on('b', 'feat/one', 'feat/work'),
  ])
  assert.equal(s.landed, false)
})

test('what a stage delivers is carried through, because it is the only prose stored', () => {
  const s = stageState(stage('feat/one', 'the schema and the write path'), [on('a', 'feat/one', 'feat/work')])
  assert.equal(s.delivers, 'the schema and the write path')
})

// ---------------------------------------------------------------- the stack

test('the stack is ordered and stateful in one pass', () => {
  const w = work({ stages: [stage('feat/two', 'the endpoints'), stage('feat/one', 'the schema')] })
  const stack = stackOf(w, [
    on('a', 'feat/one', 'feat/work', merged(1)),
    on('a', 'feat/two', 'feat/one', open(2)),
  ])
  assert.deepEqual(names(stack), ['feat/one', 'feat/two'])
  assert.equal(stack[0].landed, true)
  assert.equal(stack[1].open, true)
  assert.equal(stack[0].delivers, 'the schema')
})

test('the next stage is the first that has not landed', () => {
  const w = work({ stages: [stage('feat/one'), stage('feat/two')] })
  const stack = stackOf(w, [
    on('a', 'feat/one', 'feat/work', merged(1)),
    on('a', 'feat/two', 'feat/one', open(2)),
  ])
  assert.equal(nextStage(stack).branch, 'feat/two')
})

test('every stage in means there is no next stage, which is what makes the work branch next', () => {
  const w = work({ stages: [stage('feat/one')] })
  const stack = stackOf(w, [on('a', 'feat/one', 'feat/work', merged(1))])
  assert.equal(nextStage(stack), null)
})

test('a stack of stages nobody has cut says nothing about its order', () => {
  const w = work({ stages: [stage('feat/one'), stage('feat/two'), stage('feat/three')] })
  assert.equal(adriftNote(stackOf(w, [])), null)
})

test('stages whose pull requests all point at the work branch are not accused of anything', () => {
  // Decision 75's convention: a stage's pull request merges into the **work branch**, and the
  // live PR base is what `branchRows` reports. Every stage with a PR therefore names the same
  // base, the walk can only ever reach one of them, and that is the steady state of a sliced
  // work under review rather than an order that stopped being evidence.
  const w = work({ stages: [stage('feat/one'), stage('feat/two'), stage('feat/three')] })
  assert.equal(adriftNote(stackOf(w, [
    on('a', 'feat/one', 'feat/work', open(1)),
    on('a', 'feat/two', 'feat/work', open(2)),
    on('a', 'feat/three', 'feat/work', open(3)),
  ])), null)
})

test('a landed stage whose branch is gone leaves the stage above it alone', () => {
  // A true merge per decision 75, then the head branch deleted: nothing surviving is an
  // ancestor of the stage above, so it has no base at all. An absence is not a contradiction.
  const w = work({ stages: [stage('feat/one'), stage('feat/two')] })
  assert.equal(adriftNote(stackOf(w, [
    on('a', 'feat/one', 'feat/work', merged(1)),
    on('a', 'feat/two', null, open(2)),
  ])), null)
  assert.equal(adriftNote(stackOf(w, [
    on('a', 'feat/one', 'feat/work', merged(1)),
    on('a', 'feat/two', null),
  ])), null, 'and the same before it has a pull request of its own')
})

test('a stage outside the stack is the case the note is for, and it names that stage', () => {
  const w = work({ stages: [stage('feat/one'), stage('feat/odd')] })
  const stack = stackOf(w, [on('a', 'feat/one', 'feat/work'), on('a', 'feat/odd', 'main')])
  const note = adriftNote(stack)
  assert.match(note, /Outside the stack, so shown in declaration order: feat\/odd/)
  assert.doesNotMatch(note, /feat\/one/, 'a stage the branches do not contradict is not in doubt')
})

test('the note says what the branches report, never why a branch moved', () => {
  const w = work({ stages: [stage('feat/odd')] })
  const note = adriftNote(stackOf(w, [on('a', 'feat/odd', 'main')]))
  assert.doesNotMatch(note, /squash|rebase/i, 'that would be a guess, and a rebase does it too')
})

test('the caller says how a branch name is written, so markdown gets its backticks', () => {
  const w = work({ stages: [stage('feat/odd')] })
  const stack = stackOf(w, [on('a', 'feat/odd', 'main')])
  assert.match(adriftNote(stack, b => '`' + b + '`'), /`feat\/odd`/)
})

// ---------------------------------------------------------------- what a stage may be called

test('the work branch cannot be a stage of itself', () => {
  assert.match(stageBranchProblem(work(), 'feat/work'), /the work branch itself/)
})

test('a stage is not declared twice', () => {
  const w = work({ stages: [stage('feat/one')] })
  assert.match(stageBranchProblem(w, 'feat/one'), /already a stage/)
})

test('a stage needs a branch name at all, since that is its identity', () => {
  assert.match(stageBranchProblem(work(), ''), /needs a branch name/)
})

test('and it has to be one git would accept', () => {
  assert.match(stageBranchProblem(work(), 'feat/two words'), /not a valid branch name/)
  assert.match(stageBranchProblem(work(), 'feat/a..b'), /not a valid branch name/)
  assert.equal(stageBranchProblem(work(), 'feat/fine'), null)
})

// ---------------------------------------------------------------- the rollout plan's table

const twoStages = () => stackOf(
  work({ stages: [stage('feat/one', 'the schema'), stage('feat/two', 'the endpoints')] }),
  [on('a', 'feat/one', 'feat/work', merged(1)), on('a', 'feat/two', 'feat/one', open(2))],
)

test('the deploy-order table is rendered from the stack, in stack order', () => {
  const t = stageTable(twoStages())
  assert.match(t, /\| 1 \| `feat\/one` \| the schema \| a \| #1 \| landed \|/)
  assert.match(t, /\| 2 \| `feat\/two` \| the endpoints \| a \| #2 \| up for review \|/)
})

test('the table carries the note for a stage the branches put outside the stack', () => {
  const w = work({ stages: [stage('feat/one', 'the schema'), stage('feat/odd', 'the rest')] })
  const t = stageTable(stackOf(w, [on('a', 'feat/one', 'feat/work'), on('a', 'feat/odd', 'main')]))
  assert.match(t, /\| 2 \| `feat\/odd` \|/)
  assert.match(t, /_Outside the stack, so shown in declaration order: `feat\/odd`\._/,
    'the branch is backticked here, as it is in the table above it')
})

test('an ordinary stack under review carries no note', () => {
  const w = work({ stages: [stage('feat/one', 'the schema'), stage('feat/two', 'the rest')] })
  assert.doesNotMatch(stageTable(stackOf(w, [])), /declaration order/)
  assert.doesNotMatch(stageTable(stackOf(w, [
    on('a', 'feat/one', 'feat/work', open(1)),
    on('a', 'feat/two', 'feat/work', open(2)),
  ])), /declaration order/, 'every stage pointing at the work branch is the convention, not a fault')
})

test('the note is inside the rendered region, so a fresh plan does not go stale on it', () => {
  // `planIsStale` compares rendered regions. A note rendered beside the table instead of in it
  // would leave the plan disagreeing with the stack with nothing able to see it.
  const w = work({ stages: [stage('feat/one', 'the schema'), stage('feat/odd', 'the rest')] })
  const stack = stackOf(w, [on('a', 'feat/one', 'feat/work'), on('a', 'feat/odd', 'main')])
  const plan = `x
${renderPlanRegion(stack)}
y
`
  assert.match(plan, /declaration order/)
  assert.equal(planIsStale(plan, stack), false)
})

test('a work with no stages renders a line saying so, not an empty table', () => {
  // An empty table with one blank row is literally how the last attempt at this tool died.
  const region = renderPlanRegion([])
  assert.doesNotMatch(region, /\| 1 \|/)
  assert.match(region, /No stages declared/)
})

test('refreshing rewrites the region and leaves every word around it alone', () => {
  const prose = 'The order is mandatory because the validation lands first.'
  const before = `# Plan\n\n## The PRs\n\n${renderPlanRegion([])}\n\n## Why\n\n${prose}\n`
  const after = refreshedPlan(before, twoStages())
  assert.match(after, /feat\/one/)
  assert.match(after, new RegExp(prose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the prose is what earns the document')
  assert.match(after, /## Why/)
})

test('a plan with no markers is refused rather than having a table put back somewhere arbitrary', () => {
  assert.equal(refreshedPlan('# Plan\n\nno markers here\n', twoStages()), null)
})

test('stale is the read-back: the rendered table disagreeing with the live stack', () => {
  const fresh = `x\n${renderPlanRegion(twoStages())}\ny\n`
  assert.equal(planIsStale(fresh, twoStages()), false)
  assert.equal(planIsStale(fresh, []), true, 'the stack moved and the document did not')
})

test('a plan with no region is not stale — there is nothing to be stale against', () => {
  assert.equal(planIsStale('# Plan\n\nno markers\n', twoStages()), false)
})

test('the markers say what they are and how to rewrite them', () => {
  assert.match(PLAN_MARK.open, /generated/)
  assert.match(PLAN_MARK.open, /rig plan --refresh/)
})
