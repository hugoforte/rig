// A retro's struggles (hugoforte/rig#322): one row per thing that kept going wrong in a session,
// appended by `rig struggle` — a work's beside its context doc, a period's in the user's own data
// root — with the quote redacted before it is written. The secrets here are synthetic.
//
// The tests share one installation and run in order.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { billingInstall } from './billing-install.mjs'

const m = billingInstall('rig-struggles-')
after(m.cleanup)

const machine = os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
const workFile = path.join(m.dataRoot, 'work', 'struggled', 'struggles.tsv')
const rows = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'))
const struggle = (...args) => m.rig(['struggle', ...args])
const ROW = ['Wrote files through Bash heredocs', '--kind', 'repeat', '--session', 's-1', '--host', 'claude-code', '--fix', 'check']

test('rig struggle appends one row: when, the machine, the host, the session, the kind, the struggle, the quote and the fix', () => {
  assert.equal(m.rig(['new', 'struggled', '--title', 'A work that struggled', '--no-ticket']).code, 0)
  const r = struggle(...ROW, '--quote', 'no, use the Edit tool', '--work', 'struggled')
  assert.equal(r.code, 0, r.out)
  const [header, row] = rows(workFile)
  assert.deepEqual(header, ['at', 'machine', 'host', 'session', 'kind', 'struggle', 'quote', 'fix'])
  assert.deepEqual(row.slice(1), [machine, 'claude-code', 's-1', 'repeat', 'Wrote files through Bash heredocs', 'no, use the Edit tool', 'check'])
})

test('a struggle is committed into the data root', () => {
  assert.equal(m.gitMust(m.dataRoot, 'log', '-1', '--format=%s'), 'rig struggle struggled: Wrote files through Bash heredocs')
})

test('status names the work\'s struggles', () => {
  assert.match(m.rig(['status', '--work', 'struggled']).out, /struggles .*struggles\.tsv/)
})

test('the quote is redacted before it is written, and so is the struggle', () => {
  assert.equal(struggle('Pasted the key sk-abcdefghijklmnopqrstuvwx into chat', '--kind', 'correction', '--session', 's-2', '--host', 'claude-code', '--quote', 'password: hunter2hunter2', '--work', 'struggled').code, 0)
  const row = rows(workFile).at(-1)
  assert.deepEqual([row[5], row[6]], ['Pasted the key [redacted] into chat', 'password: [redacted]'])
})

test('a session read with nothing found is a none row, with no struggle', () => {
  assert.equal(struggle('--kind', 'none', '--session', 's-3', '--host', 'claude-code', '--work', 'struggled').code, 0)
  assert.deepEqual(rows(workFile).at(-1).slice(3, 6), ['s-3', 'none', ''])
})

test('a row that would not be one row, or names no session, kind or reader, is refused', () => {
  const refused = [
    [['Two\nlines', '--kind', 'repeat', '--session', 's', '--host', 'claude-code'], /one line, with no tab/],
    [['A struggle', '--kind', 'grumble', '--session', 's', '--host', 'claude-code'], /--kind is one of correction, repeat/],
    [['A struggle', '--kind', 'repeat', '--host', 'claude-code'], /needs --session/],
    [['A struggle', '--kind', 'repeat', '--session', 's', '--host', 'nobody'], /--host is the reader/],
    [['A struggle', '--kind', 'none', '--session', 's', '--host', 'claude-code'], /takes no struggle/],
    [['A struggle', '--kind', 'repeat', '--session', 's', '--host', 'claude-code', '--quote', 'x'.repeat(201)], /200 characters at most/],
    [['A struggle', '--kind', 'repeat', '--session', 's', '--host', 'claude-code', '--fix', 'pray'], /--fix is one of check/],
  ]
  for (const [args, why] of refused) {
    const r = struggle(...args, '--work', 'struggled')
    assert.equal(r.code, 1, args.join(' '))
    assert.match(r.out, why)
  }
})

// ------------------------------------------------- a period's, in the user's own root

const machineFile = path.join(m.install, 'rig.local.json')
const periodFile = path.join(m.dataRoot, 'retro', '2026-09', `${machine}.tsv`)

test('a period\'s struggle goes into retro/<month>/<machine>.tsv in the root --data names', () => {
  const cfg = JSON.parse(fs.readFileSync(machineFile, 'utf8'))
  delete cfg.dataRoot
  fs.writeFileSync(machineFile, JSON.stringify({ ...cfg, dataRoots: { own: { path: m.dataRoot } }, current: 'own' }, null, 2))
  const r = struggle(...ROW, '--period', '2026-09', '--data', 'own')
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(rows(periodFile).at(-1).slice(4, 6), ['repeat', 'Wrote files through Bash heredocs'])
  assert.equal(m.gitMust(m.dataRoot, 'log', '-1', '--format=%s'), 'rig struggle retro 2026-09: Wrote files through Bash heredocs')
})

test('a period\'s struggle names its root: the root in hand may be one a whole org reads', () => {
  const r = struggle(...ROW, '--period', '2026-09')
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--period writes into your own data root, which --data names/)
})

test('a period is a month', () => {
  assert.match(struggle(...ROW, '--period', '2026-9', '--data', 'own').out, /--period is a month, such as 2026-09/)
})
