import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QUIET_COMMANDS, skipReason, dueForRefresh, staleLine, announces } from '../bin/freshness.mjs'

const onMain = { repo: true, linked: false, branch: 'main', defaultBranch: 'main', upstream: true }

test('a checkout on its default branch with an upstream is judged', () => {
  assert.equal(skipReason(onMain), null)
})

test('the copy inside a work worktree is never judged', () => {
  assert.match(skipReason({ ...onMain, linked: true }), /linked worktree/)
})

test('a feature branch is not behind the default branch, it is elsewhere', () => {
  assert.match(skipReason({ ...onMain, branch: 'feat/x' }), /on feat\/x, not main/)
})

test('a detached HEAD, an unversioned tree and a remoteless checkout are all skipped', () => {
  assert.match(skipReason({ ...onMain, branch: null }), /detached HEAD/)
  assert.match(skipReason({ repo: false }), /not a git checkout/)
  assert.match(skipReason({ ...onMain, upstream: false }), /no upstream/)
})

test('a refresh is due once the interval has passed', () => {
  const now = Date.parse('2026-09-17T12:00:00Z')
  const at = iso => ({ checkedAt: iso })
  assert.equal(dueForRefresh(at('2026-09-17T11:00:00Z'), 24, now), false)
  assert.equal(dueForRefresh(at('2026-09-16T11:59:00Z'), 24, now), true)
})

test('a cache with no readable timestamp is due, not fresh', () => {
  assert.equal(dueForRefresh(undefined), true)
  assert.equal(dueForRefresh({ checkedAt: 'sometime' }), true)
})

test('the line names the distance, singular and plural', () => {
  assert.match(staleLine({ sha: 'abc', behind: 1, remote: 'origin/main' }, 'abc'), /1 commit behind origin\/main/)
  assert.match(staleLine({ sha: 'abc', behind: 4, remote: 'origin/main' }, 'abc'), /4 commits behind/)
})

test('an up-to-date cache says nothing', () => {
  assert.equal(staleLine({ sha: 'abc', behind: 0 }, 'abc'), null)
  assert.equal(staleLine(null, 'abc'), null)
})

test('a cache written before the checkout moved is ignored, not trusted', () => {
  assert.equal(staleLine({ sha: 'old', behind: 3 }, 'new'), null)
})

test('the ambient line is announced whether or not anyone is watching a terminal', () => {
  // It goes to stderr, so a pipe is not a reason to withhold it — an agent shelling out to
  // rig is the audience that most needs to be told its rig is stale.
  assert.equal(announces('attach', { enabled: true }), true)
  assert.equal(announces('attach', { enabled: false }), false)
})

test('the commands that report freshness themselves never print the ambient line', () => {
  for (const quiet of QUIET_COMMANDS) assert.equal(announces(quiet, { enabled: true }), false)
})

test('a check exactly one interval old is due', () => {
  // The boundary, not a value either side of it: `>=` sliding to `>` is a whole extra
  // interval of silence and nothing else here would notice.
  const at = '2026-09-16T12:00:00Z'
  assert.equal(dueForRefresh({ checkedAt: at }, 24, Date.parse('2026-09-17T12:00:00Z')), true)
  assert.equal(dueForRefresh({ checkedAt: at }, 24, Date.parse('2026-09-17T11:59:59Z')), false)
})

test('a check stamped in the future is due, not believed', () => {
  const now = Date.parse('2026-09-17T12:00:00Z')
  assert.equal(dueForRefresh({ checkedAt: '2027-01-01T00:00:00Z' }, 24, now), true)
})
