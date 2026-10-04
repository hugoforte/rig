// Choosing which gates a work stops at: `rig new --stops`, `rig save --stops`, and the gates an
// agent decided on its own (`--by-agent`), as the record, `rig status` and `rig list --json`
// carry them.
//
// The tests share one installation and run in order; each names the work it starts from.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { strip } from './harness.mjs'
import { billingInstall } from './billing-install.mjs'

const { dataRoot, rig, record, cleanup } = billingInstall('rig-stops-')

after(cleanup)

test('rig new --stops records the gates that wait for the human', () => {
  const r = rig(['new', 'stops-design', '--title', 'Stops at the design only', '--no-ticket', '--stops', 'design'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('stops-design').stops, ['design'])
})

test('a gate that cannot stop being a stop is refused, and no work is made', () => {
  const r = rig(['new', 'stops-ticket', '--title', 'Skips the ticket', '--no-ticket', '--stops', 'ticket'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /--stops: ticket cannot stop being a stop — only repos and design/)
  assert.throws(() => record('stops-ticket'))
})

test('rig save --stops changes the choice later, and none waits at neither', () => {
  const r = rig(['save', '--stops', 'none', '--work', 'stops-design'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('stops-design').stops, [])
})

test('a design gate the agent decided is recorded as the agent\'s', () => {
  const r = rig(['save', '-m', 'design agreed', '--designed', '--adversarial', '--by-agent', '--work', 'stops-design'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('stops-design').agentDecided, ['design'])
})

test('status marks the gate the agent decided, and says where the work stops', () => {
  const out = strip(rig(['status', '--work', 'stops-design']).out)
  assert.match(out, /^ {2}designed \d{4}-\d{2}-\d{2} \(agent decided\)$/m)
  assert.match(out, /^stops none — the agent decides the repo set and the design$/m)
})

test('list --json carries the stops and the gates the agent decided', () => {
  const { works } = JSON.parse(rig(['list', '--json', '--quick']).stdout)
  const w = works.find(x => x.id === 'stops-design')
  assert.deepEqual({ stops: w.stops, agentDecided: w.agentDecided }, { stops: [], agentDecided: ['design'] })
})

test('--by-agent says who decided a gate, so it is refused without one', () => {
  const r = rig(['save', '-m', 'an edit', '--by-agent', '--work', 'stops-design'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /--by-agent says the agent decided a gate — pass it with --designed/)
})

test('the human agreeing the design again clears what the agent decided', () => {
  const r = rig(['save', '-m', 'design reviewed', '--designed', '--adversarial', '--work', 'stops-design'])
  assert.equal(r.code, 0, r.out)
  assert.equal(record('stops-design').agentDecided, undefined)
})

test('a repo set the agent chose at rig new is recorded as the agent\'s', () => {
  const r = rig(['new', 'stops-repos', '--title', 'The agent picks the repos', '--no-ticket', '--stops', 'design', '--repos', 'billing', '--by-agent'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('stops-repos').agentDecided, ['repos'])
})

test('status says the agent chose the repo set', () => {
  assert.match(strip(rig(['status', '--work', 'stops-repos']).out), /^ {2}repos chosen \(agent decided\)$/m)
})

test('a repo the agent attached later marks the repo set the agent\'s', () => {
  assert.equal(rig(['new', 'stops-attach', '--title', 'The agent attaches', '--no-ticket']).code, 0)
  const r = rig(['attach', 'billing', '--by-agent', '--work', 'stops-attach'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('stops-attach').agentDecided, ['repos'])
})

test('the human agreeing the design clears the repo set the agent chose with it', () => {
  assert.equal(rig(['save', '-m', 'design agreed', '--designed', '--no-adversarial', '--work', 'stops-repos']).code, 0)
  assert.equal(record('stops-repos').agentDecided, undefined)
})

// ------------------------------------------------- after the adversarial review

test('a work made without --stops records none, and list --json says both stops and no marks', () => {
  assert.equal(rig(['new', 'stops-default', '--title', 'Waits at both', '--no-ticket']).code, 0)
  assert.equal(record('stops-default').stops, undefined)
  const { works } = JSON.parse(rig(['list', '--json', '--quick']).stdout)
  const w = works.find(x => x.id === 'stops-default')
  assert.deepEqual({ stops: w.stops, agentDecided: w.agentDecided }, { stops: null, agentDecided: [] })
})

test('status names the stops of a work that never chose, since absent is both', () => {
  assert.match(strip(rig(['status', '--work', 'stops-default']).out), /^stops repos and design$/m)
})

test('--by-agent takes no value, since the flag is the answer', () => {
  const r = rig(['new', 'stops-valued', '--title', 'Valued', '--no-ticket', '--repos', 'billing', '--by-agent=false'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /--by-agent takes no value — the flag is the answer/)
})

test('rig new --by-agent without --repos is refused: there is no repo set to have chosen', () => {
  const r = rig(['new', 'stops-norepos', '--title', 'No repos', '--no-ticket', '--by-agent'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /--by-agent says the agent chose the repo set — pass it with --repos/)
})

test('--stops with no gate in it is refused, rather than read as none', () => {
  for (const v of [',', ' , ', '']) {
    const r = rig(['save', '--stops', v, '--work', 'stops-default'])
    assert.equal(r.code, 1, `${JSON.stringify(v)}: ${r.out}`)
    assert.match(strip(r.out), /--stops wants the gates to wait at/)
  }
  assert.equal(record('stops-default').stops, undefined)
})

test('none stands alone', () => {
  const r = rig(['save', '--stops', 'none,design', '--work', 'stops-default'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /--stops: none stands alone/)
})

test('a stop is for a work still moving, so a stopped one refuses the change', () => {
  assert.equal(rig(['new', 'stops-stopped', '--title', 'Stopped', '--no-ticket']).code, 0)
  assert.equal(rig(['close', '--abandoned', '--work', 'stops-stopped']).code, 0)
  const r = rig(['save', '--stops', 'none', '--work', 'stops-stopped'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /stops-stopped was abandoned — it has no stops left to wait at/)
})

test('nothing refuses an agent deciding a gate the work stops at: stops are kept by the prompts', () => {
  assert.equal(rig(['new', 'stops-kept', '--title', 'Kept by prompts', '--no-ticket', '--stops', 'repos,design']).code, 0)
  const r = rig(['attach', 'billing', '--by-agent', '--work', 'stops-kept'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('stops-kept').agentDecided, ['repos'])
})

test('the human confirming what the agent decided keeps the design\'s date, so a review of it still stands', () => {
  assert.equal(rig(['save', '-m', 'design agreed', '--designed', '--adversarial', '--by-agent', '--work', 'stops-kept']).code, 0)
  const designedAt = record('stops-kept').designedAt
  assert.equal(rig(['save', '-m', 'adversarial review', '--reviewed', '--work', 'stops-kept']).code, 0)
  const r = rig(['save', '-m', 'design reviewed', '--designed', '--adversarial', '--work', 'stops-kept'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual({ designedAt: record('stops-kept').designedAt, agentDecided: record('stops-kept').agentDecided }, { designedAt, agentDecided: undefined })
})

test('a confirmation that changes the review choice is a design agreed again', () => {
  assert.equal(rig(['save', '-m', 'design agreed', '--designed', '--adversarial', '--by-agent', '--work', 'stops-kept']).code, 0)
  const designedAt = record('stops-kept').designedAt
  assert.equal(rig(['save', '-m', 'design reviewed', '--designed', '--no-adversarial', '--work', 'stops-kept']).code, 0)
  assert.notEqual(record('stops-kept').designedAt, designedAt)
})

test('a null written by hand is read as absent, the shape list --json gives it', () => {
  const file = path.join(dataRoot, 'work', 'stops-default', 'work.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), stops: null, agentDecided: null }, null, 2))
  const r = rig(['status', '--work', 'stops-default'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /^stops repos and design$/m)
})
