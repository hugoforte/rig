// Picking up a work another session left (hugoforte/rig#290): `rig next` offers the pickup
// while a handoff is newer than the last commit on the work's branches, and the pickup prompt
// says the trail is authoritative.
//
// The tests share one installation and run in order.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { billingInstall } from './billing-install.mjs'

const m = billingInstall('rig-pickup-')
after(m.cleanup)

// A commit made a minute from now, so it is newer than the handoff whatever the clock's grain.
const commitLater = (dir, message) => {
  const later = new Date(Date.now() + 60 * 1000).toISOString()
  const r = spawnSync('git', ['-C', dir, 'commit', '-qam', message], { encoding: 'utf8', env: { ...m.env, GIT_COMMITTER_DATE: later, GIT_AUTHOR_DATE: later } })
  assert.equal(r.status, 0, r.stderr)
}

test('a handoff committed after the last commit is offered as the place to pick up from', () => {
  assert.equal(m.rig(['new', 'left', '--title', 'A work left for another session', '--no-ticket', '--repos', 'billing']).code, 0)
  fs.writeFileSync(path.join(m.dataRoot, 'work', 'left', 'handoff.md'), '# Handoff\n\nWhat happened, and what is next.\n')
  assert.equal(m.rig(['save', '-m', 'handoff: what is next', '--work', 'left']).code, 0)
  const r = m.rig(['next', '--work', 'left'])
  assert.match(r.out, /a handoff was left after the last commit — pick up from it/)
  assert.match(r.out, /rig prompt pickup$/m)
})

test('the pickup offer clears on the pickup\'s first commit', () => {
  const dest = m.worktree('left', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'picked up\n')
  commitLater(dest, 'picked up')
  assert.doesNotMatch(m.rig(['next', '--work', 'left']).out, /rig prompt pickup/)
})

test('the pickup prompt says the trail is authoritative', () => {
  const r = m.rig(['prompt', 'pickup'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /the trail is authoritative/)
})
