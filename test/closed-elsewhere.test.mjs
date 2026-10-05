// A work closed on another machine, as the machine that still has its folder sees it
// (hugoforte/rig#268). The close ran elsewhere: it stamped `closedAt`, which arrived here with
// the data root, and it could only tear down its own disk. So this machine has the folder, the
// worktrees and the mirror's copy of the branch, and a record that says the work is over.
//
// The other machine is the same installation with the record stamped by hand — the one fact its
// close sends anywhere — which is exactly what pulling the data root brings.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { strip } from './harness.mjs'
import { billingInstall } from './billing-install.mjs'

const { dataRoot, workRoot, rig, git, gitMust, github, setGithub, bare, commitWork, seedPr, worktree, cleanup } = billingInstall('rig-closed-elsewhere-')

after(cleanup)

const recordFile = id => path.join(dataRoot, 'work', id, 'work.json')
const mirror = repo => path.join(workRoot, '.mirrors', 'acme', `${repo}.git`)
const hasBranch = (dir, branch) => git(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).status === 0

// A work that landed here, then was closed on the other machine. Its remote branch is left in
// place: whatever that close did on GitHub was its own decision, and this machine must not
// take it again.
const closedElsewhere = (id, number, { state = 'MERGED', stamp = {}, stage } = {}) => {
  assert.equal(rig(['new', id, '--title', `${id} work`, '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', id]).code, 0)
  if (stage) assert.equal(rig(['stage', stage, '--delivers', 'a slice', '--work', id]).code, 0)
  const dest = worktree(id, 'billing')
  commitWork(dest, `${id}: the work`)
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  seedPr({
    branch: `feat/${id}-work`, number, state, head: gitMust(dest, 'rev-parse', 'HEAD'),
    url: `https://github.com/acme/billing/pull/${number}`, mergedAt: '2026-09-20T00:00:00Z',
  })
  const record = JSON.parse(fs.readFileSync(recordFile(id), 'utf8'))
  fs.writeFileSync(recordFile(id), JSON.stringify({ ...record, closedAt: '2026-09-30T12:00:00.000Z', ...stamp }, null, 2) + '\n')
  gitMust(dataRoot, 'commit', '-qam', `rig close ${id} (the other machine)`)
  return dest
}

test('doctor names a work closed elsewhere whose folder is still here, and the command that clears it', () => {
  closedElsewhere('landed', 50)
  assert.match(strip(rig(['doctor']).out), /landed: closed on 2026-09-30, but its folder is still on this machine — `rig tidy` clears it/)
})

test('next, asked about it, offers rig close', () => {
  assert.match(strip(rig(['next', '--work', 'landed']).out), /folder is still on this machine[^\n]*\n\s*rig close/)
})

