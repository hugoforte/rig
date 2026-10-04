// The context doc checked against its template (hugoforte/rig#295): the headings `rig new`
// scaffolds are there, in order, and once the design gate has passed no placeholder of the
// template's is left. Reported, never refused: `rig save` prints it, `rig doctor` lists it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { SRC, strip } from './harness.mjs'
import { contextDocProblems } from '../bin/contextdoc.mjs'
import { billingInstall } from './billing-install.mjs'

const template = fs.readFileSync(path.join(SRC, 'templates', 'context.md'), 'utf8')
// What `rig new` writes: the template with its fields filled, and the brief's own placeholder.
const fresh = template
  .replace(/\{\{ID\}\}/g, 'w').replace(/\{\{TITLE\}\}/g, 'A work').replace(/\{\{KEYS\}\}/g, '_none_')
  .replace(/\{\{DATE\}\}/g, '2026-10-04').replace(/\{\{BRIEF\}\}/g, '_TODO: one line, then the narrative. State scope explicitly._')
const problems = (text, designed = false) => contextDocProblems(text, { template, designed })
const lineOf = (text, needle) => text.split('\n').findIndex(l => l.includes(needle)) + 1

test('a context doc made from the current template has nothing to report before the design gate', () => {
  assert.deepEqual(problems(fresh), [])
})

test('a heading the template scaffolds and the doc lost is reported, at the line it belongs', () => {
  const lost = fresh.replace('## Problem\n', '')
  assert.deepEqual(problems(lost), [{ line: lineOf(lost, '## Direction'), problem: 'no "## Problem" heading — every context doc keeps the four templates/context.md scaffolds' }])
})

test('a renamed heading is a lost one', () => {
  const renamed = fresh.replace('## Direction', '## Approach')
  assert.match(problems(renamed)[0].problem, /no "## Direction" heading/)
})

test('headings out of the template\'s order are reported', () => {
  const swapped = fresh.replace('## Problem', '## TEMP').replace('## Direction', '## Problem').replace('## TEMP', '## Direction')
  assert.deepEqual(problems(swapped), [{ line: lineOf(swapped, '## Problem'), problem: '"## Problem" comes after "## Direction" — the template has it before' }])
})

test('a section from context-sections.md is never required, and may sit anywhere', () => {
  const added = fresh.replace('## Direction', '## Key data points\n\n- a fact\n\n## Direction')
  assert.deepEqual(problems(added), [])
})

test('once the design gate has passed, each placeholder left is reported on its line', () => {
  const found = problems(fresh, true)
  assert.deepEqual(found.map(f => f.line), [
    lineOf(fresh, '| | | |'), lineOf(fresh, '_TODO: one line'), lineOf(fresh, '_TODO_'), lineOf(fresh, '_next step_'),
  ])
  assert.match(found[2].problem, /still the template's placeholder "_TODO_" — the design is agreed, so say what goes here or take it out/)
})

test('a placeholder inside a comment is the template\'s note, not a gap', () => {
  const commented = fresh.replace('## Direction', '## Direction\n\n<!-- _TODO_ is what the stub says -->')
  assert.ok(!problems(commented, true).some(f => f.line === lineOf(commented, '<!-- _TODO_')))
})

// ------------------------------------------------- rig save and rig doctor

const m = billingInstall('rig-contextdoc-')
after(m.cleanup)
const docOf = id => path.join(m.dataRoot, 'work', id, 'context.md')

test('rig save prints each problem as path:line: problem, and saves all the same', () => {
  assert.equal(m.rig(['new', 'shaped', '--title', 'A doc that lost a heading', '--no-ticket']).code, 0)
  const doc = docOf('shaped')
  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('## Problem\n', ''))
  const r = m.rig(['save', '-m', 'an edit', '--work', 'shaped'])
  assert.equal(r.code, 0, r.out)
  assert.ok(strip(r.out).includes(`${doc}:`), 'the path, as an editor opens it')
  assert.match(strip(r.out), /context\.md:\d+: no "## Problem" heading/)
  assert.equal(m.gitMust(m.dataRoot, 'log', '-1', '--format=%s'), 'rig save shaped: an edit')
})

test('the design gate makes a placeholder left in the doc a problem', () => {
  const r = m.rig(['save', '-m', 'design agreed', '--designed', '--no-adversarial', '--work', 'shaped'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /context\.md:\d+: still the template's placeholder "_TODO_"/)
})

test('rig doctor lists them under the work', () => {
  assert.match(strip(m.rig(['doctor']).out), /shaped: .*context\.md:\d+: no "## Problem" heading/)
})
