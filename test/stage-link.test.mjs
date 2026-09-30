// `rig stage --link`: a work's open stage pull requests registered as a GitHub stack, one per
// repo, on the work branch (hugoforte/rig#224), and `rig next` offering it until they are one.
//
// One installation, shared, and the tests run in order: each work below is built by the test
// that first needs it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { strip } from './harness.mjs'
import { billingInstall } from './billing-install.mjs'

const { rig, github, setGithub, cutStage, cleanup } = billingInstall('rig-stage-link-')

after(cleanup)

const url = n => `https://github.com/acme/billing/pull/${n}`
const stacks = () => github().repos['acme/billing'].stacks || []

// A work with stages cut one on the other in `billing`, each with an open pull request on the
// branch below it. `bases` overrides where a stage's pull request is based.
const stagedWork = (id, stages, first, bases = {}) => {
  const work = `feat/${id}-work`
  assert.equal(rig(['new', id, '--title', `${id} work`, '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', id]).code, 0)
  stages.forEach((name, i) => addStage(id, name, first + i, bases[name] ?? (i ? `feat/${id}-${stages[i - 1]}` : work)))
}
const addStage = (id, name, number, base) => {
  const branch = `feat/${id}-${name}`
  assert.equal(rig(['stage', branch, '--delivers', name, '--work', id]).code, 0)
  cutStage({ work: id, repo: 'billing', branch, from: base, back: `feat/${id}-work`, message: `${id}: ${name}` })
  const state = github()
  state.repos['acme/billing'].prs.push({ branch, number, state: 'OPEN', url: url(number), base, openedAt: '2026-09-30T00:00:00Z', mergedAt: null, commits: [] })
  setGithub(state)
}
const offersLink = id => /rig stage --link/.test(strip(rig(['next', '--work', id]).out))

test('rig next offers --link while two open stage PRs are not a GitHub stack', () => {
  stagedWork('linked', ['one', 'two'], 71)
  assert.equal(offersLink('linked'), true)
})

test('rig stage --link makes them one stack on the work branch, bottom to top, and says how to merge it', () => {
  const r = rig(['stage', '--link', '--work', 'linked'])
  assert.equal(r.code, 0, r.out)
  const [stack] = stacks()
  assert.deepEqual({ base: stack.base, prs: stack.prs }, { base: 'feat/linked-work', prs: [71, 72] })
  assert.match(strip(r.out), new RegExp(`billing: #71, #72 are GitHub stack #${stack.number}`))
  assert.match(strip(r.out), new RegExp(`gh stack merge ${stack.number} --merge`))
})

test('rig next stops offering --link once the stage PRs are one stack', () => {
  assert.equal(offersLink('linked'), false)
})

test('a stage added on top is offered again, and --link grows the same stack', () => {
  addStage('linked', 'three', 75, 'feat/linked-two')
  assert.equal(offersLink('linked'), true)
  assert.equal(rig(['stage', '--link', '--work', 'linked']).code, 0)
  assert.equal(stacks().length, 1)
  assert.deepEqual(stacks()[0].prs, [71, 72, 75])
})

test('a repo whose stage PRs are already a stack is told so, and nothing is linked', () => {
  const before = JSON.stringify(stacks())
  const r = rig(['stage', '--link', '--work', 'linked'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), new RegExp(`billing: already GitHub stack #${stacks()[0].number}`))
  assert.equal(JSON.stringify(stacks()), before)
})

test('stages side by side on the work branch are named and not linked, since linking would retarget one', () => {
  stagedWork('forked', ['left', 'right'], 81, { right: 'feat/forked-work' })
  const r = rig(['stage', '--link', '--work', 'forked'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /billing: not linked — #82 \(feat\/forked-right\) is based on feat\/forked-work, not feat\/forked-left/)
  assert.equal(stacks().some(s => s.prs.includes(81)), false)
  assert.equal(offersLink('forked'), false, 'nothing to offer that the command would refuse')
})

test('--link takes no branch, in either order', () => {
  for (const args of [['--link', 'feat/linked-one'], ['feat/linked-one', '--link']]) {
    const r = rig(['stage', ...args, '--work', 'linked'])
    assert.equal(r.code, 1, r.out)
    assert.match(strip(r.out), /--link registers every stage at once, and takes no branch/)
  }
})

test('--link registers the stages as they are, and takes no other flag', () => {
  const r = rig(['stage', '--link', '--delivers', 'x', '--work', 'linked'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /--link registers the stages as they are, and takes nothing else \(--delivers\)/)
})

test('a link gh stack refuses is warned with its reason, and the command still succeeds', () => {
  stagedWork('refused', ['one', 'two'], 111)
  const state = github()
  state.linkFails = 'failed to look up PR #111'
  setGithub(state)
  const r = rig(['stage', '--link', '--work', 'refused'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /billing: could not link #111, #112 \(failed to look up PR #111\)/)
  delete state.linkFails
  setGithub(state)
})

test('a missing gh stack is said with how to install it, and the command still succeeds', () => {
  stagedWork('no-tool', ['one', 'two'], 91)
  const state = github()
  state.ghStack = 'missing'
  setGithub(state)
  const r = rig(['stage', '--link', '--work', 'no-tool'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /gh stack is not installed — `gh extension install github\/gh-stack`; the base branches already carry the stack/)
  assert.equal(stacks().some(s => s.prs.includes(91)), false)
})

test('a gh stack too old to link is said with how to upgrade it', () => {
  const state = github()
  state.ghStack = 'old'
  setGithub(state)
  const r = rig(['stage', '--link', '--work', 'no-tool'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /gh stack has no `link` — `gh extension upgrade gh-stack`/)
})

test('rig next says nothing about stacks when GitHub will not list them', () => {
  const state = github()
  delete state.ghStack
  state.repos['acme/billing'].stacks = null
  setGithub(state)
  assert.equal(offersLink('no-tool'), false)
})

test('a work with fewer than two open stage PRs in a repo has nothing to link', () => {
  const state = github()
  state.repos['acme/billing'].stacks = []
  setGithub(state)
  stagedWork('single', ['one'], 101)
  const r = rig(['stage', '--link', '--work', 'single'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /billing: fewer than two stage PRs open — nothing to stack/)
  assert.equal(offersLink('single'), false)
})
