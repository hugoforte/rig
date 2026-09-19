// The verdict table, from fixtures. `bin/workstate.mjs` is pure — no fs, no git, no gh —
// so every row below is a plain object in and a judgement out: no temp checkout, no
// network, no `gh`. That is the whole reason the module is shaped this way.
//
// One test per row of the table in the module header, then the composites that made the
// table necessary: a squash-merged branch whose upstream is gone (#52), a merged PR whose
// worktree has been deleted, and two repos where only one is in the way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workState } from '../bin/workstate.mjs'

// A work record with one entry per state, named after it. `pr` on an entry is a merged
// PR's terminal facts, the way `rig close` and `rig backfill` record them.
const work = (...entries) => ({ id: 'w', repos: entries.map(e => ({ org: 'acme', ...e })) })
const clean = extra => ({ missing: false, dirty: 0, ahead: 0, behind: 0, pr: null, ...extra })
const openPr = { number: 7, state: 'OPEN', url: 'https://github.com/acme/billing/pull/7' }
const mergedPr = { number: 7, state: 'MERGED', url: 'https://github.com/acme/billing/pull/7', mergedAt: '2026-09-01T00:00:00Z' }
const record = { number: 7, url: 'https://github.com/acme/billing/pull/7', openedAt: '2026-08-30T00:00:00Z', firstCommitAt: '2026-08-29T00:00:00Z', mergedAt: '2026-09-01T00:00:00Z' }

// One repo called billing, with whatever state the row under test describes.
const one = (state, entry = {}) => workState(work({ repo: 'billing', ...entry }), [{ repo: 'billing', ...state }])
const kinds = v => v.blockers.map(b => b.kind)

test('uncommitted changes block the close and are not done', () => {
  const v = one(clean({ dirty: 2 }))
  assert.deepEqual(kinds(v), ['dirty'])
  assert.equal(v.blockers[0].message, 'billing: 2 uncommitted change(s)')
  assert.equal(v.safeToClose, false)
  assert.equal(v.done, false)
})

test('unpushed commits block the close', () => {
  const v = one(clean({ ahead: 3 }))
  assert.deepEqual(kinds(v), ['unpushed'])
  assert.equal(v.blockers[0].message, 'billing: 3 unpushed commit(s)')
})

test('a distance git could not measure blocks the close, and says what git said', () => {
  const v = one(clean({ ahead: null, behind: null, distanceUnknown: 'fatal: bad revision' }))
  assert.deepEqual(kinds(v), ['distance-unknown'])
  assert.equal(v.blockers[0].message, 'billing: commits unknown (fatal: bad revision)')
  assert.equal(v.safeToClose, false)
})

test('an open PR blocks the close', () => {
  const v = one(clean({ pr: openPr }))
  assert.deepEqual(kinds(v), ['pr-open'])
  assert.equal(v.blockers[0].message, 'billing: PR #7 still open')
})

test('a PR state GitHub would not answer for blocks the close', () => {
  const v = one(clean({ prError: 'gh not found on PATH' }))
  assert.deepEqual(kinds(v), ['pr-unknown'])
  assert.equal(v.blockers[0].message, 'billing: PR state unknown (gh not found on PATH)')
})

test('a merged PR blocks nothing and counts as done', () => {
  const v = one(clean({ pr: mergedPr }))
  assert.deepEqual(v.blockers, [])
  assert.equal(v.repos[0].merged, true)
  assert.equal(v.safeToClose, true)
  assert.equal(v.done, true)
  assert.equal(v.reason, '')
})

test('no PR at all with a clean tree is safe to close, and is not done', () => {
  const v = one(clean())
  assert.deepEqual(v.blockers, [])
  assert.equal(v.safeToClose, true)
  assert.equal(v.done, false, 'nothing landed, so nothing is finished')
  assert.equal(v.reason, 'Not every PR is merged — billing (no PR).')
})

test('a missing worktree is not a verdict on its own: judged on its PR alone', () => {
  const v = one({ repo: 'billing', missing: true, dirty: 0, ahead: 0, behind: 0, pr: null })
  assert.deepEqual(v.blockers, [], 'a tree that is gone has nothing left to be in the way')
  assert.equal(v.done, false)
  assert.equal(v.reason, 'Not every PR is merged — billing (no PR).',
    '"worktree missing" is never why a ticket stays open')
})

