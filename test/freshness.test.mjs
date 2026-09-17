import { test } from 'node:test'
import assert from 'node:assert/strict'
import { skipReason, dueForRefresh, staleLine, announces } from '../bin/freshness.mjs'

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

test('the ambient line stays out of piped output and out of the commands that report it themselves', () => {
  const on = { enabled: true, tty: true }
  assert.equal(announces('attach', on), true)
  assert.equal(announces('attach', { enabled: true, tty: false }), false)
  assert.equal(announces('attach', { enabled: false, tty: true }), false)
  for (const quiet of ['prompt', 'help', 'doctor', 'update']) assert.equal(announces(quiet, on), false)
})
