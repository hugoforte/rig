// A stage's own ticket, and what `close` does about it.
//
// GitHub fires a closing keyword only for a pull request that merges into the default
// branch, and a stage's pull request merges into the work branch — so a slice's ticket
// cannot close itself, and `rig close` is the one moment anything speaks for it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { billingInstall } from './billing-install.mjs'

const { rig, gitMust, commitWork, seedIssue, seedJiraIssue, jiraIssue, seedPr, withVisibility, worktree, record, issueNumbered, github, setGithub, cleanup } = billingInstall('rig-stage-tickets-')

after(cleanup)

test('a slice that landed closes its own ticket, at the one moment rig speaks', () => {
  assert.equal(rig(['new', 'ticketed', '--title', 'Ticketed work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'ticketed']).code, 0)
  seedIssue(7, 'the schema')

  const dest = worktree('ticketed', 'billing')
  const r = rig(['stage', 'feat/ticketed-one', '--delivers', 'the schema', '--key', 'acme/billing#7', '--cut', '--work', 'ticketed'], { cwd: dest })
  assert.equal(r.code, 0, r.out)
  commitWork(dest, 'the schema')
  gitMust(dest, 'checkout', '-q', 'feat/ticketed-work')
  // Merged down, not squashed: the convention the derived stack relies on.
  gitMust(dest, 'merge', '-q', '--no-ff', '-m', 'merge the schema', 'feat/ticketed-one')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')

  seedPr({ branch: 'feat/ticketed-one', number: 30, state: 'MERGED', base: 'feat/ticketed-work', url: 'https://github.com/acme/billing/pull/30', mergedAt: '2026-09-19T10:00:00Z' })
  seedPr({ branch: 'feat/ticketed-work', number: 31, state: 'MERGED', base: 'main', url: 'https://github.com/acme/billing/pull/31', mergedAt: '2026-09-19T11:00:00Z' })

  const c = rig(['close', '--work', 'ticketed'])
  assert.equal(c.code, 0, c.out)
  assert.ok(c.out.includes('closed acme/billing#7 (stage feat/ticketed-one landed)'), c.out)
  assert.equal(issueNumbered(7).state, 'CLOSED')
  assert.match(issueNumbered(7).comments[0], /The slice this was opened for landed/)
  // A private repo is no more visible than a data root with no remote, so it may name it.
  assert.match(issueNumbered(7).comments[0], /\nContext doc: work\/ticketed\/context\.md in the rig data root$/)
})

test('a public repo\'s tickets are told what landed without the private data root\'s link (#202)', () => {
  assert.equal(rig(['new', 'in-public', '--title', 'In public', '--type', 'feat', '--key', 'acme/billing#60']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'in-public']).code, 0)
  seedIssue(60, 'In public')
  seedIssue(61, 'the public slice')
  const dest = worktree('in-public', 'billing')
  assert.equal(rig(['stage', 'feat/in-public-one', '--delivers', 'the slice', '--key', 'acme/billing#61', '--cut', '--work', 'in-public'], { cwd: dest }).code, 0)
  commitWork(dest, 'the slice')
  gitMust(dest, 'checkout', '-q', 'feat/in-public')
  gitMust(dest, 'merge', '-q', '--no-ff', '-m', 'merge the slice', 'feat/in-public-one')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  seedPr({ branch: 'feat/in-public-one', number: 62, state: 'MERGED', base: 'feat/in-public', url: 'https://github.com/acme/billing/pull/62', mergedAt: '2026-09-19T10:00:00Z' })
  seedPr({ branch: 'feat/in-public', number: 63, state: 'MERGED', base: 'main', url: 'https://github.com/acme/billing/pull/63', mergedAt: '2026-09-19T11:00:00Z' })

  const c = withVisibility('acme/billing', 'public', () => rig(['close', '--work', 'in-public']))
  assert.equal(c.code, 0, c.out)
  for (const n of [60, 61]) {
    assert.equal(issueNumbered(n).state, 'CLOSED')
    assert.doesNotMatch(issueNumbered(n).comments.join('\n'), /Context doc|context\.md/)
  }
})

test('a pull request opened after a work closed is reported by status, which has the facts', () => {
  // The rule's second term is live state, so it can turn true long after the record stopped
  // moving. `rig status` is where it fires because it is the command that already looked the
  // pull requests up; `doctor` asks the records alone, over every work.
  seedPr({ branch: 'feat/ticketed-work', number: 32, state: 'OPEN', base: 'main', url: 'https://github.com/acme/billing/pull/32', mergedAt: null })
  const r = rig(['status', '--work', 'ticketed'])
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes('ticketed: closed, but billing still has PR #32 open'), r.out)
  assert.match(r.out, /should not be possible/)
})

test('a slice still up for review stops the work closing over it', () => {
  assert.equal(rig(['new', 'outstanding', '--title', 'Outstanding work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'outstanding']).code, 0)
  seedIssue(8, 'the endpoints')

  const dest = worktree('outstanding', 'billing')
  assert.equal(rig(['stage', 'feat/outstanding-one', '--delivers', 'the endpoints', '--key', 'acme/billing#8', '--cut', '--work', 'outstanding'], { cwd: dest }).code, 0)
  commitWork(dest, 'the endpoints')
  gitMust(dest, 'checkout', '-q', 'feat/outstanding-work')
  gitMust(dest, 'merge', '-q', '--no-ff', '-m', 'merge the endpoints', 'feat/outstanding-one')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')

  seedPr({ branch: 'feat/outstanding-one', number: 40, state: 'OPEN', base: 'feat/outstanding-work', url: 'https://github.com/acme/billing/pull/40', mergedAt: null })
  seedPr({ branch: 'feat/outstanding-work', number: 41, state: 'MERGED', base: 'main', url: 'https://github.com/acme/billing/pull/41', mergedAt: '2026-09-19T11:00:00Z' })

  const c = rig(['close', '--work', 'outstanding'])
  assert.equal(c.code, 1, c.out)
  assert.ok(c.out.includes('stage feat/outstanding-one still has PR #40 open'), c.out)
  assert.equal(issueNumbered(8).state, 'OPEN')
})

test('abandoning tells the slice ticket and leaves it open, like every other ticket', () => {
  const c = rig(['close', '--abandoned', '--work', 'outstanding'])
  assert.equal(c.code, 0, c.out)
  assert.ok(c.out.includes('left open: stage feat/outstanding-one did not land'), c.out)
  assert.equal(issueNumbered(8).state, 'OPEN')
  assert.match(issueNumbered(8).comments[0], /This slice did not land/)
})

test('forcing past an open slice records the decision, rather than leaving it unexplained', () => {
  assert.equal(rig(['new', 'forced', '--title', 'Forced work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'forced']).code, 0)
  const dest = worktree('forced', 'billing')
  assert.equal(rig(['stage', 'feat/forced-one', '--delivers', 'the schema', '--cut', '--work', 'forced'], { cwd: dest }).code, 0)
  commitWork(dest, 'the schema')
  gitMust(dest, 'checkout', '-q', 'feat/forced-work')
  gitMust(dest, 'merge', '-q', '--no-ff', '-m', 'merge the schema', 'feat/forced-one')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  seedPr({ branch: 'feat/forced-one', number: 50, state: 'OPEN', base: 'feat/forced-work', url: 'https://github.com/acme/billing/pull/50', mergedAt: null })
  seedPr({ branch: 'feat/forced-work', number: 51, state: 'MERGED', base: 'main', url: 'https://github.com/acme/billing/pull/51', mergedAt: '2026-09-19T11:00:00Z' })

  assert.equal(rig(['close', '--work', 'forced']).code, 1, 'it refuses first')
  const c = rig(['close', '--force', '--work', 'forced'])
  assert.equal(c.code, 0, c.out)
  assert.ok(record('forced').forcedAt, 'the force is a decision, and decisions are what rig records')
})

test('and a forced close is not then reported as a contradiction', () => {
  // `rig close --force` exists to tear down past exactly this, so the state is explained. The
  // rule fires on a record nothing can account for, never on a decision made on purpose.
  // It reads the work branch's own pull request, and #51 merged, so an open one is what gives
  // it something to fire on.
  seedPr({ branch: 'feat/forced-work', number: 54, state: 'OPEN', base: 'main', url: 'https://github.com/acme/billing/pull/54', mergedAt: null })
  const r = rig(['status', '--work', 'forced'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /should not be possible/)
})

test("close refuses while one stage's PR lookup fails, and --force goes past it", () => {
  // The work branch landed; whether the slice did is something GitHub would not say, and a
  // slice that may still be up for review is unfinished business (decision 173).
  assert.equal(rig(['new', 'unasked', '--title', 'Unasked work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'unasked']).code, 0)
  seedIssue(95, 'the unasked schema')
  const dest = worktree('unasked', 'billing')
  assert.equal(rig(['stage', 'feat/unasked-one', '--delivers', 'the schema', '--key', 'acme/billing#95', '--cut', '--work', 'unasked'], { cwd: dest }).code, 0)
  commitWork(dest, 'the schema')
  gitMust(dest, 'checkout', '-q', 'feat/unasked-work')
  gitMust(dest, 'merge', '-q', '--no-ff', '-m', 'merge the schema', 'feat/unasked-one')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  seedPr({ branch: 'feat/unasked-one', number: 96, state: 'MERGED', base: 'feat/unasked-work', url: 'https://github.com/acme/billing/pull/96', mergedAt: '2026-09-19T10:00:00Z' })
  seedPr({ branch: 'feat/unasked-work', number: 97, state: 'MERGED', base: 'main', url: 'https://github.com/acme/billing/pull/97', mergedAt: '2026-09-19T11:00:00Z' })
  const failing = github()
  failing.repos['acme/billing'].branchLookupFails = { 'feat/unasked-one': 'HTTP 502: Bad Gateway' }
  setGithub(failing)
  const n = rig(['next', '--work', 'unasked'])
  const c = rig(['close', '--work', 'unasked'])
  const f = rig(['close', '--force', '--work', 'unasked'])
  // The close commented on the ticket, so the lookup failure comes off what it left behind.
  const after = github()
  delete after.repos['acme/billing'].branchLookupFails
  setGithub(after)

  assert.doesNotMatch(n.out, /rig close/, 'a close that would refuse is not offered')
  assert.equal(c.code, 1, c.out)
  assert.ok(c.out.includes('billing: stage feat/unasked-one PR state unknown'), c.out)
  assert.equal(f.code, 0, f.out)
  assert.ok(record('unasked').forcedAt, 'forcing past it is recorded, like any blocker')
  // Its ticket is told what rig knows, which is not that the slice failed to land.
  assert.equal(issueNumbered(95).state, 'OPEN')
  assert.equal(issueNumbered(95).comments?.length, 1, f.out)
  assert.match(issueNumbered(95).comments[0], /GitHub would not say whether this slice landed, so the issue stays open\./)
  assert.ok(f.out.includes('left open: GitHub would not say whether stage feat/unasked-one landed'), f.out)
})

// The work branch landed and a slice of it did not — the one shape where the work's *own*
// ticket has something to answer for that its own pull request cannot say. Both tests below
// run against this fixture, which is why it is built in the first.

test('`rig next` does not offer to close a work it has just said has a slice up for review', () => {
  assert.equal(rig(['new', 'forced-ticket', '--title', 'Forced ticket work', '--type', 'feat', '--key', 'acme/billing#9']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'forced-ticket']).code, 0)
  seedIssue(9, 'Forced ticket work')

  const dest = worktree('forced-ticket', 'billing')
  assert.equal(rig(['stage', 'feat/forced-ticket-one', '--delivers', 'the schema', '--cut', '--work', 'forced-ticket'], { cwd: dest }).code, 0)
  commitWork(dest, 'the schema')
  gitMust(dest, 'checkout', '-q', 'feat/forced-ticket-work')
  gitMust(dest, 'merge', '-q', '--no-ff', '-m', 'merge the schema', 'feat/forced-ticket-one')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  seedPr({ branch: 'feat/forced-ticket-one', number: 52, state: 'OPEN', base: 'feat/forced-ticket-work', url: 'https://github.com/acme/billing/pull/52', mergedAt: null })
  seedPr({ branch: 'feat/forced-ticket-work', number: 53, state: 'MERGED', base: 'main', url: 'https://github.com/acme/billing/pull/53', mergedAt: '2026-09-19T11:00:00Z' })

  const r = rig(['next', '--work', 'forced-ticket'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /feat\/forced-ticket-one.*up for review/)
  assert.doesNotMatch(r.out, /rig close/, 'a command that would refuse is not an offer')
})

test('and forcing the close past it leaves the work ticket open, naming the slice and the force', () => {
  assert.equal(rig(['close', '--work', 'forced-ticket']).code, 1, 'it refuses first')
  const c = rig(['close', '--force', '--work', 'forced-ticket'])
  assert.equal(c.code, 0, c.out)

  assert.equal(issueNumbered(9).state, 'OPEN', 'the work branch landed, but a slice of it did not')
  const comment = issueNumbered(9).comments[0]
  assert.match(comment, /billing: stage feat\/forced-ticket-one still has PR #52 open/)
  assert.match(comment, /^Closed by `rig close --force`\. The blockers were overridden deliberately\./,
    'a work torn down past an open PR must not read like one that had nothing to get past')
})

test('a dropped slice tells its ticket why, and leaves it open', () => {
  assert.equal(rig(['new', 'dropping', '--title', 'Dropping work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'dropping']).code, 0)
  seedIssue(11, 'the gathering')
  assert.equal(rig(['stage', 'feat/dropping-one', '--delivers', 'the gathering', '--key', 'acme/billing#11', '--work', 'dropping']).code, 0)
  assert.equal(rig(['stage', 'feat/dropping-one', '--dropped', 'worth about 15%', '--work', 'dropping']).code, 0)
  const c = rig(['close', '--abandoned', '--work', 'dropping'])
  assert.equal(c.code, 0, c.out)
  assert.equal(issueNumbered(11).state, 'OPEN')
  assert.match(issueNumbered(11).comments[0], /This slice was dropped: worth about 15%\. The issue stays open\./)
})

// A work rigged with `--key` for its ticket, and a stage declared with the same key: the shape
// `rig new --key` then `rig stage --key` makes for a work that is one slice of one ticket. The
// stage lands, and the work branch's own PR is seeded as `workPr` says.
// `jira` names a Jira key to hold both roles instead of the GitHub issue.
const bothRoles = ({ id, issue, stagePr, workPr, jira }) => {
  const key = jira || `acme/billing#${issue}`
  assert.equal(rig(['new', id, '--title', id, '--branch', `feat/${id}`, '--key', key]).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', id]).code, 0)
  if (jira) seedJiraIssue(jira, id)
  else seedIssue(issue, id)
  const dest = worktree(id, 'billing')
  const r = rig(['stage', `feat/${id}-one`, '--delivers', 'the slice', '--key', key, '--cut', '--work', id], { cwd: dest })
  assert.equal(r.code, 0, r.out)
  commitWork(dest, 'the slice')
  gitMust(dest, 'checkout', '-q', `feat/${id}`)
  gitMust(dest, 'merge', '-q', '--no-ff', '-m', 'merge the slice', `feat/${id}-one`)
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  seedPr({ branch: `feat/${id}-one`, number: stagePr, state: 'MERGED', base: `feat/${id}`, url: `https://github.com/acme/billing/pull/${stagePr}`, mergedAt: '2026-09-19T10:00:00Z' })
  seedPr({ branch: `feat/${id}`, base: 'main', url: `https://github.com/acme/billing/pull/${workPr.number}`, ...workPr })
}
const MERGED = { state: 'MERGED', mergedAt: '2026-09-19T11:00:00Z' }

test('a ticket that is the work\'s and a slice\'s is told once, with both PRs, and closed once (#229)', () => {
  bothRoles({ id: 'both-roles', issue: 70, stagePr: 71, workPr: { number: 72, ...MERGED } })
  const c = rig(['close', '--work', 'both-roles'])
  assert.equal(c.code, 0, c.out)
  assert.equal(c.out.match(/acme\/billing#70/g)?.length, 1, c.out)
  assert.equal(issueNumbered(70).state, 'CLOSED')
  assert.equal(issueNumbered(70).comments.length, 1)
  const [comment] = issueNumbered(70).comments
  assert.match(comment, /^The slice this was opened for landed/, 'the slice is the more specific news')
  assert.match(comment, /pull\/71\n- billing: https:\/\/github\.com\/acme\/billing\/pull\/72\n/, 'and the work PR is named beside the stage\'s')
})

test('a ticket in both roles stays open while the work has not landed, though its slice did (#229)', () => {
  bothRoles({ id: 'half-landed', issue: 73, stagePr: 74, workPr: { number: 75, state: 'OPEN', mergedAt: null } })
  assert.equal(rig(['close', '--work', 'half-landed']).code, 1, 'it refuses first')
  const c = rig(['close', '--force', '--work', 'half-landed'])
  assert.equal(c.code, 0, c.out)
  assert.equal(c.out.match(/acme\/billing#73/g)?.length, 1, c.out)
  assert.equal(issueNumbered(73).state, 'OPEN')
  assert.equal(issueNumbered(73).comments.length, 1)
  assert.match(issueNumbered(73).comments[0], /^`rig close --force` ran on half-landed\. The blockers were overridden deliberately\. The slice this was opened for landed in `feat\/half-landed`, but the work has not: Not every PR is merged — billing \(PR #75 open\)\. The issue stays open\./)
})

test('a ticket two slices hold is told once, naming both, and stays open for the one that did not land (#229)', () => {
  bothRoles({ id: 'two-slices', issue: 76, stagePr: 77, workPr: { number: 78, ...MERGED } })
  assert.equal(rig(['stage', 'feat/two-slices-two', '--delivers', 'the rest', '--key', 'acme/billing#76', '--work', 'two-slices']).code, 0)
  const c = rig(['close', '--work', 'two-slices'])
  assert.equal(c.code, 0, c.out)
  assert.equal(issueNumbered(76).state, 'OPEN')
  assert.equal(issueNumbered(76).comments.length, 1)
  const [comment] = issueNumbered(76).comments
  assert.match(comment, /The slice `feat\/two-slices-two` did not land, so the issue stays open\./)
  assert.match(comment, /\n\nStage: `feat\/two-slices-one` — the slice\nStage: `feat\/two-slices-two` — the rest\n/)
})

test('a withdrawn slice is what a ticket two slices hold is told stays open for (#229)', () => {
  assert.equal(rig(['new', 'withdrawn-two', '--title', 'Withdrawn two', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'withdrawn-two']).code, 0)
  seedIssue(79, 'withdrawn two')
  for (const b of ['one', 'two']) {
    assert.equal(rig(['stage', `feat/withdrawn-two-${b}`, '--delivers', `slice ${b}`, '--key', 'acme/billing#79', '--work', 'withdrawn-two']).code, 0)
  }
  assert.equal(rig(['stage', 'feat/withdrawn-two-one', '--dropped', 'not needed', '--work', 'withdrawn-two']).code, 0)
  const c = rig(['close', '--abandoned', '--work', 'withdrawn-two'])
  assert.equal(c.code, 0, c.out)
  assert.equal(issueNumbered(79).comments.length, 1)
  assert.match(issueNumbered(79).comments[0], /The slice `feat\/withdrawn-two-one` was dropped: not needed\. The issue stays open\./)
})

test('a Jira ticket that is the work\'s and a slice\'s is told once too, and never moved (#229)', () => {
  bothRoles({ id: 'jira-both', jira: 'PROJ-80', stagePr: 81, workPr: { number: 82, ...MERGED } })
  const c = rig(['close', '--work', 'jira-both'])
  assert.equal(c.code, 0, c.out)
  assert.equal(c.out.match(/PROJ-80/g)?.length, 1, c.out)
  const { comments } = jiraIssue('PROJ-80')
  assert.equal(comments.length, 1)
  assert.match(comments[0], /^The slice this was opened for landed[\s\S]*pull\/82\n[\s\S]*rig does not transition Jira tickets/)
})
