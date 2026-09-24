// The phase a work is in, and the contradictions a record can carry. Pure decisions over
// fixtures — no fs, no git, no gh — which is the whole point of `bin/phase.mjs` being its
// own module: every row of the table below is one object literal away from being asserted.
import test from 'node:test'
import assert from 'node:assert/strict'

import { PHASES, TERMINAL, GATES, phaseOf, phaseLabel, statusLine, contradictions, gatesOf } from '../bin/phase.mjs'

const AT = '2026-09-19T10:00:00.000Z'

// A work record, as thin as the phase needs it.
const work = (over = {}) => ({ id: 'w', branch: 'feat/x', repos: [], ...over })
const repo = (over = {}) => ({ repo: 'r', merged: false, pr: null, ...over })
const merged = n => repo({ merged: true, pr: { number: n, state: 'MERGED' } })
const open = n => repo({ pr: { number: n, state: 'OPEN' } })

test('the phases are ordered, and the terminal ones are not among them', () => {
  assert.deepEqual(PHASES, ['planning', 'designing', 'building', 'reviewing', 'landing'])
  assert.deepEqual(TERMINAL, ['closed', 'abandoned'])
  for (const t of TERMINAL) assert.ok(!PHASES.includes(t))
})

test('active phases are present participles and terminal ones past', () => {
  for (const p of PHASES) assert.match(p, /ing$/)
  for (const t of TERMINAL) assert.match(t, /ed$/)
})

test('every gate names the field it is stored in', () => {
  assert.deepEqual(GATES, { designed: 'designedAt', learned: 'learnedAt', abandoned: 'abandonedAt', closed: 'closedAt' })
})

// ---------------------------------------------------------------- deriving the phase

test('a work with no repos attached is planning', () => {
  assert.equal(phaseOf(work(), []), 'planning')
})

test('repos attached but no design gate is designing', () => {
  assert.equal(phaseOf(work({ repos: [{ repo: 'r' }] }), [repo()]), 'designing')
})

test('the design gate passed, with no PR anywhere, is building', () => {
  assert.equal(phaseOf(work({ repos: [{ repo: 'r' }], designedAt: AT }), [repo()]), 'building')
})

test('an open PR is reviewing', () => {
  assert.equal(phaseOf(work({ repos: [{ repo: 'r' }], designedAt: AT }), [open(1)]), 'reviewing')
})

test('every repo merged is landing', () => {
  assert.equal(phaseOf(work({ repos: [{ repo: 'a' }, { repo: 'b' }], designedAt: AT }), [merged(1), merged(2)]), 'landing')
})

test('one merged and one still open is reviewing, not landing', () => {
  assert.equal(phaseOf(work({ repos: [{ repo: 'a' }, { repo: 'b' }], designedAt: AT }), [merged(1), open(2)]), 'reviewing')
})

test('one merged and one with no PR at all is reviewing', () => {
  assert.equal(phaseOf(work({ repos: [{ repo: 'a' }, { repo: 'b' }], designedAt: AT }), [merged(1), repo()]), 'reviewing')
})

test('closedAt wins over everything the repos say', () => {
  assert.equal(phaseOf(work({ repos: [{ repo: 'r' }], designedAt: AT, closedAt: AT }), [open(1)]), 'closed')
})

test('abandonedAt wins over closedAt, which an abandoned work also carries', () => {
  // Both are true and they are different facts: `closedAt` is when the teardown ran,
  // `abandonedAt` is the decision that it ended unfinished. The more specific one wins.
  assert.equal(phaseOf(work({ closedAt: AT, abandonedAt: AT }), []), 'abandoned')
})

test('a PR reached before the design gate still reads as reviewing', () => {
  // The gate is a decision someone records, and forgetting to is an omission `rig next`
  // raises — not a reason to report a work under review as still being designed.
  assert.equal(phaseOf(work({ repos: [{ repo: 'r' }] }), [open(1)]), 'reviewing')
})

test('the design gate outranks an empty repo list', () => {
  // A work whose design is agreed with nothing attached yet is an ordinary record — a sweep
  // across repos not yet chosen starts exactly here. Calling it `planning` would have the
  // derived phase deny a gate that was recorded.
  assert.equal(phaseOf(work({ designedAt: AT }), []), 'building')
  assert.equal(statusLine(work({ designedAt: AT }), []), 'Building (design agreed 2026-09-19)')
})

