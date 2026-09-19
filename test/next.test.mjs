// What `rig next` offers, over fixtures. Pure decisions, so every rung of the ladder is one
// object literal away from being asserted — and the two guardrails are assertable too, which
// is the point of testing this at all: "only ever offers" is a property of the whole output,
// not of any one line.
import test from 'node:test'
import assert from 'node:assert/strict'

import { nextFor } from '../bin/next.mjs'

const AT = '2026-09-19T10:00:00.000Z'

const work = (over = {}) => ({ id: 'w', branch: 'feat/x', repos: [], ...over })
const repo = (name, over = {}) => ({ repo: name, merged: false, pr: null, dirty: 0, ahead: 0, pushed: false, missing: false, ...over })
const attached = (...names) => names.map(n => ({ repo: n }))
const says = out => out.map(o => o.says).join(' | ')
const commands = out => out.map(o => o.command).filter(Boolean)

test('a work with nothing attached is pointed at the repo interview', () => {
  const out = nextFor({ work: work() })
  assert.equal(out.length, 1)
  assert.equal(out[0].phase, 'planning')
  assert.equal(out[0].command, 'rig prompt select-repos')
})

test('the design gate is offered while it is unrecorded, and names the Direction when it is a stub', () => {
  const out = nextFor({ work: work({ repos: attached('a') }), repos: [repo('a')], directionTodo: true })
  assert.match(says(out), /Direction is still `_TODO_`/)
  assert.ok(commands(out).includes('rig save -m "design agreed" --designed'))
})

test('once the Direction is written the offer is only about the gate', () => {
  const out = nextFor({ work: work({ repos: attached('a') }), repos: [repo('a')], directionTodo: false })
  assert.match(says(out), /Direction is written but the design gate is not recorded/)
})

test('a recorded design gate stops being offered', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')] })
  assert.doesNotMatch(says(out), /design gate/)
})

test('uncommitted changes are named before anything that would build on them', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [repo('a', { dirty: 3 }), repo('b', { ahead: 1 })],
  })
  assert.match(out[0].says, /uncommitted changes in a/)
})

test('unpushed commits are offered a push, and not also a pull request', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { ahead: 2 })],
  })
  assert.match(says(out), /commits that are not pushed/)
  assert.doesNotMatch(says(out), /no PR open/, 'one branch state, one offer')
})

test('a pushed branch with no PR is offered one', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { pushed: true })],
  })
  assert.match(says(out), /a is pushed with no PR open/)
  assert.ok(commands(out).includes('rig pr'))
})

test('a branch nobody has written on is never nagged about opening a PR', () => {
  // `ahead` reads 0 both for a pushed branch and for one with nothing on it, which is why
  // this rung asks `pushed` instead. Getting it wrong here is a reproach, and this command
  // does not make them.
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')] })
  assert.doesNotMatch(says(out), /no PR open/)
  assert.match(says(out), /yours to write/)
})

test('a distance git could not measure is never read as nothing outstanding', () => {
  // `ahead: null` is what `worktrees.state()` answers when it could not measure at all, and
  // that is the *ordinary* state of a branch whose PR was squash-merged (decision 62). Read as
  // 0 it means "pushed, waiting for a PR", which is a confident answer to a question nobody
  // could answer.
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { ahead: null, pushed: true })],
  })
  assert.doesNotMatch(says(out), /no PR open/)
  assert.doesNotMatch(says(out), /not pushed/)
})

test('nor as work waiting to be written', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { ahead: null, pushed: false })],
  })
  assert.doesNotMatch(says(out), /yours to write/)
})

test('a measured zero still reads as zero, which is the distinction that was lost', () => {
  const pushed = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { ahead: 0, pushed: true })],
  })
  assert.match(says(pushed), /is pushed with no PR open/)
})

// ---------------------------------------------------------------- weight, derived

test('one repo is never offered a rollout plan', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')] })
  assert.doesNotMatch(says(out), /rollout plan/)
})

test('three repos are, because that is where deploy order starts causing incidents', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b', 'c'), designedAt: AT }),
    repos: [repo('a'), repo('b'), repo('c')],
  })
  assert.match(says(out), /3 repos means deploy order matters/)
  assert.ok(commands(out).includes('rig plan'))
})

