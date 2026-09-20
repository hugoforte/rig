// What `rig doctor` says, over fixtures. Every check is one object literal away from being
// asserted now that the probing is the caller's — which is the whole point of the split: the
// command you run *because* something is already broken used to be the command with no unit
// tests, and the only way to reach a check was to build a real installation that had the
// fault.
//
// The two things these fixtures cannot prove are in `test/installation.test.mjs`: that doctor
// *survives* a machine with no git and no free-space probe. Those are properties of the
// probing, and the probing is the half that stays impure.
import test from 'node:test'
import assert from 'node:assert/strict'

import { doctorFindings, problemCount, ISSUES_URL } from '../bin/doctor.mjs'

const checkout = (over = {}) => ({
  repo: 'own', top: null, branch: 'main', upstream: 'origin/main',
  ahead: 0, behind: 0, dirty: 0, modified: 0, ...over,
})

// One data root with nothing wrong with it. Unnamed, because an installation that knows only
// one never says which — the tests that care about the labelling pass a name.
const root = (over = {}) => ({
  name: null, path: 'C:\\rig-data', split: true, exists: true, state: checkout(),
  repoConfig: {
    path: 'C:\\rig-data\\rig.json', exists: true, orgs: 1,
    stamp: { pending: [], writtenBy: '3.4.0', major: 3 },
  },
  orgs: [], drafts: [], ...over,
})

// A machine with nothing wrong with it. Every test below breaks exactly one thing.
const snap = (over = {}) => ({
  setUp: true,
  localFile: 'C:\\Users\\dev\\.rig\\rig.local.json',
  configFileExists: true,
  strayOrgKeys: [],
  node: 'v20.11.0',
  git: 'git version 2.47.0',
  rig: { recordFormat: 3, root: 'C:\\rig', mark: 'v3.4.0' },
  freshness: { behind: 0, upstream: 'origin/main' },
  gh: 'ok',
  jira: { needed: false, present: false },
  gitConfig: { longpaths: 'true', symlinks: 'false' },
  workRoot: { path: 'C:\\w', exists: true, entries: [] },
  mirrorRoot: { path: 'C:\\w\\.mirrors', exists: true },
  dataRoots: [root()],
  works: [],
  disk: { label: 'C:', freeGb: 190 },
  ...over,
})

const says = found => found.map(f => f.says).join(' | ')
const matching = (found, re) => found.filter(f => re.test(f.says))
const only = (found, re) => {
  const hits = matching(found, re)
  assert.equal(hits.length, 1, `expected exactly one finding matching ${re}, got ${hits.length}: ${says(found)}`)
  return hits[0]
}

test('a machine with nothing wrong with it counts nothing', () => {
  assert.equal(problemCount(doctorFindings(snap())), 0, says(doctorFindings(snap())))
})

test('an installation with no config at all says so and asks nothing else', () => {
  const found = doctorFindings({ setUp: false, localFile: 'C:\\x\\rig.local.json' })
  assert.equal(found.length, 1)
  assert.match(found[0].says, /not set up — no C:\\x\\rig.local.json/)
  assert.equal(problemCount(found), 1)
})

test('the exit code is the findings that count, not the findings there are', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ drafts: ['billing'] })], gh: 'missing' }))
  assert.ok(found.length > 2)
  assert.equal(problemCount(found), 1, 'a draft entry is not a problem; an absent gh is')
})

test('a key of the org half left in the machine file is named, one line each', () => {
  const found = doctorFindings(snap({ strayOrgKeys: ['orgs', 'tracker'] }))
  assert.match(says(found), /has "orgs" — ignored; it lives in rig\.json/)
  assert.match(says(found), /has "tracker" — ignored/)
  assert.equal(problemCount(found), 2)
})

test('git missing is said, and every check that needs git is dropped rather than failed', () => {
  const found = doctorFindings(snap({ git: null, gitConfig: null, dataRoots: [root({ state: null })] }))
  assert.match(only(found, /^git/).says, /git — not on PATH/)
  assert.equal(matching(found, /core\.longpaths/).length, 0, 'not asked without git')
  assert.equal(matching(found, /data root is a git checkout/).length, 0)
})

