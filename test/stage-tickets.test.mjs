// A stage's own ticket, and what `close` does about it.
//
// GitHub fires a closing keyword only for a pull request that merges into the default
// branch, and a stage's pull request merges into the work branch — so a slice's ticket
// cannot close itself, and `rig close` is the one moment anything speaks for it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { billingInstall } from './billing-install.mjs'

const { rig, gitMust, github, commitWork, seedIssue, seedPr, worktree, record, issueNumbered, cleanup } = billingInstall('rig-stage-tickets-')

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
  const r = rig(['status', '--work', 'forced'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /should not be possible/)
  // Scoped to this work: the shared installation carries other works with contradictions of
  // their own, which is the point of `doctor` running over all of them.
  assert.doesNotMatch(rig(['doctor']).out, /forced: closed, but/)
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
