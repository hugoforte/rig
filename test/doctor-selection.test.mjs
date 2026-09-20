// `rig doctor` on a machine whose data root cannot be resolved.
//
// doctor is the command you run *because* something is already broken, and the selection is
// one of the things that breaks: a machine that configures two data roots and marks neither
// `current` has no root in hand. Every other command is right to die on that — there is no
// answer to give without a root — and this one is not, because the broken selection is
// itself something doctor has to say. So it is a finding, and the checks that never needed
// the selection still run.
//
// Two halves, each tested where it lives: what the finding is, against `doctorFindings` with
// no subprocess, and that the command lives long enough to print it, against a real
// installation with two roots and no current.
//
// Every fixture name here starts `doctor-sel-`: the work root is shared by every suite on
// the machine and by every branch being tested beside this one.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { doctorFindings, problemCount } from '../bin/doctor.mjs'
import { makeInstall } from './harness.mjs'

// The message `bin/roots.mjs` refuses with, which is what the snapshot carries.
const UNRESOLVABLE = 'C:\\Users\\dev\\rig.local.json configures 2 data roots (one, two) and none is current — run `rig use <name>`, or pass --data <name>'

// A machine with two roots, both fine, and no way to say which is in hand. Only the fields
// the assertions below read: what a whole snapshot looks like is `test/doctor.test.mjs`'s.
const twoRoots = (over = {}) => ({
  setUp: true,
  localFile: 'C:\\Users\\dev\\rig.local.json',
  configFileExists: true,
  strayOrgKeys: [],
  node: 'v20.11.0',
  git: 'git version 2.47.0',
  rig: { version: '3.7.0', root: 'C:\\rig', mark: 'v3.7.0' },
  freshness: { behind: 0, upstream: 'origin/main' },
  gh: 'ok',
  jira: { needed: false, present: false },
  gitConfig: { longpaths: 'true', symlinks: 'false' },
  workRoot: { path: 'C:\\w', exists: true, entries: [] },
  mirrorRoot: { path: 'C:\\w\\.mirrors', exists: true },
  dataRoots: [one('one'), one('two')],
  works: [],
  disk: { label: 'C:', freeGb: 190 },
  selection: { error: null },
  ...over,
})

function one (name) {
  return {
    name,
    path: `C:\\rig-data-${name}`,
    split: true,
    exists: true,
    state: { repo: 'own', top: null, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0, modified: 0 },
    repoConfig: {
      path: `C:\\rig-data-${name}\\rig.json`, exists: true, orgs: 1,
      stamp: { pending: [], writtenBy: '3.7.0', major: 3 },
    },
    orgs: [],
    drafts: [],
  }
}

const says = found => found.map(f => f.says).join(' | ')
const matching = (found, re) => found.filter(f => re.test(f.says))
const only = (found, re) => {
  const hits = matching(found, re)
  assert.equal(hits.length, 1, `expected exactly one finding matching ${re}, got ${hits.length}: ${says(found)}`)
  return hits[0]
}

// ------------------------------------------------------------------ the finding

test('a data root that cannot be resolved is a problem, not a reason to stop', () => {
  const found = doctorFindings(twoRoots({ selection: { error: UNRESOLVABLE } }))
  const hit = only(found, /none is current/)
  assert.equal(hit.verdict, 'bad')
  assert.equal(hit.counts, true)
})

test('the refusal is carried word for word, so doctor names the fix every other command names', () => {
  const found = doctorFindings(twoRoots({ selection: { error: UNRESOLVABLE } }))
  assert.equal(only(found, /none is current/).says, UNRESOLVABLE)
})

test('a selection that resolved says nothing at all', () => {
  assert.equal(matching(doctorFindings(twoRoots()), /none is current/).length, 0)
})

test('every check that does not need the selection is still made', () => {
  const found = doctorFindings(twoRoots({ selection: { error: UNRESOLVABLE } }))
  for (const re of [/^node$/, /^git$/, /^gh authenticated$/, /^work root$/, /^mirror root$/, /^disk on C:$/]) {
    only(found, re)
  }
})

test('the per-root checks read the registry, so both roots are still checked in full', () => {
  const found = doctorFindings(twoRoots({ selection: { error: UNRESOLVABLE } }))
  only(found, /^one: data root$/)
  only(found, /^two: data root$/)
})

test('an unresolvable selection is one thing to look at, and it is the only one', () => {
  assert.equal(problemCount(doctorFindings(twoRoots({ selection: { error: UNRESOLVABLE } }))), 1)
  assert.equal(problemCount(doctorFindings(twoRoots())), 0)
})

// ------------------------------------------------------------------ the command

// Two data roots, each set up the way `rig init` sets one up, and then the pointer between
// them removed — the state the machine file is in between naming a second root and running
// `rig use`.
const install = makeInstall({ prefix: 'doctor-sel-', localConfig: true, github: { issues: {} } })
const { tmp, dataRoot, workRoot, localConfig, rig, cleanup } = install
const second = path.join(tmp, 'rig-data-doctor-sel-two')

const setUp = () => {
  assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--email', 'hugo@acme.invalid', '--name', 'doctor-sel-one']).code, 0)
  assert.equal(rig(['init', '--data-root', second, '--orgs', 'acme',
    '--email', 'hugo@acme.invalid', '--name', 'doctor-sel-two']).code, 0)
  // A work in one of them, with its folder taken away: the work checks are made of every
  // root's records at once, and this is what proves they were still made with nothing
  // selected. Created while a root is in hand, because `rig new` writes and is right to
  // refuse without one.
  assert.equal(rig(['new', 'doctor-sel-orphan', '--title', 'Left without a folder', '--no-ticket']).code, 0)
  fs.rmSync(path.join(workRoot, 'doctor-sel-orphan'), { recursive: true, force: true, maxRetries: 5 })
  const machine = JSON.parse(fs.readFileSync(localConfig, 'utf8'))
  delete machine.current
  fs.writeFileSync(localConfig, JSON.stringify(machine))
}
setUp()

test.after(cleanup)

test('rig doctor reports an unresolvable data root instead of dying on it', () => {
  const r = rig(['doctor'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /configures 2 data roots \(doctor-sel-one, doctor-sel-two\) and none is current/)
  assert.match(r.out, /run `rig use <name>`/)
  assert.match(r.out, /thing\(s\) to look at/, 'it reached its verdict')
})

test('the checks that never needed a root in hand all ran', () => {
  const out = rig(['doctor']).out
  for (const re of [/node/, /git version/, /gh authenticated/, /work root/, /mirror root/, /freshness|installed rig/]) {
    assert.match(out, re)
  }
})

test('both roots are still checked, by name, from the registry', () => {
  const out = rig(['doctor']).out
  assert.match(out, /doctor-sel-one: rig\.json/)
  assert.match(out, /doctor-sel-two: rig\.json/)
})

test('the work records are still read, from whichever root holds them', () => {
  assert.match(rig(['doctor']).out, /doctor-sel-orphan: work folder missing but not closed/)
})

test('saying which root is in hand is all it takes to clear the finding', () => {
  assert.equal(rig(['use', 'doctor-sel-one']).code, 0)
  const out = rig(['doctor']).out
  assert.doesNotMatch(out, /none is current/)
  const machine = JSON.parse(fs.readFileSync(localConfig, 'utf8'))
  delete machine.current
  fs.writeFileSync(localConfig, JSON.stringify(machine))
})