test('a freshness check this checkout was never going to make is a note, not a problem', () => {
  const found = doctorFindings(snap({ freshness: { skipped: 'the tool is running from a linked worktree' } }))
  assert.equal(only(found, /freshness not checked/).verdict, 'note')
  assert.equal(problemCount(found), 0)
})

test('a fetch that was attempted and failed counts, which is what tells it from one that was skipped', () => {
  const found = doctorFindings(snap({ freshness: { fetchError: 'host unreachable' } }))
  assert.equal(only(found, /freshness not checked/).verdict, 'warn')
  assert.equal(problemCount(found), 1)
})

test('a distance git could not measure is never reported as up to date', () => {
  const found = doctorFindings(snap({ freshness: { behind: null, upstream: 'origin/main' } }))
  assert.match(only(found, /freshness not checked/).says, /could not measure the distance from origin\/main/)
  assert.equal(problemCount(found), 1)
})

test('an installation behind its upstream is told how far and what to run', () => {
  const found = doctorFindings(snap({ freshness: { behind: 3, upstream: 'origin/main' } }))
  assert.match(only(found, /installed rig/).says, /3 commit\(s\) behind origin\/main — run `rig update`/)
  assert.equal(problemCount(found), 1)
})

test('gh absent and gh unauthenticated are different sentences', () => {
  assert.match(only(doctorFindings(snap({ gh: 'missing' })), /gh authenticated/).says, /gh not on PATH/)
  assert.match(only(doctorFindings(snap({ gh: 'unauthenticated' })), /gh authenticated/).says, /PR state and org resolution will not work/)
})

test('twg is only asked about when an org actually tracks in Jira', () => {
  assert.equal(matching(doctorFindings(snap()), /twg present/).length, 0)
  const found = doctorFindings(snap({ jira: { needed: true, present: false } }))
  assert.match(only(found, /twg present/).says, /Jira ticket creation, fetch and write-back will not work/)
})

test('core.longpaths unset is a problem; core.symlinks=false is by design', () => {
  const found = doctorFindings(snap({ gitConfig: { longpaths: '', symlinks: 'false' } }))
  assert.match(only(found, /core\.longpaths/).says, /run `rig init`/)
  assert.equal(only(found, /core\.symlinks/).verdict, 'note')
  assert.equal(problemCount(found), 1)
})

test('a data root inside the tool checkout is not set up, and says why that is not allowed', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ path: 'C:\\rig\\data', split: false, exists: true, state: null })] }))
  assert.match(only(found, /^data root/).says, /is inside the tool checkout — not set up/)
})

test('a data root that is a directory inside another checkout names the checkout it is inside', () => {
  const state = checkout({ repo: 'nested', top: 'C:\\everything' })
  const found = doctorFindings(snap({ dataRoots: [root({ path: 'C:\\everything\\rig-data', split: true, exists: true, state })] }))
  assert.match(only(found, /checkout of its own/).says, /it is a directory inside C:\\everything/)
  assert.equal(problemCount(found), 1)
})

test('an unversioned data root says records written there are not versioned', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ state: checkout({ repo: 'none' }) })] }))
  assert.match(only(found, /checkout of its own/).says, /records written there are not versioned/)
})

test('an edit made outside rig warns and does not count — it is waiting for `rig save`, not broken', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ state: checkout({ dirty: 2 }) })] }))
  assert.equal(only(found, /uncommitted change/).verdict, 'warn')
  assert.equal(problemCount(found), 0)
})

test('a working tree git could not read is never given the green tick', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ state: checkout({ dirty: null }) })] }))
  assert.match(only(found, /could not read the working tree/).says, /git -C C:\\rig-data status/)
  assert.equal(matching(found, /committed and pushed/).length, 0)
  assert.equal(problemCount(found), 1)
})

test('a data root on a detached HEAD counts, because rig commits there go nowhere', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ state: checkout({ branch: null }) })] }))
  assert.match(only(found, /detached HEAD/).says, /check out main/)
  assert.equal(problemCount(found), 1)
})