test('the phase is derived without repo facts when the gates already settle it', () => {
  assert.equal(phaseOf(work({ abandonedAt: AT })), 'abandoned')
  assert.equal(phaseOf(work({ closedAt: AT })), 'closed')
  assert.equal(phaseOf(work()), 'planning')
})

// ---------------------------------------------------------------- what is shown

test('the label is the phase capitalised', () => {
  assert.equal(phaseLabel('building'), 'Building')
  assert.equal(phaseLabel('abandoned'), 'Abandoned')
})

test('the status line carries the phase and the design gate once it is passed', () => {
  assert.equal(statusLine(work({ repos: [{ repo: 'r' }], designedAt: AT }), [repo()]),
    'Building (design agreed 2026-09-19)')
})

test('the status line is the phase alone before the design gate', () => {
  assert.equal(statusLine(work({ repos: [{ repo: 'r' }] }), [repo()]), 'Designing')
})

test('an abandoned work says so and keeps its design gate', () => {
  assert.equal(statusLine(work({ designedAt: AT, abandonedAt: AT, closedAt: AT }), []),
    'Abandoned (design agreed 2026-09-19)')
})

test('the gates passed are listed with their dates, in lifecycle order', () => {
  assert.deepEqual(gatesOf(work({ designedAt: AT, learnedAt: AT, abandonedAt: AT, closedAt: AT })), [
    { gate: 'designed', at: AT },
    { gate: 'learned', at: AT },
    { gate: 'abandoned', at: AT },
    { gate: 'closed', at: AT },
  ])
  assert.deepEqual(gatesOf(work()), [])
})

// ---------------------------------------------------------------- contradictions

test('a clean record contradicts nothing', () => {
  assert.deepEqual(contradictions(work({ repos: [{ repo: 'r' }], designedAt: AT }), [open(1)]), [])
})

test('closed with an open PR is a contradiction', () => {
  const found = contradictions(work({ repos: [{ repo: 'r' }], closedAt: AT }), [open(7)])
  assert.equal(found.length, 1)
  assert.match(found[0], /closed.*PR #7/)
})

test('a forced close is explained, not impossible', () => {
  // `rig close --force` exists to tear down past an open PR, and it records that it did.
  // Without the record the state is indistinguishable from a rig bug, which is what this rule
  // used to call it.
  assert.deepEqual(contradictions(work({ repos: [{ repo: 'r' }], closedAt: AT, forcedAt: AT }), [open(7)]), [])
})

test('a work both closed and abandoned contradicts nothing', () => {
  assert.deepEqual(contradictions(work({ closedAt: AT, abandonedAt: AT }), []), [])
})

test('abandoned with no teardown behind it is a contradiction', () => {
  const found = contradictions(work({ abandonedAt: AT }), [])
  assert.equal(found.length, 1)
  assert.match(found[0], /closedAt/)
})

test('an abandoned work leaving a PR open contradicts nothing', () => {
  // `close --abandoned` promises to leave them alone, so finding one is the promise kept.
  assert.deepEqual(contradictions(work({ repos: [{ repo: 'r' }], closedAt: AT, abandonedAt: AT }), [open(9)]), [])
})

test('a design gate dated after the close is a contradiction', () => {
  const found = contradictions(work({ designedAt: '2026-09-20T00:00:00.000Z', closedAt: AT }), [])
  assert.equal(found.length, 1)
  assert.match(found[0], /design gate/)
})

test('an unparseable gate date is a contradiction', () => {
  const found = contradictions(work({ designedAt: 'last tuesday' }), [])
  assert.equal(found.length, 1)
  assert.match(found[0], /designedAt/)
})

test('omissions are not contradictions', () => {
  // A work under review with no design gate recorded is the commonest record there is.
  // `rig next` offers the gate; `doctor` says nothing, or nobody reads `doctor`.
  assert.deepEqual(contradictions(work({ repos: [{ repo: 'r' }] }), [open(1)]), [])
})
