// `rig stage --land`: a work's stage pull requests merged down into the work branch, with a
// merge commit, and never past it (hugoforte/rig#319); and `rig next` offering it once no live
// stage is still to come.
//
// One installation, shared, and the tests run in order: each work below is built by the test
// that first needs it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { strip } from './harness.mjs'
import { billingInstall } from './billing-install.mjs'

const { rig, github, setGithub, cutStage, cleanup } = billingInstall('rig-stage-land-')

after(cleanup)

const url = n => `https://github.com/acme/billing/pull/${n}`
const pr = n => github().repos['acme/billing'].prs.find(p => p.number === n)
const states = (...ns) => ns.map(n => pr(n).state)

// A work with stages cut one on the other in `billing`, each with an open pull request on the
// branch below it. `prs` overrides a stage's pull request: `false` for none, or fields to set.
const stagedWork = (id, stages, first, prs = {}) => {
  const work = `feat/${id}-work`
  assert.equal(rig(['new', id, '--title', `${id} work`, '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', id]).code, 0)
  stages.forEach((name, i) => addStage(id, name, first + i, i ? `feat/${id}-${stages[i - 1]}` : work, prs[name]))
}
const addStage = (id, name, number, base, fields = {}) => {
  const branch = `feat/${id}-${name}`
  assert.equal(rig(['stage', branch, '--delivers', name, '--work', id]).code, 0)
  cutStage({ work: id, repo: 'billing', branch, from: base, back: `feat/${id}-work`, message: `${id}: ${name}` })
  if (fields === false) return
  const state = github()
  state.repos['acme/billing'].prs.push({ branch, number, state: 'OPEN', url: url(number), base, openedAt: '2026-10-05T00:00:00Z', mergedAt: null, commits: [], ...fields })
  setGithub(state)
}
const setPr = (n, fields) => {
  const state = github()
  Object.assign(state.repos['acme/billing'].prs.find(p => p.number === n), fields)
  setGithub(state)
}
const offersLand = id => /rig stage --land/.test(strip(rig(['next', '--work', id]).out))

test('rig next offers --land once every live stage has an open PR', () => {
  stagedWork('whole', ['one', 'two'], 201)
  assert.equal(offersLand('whole'), true)
})