test('a local-only data root is a note, and unpushed commits warn without counting', () => {
  const local = doctorFindings(snap({ dataRoots: [root({ state: checkout({ upstream: null }) })] }))
  assert.equal(only(local, /no upstream — local only/).verdict, 'note')
  const ahead = doctorFindings(snap({ dataRoots: [root({ state: checkout({ ahead: 2 }) })] }))
  assert.equal(only(ahead, /2 unpushed commit\(s\)/).verdict, 'warn')
  assert.equal(problemCount(ahead), 0)
})

test('a data root behind its origin counts, and names the command that fast-forwards it', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ state: checkout({ behind: 4 }) })] }))
  assert.match(only(found, /behind origin/).says, /`rig update` fast-forwards it/)
  assert.equal(problemCount(found), 1)
})

test('a rig.json with no orgs is not set up', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ repoConfig: { path: 'C:\\rig-data\\rig.json', exists: true, orgs: 0, stamp: { pending: [], major: 3 } } })] }))
  assert.match(only(found, /no orgs/).says, /run `rig prompt setup`/)
})

test('a stamp no rig wrote is reported as something to fix by hand, never migrated', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ repoConfig: { path: 'p', exists: true, orgs: 1, stamp: { unreadable: true, writtenBy: 42 } } })] }))
  assert.match(only(found, /writtenBy/).says, /which is not a record format any rig wrote/)
  assert.equal(problemCount(found), 1)
})

test('a data root written by a newer rig says the mutating commands are the ones that refuse', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ repoConfig: { path: 'p', exists: true, orgs: 1, stamp: { blocked: true, major: 3, dataMajor: 4 } } })] }))
  assert.match(only(found, /record format 4/).says, /mutating commands refuse until this rig is updated/)
})

test('pending migrations are reported and never run', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ repoConfig: { path: 'p', exists: true, orgs: 1, stamp: { pending: ['stamp the data root', 'phase replaces status'], major: 3 } } })] }))
  assert.match(only(found, /pending migration/).says, /2 pending migration\(s\) — run `rig update`: stamp the data root; phase replaces status/)
  assert.equal(problemCount(found), 1)
})

test('a checkout with no release to name still has a subject in that sentence', () => {
  // The mark is the version now, so with no mark — no git on PATH, or a copy of the tool with
  // no `.git` — the line would read `rig at C:\rig` and have lost what it is about.
  const found = doctorFindings(snap({ rig: { recordFormat: 3, root: 'C:\\rig', mark: null } }))
  assert.match(only(found, /^rig /).says, /^rig record format 3 at /)
})

test('a data root at the format this rig writes is a note, and names the format once', () => {
  // No "stamped by rig X": the stamp is derived from the format now, so naming it would be
  // this line saying one number twice and calling the second one a rig (ADR 0004).
  const found = doctorFindings(snap())
  assert.equal(only(found, /record format 3/).verdict, 'note')
  assert.equal(only(found, /record format 3/).says, 'record format 3')
})

test('a data root written before stamping existed says so, rather than showing undefined', () => {
  // The oldest data roots carry no `writtenBy` at all. That is still worth saying — it is a
  // fact about the record, and the only stamp state a derived one cannot account for.
  const found = doctorFindings(snap({
    dataRoots: [root({ repoConfig: { path: 'p', exists: true, orgs: 1, stamp: { pending: [], major: 3 } } })],
  }))
  assert.match(only(found, /record format 3/).says, /from before stamping existed/)
})

test('an org with no mirror yet is a note: there is nothing to ask git about', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ orgs: [{ org: 'acme', identity: { email: null, source: 'unknown' }, tracker: null }] })] }))
  assert.equal(only(found, /identity for acme/).verdict, 'note')
  assert.equal(problemCount(found), 0)
})

test('an org git has no address for cannot commit, and that is the one identity worth a warning', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ orgs: [{ org: 'acme', identity: { email: null, source: 'none' }, tracker: null }] })] }))
  assert.match(only(found, /identity for acme/).says, /git has no user\.email to commit with/)
  assert.equal(problemCount(found), 1)
})

