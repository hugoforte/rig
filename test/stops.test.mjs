// Choosing which gates a work stops at: `rig new --stops`, `rig save --stops`, and the gates an
// agent decided on its own (`--by-agent`), as the record, `rig status` and `rig list --json`
// carry them.
//
// The tests share one installation and run in order; each names the work it starts from.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { strip } from './harness.mjs'
import { billingInstall } from './billing-install.mjs'

const { rig, record, cleanup } = billingInstall('rig-stops-')

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