test('rig stage --land stacks the open stage PRs and merges them into the work branch with a merge commit', () => {
  const r = rig(['stage', '--land', '--work', 'whole'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /billing: landed #201, #202 in feat\/whole-work/)
  assert.deepEqual(states(201, 202), ['MERGED', 'MERGED'])
  assert.deepEqual(github().merges, [{ repo: 'acme/billing', via: 'stack', number: 202 }])
})

test('a work whose every stage has landed has nothing to land', () => {
  const r = rig(['stage', '--land', '--work', 'whole'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /every stage of whole has landed — there is nothing to land/)
})

test('rig next stops offering --land once the stack has landed', () => {
  assert.equal(offersLand('whole'), false)
})

test('rig stage <branch> --land lands that stage and the ones below it, and nothing above', () => {
  stagedWork('partial', ['one', 'two', 'three'], 211)
  const r = rig(['stage', 'feat/partial-two', '--land', '--work', 'partial'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /billing: landed #211, #212 in feat\/partial-work/)
  assert.deepEqual(states(211, 212, 213), ['MERGED', 'MERGED', 'OPEN'])
})

test('a single open stage PR on the work branch lands with a merge commit', () => {
  stagedWork('single', ['one'], 221)
  const r = rig(['stage', '--land', '--work', 'single'])
  assert.equal(r.code, 0, r.out)
  assert.equal(pr(221).state, 'MERGED')
  assert.deepEqual(github().merges.at(-1), { repo: 'acme/billing', via: 'pr', number: 221 })
})

test('rig next does not offer --land while a live stage has no PR yet', () => {
  stagedWork('gap', ['one', 'two'], 231, { two: false })
  assert.equal(offersLand('gap'), false)
})

test('a stage below the one asked for with no PR refuses the landing, and nothing merges', () => {
  const r = rig(['stage', 'feat/gap-two', '--land', '--work', 'gap'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /feat\/gap-two has no open PR in billing/)
  assert.equal(pr(231).state, 'OPEN')
})

// The second of two stage PRs is not ready, so neither lands.
const refusesOver = (id, first, fields, says) => {
  stagedWork(id, ['one', 'two'], first, { two: fields })
  const r = rig(['stage', '--land', '--work', id])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), says)
  assert.deepEqual(states(first, first + 1), ['OPEN', 'OPEN'])
}

test('a stage PR whose checks are failing refuses the whole landing, and nothing merges', () => {
  refusesOver('failing', 241, { checks: 'FAILURE' }, /#242 \(feat\/failing-two\): its checks are failing/)
})

test('a stage PR whose checks have not passed yet refuses the whole landing', () => {
  refusesOver('pending', 251, { checks: 'PENDING' }, /#252 \(feat\/pending-two\): its checks have not passed yet/)
})

test('a stage PR with a review requested and not given refuses the whole landing, since that merge is the reviewer\'s', () => {
  refusesOver('requested', 261, { reviewRequests: 1 }, /#262 \(feat\/requested-two\): a review is requested and not given — that merge is the reviewer's/)
})

test('a stage PR with changes requested refuses the whole landing', () => {
  refusesOver('changes', 271, { reviewDecision: 'CHANGES_REQUESTED' }, /#272 \(feat\/changes-two\): changes are requested/)
})

test('a draft stage PR refuses the whole landing', () => {
  refusesOver('draft', 281, { draft: true }, /#282 \(feat\/draft-two\): it is a draft/)
})

test('a stage PR GitHub would not say is ready refuses the whole landing', () => {
  refusesOver('unsaid', 291, { readinessUnknown: true }, /#292 \(feat\/unsaid-two\): GitHub would not say whether it is ready/)
})

test('a stage PR based anywhere but the work branch is refused, so nothing merges past it', () => {
  stagedWork('past', ['one'], 301, { one: { base: 'main' } })
  const r = rig(['stage', '--land', '--work', 'past'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /#301 \(feat\/past-one\) is based on main, not feat\/past-work — rig lands a stage into the work branch and never further/)
  assert.equal(pr(301).state, 'OPEN')
})

test('stages side by side are refused with what is wrong, since a stack merge would land them as one chain', () => {
  stagedWork('forked', ['left', 'right'], 311, { right: { base: 'feat/forked-work' } })
  const r = rig(['stage', '--land', '--work', 'forked'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /billing: #312 \(feat\/forked-right\) is based on feat\/forked-work, not feat\/forked-left/)
  assert.deepEqual(states(311, 312), ['OPEN', 'OPEN'])
})

test('without gh stack, two stage PRs are not landed, and how to install it is said', () => {
  stagedWork('no-tool', ['one', 'two'], 321)
  const state = github()
  state.ghStack = 'missing'
  setGithub(state)
  const r = rig(['stage', '--land', '--work', 'no-tool'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /gh stack is not installed — `gh extension install github\/gh-stack`/)
  assert.deepEqual(states(321, 322), ['OPEN', 'OPEN'])
  delete state.ghStack
  setGithub(state)
})

test('a merge GitHub refuses fails the command with GitHub\'s words', () => {
  const state = github()
  state.mergeFails = 'Pull request #322 is not mergeable: the merge commit cannot be cleanly created'
  setGithub(state)
  const r = rig(['stage', '--land', '--work', 'no-tool'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /billing: could not land #321, #322 \(Pull request #322 is not mergeable/)
  delete state.mergeFails
  setGithub(state)
})

test('--land takes nothing else', () => {
  const r = rig(['stage', '--land', '--link', '--work', 'no-tool'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /--land merges the stages as they are, and takes nothing else \(--link\)/)
})

test('--land names a stage of this work, and one still to land', () => {
  const r = rig(['stage', 'feat/nowhere', '--land', '--work', 'no-tool'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /feat\/nowhere is not a stage of no-tool still to land/)
})