test('an address git resolved says so, so nobody goes looking for it in rig.local.json', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ orgs: [{ org: 'acme', identity: { email: 'dev@acme.example', source: 'git' }, tracker: null }] })] }))
  assert.equal(only(found, /identity for acme/).dim, 'dev@acme.example — from git, not rig')
})

test('the tracker for an org is reported, including when there is none', () => {
  const none = doctorFindings(snap({ dataRoots: [root({ orgs: [{ org: 'acme', identity: { email: 'a@b', source: 'rig' }, tracker: null }] })] }))
  assert.match(only(none, /tracker for acme/).says, /none — `rig new --ticket` unavailable \(rig\.json\)/)
  const jira = doctorFindings(snap({ dataRoots: [root({ orgs: [{ org: 'acme', identity: { email: 'a@b', source: 'rig' }, tracker: { kind: 'jira', project: 'KTLO' } }] })] }))
  assert.match(only(jira, /tracker for acme/).says, /jira KTLO/)
})

test('an installation that knows one root never names it — there is nothing to tell it from', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ name: 'hugoforte' })] }))
  assert.equal(only(found, /^data root$/).dim, 'C:\\rig-data')
  assert.equal(matching(found, /^hugoforte: /).length, 0)
})

test('every configured root is checked in full, and every line says which root it is about', () => {
  const found = doctorFindings(snap({
    dataRoots: [
      root({ name: 'hugoforte' }),
      root({
        name: 'personal',
        path: 'C:\\rig-data-personal',
        state: checkout({ dirty: 3 }),
        drafts: ['notes'],
        repoConfig: {
          path: 'C:\\rig-data-personal\\rig.json', exists: true, orgs: 1,
          stamp: { pending: ['stamp the data root'], major: 3 },
        },
      }),
    ],
  }))
  assert.match(only(found, /uncommitted change/).says, /^personal: data root has 3 uncommitted/)
  assert.match(only(found, /committed and pushed/).says, /^hugoforte: /)
  assert.match(only(found, /pending migration/).says, /^personal: /)
  assert.match(only(found, /draft catalogue/).says, /^personal: /)
  assert.equal(matching(found, /rig\.json/).length, 2, 'each root carries its own')
  assert.equal(matching(found, /^data root/).length, 0, 'and none of it is said unlabelled')
})

test('a root whose directory has gone is one finding, and the roots after it are still checked', () => {
  const found = doctorFindings(snap({
    dataRoots: [
      root({ name: 'gone', path: 'C:\\rig-data-gone', exists: false, state: null }),
      root({ name: 'personal' }),
    ],
  }))
  const one = only(found, /^gone: /)
  assert.match(one.says, /C:\\rig-data-gone missing — check dataRoots\.gone in rig\.local\.json/)
  assert.match(says(found), /personal: data root is committed and pushed/)
})

test('a contradiction is an error, not a warning, and says where to report it', () => {
  const found = doctorFindings(snap({ works: [{ id: 'w', closed: false, contradictions: ['w: closed, but its PR is open'], repos: [] }] }))
  const one = only(found, /closed, but/)
  assert.equal(one.verdict, 'bad')
  assert.match(one.says, new RegExp(`please file an issue at ${ISSUES_URL.replace(/[/.]/g, '\\$&')}`))
  assert.equal(problemCount(found), 1)
})

test('a closed work keeps its contradictions and loses its stray checks — its worktrees are gone on purpose', () => {
  const found = doctorFindings(snap({
    works: [{ id: 'w', closed: true, contradictions: ['w: forced: closed, but'], folderMissing: true, strays: ['junk'], repos: [] }],
  }))
  assert.equal(matching(found, /forced: closed/).length, 1)
  assert.equal(matching(found, /work folder missing|unmanaged entry/).length, 0)
})

test('a work folder that is missing is said once, and nothing under it is guessed at', () => {
  const found = doctorFindings(snap({
    works: [{ id: 'w', closed: false, contradictions: [], folderMissing: true, strays: ['junk'], repos: [{ repo: 'billing', worktreeMissing: true }] }],
  }))
  assert.match(only(found, /^w:/).says, /work folder missing but not closed/)
  assert.equal(problemCount(found), 1)
})

