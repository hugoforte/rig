// Correcting what rig wrote into a work's record at one moment and a person later found wrong:
// the title, with `rig save --title`.
//
// A correction rewrites the record and the views of it — the context doc, the generated
// AGENTS.md — and never what the record's other facts hang off: the id and the branch.
//
// The tests share one installation and run in order; each names the work it starts from.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { billingInstall } from './billing-install.mjs'

const { dataRoot, workRoot, rig, gitMust, record, cleanup } = billingInstall('rig-record-corrections-')

after(cleanup)

const doc = id => fs.readFileSync(path.join(dataRoot, 'work', id, 'context.md'), 'utf8')
const agents = id => fs.readFileSync(path.join(workRoot, id, 'AGENTS.md'), 'utf8')

test('save --title corrects the title in the record, the context doc heading and the generated AGENTS.md', () => {
  assert.equal(rig(['new', 'retitled', '--title', 'The suite costs 185 seconds', '--no-ticket']).code, 0)
  const r = rig(['save', '--title', 'The suite is slow on Windows', '--work', 'retitled'])
  assert.equal(r.code, 0, r.out)
  assert.equal(record('retitled').title, 'The suite is slow on Windows')
  assert.match(doc('retitled'), /^# retitled — The suite is slow on Windows$/m)
  assert.match(agents('retitled'), /^# retitled — The suite is slow on Windows$/m)
})

test('save --title never renames the branch', () => {
  assert.equal(record('retitled').branch, 'feat/the-suite-costs-185-seconds')
})

test('save --title commits under a message that says what changed', () => {
  assert.equal(gitMust(dataRoot, 'log', '-1', '--format=%s'), 'rig save retitled: title "The suite is slow on Windows"')
})

test('save --title leaves the rest of the context doc as it was', () => {
  const before = doc('retitled')
  assert.equal(rig(['save', '--title', 'Slow on Windows', '--work', 'retitled']).code, 0)
  assert.equal(doc('retitled'), before.replace('# retitled — The suite is slow on Windows', '# retitled — Slow on Windows'))
})

test('save --title with no title is refused and changes nothing', () => {
  const r = rig(['save', '--title', '--work', 'retitled'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--title needs the title/)
  assert.equal(record('retitled').title, 'Slow on Windows')
})

test('a heading edited by hand is left alone by a save that does not ask for a title', () => {
  const file = path.join(dataRoot, 'work', 'retitled', 'context.md')
  fs.writeFileSync(file, doc('retitled').replace('# retitled — Slow on Windows', '# retitled — Slow on Windows (by hand)'))
  assert.equal(rig(['save', '-m', 'an edit', '--work', 'retitled']).code, 0)
  assert.match(doc('retitled'), /^# retitled — Slow on Windows \(by hand\)$/m)
})

test('a doc with no heading keeps what it has, and the save says so', () => {
  const file = path.join(dataRoot, 'work', 'retitled', 'context.md')
  fs.writeFileSync(file, doc('retitled').replace(/^# retitled — .*$/m, '# Something else'))
  const r = rig(['save', '--title', 'Slow', '--work', 'retitled'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /has no `# retitled — …` heading/)
  assert.equal(record('retitled').title, 'Slow')
  assert.match(doc('retitled'), /^# Something else$/m)
})

test('a gate refused alongside --title leaves the doc as untouched as the record', () => {
  assert.equal(rig(['new', 'stopped', '--title', 'Before', '--no-ticket']).code, 0)
  assert.equal(rig(['close', '--abandoned', '--work', 'stopped']).code, 0)
  const r = rig(['save', '--title', 'After', '--learned', '--work', 'stopped'])
  assert.equal(r.code, 1, r.out)
  assert.equal(record('stopped').title, 'Before')
  assert.match(doc('stopped'), /^# stopped — Before$/m)
})
