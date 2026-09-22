// The rollout plan, made live: part generated and part prose, and the split is the point.
//
// Between the `rig:deploy-order` markers is rig's, rewritten whole from the stack. Everything
// around it is the reader's, and a refresh never touches it. `rig next` compares the two,
// which is what stops the table going stale — the standard this artifact had failed for its
// entire existence.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { billingInstall, slicedWork } from './billing-install.mjs'

const m = billingInstall('rig-plan-')
const { rig, planFile, cleanup } = m

after(cleanup)

// The two-stage work this file renders: the first slice landed, the second is up for review.
slicedWork(m)

test('plan scaffolds with the deploy order already rendered from the stack', () => {
  const r = rig(['plan', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  const text = fs.readFileSync(planFile('sliced'), 'utf8')
  assert.match(text, /rig:deploy-order/)
  assert.match(text, /\| 1 \| `feat\/sliced-one` \| the schema \|/)
  assert.match(text, /\| 2 \| `feat\/sliced-two` \| the endpoints \|/)
  assert.doesNotMatch(text, /\{\{DEPLOY_ORDER\}\}/, 'the placeholder was filled, not left in')
})

test('the prose around it is still the template prose, which is the part that earns the file', () => {
  const text = fs.readFileSync(planFile('sliced'), 'utf8')
  for (const heading of ['Why deploy order is mandatory', 'The rejection window', 'Configuration prerequisites', 'Rollback']) {
    assert.ok(text.includes(heading), `${heading} survived`)
  }
})

test('refresh is a no-op while the document already agrees with the stack', () => {
  const r = rig(['plan', '--work', 'sliced', '--refresh'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /already up to date/)
})

test('a stage declared after the plan was written makes it stale, and rig next says so', () => {
  assert.equal(rig(['stage', 'feat/sliced-three', '--delivers', 'the UI', '--work', 'sliced']).code, 0)
  const out = rig(['next', '--work', 'sliced']).out
  assert.match(out, /no longer matches the stack/, 'something reads the artifact back — the test the epic uses')
  assert.match(out, /rig plan --refresh/)
})

test('and refreshing brings it back, rewriting only the generated region', () => {
  const before = fs.readFileSync(planFile('sliced'), 'utf8')
  // A hand edit in the prose half, to prove the refresh does not touch it.
  fs.writeFileSync(planFile('sliced'), before.replace('## Rollback', '## Rollback\n\nRevert the migration; it is additive.'))

  const r = rig(['plan', '--work', 'sliced', '--refresh'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /refreshed the deploy order/)

  const after = fs.readFileSync(planFile('sliced'), 'utf8')
  assert.match(after, /feat\/sliced-three/, 'the new stage reached the table')
  assert.match(after, /Revert the migration; it is additive\./, 'the hand-written prose is untouched')
  assert.doesNotMatch(rig(['next', '--work', 'sliced']).out, /no longer matches the stack/)
})

test('a plan whose markers were removed is refused, not silently appended to', () => {
  const text = fs.readFileSync(planFile('sliced'), 'utf8')
  fs.writeFileSync(planFile('sliced'), text.replace(/<!-- \/?rig:deploy-order.*?-->/g, ''))
  const r = rig(['plan', '--work', 'sliced', '--refresh'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no `rig:deploy-order` region/)
})

test('refresh on a work with no plan says to write one first', () => {
  assert.equal(rig(['new', 'unplanned', '--title', 'Unplanned work', '--type', 'feat', '--no-ticket']).code, 0)
  const r = rig(['plan', '--work', 'unplanned', '--refresh'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /does not exist/)
})