test('close clears this machine\'s copy and nothing that leaves it', () => {
  const record = fs.readFileSync(recordFile('landed'), 'utf8')
  const tracker = JSON.stringify(github())
  const head = gitMust(dataRoot, 'rev-parse', 'HEAD')
  const r = rig(['close', '--work', 'landed'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /cleared this machine's copy of landed — it was closed on 2026-09-30, and its record is unchanged/)
  assert.equal(fs.existsSync(path.join(workRoot, 'landed')), false, 'the folder is gone')
  assert.equal(hasBranch(mirror('billing'), 'feat/landed-work'), false, 'the mirror copy landed, so it went')
  assert.equal(hasBranch(bare('billing'), 'feat/landed-work'), true, 'the remote was the first close\'s to decide')
  assert.equal(fs.readFileSync(recordFile('landed'), 'utf8'), record, 'the record is byte-identical')
  assert.equal(JSON.stringify(github()), tracker, 'GitHub heard nothing')
  assert.equal(gitMust(dataRoot, 'rev-parse', 'HEAD'), head, 'the data root has no new commit')
})

test('close again finds nothing here, says so, and succeeds', () => {
  const r = rig(['close', '--work', 'landed'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /landed was already closed on 2026-09-30 — nothing of it is on this machine/)
})

// A commit made after the merge is not at risk: removing a worktree keeps its branch, and the
// mirror keeps a copy whose commits did not land. An uncommitted change has no such copy.
test('a leftover with an uncommitted change refuses the close, and keeps everything', () => {
  const dest = closedElsewhere('unsaved', 51)
  fs.writeFileSync(path.join(dest, 'NOTES.md'), 'unsaved\n')
  const r = rig(['close', '--work', 'unsaved'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /not clearing unsaved — it was closed on 2026-09-30[\s\S]*billing: 1 uncommitted change\(s\)/)
  assert.ok(fs.existsSync(path.join(dest, 'NOTES.md')))
})

test('tidy --dry-run says what it would clear and skip, and changes nothing', () => {
  closedElsewhere('tidy-me', 52)
  const r = rig(['tidy', '--dry-run'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /would clear tidy-me — closed on 2026-09-30/)
  assert.match(strip(r.out), /would skip unsaved/)
  assert.ok(fs.existsSync(worktree('tidy-me', 'billing')))
})

test('tidy clears every clean leftover, skips the one with work only here, and says how to force it', () => {
  const r = rig(['tidy'])
  assert.equal(r.code, 1, 'a skipped leftover is something still to look at')
  assert.match(strip(r.out), /cleared tidy-me — closed on 2026-09-30/)
  assert.match(strip(r.out), /skipped unsaved[\s\S]*`rig close --work unsaved --force` to discard it/)
  assert.equal(fs.existsSync(path.join(workRoot, 'tidy-me')), false)
  assert.ok(fs.existsSync(worktree('unsaved', 'billing')))
})

test('close --force clears a leftover past what exists only here', () => {
  const r = rig(['close', '--work', 'unsaved', '--force'])
  assert.equal(r.code, 0, r.out)
  assert.equal(fs.existsSync(path.join(workRoot, 'unsaved')), false)
})

test('a commit on a detached HEAD after the merge refuses the close, because no branch holds it', () => {
  const dest = closedElsewhere('detached', 53)
  gitMust(dest, 'checkout', '-q', '--detach')
  commitWork(dest, 'detached: after the merge')
  const r = rig(['close', '--work', 'detached'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /billing: 1 commit\(s\) on a detached HEAD that no branch holds/)
  assert.equal(rig(['close', '--work', 'detached', '--force']).code, 0)
})

test('a file in the folder that is not one of the work\'s repos refuses the close, and is kept', () => {
  closedElsewhere('notes-here', 54)
  const notes = path.join(workRoot, 'notes-here', 'scratch.md')
  fs.writeFileSync(notes, 'mine\n')
  const r = rig(['close', '--work', 'notes-here'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /scratch\.md: not one of the work's repos/)
  assert.ok(fs.existsSync(notes))
  assert.equal(rig(['close', '--work', 'notes-here', '--force']).code, 0)
})

test('commits the remote lacks on a branch whose PR did not merge refuse the close', () => {
  const dest = closedElsewhere('unmerged', 55, { state: 'CLOSED' })
  commitWork(dest, 'unmerged: never pushed')
  const r = rig(['close', '--work', 'unmerged'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /billing: 1 unpushed commit\(s\)/)
  assert.equal(rig(['close', '--work', 'unmerged', '--force']).code, 0)
})

test('an open PR on a leftover does not refuse the close: it is on GitHub, not on this disk', () => {
  closedElsewhere('still-open', 56, { state: 'OPEN', stamp: { abandonedAt: '2026-09-30T12:00:00.000Z' } })
  assert.match(strip(rig(['doctor']).out), /still-open: abandoned on 2026-09-30, but its folder is still on this machine/)
  const r = rig(['close', '--work', 'still-open'])
  assert.equal(r.code, 0, r.out)
  assert.equal(hasBranch(mirror('billing'), 'feat/still-open-work'), true, 'nothing landed, so the mirror keeps the branch')
})

test("a leftover whose stage GitHub would not answer for keeps the mirror's branches, and says why", () => {
  // The clear drops the mirror's copies only when the work is done, and a stage rig could not
  // ask about may not have landed: keeping them is right, keeping them silently is not.
  closedElsewhere('flaky', 58, { stage: 'feat/flaky-one' })
  const state = github()
  const failing = structuredClone(state)
  failing.repos['acme/billing'].branchLookupFails = { 'feat/flaky-one': 'HTTP 502: Bad Gateway' }
  setGithub(failing)
  const r = rig(['close', '--work', 'flaky'])
  setGithub(state)
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /kept the mirror's copies of flaky's branches — GitHub would not say whether feat\/flaky-one landed/)
  assert.match(strip(r.out), /cleared this machine's copy of flaky/)
  assert.equal(hasBranch(mirror('billing'), 'feat/flaky-work'), true)
})

test('a close date that is not a string is reported, not a crash', () => {
  closedElsewhere('odd-date', 57, { stamp: { closedAt: 20260930 } })
  const r = rig(['doctor'])
  assert.doesNotMatch(r.out, /TypeError/)
  assert.match(strip(r.out), /odd-date: closed on 20260930, but its folder is still on this machine/)
  assert.equal(rig(['close', '--work', 'odd-date']).code, 0)
})

test('with every leftover gone, tidy has nothing to do and doctor nothing to say about them', () => {
  assert.match(strip(rig(['tidy']).out), /nothing to tidy/)
  assert.doesNotMatch(strip(rig(['doctor']).out), /still on this machine/)
})

test('tidy names a record it could not read rather than passing over it', () => {
  closedElsewhere('garbled', 58)
  fs.writeFileSync(recordFile('garbled'), '{ not json')
  assert.match(strip(rig(['tidy', '--dry-run']).out), /could not be read and was left out: garbled/)
})
