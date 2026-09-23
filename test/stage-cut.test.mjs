// `rig stage --cut`: rig makes the branch, in the worktree you are standing in and nowhere
// else, on top of whatever that repo's stack reaches — and still writes nothing down.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { billingInstall, slicedWork } from './billing-install.mjs'

const m = billingInstall('rig-stage-cut-')
const { rig, gitMust, commitWork, seedPr, worktree, record, cleanup } = m

after(cleanup)

// The two-stage work this file renders: the first slice landed, the second is up for review.
before(() => slicedWork(m))

test('--cut outside a worktree says which repos it could have meant', () => {
  assert.equal(rig(['new', 'cutter', '--title', 'Cutter work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'cutter']).code, 0)
  const r = rig(['stage', 'feat/cutter-one', '--delivers', 'the schema', '--cut', '--work', 'cutter'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /run it inside one of cutter's worktrees \(billing\)/)
})

test('--cut makes the branch on the work branch, and rig finds it without being told', () => {
  const dest = worktree('cutter', 'billing')
  const r = rig(['stage', 'feat/cutter-one', '--delivers', 'the schema', '--cut', '--work', 'cutter'], { cwd: dest })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: cut feat\/cutter-one on feat\/cutter-work/)
  assert.equal(gitMust(dest, 'branch', '--show-current'), 'feat/cutter-one')

  const out = rig(['stage', '--work', 'cutter']).out
  assert.match(out, /1\. feat\/cutter-one/)
  assert.match(out, /billing/)
  assert.doesNotMatch(out, /not cut in any repo yet/)
  assert.deepEqual(record('cutter').repos[0].branches, [{ branch: 'feat/cutter-work', base: 'main' }],
    'rig watched itself cut the branch and still wrote nothing down')
})

test('a second --cut stacks on the first, because that is where this repo has reached', () => {
  const dest = worktree('cutter', 'billing')
  commitWork(dest, 'the schema')
  const r = rig(['stage', 'feat/cutter-two', '--delivers', 'the endpoints', '--cut', '--work', 'cutter'], { cwd: dest })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: cut feat\/cutter-two on feat\/cutter-one/)

  const out = rig(['stage', '--work', 'cutter']).out
  assert.match(out, /1\. feat\/cutter-one/)
  assert.match(out, /2\. feat\/cutter-two/)
})

test('--cut reaches a stage declared long before anyone made its branch', () => {
  // The ordinary order, and the case #78 ruled out recording at declaration time for.
  assert.equal(rig(['stage', 'feat/cutter-three', '--delivers', 'the UI', '--work', 'cutter']).code, 0)
  const dest = worktree('cutter', 'billing')
  commitWork(dest, 'the endpoints')

  const r = rig(['stage', 'feat/cutter-three', '--cut', '--work', 'cutter'], { cwd: dest })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: cut feat\/cutter-three on feat\/cutter-two/)
  assert.equal(record('cutter').stages.filter(st => st.branch === 'feat/cutter-three').length, 1,
    'cutting a declared stage does not declare it twice')
  assert.match(rig(['stage', '--work', 'cutter']).out, /3\. feat\/cutter-three/)
})

test('and declaring the same stage twice is still refused when nothing is being cut', () => {
  const r = rig(['stage', 'feat/cutter-three', '--work', 'cutter'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /already a stage/)
})

test('the next stage is the first that has not landed', () => {
  assert.match(rig(['stage', '--work', 'sliced']).out, /feat\/sliced-two.*← next/s)
})

test('and rig next says which stage you are on rather than the whole stack', () => {
  const out = rig(['next', '--work', 'sliced']).out
  assert.match(out, /stage 2 of 2: feat\/sliced-two — the endpoints/)
  assert.doesNotMatch(out, /sliced-one/, 'the whole stack is what rig stage is for; this is one line about where you are')
})

test('a stage whose branch is gone but whose PR merged is landed, not uncut', () => {
  // The branch is deleted when the slice lands, and until `rig close` records the merged
  // pull request there is nothing in the record either. Git cannot answer, so GitHub is
  // asked — for the branches git could not find, and only those.
  assert.equal(rig(['new', 'vanished', '--title', 'Vanished work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'vanished']).code, 0)
  const dest = worktree('vanished', 'billing')
  assert.equal(rig(['stage', 'feat/vanished-one', '--delivers', 'the schema', '--cut', '--work', 'vanished'], { cwd: dest }).code, 0)
  commitWork(dest, 'the schema')
  gitMust(dest, 'checkout', '-q', 'feat/vanished-work')
  gitMust(dest, 'merge', '-q', '--no-ff', '-m', 'merge the schema', 'feat/vanished-one')
  seedPr({ branch: 'feat/vanished-one', number: 60, state: 'MERGED', base: 'feat/vanished-work', url: 'https://github.com/acme/billing/pull/60', mergedAt: '2026-09-19T12:00:00Z' })
  gitMust(dest, 'branch', '-D', 'feat/vanished-one')

  const out = rig(['stage', '--work', 'vanished']).out
  assert.ok(out.includes('billing'), out)
  assert.ok(!out.includes('not cut in any repo yet'), out)
  assert.ok(out.includes('PR #60 merged'), out)
})

test('and a stage nobody has cut anywhere is still reported as not started', () => {
  assert.equal(rig(['stage', 'feat/vanished-two', '--delivers', 'the endpoints', '--work', 'vanished']).code, 0)
  const out = rig(['stage', '--work', 'vanished']).out
  assert.ok(out.includes('not cut in any repo yet'), out)
})
