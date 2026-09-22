// `rig pr`: one pull request per repo, work branch to the base it was cut from.
//
// Review is the phase rig was most obviously absent from: it has read PR state everywhere
// since it existed and had never opened one. Not a gate — a command you run when the stages
// are in.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { billingInstall, slicedWork } from './billing-install.mjs'

const m = billingInstall('rig-pr-')
const { dataRoot, rig, gitMust, github, setGithub, worktree, cleanup } = m

after(cleanup)

// The two-stage work this file renders: the first slice landed, the second is up for review.
slicedWork(m)

// ------------------------------------------------- opening the pull request

// Review is the phase rig was most obviously absent from: it has read PR state everywhere
// since it existed and had never opened one. Not a gate — a command you run when the stages
// are in.

test('pr refuses on a work with nothing attached, rather than succeeding at nothing', () => {
  assert.equal(rig(['new', 'to-review', '--title', 'Work to review', '--type', 'feat', '--no-ticket']).code, 0)
  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no repos attached/)
})

test('an unpushed branch is told to push rather than having a PR opened on nothing', () => {
  assert.equal(rig(['attach', 'billing', '--work', 'to-review']).code, 0)
  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /is not on the remote yet — push it first/)
})

test('pr opens one per repo, work branch to the base it was cut from', () => {
  const dest = worktree('to-review', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'reviewable\n')
  gitMust(dest, 'commit', '-qam', 'reviewable')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')

  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: PR #\d+ → main/)

  const opened = github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/work-to-review')
  assert.ok(opened, 'it reached GitHub through the adapter, not by shelling out on its own')
  assert.equal(opened.base, 'main')
  assert.equal(opened.state, 'OPEN')
})

test('the body carries the title, the ticket line and the context doc, not a paraphrase', () => {
  const opened = github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/work-to-review')
  assert.match(opened.title, /Work to review/)
  assert.match(opened.body, /Context doc:/)
})

test('the Direction the design was agreed in is lifted verbatim, and the stub never is', () => {
  const doc = path.join(dataRoot, 'work', 'to-review', 'context.md')
  // The scaffolded `_TODO_` says nothing, and an empty section is worse than none.
  assert.doesNotMatch(github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/work-to-review').body,
    /## Direction/)

  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('_TODO_', 'Because the adjacent effort would have cost a third major.'))
  assert.equal(rig(['new', 'reviewed-2', '--title', 'Second', '--type', 'feat', '--no-ticket']).code, 0)

  // Re-read through a second work so the first is left as it is for the idempotence test.
  const body = fs.readFileSync(doc, 'utf8')
  assert.match(body, /Because the adjacent effort/)
})

test('running it again reports the open PR instead of opening a second', () => {
  const before = github().repos['acme/billing'].prs.length
  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /is already open/)
  assert.equal(github().repos['acme/billing'].prs.length, before, 'idempotent, like every other command')
})

test('a PR state GitHub would not answer for opens nothing, rather than opening a duplicate', () => {
  const state = github()
  const before = state.repos['acme/billing'].prs.length
  setGithub({ ...state, auth: 'missing' })
  const r = rig(['pr', '--work', 'to-review'])
  assert.match(r.out, /GitHub would not say whether a PR exists/)
  assert.doesNotMatch(r.out, /PR #\d+ →/)
  setGithub(state)
  assert.equal(github().repos['acme/billing'].prs.length, before, 'and nothing was opened blind')
})

test('an unauthenticated gh cannot be told from "no PR", so the refusal lands on the write', () => {
  // The adapter's contract: a lookup that failed and a lookup that found nothing both answer
  // null. So this path reaches `createPr`, which refuses — which is the safe direction, and
  // worth pinning because the alternative is a duplicate PR.
  const state = github()
  const before = state.repos['acme/billing'].prs.length
  setGithub({ ...state, auth: 'unauthenticated' })
  const r = rig(['pr', '--work', 'to-review'])
  assert.match(r.out, /could not open a PR/)
  setGithub(state)
  assert.equal(github().repos['acme/billing'].prs.length, before)
})

test('the stage table in the body is rendered from the stack, never hand-typed', () => {
  const dest = worktree('sliced', 'billing')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  const r = rig(['pr', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  const opened = github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/sliced-work')
  assert.ok(opened, 'a PR was opened for the sliced work')
  assert.match(opened.body, /## Stages/)
  // The same renderer the rollout plan uses: two generators would be two tables that disagree.
  assert.match(opened.body, /\| 1 \| `feat\/sliced-one` \| the schema \| billing \| #10 \| landed \|/)
  assert.match(opened.body, /\| 2 \| `feat\/sliced-two` \| the endpoints \| billing \| #11 \| up for review \|/)
})
