// Correcting what rig wrote into a work's record at one moment and a person later found wrong:
// the title (`rig save --title`) and the tickets (`rig ticket --replaces`, `--remove`).
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

const { dataRoot, workRoot, rig, gitMust, record, seedIssue, issueNumbered, cleanup } = billingInstall('rig-record-corrections-')

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

test('a title over two lines is refused, since it is a heading and a PR title', () => {
  const r = rig(['save', '--title', 'Line one\nLine two', '--work', 'retitled'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--title takes the title in one line/)
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

test('ticket --replaces puts the new key where the old one was, in the record and the Tickets: line', () => {
  assert.equal(rig(['new', 'moved', '--title', 'Moved issues', '--key', 'acme/billing#1,acme/billing#2']).code, 0)
  const r = rig(['ticket', 'acme/ledger#9', '--replaces', 'acme/billing#1', '--work', 'moved'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('moved').tickets, ['acme/ledger#9', 'acme/billing#2'])
  assert.match(doc('moved'), /^Tickets: acme\/ledger#9, acme\/billing#2 · Status: /m)
  assert.match(agents('moved'), /^Tickets: acme\/ledger#9, acme\/billing#2 · Status: /m)
})

test('ticket --replaces commits under a message naming both keys', () => {
  assert.equal(gitMust(dataRoot, 'log', '-1', '--format=%s'), 'rig ticket moved: acme/ledger#9 replaces acme/billing#1')
})

test('ticket --remove takes a key off the record and the Tickets: line', () => {
  const r = rig(['ticket', '--remove', 'acme/billing#2', '--work', 'moved'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('moved').tickets, ['acme/ledger#9'])
  assert.match(doc('moved'), /^Tickets: acme\/ledger#9 · Status: /m)
})

test('neither --replaces nor --remove tells the tracker anything', () => {
  seedIssue(3, 'moved to another repo')
  seedIssue(4, 'recorded by mistake')
  assert.equal(rig(['ticket', 'acme/billing#3', '--work', 'moved']).code, 0)
  assert.equal(rig(['ticket', 'acme/billing#4', '--work', 'moved']).code, 0)
  assert.equal(rig(['ticket', 'acme/ledger#3', '--replaces', 'acme/billing#3', '--work', 'moved']).code, 0)
  assert.equal(rig(['ticket', '--remove', 'acme/billing#4', '--work', 'moved']).code, 0)
  assert.deepEqual([3, 4].map(n => [issueNumbered(n).state, issueNumbered(n).comments]), [['OPEN', []], ['OPEN', []]])
  assert.equal(rig(['ticket', '--remove', 'acme/ledger#3', '--work', 'moved']).code, 0)
})

test("a stage's own key is replaced and removed the same way as the work's", () => {
  assert.equal(rig(['stage', 'feat/moved-one', '--delivers', 'the schema', '--key', 'acme/billing#4', '--work', 'moved']).code, 0)
  assert.equal(rig(['ticket', 'acme/ledger#10', '--replaces', 'acme/billing#4', '--work', 'moved']).code, 0)
  assert.deepEqual(record('moved').stages[0].tickets, ['acme/ledger#10'])
  assert.deepEqual(record('moved').tickets, ['acme/ledger#9'], "a stage's key is not moved onto the work")
  assert.equal(rig(['ticket', '--remove', 'acme/ledger#10', '--work', 'moved']).code, 0)
  assert.equal(record('moved').stages[0].tickets, undefined)
})

test('a key the record does not hold is refused, and what it does hold is named', () => {
  const r = rig(['ticket', '--remove', 'acme/billing#99', '--work', 'moved'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /acme\/billing#99 is not recorded on moved — it has acme\/ledger#9/)
})

test('a correction asked for badly is refused, and changes nothing', () => {
  const before = record('moved').tickets
  for (const [args, says] of [
    [['--remove'], /--remove needs the key/],
    [['acme/ledger#12', '--remove', 'acme/ledger#9'], /--remove takes the one key it removes, and nothing else/],
    [['acme/ledger#12', '--replaces'], /--replaces needs the key it replaces/],
    [['acme/ledger#9', '--replaces', 'acme/ledger#9'], /acme\/ledger#9 cannot replace itself/],
  ]) {
    const r = rig(['ticket', ...args, '--work', 'moved'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, says)
  }
  assert.deepEqual(record('moved').tickets, before)
})

test('replacing a key with one the record already holds leaves it there once', () => {
  assert.equal(rig(['ticket', 'acme/billing#5', '--work', 'moved']).code, 0)
  assert.equal(rig(['ticket', 'acme/ledger#9', '--replaces', 'acme/billing#5', '--work', 'moved']).code, 0)
  assert.deepEqual(record('moved').tickets, ['acme/ledger#9'])
})

test('a key held twice in one list is removed entirely', () => {
  assert.equal(rig(['new', 'twice', '--title', 'Twice', '--key', 'acme/billing#6,acme/billing#6']).code, 0)
  assert.equal(rig(['ticket', '--remove', 'acme/billing#6', '--work', 'twice']).code, 0)
  assert.deepEqual(record('twice').tickets, [])
})

test('removing the last ticket says the work has none now', () => {
  assert.match(rig(['ticket', 'acme/billing#7', '--work', 'twice']).out, /recorded/)
  const r = rig(['ticket', '--remove', 'acme/billing#7', '--work', 'twice'])
  assert.match(r.out, /twice has no ticket now/)
})
