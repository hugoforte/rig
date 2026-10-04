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

test('a note needs its why', () => {
  const r = m.rig(['note', 'No reason', '--evidence', 'abc1234', '--work', 'noted'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /a note needs --why/)
})

test('status names the notes', () => {
  assert.match(strip(m.rig(['status', '--work', 'noted']).out), /^notes .*notes\.tsv/m)
})