// ------------------------------------------------- the composites

test('a merged PR settles a branch whose upstream the squash merge deleted (#52)', () => {
  // The exact shape of #52: the head branch is gone, so `rev-list` measures against the
  // base instead and the pre-squash commits read as unpushed forever.
  const v = one(clean({ ahead: 4, pr: mergedPr }))
  assert.deepEqual(v.blockers, [], 'no --force needed to close work that is already merged')
  assert.equal(v.done, true)
})

test('a merged PR settles a distance nobody could measure either', () => {
  const v = one(clean({ ahead: null, behind: null, distanceUnknown: 'fatal: bad revision', pr: mergedPr }))
  assert.deepEqual(v.blockers, [])
  assert.equal(v.done, true)
  assert.equal(v.repos[0].distanceUnknown, 'fatal: bad revision',
    'the fact is still reported — only the blocker it would raise is dropped')
})

test('a merge settles the branch, never the working tree', () => {
  const v = one(clean({ dirty: 1, ahead: 4, pr: mergedPr }))
  assert.deepEqual(kinds(v), ['dirty'], 'unsaved work is the one thing close could destroy')
  assert.equal(v.done, false)
  assert.equal(v.reason, 'Every PR is merged, but billing: 1 uncommitted change(s).')
})

test('a merged PR whose worktree is gone is done, with nothing in the way', () => {
  const v = one({ repo: 'billing', missing: true, dirty: 0, ahead: 0, behind: 0, pr: mergedPr })
  assert.deepEqual(v.blockers, [])
  assert.equal(v.done, true)
})

test('a recorded merged PR settles the branch with no lookup at all', () => {
  const v = one(clean({ pr: null }), { pr: record })
  assert.equal(v.repos[0].merged, true)
  assert.equal(v.repos[0].pr.state, 'MERGED')
  assert.equal(v.repos[0].pr.recorded, true, 'so no reader mistakes it for a fresh lookup')
  assert.equal(v.done, true)
})

test('a recorded merged PR also settles a lookup GitHub refused', () => {
  const v = one(clean({ prError: 'gh not found on PATH' }), { pr: record })
  assert.deepEqual(v.blockers, [], 'a stored record has nothing left to refuse')
  assert.equal(v.repos[0].prUnknown, null)
  assert.equal(v.done, true)
})

test('a live open PR beats a record: the branch carried a second PR after the first merged', () => {
  const v = one(clean({ pr: { ...openPr, number: 9 } }), { pr: record })
  assert.deepEqual(kinds(v), ['pr-open'])
  assert.equal(v.blockers[0].message, 'billing: PR #9 still open')
  assert.equal(v.done, false)
})

test('two repos, one in the way: the blocker names it and the work is neither safe nor done', () => {
  const v = workState(
    work({ repo: 'billing' }, { repo: 'orders' }),
    [{ repo: 'billing', ...clean({ pr: mergedPr }) }, { repo: 'orders', ...clean({ dirty: 1, pr: openPr }) }])
  assert.deepEqual(v.blockers.map(b => b.repo), ['orders', 'orders'])
  assert.deepEqual(kinds(v), ['dirty', 'pr-open'])
  assert.equal(v.safeToClose, false)
  assert.equal(v.done, false)
  assert.equal(v.repos[0].blockers.length, 0, 'the merged repo is not implicated')
  assert.equal(v.reason, 'Not every PR is merged — orders (PR #7 open).')
})

test('a work with nothing attached is safe to close and is not done', () => {
  const v = workState(work(), [])
  assert.deepEqual(v.blockers, [])
  assert.equal(v.safeToClose, true)
  assert.equal(v.done, false)
  assert.equal(v.reason, 'No repos were attached, so there are no PRs to check.')
})

test('the reason names every unmerged repo in the PR\'s own terms', () => {
  const v = workState(
    work({ repo: 'billing' }, { repo: 'orders' }, { repo: 'warehouse' }),
    [
      { repo: 'billing', ...clean({ pr: mergedPr }) },
      { repo: 'orders', ...clean({ prError: 'HTTP 502' }) },
      { repo: 'warehouse', missing: true, dirty: 0, ahead: 0, behind: 0, pr: null },
    ])
  assert.equal(v.reason, 'Not every PR is merged — orders (PR state unknown), warehouse (no PR).')
})
