// The stage stack end to end: declaring one, where the branches place it, and what rig will
// and will not say about a stage the chain cannot account for.
//
// `test/stages.test.mjs` is the same model over object literals. This is the half that only
// real branches can prove — that `worktrees.chain()` finds what git actually holds, and that
// a live pull request base outranks it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { billingInstall } from './billing-install.mjs'

const { rig, github, setGithub, commitWork, cutStage, worktree, record, planFile, cleanup } = billingInstall('rig-stages-')

after(cleanup)

test('a work starts with no stages, and says so without making it sound like a deficiency', () => {
  assert.equal(rig(['new', 'sliced', '--title', 'Sliced work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'sliced']).code, 0)
  const r = rig(['stage', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /no stages/)
  assert.match(r.out, /how every work starts/)
})

test('the record keeps a base per branch now, not one per repo', () => {
  const entry = record('sliced').repos[0]
  assert.equal(entry.base, undefined, 'a base belongs to the branch it was cut for')
  assert.deepEqual(entry.branches, [{ branch: 'feat/sliced-work', base: 'main' }])
})

test('declaring a stage stores the branch and the one line, and nothing else', () => {
  const r = rig(['stage', 'feat/sliced-one', '--delivers', 'the schema', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('sliced').stages, [{ branch: 'feat/sliced-one', delivers: 'the schema' }])
})

test('the work branch cannot be a stage of itself', () => {
  const r = rig(['stage', 'feat/sliced-work', '--work', 'sliced'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /the work branch itself/)
})

test('and a stage is not declared twice', () => {
  const r = rig(['stage', 'feat/sliced-one', '--work', 'sliced'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /already a stage/)
})

test('a declared stage nobody has cut is listed, and reported as not started', () => {
  const r = rig(['stage', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1\. feat\/sliced-one/)
  assert.match(r.out, /the schema/)
  assert.match(r.out, /not cut in any repo yet/)
  assert.doesNotMatch(r.out, /Outside the stack/, 'an uncut stage is ordinary, and nothing contradicts where it is shown')
})

test('a stage branch cut in a repo is found, and nothing is written to the record', () => {
  cutStage({ work: 'sliced', repo: 'billing', branch: 'feat/sliced-one', from: 'feat/sliced-work', back: 'feat/sliced-work', message: 'the schema' })

  const r = rig(['stage', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1\. feat\/sliced-one/)
  assert.match(r.out, /billing/)
  assert.doesNotMatch(r.out, /not cut in any repo yet/)
  assert.deepEqual(record('sliced').repos[0].branches, [{ branch: 'feat/sliced-work', base: 'main' }],
    'the stack is derived: the record still holds the work branch alone')
})

test('a second stage, stacked on the first, is placed under it with no PR to ask', () => {
  assert.equal(rig(['stage', 'feat/sliced-two', '--delivers', 'the endpoints', '--work', 'sliced']).code, 0)
  cutStage({ work: 'sliced', repo: 'billing', branch: 'feat/sliced-two', from: 'feat/sliced-one', back: 'feat/sliced-work', message: 'the endpoints' })

  // Declared and stacked in the same order, so this cannot tell the chain from the array: "the
  // chain outranks the order the stages were declared in" is the test that can.
  const out = rig(['stage', '--work', 'sliced']).out
  assert.match(out, /1\. feat\/sliced-one/)
  assert.match(out, /2\. feat\/sliced-two/)
})

test('and a pull request, once one exists, answers the base over git', () => {
  const state = github()
  state.repos['acme/billing'].prs.push(
    { branch: 'feat/sliced-two', number: 11, state: 'OPEN', url: 'https://github.com/acme/billing/pull/11', base: 'feat/sliced-one', openedAt: '2026-09-19T00:00:00Z', mergedAt: null, commits: [] },
    { branch: 'feat/sliced-one', number: 10, state: 'MERGED', url: 'https://github.com/acme/billing/pull/10', base: 'feat/sliced-work', openedAt: '2026-09-18T00:00:00Z', mergedAt: '2026-09-18T12:00:00Z', commits: [] },
  )
  setGithub(state)

  const out = rig(['stage', '--work', 'sliced']).out
  assert.match(out, /1\. feat\/sliced-one/)
  assert.match(out, /2\. feat\/sliced-two/)
  assert.match(out, /PR #10 merged/)
  assert.match(out, /PR #11 open/)
  assert.deepEqual(record('sliced').repos[0].branches, [{ branch: 'feat/sliced-work', base: 'main' }],
    'a pull request is read, never recorded, until it is merged and the work closes')
})

test('the chain outranks the order the stages were declared in', () => {
  // Declared late-then-early and stacked early-then-late, so the array and the branches
  // disagree. Nothing stores an order, so where the commits sit is the only thing that can
  // tell them apart — and it is the one that survives someone re-stacking the work.
  assert.equal(rig(['new', 'restacked', '--title', 'Restacked work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'restacked']).code, 0)
  assert.equal(rig(['stage', 'feat/restacked-late', '--delivers', 'the endpoints', '--work', 'restacked']).code, 0)
  assert.equal(rig(['stage', 'feat/restacked-early', '--delivers', 'the schema', '--work', 'restacked']).code, 0)

  const opts = { work: 'restacked', repo: 'billing', back: 'feat/restacked-work' }
  cutStage({ ...opts, branch: 'feat/restacked-early', from: 'feat/restacked-work', message: 'the schema' })
  cutStage({ ...opts, branch: 'feat/restacked-late', from: 'feat/restacked-early', message: 'the endpoints' })

  const out = rig(['stage', '--work', 'restacked']).out
  assert.match(out, /1\. feat\/restacked-early/)
  assert.match(out, /2\. feat\/restacked-late/)
  assert.ok(out.indexOf('restacked-early') < out.indexOf('restacked-late'), 'the branches order them, not the array')
})

test('a stage cut outside the stack is not accused, because git is never asked a question that could say so', () => {
  // The limitation, pinned so it cannot be mistaken for an oversight. `worktrees.chain()`
  // picks a base out of a candidate set that is the work branch plus the declared stages, so
  // a git-derived base is **inside the stack by construction** — a stage cut from the base
  // branch reports `base: null`, which is the same answer as a stage whose neighbour below
  // landed and took its branch away. An unknown is not a fact, so nothing is said.
  assert.equal(rig(['new', 'adrift', '--title', 'Adrift work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'adrift']).code, 0)
  assert.equal(rig(['stage', 'feat/adrift-one', '--delivers', 'the schema', '--work', 'adrift']).code, 0)
  assert.equal(rig(['stage', 'feat/adrift-two', '--delivers', 'the endpoints', '--work', 'adrift']).code, 0)

  const dest = worktree('adrift', 'billing')
  commitWork(dest, 'the work branch has its own commit')
  const opts = { work: 'adrift', repo: 'billing', back: 'feat/adrift-work' }
  cutStage({ ...opts, branch: 'feat/adrift-one', from: 'feat/adrift-work', message: 'the schema' })
  cutStage({ ...opts, branch: 'feat/adrift-two', from: 'main', message: 'the endpoints' })

  const out = rig(['stage', '--work', 'adrift']).out
  assert.match(out, /1\. feat\/adrift-one/)
  assert.match(out, /2\. feat\/adrift-two/)
  assert.doesNotMatch(out, /Outside the stack/, 'git cannot tell this from an ordinary landed neighbour')
})

test('a stage whose pull request lands outside the stack is shown as such, not as if it were placed', () => {
  // The reachable contradiction, and the only one: a pull request names any branch it likes,
  // and `branchRows` prefers the live PR base. A stage merging into the base branch is not a
  // slice of this work's stack, so its position in the list is the order it was declared in.
  const state = github()
  state.repos['acme/billing'].prs.push(
    { branch: 'feat/adrift-two', number: 90, state: 'OPEN', url: 'https://github.com/acme/billing/pull/90', base: 'main', openedAt: '2026-09-19T00:00:00Z', mergedAt: null, commits: [] },
  )
  setGithub(state)

  const out = rig(['stage', '--work', 'adrift']).out
  const note = out.split('\n').find(l => l.includes('Outside the stack'))
  assert.ok(note, `no note in:\n${out}`)
  assert.match(note, /Outside the stack, so shown in declaration order: feat\/adrift-two$/)
  assert.doesNotMatch(note, /adrift-one/, 'the stage the branches do not contradict is not named')

  // And the deploy-order table says it too, since the reader of a PR body has even less to
  // go on than the reader of a terminal.
  assert.equal(rig(['plan', '--work', 'adrift']).code, 0)
  assert.match(fs.readFileSync(planFile('adrift'), 'utf8'), /_Outside the stack, so shown in declaration order: `feat\/adrift-two`\._/)
})

test('a stack under review, every pull request pointing at the work branch, is accused of nothing', () => {
  // The convention decision 75 relies on, and the state every sliced work is in from the
  // moment its slices are up for review: the live PR base wins over git, so every stage names
  // the work branch and the chain walk can only ever reach one of them. Nothing is wrong here,
  // and nothing may be said — this is the case the first cut of this feature fired on.
  assert.equal(rig(['new', 'instack', '--title', 'Instack work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'instack']).code, 0)
  for (const [n, what] of [['one', 'the schema'], ['two', 'the endpoints'], ['three', 'the UI']]) {
    assert.equal(rig(['stage', `feat/instack-${n}`, '--delivers', what, '--work', 'instack']).code, 0)
  }

  const opts = { work: 'instack', repo: 'billing', back: 'feat/instack-work' }
  cutStage({ ...opts, branch: 'feat/instack-one', from: 'feat/instack-work', message: 'the schema' })
  cutStage({ ...opts, branch: 'feat/instack-two', from: 'feat/instack-one', message: 'the endpoints' })
  cutStage({ ...opts, branch: 'feat/instack-three', from: 'feat/instack-two', message: 'the UI' })

  const state = github()
  state.repos['acme/billing'].prs.push(
    ...['one', 'two', 'three'].map((n, i) => ({
      branch: `feat/instack-${n}`, number: 92 + i, state: 'OPEN', url: `https://github.com/acme/billing/pull/${92 + i}`,
      base: 'feat/instack-work', openedAt: '2026-09-19T00:00:00Z', mergedAt: null, commits: [],
    })),
  )
  setGithub(state)

  const out = rig(['stage', '--work', 'instack']).out
  assert.doesNotMatch(out, /Outside the stack/, 'the convention is not a fault')
  assert.equal(rig(['plan', '--work', 'instack']).code, 0)
  assert.doesNotMatch(fs.readFileSync(planFile('instack'), 'utf8'), /Outside the stack/)
  assert.doesNotMatch(rig(['next', '--work', 'instack']).out, /outside the stack/)
})

test('and rig next, which claims a position too, says when the stage is outside the stack', () => {
  assert.equal(rig(['new', 'lone', '--title', 'Lone work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'lone']).code, 0)
  assert.equal(rig(['stage', 'feat/lone-one', '--delivers', 'the schema', '--work', 'lone']).code, 0)

  const dest = worktree('lone', 'billing')
  commitWork(dest, 'the work branch has its own commit')
  cutStage({ work: 'lone', repo: 'billing', branch: 'feat/lone-one', from: 'feat/lone-work', back: 'feat/lone-work', message: 'the schema' })

  const state = github()
  state.repos['acme/billing'].prs.push(
    { branch: 'feat/lone-one', number: 91, state: 'OPEN', url: 'https://github.com/acme/billing/pull/91', base: 'main', openedAt: '2026-09-19T00:00:00Z', mergedAt: null, commits: [] },
  )
  setGithub(state)

  const out = rig(['next', '--work', 'lone']).out
  assert.match(out, /stage 1 of 1: feat\/lone-one/)
  assert.match(out, /outside the stack/)
})

test('a closed pull request is not up for review', () => {
  // CLOSED is neither merged nor open, and reading "not merged" as "up for review" makes a
  // stage somebody gave up on look like one that is waiting for a reviewer.
  assert.equal(rig(['new', 'shelved', '--title', 'Shelved work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'shelved']).code, 0)
  assert.equal(rig(['stage', 'feat/shelved-one', '--delivers', 'the schema', '--work', 'shelved']).code, 0)
  cutStage({ work: 'shelved', repo: 'billing', branch: 'feat/shelved-one', from: 'feat/shelved-work', back: 'feat/shelved-work', message: 'the schema' })

  const state = github()
  state.repos['acme/billing'].prs.push(
    { branch: 'feat/shelved-one', number: 20, state: 'CLOSED', url: 'https://github.com/acme/billing/pull/20', base: 'feat/shelved-work', openedAt: '2026-09-19T00:00:00Z', mergedAt: null, commits: [] },
  )
  setGithub(state)

  assert.equal(rig(['plan', '--work', 'shelved']).code, 0)
  const text = fs.readFileSync(planFile('shelved'), 'utf8')
  assert.match(text, /\| `feat\/shelved-one` \|.*\| in progress \|/)
  assert.doesNotMatch(text, /up for review/)
})

test('a pull request lookup GitHub refused reads as unknown, never as no PR', () => {
  // `branchRows` has always computed the error and the stack has always dropped it, so a
  // rate-limited lookup rendered as a stage nobody has opened anything on. rig has a rule
  // for this everywhere else: a lookup that failed is unknown, and says so.
  assert.equal(rig(['new', 'refused', '--title', 'Refused work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'refused']).code, 0)
  assert.equal(rig(['stage', 'feat/refused-one', '--delivers', 'the schema', '--work', 'refused']).code, 0)
  cutStage({ work: 'refused', repo: 'billing', branch: 'feat/refused-one', from: 'feat/refused-work', back: 'feat/refused-work', message: 'the schema' })

  const state = github()
  setGithub({ ...state, auth: 'missing' })
  const out = rig(['stage', '--work', 'refused']).out
  const plan = rig(['plan', '--work', 'refused'])
  setGithub({ ...github(), auth: 'ok' })

  assert.match(out, /PR state unknown/)
  assert.equal(plan.code, 0, plan.out)
  assert.match(fs.readFileSync(planFile('refused'), 'utf8'), /\| `feat\/refused-one` \|.*\| PR state unknown \|/)
})

test('a stage whose line contains $& is rendered as written, not as a regex replacement', () => {
  // `String.replace` reads `$&` in the *replacement* as the whole match, so a refresh used to
  // paste the old region back into the new one and corrupt the document.
  assert.equal(rig(['new', 'dollar', '--title', 'Dollar work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'dollar']).code, 0)
  assert.equal(rig(['stage', 'feat/dollar-one', '--delivers', 'the $& path', '--work', 'dollar']).code, 0)
  assert.equal(rig(['plan', '--work', 'dollar']).code, 0)
  assert.equal(rig(['stage', 'feat/dollar-two', '--delivers', 'the rest', '--work', 'dollar']).code, 0)
  assert.equal(rig(['plan', '--work', 'dollar', '--refresh']).code, 0)

  const text = fs.readFileSync(planFile('dollar'), 'utf8')
  assert.match(text, /the \$& path/)
  assert.equal(text.match(/rig:deploy-order/g).length, 2, 'one region, not a region pasted inside itself')
})