test('rig owns the work folder, so anything it did not put there is named', () => {
  const found = doctorFindings(snap({
    works: [{ id: 'w', closed: false, contradictions: [], folderMissing: false, strays: ['notes.md', 'scratch'], repos: [] }],
  }))
  assert.match(says(found), /w: unmanaged entry "notes\.md" under the work root/)
  assert.equal(problemCount(found), 2)
})

test('a work folder is accounted for by whichever root holds its record, not by the current one', () => {
  // The work root is shared, so the question is asked once over every root's records. Asked
  // per root instead, each would report the other's live work folder as junk.
  const work = (id) => ({ id, closed: false, contradictions: [], folderMissing: false, strays: [], repos: [] })
  const found = doctorFindings(snap({
    dataRoots: [root({ name: 'hugoforte' }), root({ name: 'personal', path: 'C:\\rig-data-personal' })],
    workRoot: { path: 'C:\\w', exists: true, entries: ['refunds', 'notes-tidy', 'scratch'] },
    works: [work('refunds'), work('notes-tidy')],
  }))
  assert.match(only(found, /unmanaged entry/).says, /"scratch" in C:\\w — no data root has a work record for it/)
  assert.equal(problemCount(found), 1)
})

test('an unclosed work is warned about whichever root holds its record', () => {
  const found = doctorFindings(snap({
    works: [{ id: 'in-the-other-root', closed: false, contradictions: [], folderMissing: true, strays: [], repos: [] }],
  }))
  assert.match(only(found, /^in-the-other-root:/).says, /work folder missing but not closed/)
})

test('an attached repo whose worktree is gone is named, and so is one whose secrets have no source', () => {
  const found = doctorFindings(snap({
    works: [{
      id: 'w', closed: false, contradictions: [], folderMissing: false, strays: [],
      repos: [{ repo: 'billing', worktreeMissing: true, secretsUnconfigured: false },
              { repo: 'orders', worktreeMissing: false, secretsUnconfigured: true }],
    }],
  }))
  assert.match(says(found), /w: billing is attached but its worktree is gone/)
  assert.match(says(found), /w: orders mentions secrets in its catalogue entry but has no source/)
  assert.equal(problemCount(found), 2)
})

test('draft catalogue entries are an invitation, not a fault: they warn and do not count', () => {
  const found = doctorFindings(snap({ dataRoots: [root({ drafts: ['billing', 'orders'] })] }))
  const one = only(found, /draft catalogue/)
  assert.equal(one.verdict, 'warn')
  assert.match(one.says, /2 draft catalogue entries: billing, orders/)
  assert.equal(problemCount(found), 0)
})

test('one draft entry is singular, because the line is read by a person', () => {
  assert.match(only(doctorFindings(snap({ dataRoots: [root({ drafts: ['billing'] })] })), /draft catalogue/).says, /1 draft catalogue entry: billing/)
})

test('a free-space probe this machine does not have costs one line, not the verdict (decision 54)', () => {
  const found = doctorFindings(snap({ disk: null }))
  assert.equal(matching(found, /disk on/).length, 0)
  assert.equal(problemCount(found), 0)
})

test('a nearly full disk counts, and says how little is left', () => {
  const found = doctorFindings(snap({ disk: { label: '/', freeGb: 4 } }))
  assert.match(only(found, /disk on/).says, /only 4 GB free/)
  assert.equal(problemCount(found), 1)
})

test('every finding is one of the four channels, and only a passing check carries a dim detail', () => {
  const found = doctorFindings(snap({
    gh: 'missing',
    dataRoots: [root({ drafts: ['billing'] })],
    works: [{ id: 'w', closed: false, contradictions: ['w: impossible'], repos: [] }],
    freshness: { skipped: 'the tool is not a git checkout' },
  }))
  for (const f of found) {
    assert.ok(['ok', 'warn', 'bad', 'note'].includes(f.verdict), `unknown verdict ${f.verdict}`)
    if (f.dim) assert.equal(f.verdict, 'ok', `a ${f.verdict} folds its detail into the sentence`)
    assert.equal(typeof f.counts, 'boolean')
  }
})
