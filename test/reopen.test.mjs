// `rig reopen`: a work closed or abandoned by mistake goes back to open, its folder comes back
// from the record, and its tickets are told (hugoforte/rig#350).
//
// One installation, shared, and the tests on one work are one story, each standing on what the
// one before left.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { strip } from './harness.mjs'
import { billingInstall } from './billing-install.mjs'

const { dataRoot, workRoot, rig, gitMust, commitWork, github, setGithub, squashMergeAndDeleteBranch, seedIssue, seedJiraIssue, jiraIssue, seedPr, issueNumbered, worktree, record, cleanup } = billingInstall('rig-reopen-')

after(cleanup)

const lastCommit = () => gitMust(dataRoot, 'log', '-1', '--format=%s')

test('a work abandoned with its PR open', () => {
  seedIssue(11, 'the thing worth keeping')
  assert.equal(rig(['new', 'kept', '--title', 'Kept work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['ticket', 'acme/billing#11', '--work', 'kept']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'kept']).code, 0)
  const dest = worktree('kept', 'billing')
  commitWork(dest, 'the work')
  gitMust(dest, 'push', '-q', 'origin', 'feat/kept-work')
  seedPr({ branch: 'feat/kept-work', number: 21, state: 'OPEN', url: 'https://github.com/acme/billing/pull/21', mergedAt: null })

  const r = rig(['close', '--abandoned', '--work', 'kept'])
  assert.equal(r.code, 0, r.out)
  assert.ok(record('kept').abandonedAt)
  assert.equal(issueNumbered(11).comments.length, 1)
})

test('reopen puts the record back to open', () => {
  const was = record('kept')
  const r = rig(['reopen', 'kept'])
  assert.equal(r.code, 0, r.out)
  const w = record('kept')
  assert.deepEqual([w.closedAt, w.abandonedAt], [undefined, undefined])
  assert.deepEqual(w.reopened.map(({ at: _, ...rest }) => rest), [{ closedAt: was.closedAt, abandonedAt: was.abandonedAt }])
})

test('reopen records when it ran', () => {
  assert.ok(!Number.isNaN(Date.parse(record('kept').reopened[0].at)))
})

test('reopen puts the worktree back on the work branch, with the commit the close left on it', () => {
  const dest = worktree('kept', 'billing')
  assert.equal(gitMust(dest, 'branch', '--show-current'), 'feat/kept-work')
  assert.equal(gitMust(dest, 'log', '-1', '--format=%s'), 'the work')
})

test('reopen writes the work folder rig generates', () => {
  assert.equal(fs.readFileSync(path.join(workRoot, 'kept', '.rig', 'id'), 'utf8').trim(), 'kept')
})

test('reopen tells the ticket the work is open again, and leaves it open', () => {
  const issue = issueNumbered(11)
  assert.deepEqual([issue.state, issue.comments.length], ['OPEN', 2])
  assert.match(issue.comments[1], /^Reopened — `rig reopen` ran\. The work was abandoned on \d{4}-\d\d-\d\d and is open again\./)
})

test('reopen commits the data root under its own name', () => {
  assert.equal(lastCommit(), 'rig reopen kept')
})

test('a reopened work reads as the phase its PR puts it in', () => {
  assert.match(strip(rig(['status', '--work', 'kept']).out), /^phase Reviewing$/m)
})

test('status says when the work was reopened, and what it had been', () => {
  assert.match(strip(rig(['status', '--work', 'kept']).out), /^ {2}reopened \d{4}-\d\d-\d\d \(abandoned \d{4}-\d\d-\d\d\)$/m)
})

test('list --json carries the reopening', () => {
  const work = JSON.parse(rig(['list', '--json', '--quick']).stdout).works.find(w => w.id === 'kept')
  assert.equal(work.reopened.length, 1)
})

test('reopen refuses a work that is open', () => {
  const r = rig(['reopen', 'kept'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /kept is open — there is nothing to reopen/)
})

test('the next close of a reopened work closes it again', () => {
  const r = rig(['close', '--abandoned', '--work', 'kept'])
  assert.equal(r.code, 0, r.out)
  assert.ok(record('kept').abandonedAt)
})

test('a second reopen keeps the first in the record', () => {
  assert.equal(rig(['reopen', 'kept']).code, 0)
  assert.equal(record('kept').reopened.length, 2)
})

// ------------------------------------------------- a work that landed

test('reopen refuses a work whose PR merged, and changes nothing', () => {
  assert.equal(rig(['new', 'landed', '--title', 'Landed work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'landed']).code, 0)
  const dest = worktree('landed', 'billing')
  commitWork(dest, 'landed work')
  gitMust(dest, 'push', '-q', 'origin', 'feat/landed-work')
  squashMergeAndDeleteBranch('billing', 'feat/landed-work', 22)
  seedPr({ branch: 'feat/landed-work', number: 22, state: 'MERGED', url: 'https://github.com/acme/billing/pull/22', mergedAt: '2026-09-20T00:00:00Z' })
  assert.equal(rig(['close', '--work', 'landed']).code, 0)
  const was = record('landed')

  const r = rig(['reopen', 'landed'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /landed landed — billing's PR #22 merged; a new work on its ticket is the way on/)
  assert.deepEqual(record('landed'), was)
})

test('restore on a work that landed does not offer the reopen it would refuse', () => {
  assert.doesNotMatch(rig(['restore', 'landed']).out, /rig reopen/)
})

test('reopen asks GitHub for a merged PR the close could not record, and refuses on it', () => {
  assert.equal(rig(['new', 'unrecorded', '--title', 'Unrecorded work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'unrecorded']).code, 0)
  const dest = worktree('unrecorded', 'billing')
  commitWork(dest, 'unrecorded work')
  gitMust(dest, 'push', '-q', 'origin', 'feat/unrecorded-work')
  squashMergeAndDeleteBranch('billing', 'feat/unrecorded-work', 23)
  seedPr({ branch: 'feat/unrecorded-work', number: 23, state: 'MERGED', url: 'https://github.com/acme/billing/pull/23', mergedAt: '2026-09-20T00:00:00Z' })
  assert.equal(rig(['close', '--work', 'unrecorded']).code, 0)
  // What a close leaves when GitHub would not give the PR's timing: the work landed, and its
  // record holds no PR, with a warning to `rig backfill`.
  const file = path.join(dataRoot, 'work', 'unrecorded', 'work.json')
  const w = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete w.repos[0].branches[0].pr
  fs.writeFileSync(file, JSON.stringify(w, null, 2))

  const r = rig(['reopen', 'unrecorded'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /unrecorded landed — billing's PR #23 merged/)
})

test('a work abandoned with every PR merged reopens, since the abandon closed no ticket and deleted no branch', () => {
  assert.equal(rig(['new', 'misread', '--title', 'Misread work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'misread']).code, 0)
  const dest = worktree('misread', 'billing')
  commitWork(dest, 'misread work')
  gitMust(dest, 'push', '-q', 'origin', 'feat/misread-work')
  seedPr({ branch: 'feat/misread-work', number: 24, state: 'MERGED', url: 'https://github.com/acme/billing/pull/24', mergedAt: '2026-09-20T00:00:00Z' })
  assert.equal(rig(['close', '--abandoned', '--work', 'misread']).code, 0)
  assert.equal(record('misread').repos[0].branches[0].pr.number, 24, 'the abandon recorded the merged PR')

  const r = rig(['reopen', 'misread'])
  assert.equal(r.code, 0, r.out)
  assert.equal(record('misread').closedAt, undefined)
})

// ------------------------------------------------- a forced close

test('reopen moves a forced close\'s mark into the history, so the next close is not called forced', () => {
  seedIssue(13, 'forced past by mistake')
  assert.equal(rig(['new', 'forced', '--title', 'Forced work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['ticket', 'acme/billing#13', '--work', 'forced']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'forced']).code, 0)
  commitWork(worktree('forced', 'billing'), 'never pushed')
  assert.equal(rig(['close', '--force', '--work', 'forced']).code, 0)
  const was = record('forced').forcedAt
  assert.ok(was)

  assert.equal(rig(['reopen', 'forced']).code, 0)
  const w = record('forced')
  assert.deepEqual([w.forcedAt, w.reopened[0].forcedAt], [undefined, was])
})

test('reopen puts back a branch that was never pushed, from the mirror', () => {
  assert.equal(gitMust(worktree('forced', 'billing'), 'log', '-1', '--format=%s'), 'never pushed')
})

test('the next close of a reopened forced work does not tell the ticket it was forced', () => {
  const dest = worktree('forced', 'billing')
  gitMust(dest, 'reset', '-q', '--hard', 'origin/main')
  assert.equal(rig(['close', '--work', 'forced']).code, 0)
  assert.match(issueNumbered(13).comments.at(-1), /^Closed by `rig close`\. /)
})

// ------------------------------------------------- attempts the close ended

test('a set of attempts the abandon dropped opens again, with its folders', () => {
  assert.equal(rig(['new', 'paused', '--title', 'Paused work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'paused']).code, 0)
  assert.equal(rig(['attempt', '--n', '2', '--work', 'paused'], { cwd: worktree('paused', 'billing') }).code, 0)
  assert.equal(rig(['close', '--abandoned', '--work', 'paused']).code, 0)
  assert.equal(record('paused').attempts[0].reason, 'the work was abandoned')

  const r = rig(['reopen', 'paused'])
  assert.equal(r.code, 0, r.out)
  const set = record('paused').attempts[0]
  assert.deepEqual([set.droppedAt, set.reason, fs.existsSync(path.join(workRoot, 'paused', 'billing@2'))], [undefined, undefined, true])
})

test('a set dropped for its own reason stays dropped', () => {
  assert.equal(rig(['attempt', 'feat/paused-work', '--dropped', 'neither was right', '--work', 'paused']).code, 0)
  assert.equal(rig(['close', '--abandoned', '--work', 'paused']).code, 0)
  assert.equal(rig(['reopen', 'paused']).code, 0)
  assert.equal(record('paused').attempts[0].reason, 'neither was right')
})

// ------------------------------------------------- tickets

test('a ticket the work and a stage both hold is told once, and a Jira one is told to move it back', () => {
  seedIssue(14, 'held twice')
  seedJiraIssue('PROJ-7', 'held in Jira')
  assert.equal(rig(['new', 'told', '--title', 'Told work', '--type', 'chore', '--no-ticket']).code, 0)
  assert.equal(rig(['ticket', 'acme/billing#14', '--work', 'told']).code, 0)
  assert.equal(rig(['ticket', 'PROJ-7', '--work', 'told']).code, 0)
  assert.equal(rig(['stage', 'feat/told-one', '--delivers', 'a slice', '--key', 'acme/billing#14', '--work', 'told']).code, 0)
  assert.equal(rig(['close', '--abandoned', '--work', 'told']).code, 0)
  const before = issueNumbered(14).comments.length

  assert.equal(rig(['reopen', 'told']).code, 0)
  const jira = jiraIssue('PROJ-7').comments.at(-1)
  assert.deepEqual([issueNumbered(14).comments.length - before, /move this one yourself/.test(jira)], [1, true])
})

// ------------------------------------------------- a work with nothing attached

test('a work with no repos reopens to a folder of its own', () => {
  assert.equal(rig(['new', 'bare', '--title', 'Bare work', '--type', 'chore', '--no-ticket']).code, 0)
  assert.equal(rig(['close', '--work', 'bare']).code, 0)
  assert.ok(!fs.existsSync(path.join(workRoot, 'bare')))

  const r = rig(['reopen', '--work', 'bare'])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(workRoot, 'bare', 'AGENTS.md')))
})

test('a tracker that will not answer is warned about, and the reopen still lands', () => {
  seedIssue(12, 'asked of a GitHub that is signed out')
  assert.equal(rig(['new', 'offline', '--title', 'Offline work', '--type', 'chore', '--no-ticket']).code, 0)
  assert.equal(rig(['ticket', 'acme/billing#12', '--work', 'offline']).code, 0)
  assert.equal(rig(['close', '--abandoned', '--work', 'offline']).code, 0)
  const state = github()
  state.auth = 'unauthenticated'
  setGithub(state)
  try {
    const r = rig(['reopen', 'offline'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /acme\/billing#12: could not comment/)
    assert.equal(record('offline').closedAt, undefined)
  } finally {
    state.auth = 'ok'
    setGithub(state)
  }
})
