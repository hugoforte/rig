// A work's notes (hugoforte/rig#294): one row per decision a session took along the way, with
// why and a pointer at the evidence, appended by `rig note` and never read to be written.
//
// The tests share one installation and run in order.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { strip } from './harness.mjs'
import { billingInstall } from './billing-install.mjs'

const m = billingInstall('rig-notes-')
after(m.cleanup)

const notesFile = path.join(m.dataRoot, 'work', 'noted', 'notes.tsv')
const rows = () => fs.readFileSync(notesFile, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'))

test('rig note appends one row: when, the stage, the note, why, the evidence and the result', () => {
  assert.equal(m.rig(['new', 'noted', '--title', 'A work with notes', '--no-ticket']).code, 0)
  const r = m.rig(['note', 'Dropped the cache layer', '--why', 'it hid a stale read', '--evidence', 'abc1234,bin/cache.mjs:40', '--stage', 'feat/x-reads', '--result', 'reverted', '--work', 'noted'])
  assert.equal(r.code, 0, r.out)
  const [, row] = rows()
  assert.ok(!Number.isNaN(Date.parse(row[0])), 'a time')
  assert.deepEqual(row.slice(1), ['feat/x-reads', 'Dropped the cache layer', 'it hid a stale read', 'abc1234,bin/cache.mjs:40', 'reverted'])
})

test('the file opens with its header, written once', () => {
  assert.deepEqual(rows()[0], ['at', 'stage', 'note', 'why', 'evidence', 'result'])
})

test('a note is committed into the data root', () => {
  assert.equal(m.gitMust(m.dataRoot, 'log', '-1', '--format=%s'), 'rig note noted: Dropped the cache layer')
})

test('a second note goes below the first and leaves it as it was', () => {
  const before = fs.readFileSync(notesFile, 'utf8')
  assert.equal(m.rig(['note', 'Kept the retry', '--why', 'the flake is upstream', '--evidence', 'https://github.com/acme/billing/pull/5', '--work', 'noted']).code, 0)
  const after = fs.readFileSync(notesFile, 'utf8')
  assert.ok(after.startsWith(before), 'append-only')
  assert.deepEqual(rows()[2].slice(1), ['', 'Kept the retry', 'the flake is upstream', 'https://github.com/acme/billing/pull/5', ''])
})

test('a note with no evidence is refused, and nothing is written', () => {
  const before = fs.readFileSync(notesFile, 'utf8')
  const r = m.rig(['note', 'Trust me', '--why', 'it is fine', '--work', 'noted'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /a note needs --evidence: a pointer a reviewer can open/)
  assert.equal(fs.readFileSync(notesFile, 'utf8'), before)
})

test('evidence that is prose rather than a pointer is refused', () => {
  const r = m.rig(['note', 'Checked it', '--why', 'to be sure', '--evidence', 'I ran the tests and they passed', '--work', 'noted'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /--evidence is a pointer — a SHA, a PR, file:line, a path or a URL, several split by commas — not prose/)
})

test('a note, a why or a result over more than one line, or with a tab, is refused', () => {
  for (const [flag, value] of [['--why', 'one\ntwo'], ['--result', 'a\tb']]) {
    const r = m.rig(['note', 'Split', flag, value, '--evidence', 'abc1234', ...(flag === '--why' ? [] : ['--why', 'w']), '--work', 'noted'])
    assert.equal(r.code, 1, `${flag}: ${r.out}`)
    assert.match(strip(r.out), /takes one line, with no tab — a note is one row/)
  }
})

test('a note over more than one line is refused, like its cells', () => {
  const r = m.rig(['note', 'one\ntwo', '--why', 'w', '--evidence', 'abc1234', '--work', 'noted'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /the note takes one line, with no tab/)
})

test('a word that is not a pointer is refused as evidence, though it has no space', () => {
  const r = m.rig(['note', 'Checked it', '--why', 'to be sure', '--evidence', 'done', '--work', 'noted'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /--evidence is a pointer/)
})

test('a trailing comma in the evidence is no empty pointer', () => {
  const r = m.rig(['note', 'Listed', '--why', 'tidy', '--evidence', 'abc1234,', '--work', 'noted'])
  assert.equal(r.code, 0, r.out)
  assert.equal(rows().at(-1)[4], 'abc1234')
})

test('-- lets a note begin with a dash', () => {
  const r = m.rig(['note', '--why', 'it was the wrong call', '--evidence', 'abc1234', '--work', 'noted', '--', '--force was the wrong call'])
  assert.equal(r.code, 0, r.out)
  assert.equal(rows().at(-1)[2], '--force was the wrong call')
})

test('a row is never glued to a last line left without its newline', () => {
  fs.writeFileSync(notesFile, fs.readFileSync(notesFile, 'utf8').replace(/\n$/, ''))
  assert.equal(m.rig(['note', 'After a hand edit', '--why', 'w', '--evidence', 'abc1234', '--work', 'noted']).code, 0)
  assert.ok(rows().every(r => r.length === 6), 'every row is six cells')
  assert.equal(rows().at(-1)[2], 'After a hand edit')
})

test('a notes file found empty is given its header first', () => {
  assert.equal(m.rig(['new', 'emptied', '--title', 'An emptied notes file', '--no-ticket']).code, 0)
  const file = path.join(m.dataRoot, 'work', 'emptied', 'notes.tsv')
  fs.writeFileSync(file, '')
  assert.equal(m.rig(['note', 'First', '--why', 'w', '--evidence', 'abc1234', '--work', 'emptied']).code, 0)
  assert.equal(fs.readFileSync(file, 'utf8').split('\n')[0], 'at\tstage\tnote\twhy\tevidence\tresult')
})

test('two machines\' appends merge as both rows, since the notes merge as a union', () => {
  assert.equal(fs.readFileSync(path.join(m.dataRoot, 'work', 'noted', '.gitattributes'), 'utf8'), 'notes.tsv merge=union\n')
})

test('a stage the work does not declare, or a work already closed, is said and noted all the same', () => {
  assert.equal(m.rig(['stage', 'feat/noted-one', '--delivers', 'a slice', '--work', 'noted']).code, 0)
  let r = m.rig(['note', 'On a typo', '--why', 'w', '--evidence', 'abc1234', '--stage', 'feat/noted-on', '--work', 'noted'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /feat\/noted-on is not one of noted's stages/)
  assert.equal(m.rig(['close', '--abandoned', '--work', 'emptied']).code, 0)
  r = m.rig(['note', 'Late', '--why', 'w', '--evidence', 'abc1234', '--work', 'emptied'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /emptied is abandoned — this note comes after its story/)
})

test('a long note is cut to one line in the commit subject', () => {
  const long = 'x'.repeat(100)
  assert.equal(m.rig(['note', long, '--why', 'w', '--evidence', 'abc1234', '--work', 'noted']).code, 0)
  assert.equal(m.gitMust(m.dataRoot, 'log', '-1', '--format=%s'), `rig note noted: ${'x'.repeat(71)}…`)
})

test('a note needs its why', () => {
  const r = m.rig(['note', 'No reason', '--evidence', 'abc1234', '--work', 'noted'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /a note needs --why/)
})

test('status names the notes', () => {
  assert.match(strip(m.rig(['status', '--work', 'noted']).out), /^notes .*notes\.tsv/m)
})