test('and not twice — a plan that exists is not offered again', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b', 'c'), designedAt: AT }),
    repos: [repo('a'), repo('b'), repo('c')],
    planExists: true,
  })
  assert.doesNotMatch(says(out), /rollout plan/)
})

// ---------------------------------------------------------------- landing and after

test('a partly merged work says what is still out', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [repo('a', { merged: true, pr: { number: 1, state: 'MERGED' } }), repo('b', { ahead: 1 })],
  })
  assert.match(says(out), /1 of 2 merged — still out: b/)
})

test('everything merged and clean is offered the close', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { merged: true, pr: { number: 1, state: 'MERGED' } })],
  })
  assert.ok(commands(out).includes('rig close'))
})

test('everything merged but a dirty tree is not offered the close', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { merged: true, pr: { number: 1, state: 'MERGED' }, dirty: 1 })],
  })
  assert.ok(!commands(out).includes('rig close'))
  assert.match(says(out), /uncommitted changes/)
})

test('a stopped work has nothing to offer, and that is an answer', () => {
  assert.deepEqual(nextFor({ work: work({ repos: attached('a'), closedAt: AT }), repos: [repo('a')] }), [])
  assert.deepEqual(nextFor({ work: work({ repos: attached('a'), closedAt: AT, abandonedAt: AT }), repos: [repo('a')] }), [])
})

// ---------------------------------------------------------------- stages

const stage = (branch, over = {}) => ({ branch, delivers: '', repos: [], started: false, open: false, landed: false, prs: [], ...over })

test('a work with stages is told which one is next, and what it delivers', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a')],
    stack: [
      stage('feat/one', { landed: true, started: true, repos: ['a'] }),
      stage('feat/two', { delivers: 'the endpoints', started: true, repos: ['a'], open: true }),
    ],
  })
  assert.match(says(out), /stage 2 of 2: feat\/two — the endpoints \(a — up for review\)/)
})

test('a stage nobody has cut yet says so rather than claiming progress', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a')],
    stack: [stage('feat/one')],
  })
  assert.match(says(out), /stage 1 of 1: feat\/one \(not cut in any repo yet\)/)
})

test('every stage in makes the work branch the thing that is left', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { pushed: true })],
    stack: [stage('feat/one', { landed: true, started: true, repos: ['a'] })],
  })
  assert.match(says(out), /every stage is in — the work branch is what is left to land/)
})

test('a work with no stages behaves exactly as it did before stages existed', () => {
  const withNone = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')] })
  const withEmpty = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')], stack: [] })
  assert.deepEqual(withNone, withEmpty)
  assert.doesNotMatch(says(withNone), /stage/)
})

// ---------------------------------------------------------------- the guardrails

test('it only ever offers: nothing it says is a warning or a reproach', () => {
  // Every shape of work this module knows about, run through one assertion. The guardrail is
  // a property of the whole output, so this is the test that would catch it eroding.
  const shapes = [
    { work: work() },
    { work: work({ repos: attached('a') }), repos: [repo('a')], directionTodo: true },
    { work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a', { dirty: 2, ahead: 1 })] },
    { work: work({ repos: attached('a', 'b', 'c'), designedAt: AT }), repos: [repo('a'), repo('b'), repo('c')] },
    {
      work: work({ repos: attached('a'), designedAt: AT }),
      repos: [repo('a', { merged: true, pr: { number: 1, state: 'MERGED' } })],
    },
  ]
  for (const s of shapes) {
    for (const o of nextFor(s)) {
      assert.doesNotMatch(o.says, /should have|you failed|missing|must |required|error/i,
        `"${o.says}" reads as a reproach, and this command never reproaches`)
    }
  }
})

test('every offer names the phase it belongs to', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b', 'c'), designedAt: AT }),
    repos: [repo('a', { ahead: 1 }), repo('b'), repo('c')],
  })
  assert.ok(out.length > 0)
  for (const o of out) assert.match(o.phase, /^(planning|designing|building|reviewing|landing)$/)
})
