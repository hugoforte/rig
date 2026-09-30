// `rig pr`: one pull request per repo, work branch to the base it was cut from.
//
// Review is the phase rig was most obviously absent from: it has read PR state everywhere
// since it existed and had never opened one. Not a gate — a command you run when the stages
// are in.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { billingInstall, slicedWork } from './billing-install.mjs'

const m = billingInstall('rig-pr-')
const { dataRoot, rig, gitMust, github, setGithub, worktree, cleanup } = m

after(cleanup)

// The two-stage work this file renders: the first slice landed, the second is up for review.
before(() => slicedWork(m))

test('pr refuses on a work with nothing attached, rather than succeeding at nothing', () => {
  assert.equal(rig(['new', 'to-review', '--title', 'Work to review', '--type', 'feat', '--no-ticket']).code, 0)
  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no repos attached/)
})

test('an unpushed branch is told to push rather than having a PR opened on nothing', () => {
  assert.equal(rig(['attach', 'billing', '--work', 'to-review']).code, 0)
  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /is not on the remote yet — push it first/)
})

test('pr --help prints how pr is used and opens nothing', () => {
  const dest = worktree('to-review', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'reviewable\n')
  gitMust(dest, 'commit', '-qam', 'reviewable')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  const before = github().repos['acme/billing'].prs.length

  const r = rig(['pr', '--work', 'to-review', '--help'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^ {2}rig pr {2,}open one PR per repo/)
  assert.equal(github().repos['acme/billing'].prs.length, before, 'no pull request opened')
})

test('pr opens one per repo, work branch to the base it was cut from', () => {
  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: PR #\d+ → main/)

  const opened = github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/work-to-review')
  assert.ok(opened, 'it reached GitHub through the adapter, not by shelling out on its own')
  assert.equal(opened.base, 'main')
  assert.equal(opened.state, 'OPEN')
})

test('the body carries the title, the ticket line and the context doc, not a paraphrase', () => {
  const opened = github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/work-to-review')
  assert.match(opened.title, /Work to review/)
  assert.match(opened.body, /Context doc:/)
})

test('the Direction the design was agreed in is lifted verbatim, and the stub never is', () => {
  // The scaffolded `_TODO_` says nothing, and an empty section is worse than none.
  assert.doesNotMatch(github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/work-to-review').body,
    /## Direction/)

  // A second work, so the first is left as it is for the idempotence test below.
  assert.equal(rig(['new', 'reviewed-2', '--title', 'Second', '--type', 'feat', '--no-ticket']).code, 0)
  const doc = path.join(dataRoot, 'work', 'reviewed-2', 'context.md')
  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('_TODO_', 'Because the adjacent effort would have cost a third major.'))
  assert.equal(rig(['attach', 'billing', '--work', 'reviewed-2']).code, 0)
  const dest = worktree('reviewed-2', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'second\n')
  gitMust(dest, 'commit', '-qam', 'second')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')

  const r = rig(['pr', '--work', 'reviewed-2'])
  assert.equal(r.code, 0, r.out)
  const opened = github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/second')
  assert.match(opened.body, /## Direction\n\nBecause the adjacent effort would have cost a third major\./)
})

test('running it again reports the open PR instead of opening a second', () => {
  const before = github().repos['acme/billing'].prs.length
  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /is already open/)
  assert.equal(github().repos['acme/billing'].prs.length, before, 'idempotent, like every other command')
})

test('a PR state GitHub would not answer for opens nothing, rather than opening a duplicate', () => {
  const state = github()
  const before = state.repos['acme/billing'].prs.length
  setGithub({ ...state, auth: 'missing' })
  const r = rig(['pr', '--work', 'to-review'])
  assert.match(r.out, /GitHub would not say whether a PR exists/)
  assert.doesNotMatch(r.out, /PR #\d+ →/)
  setGithub(state)
  assert.equal(github().repos['acme/billing'].prs.length, before, 'and nothing was opened blind')
})

test('an unauthenticated gh cannot be told from "no PR", so the refusal lands on the write', () => {
  // The adapter's contract: a lookup that failed and a lookup that found nothing both answer
  // null. So this path reaches `createPr`, which refuses — which is the safe direction, and
  // worth pinning because the alternative is a duplicate PR.
  const state = github()
  const before = state.repos['acme/billing'].prs.length
  setGithub({ ...state, auth: 'unauthenticated' })
  const r = rig(['pr', '--work', 'to-review'])
  assert.match(r.out, /could not open a PR/)
  setGithub(state)
  assert.equal(github().repos['acme/billing'].prs.length, before)
})

test('the stage table in the body is rendered from the stack, never hand-typed', () => {
  const dest = worktree('sliced', 'billing')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  const r = rig(['pr', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  const opened = github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/sliced-work')
  assert.ok(opened, 'a PR was opened for the sliced work')
  assert.match(opened.body, /## Stages/)
  // The same renderer the rollout plan uses: two generators would be two tables that disagree.
  assert.match(opened.body, /\| 1 \| `feat\/sliced-one` \| the schema \| billing \| #10 \| landed \|/)
  assert.match(opened.body, /\| 2 \| `feat\/sliced-two` \| the endpoints \| billing \| #11 \| up for review \|/)
})

test('a worktree left on a stage that landed is told how to get back to the work branch (#200)', () => {
  // Every stage merged on GitHub and the stage branch was deleted there, and the worktree is
  // still where the last push left it: on the stage, with the work branch behind the remote's.
  assert.equal(rig(['new', 'landed', '--title', 'Landed work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'landed']).code, 0)
  assert.equal(rig(['stage', 'feat/landed-one', '--delivers', 'the schema', '--work', 'landed']).code, 0)
  const dest = worktree('landed', 'billing')
  const work = 'feat/landed-work'
  gitMust(dest, 'push', '-q', 'origin', work)
  gitMust(dest, 'checkout', '-q', '-b', 'feat/landed-one')
  fs.appendFileSync(path.join(dest, 'README.md'), 'the schema\n')
  gitMust(dest, 'commit', '-qam', 'the schema')
  gitMust(dest, 'push', '-q', 'origin', `feat/landed-one:${work}`)
  const state = github()
  state.repos['acme/billing'].prs.push({ branch: 'feat/landed-one', number: 30, state: 'MERGED', url: 'https://github.com/acme/billing/pull/30', base: work, openedAt: '2026-09-19T00:00:00Z', mergedAt: '2026-09-19T12:00:00Z', commits: [] })
  setGithub(state)

  const r = rig(['pr', '--work', 'landed'])
  assert.equal(r.code, 0, r.out)
  const commands = [`git switch ${work}`, `git pull --ff-only origin ${work}`]
  assert.ok(r.out.includes(`billing: the worktree is still on feat/landed-one, a stage that has landed — \`${commands[0]}\`, then \`${commands[1]}\``), r.out)
  assert.ok(github().repos['acme/billing'].prs.some(pr => pr.branch === work), 'the PR is opened all the same')

  // And the commands it names do what they say.
  for (const command of commands) gitMust(dest, ...command.split(' ').slice(1))
  assert.equal(gitMust(dest, 'branch', '--show-current'), work)
  assert.match(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), /the schema/)
})

test('pr --refresh rewrites an open PR from the record as it stands now', () => {
  const doc = path.join(dataRoot, 'work', 'reviewed-2', 'context.md')
  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('Because the adjacent effort would have cost a third major.', 'Because a trial run showed the cheaper path.'))
  assert.equal(rig(['ticket', 'acme/billing#12', '--work', 'reviewed-2']).code, 0)
  assert.equal(rig(['save', '--title', 'Second, as it turned out', '--work', 'reviewed-2']).code, 0)

  const r = rig(['pr', '--refresh', '--work', 'reviewed-2'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: PR #\d+ refreshed from the record/)
  const pr = github().repos['acme/billing'].prs.find(p => p.branch === 'feat/second')
  assert.equal(pr.title, 'Second, as it turned out')
  assert.match(pr.body, /^Second, as it turned out\n\nTickets: acme\/billing#12\n\n## Direction\n\nBecause a trial run showed the cheaper path\.\n/)
})

test('pr --refresh again finds nothing to change, and edits nothing', () => {
  const before = github().repos['acme/billing'].prs.find(p => p.branch === 'feat/second')
  const r = rig(['pr', '--refresh', '--work', 'reviewed-2'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: PR #\d+ is already up to date/)
  assert.deepEqual(github().repos['acme/billing'].prs.find(p => p.branch === 'feat/second'), before)
})

test('a body GitHub hands back with CRLF line ends and a trailing newline still counts as up to date', () => {
  const state = github()
  const pr = state.repos['acme/billing'].prs.find(p => p.branch === 'feat/second')
  pr.body = `${pr.body.replace(/\n/g, '\r\n')}\r\n`
  setGithub(state)
  const r = rig(['pr', '--refresh', '--work', 'reviewed-2'])
  assert.match(r.out, /billing: PR #\d+ is already up to date/)
})

test('list --json leaves out the PR title and body the refresh compares', () => {
  const listed = JSON.parse(rig(['list', '--json']).out)
  const repo = listed.works.find(w => w.id === 'reviewed-2').repos[0]
  assert.ok(repo.pr.number, 'the PR itself is listed')
  assert.deepEqual([repo.pr.title, repo.pr.body], [undefined, undefined])
})

test('a stage GitHub will not answer for stops the refresh, rather than writing "PR state unknown" into the PR', () => {
  const state = github()
  setGithub({ ...state, auth: 'missing' })
  const r = rig(['pr', '--refresh', '--work', 'sliced'])
  setGithub(state)
  assert.match(r.out, /would not say what became of feat\/sliced-one, feat\/sliced-two — nothing refreshed/)
})

test('an unauthenticated gh is not reported as having no open PR, and nothing is refreshed', () => {
  const state = github()
  setGithub({ ...state, auth: 'unauthenticated' })
  const r = rig(['pr', '--refresh', '--work', 'reviewed-2'])
  setGithub(state)
  assert.match(r.out, /GitHub would not say whether a PR is open \(gh is unauthenticated\) — nothing refreshed/)
  assert.doesNotMatch(r.out, /no open PR/)
})

test('dropping a stage changes the stage table, so the open PR is offered a refresh that says so', () => {
  assert.equal(rig(['stage', 'feat/sliced-three', '--delivers', 'the UI', '--work', 'sliced']).code, 0)
  assert.equal(rig(['pr', '--refresh', '--work', 'sliced']).code, 0)
  assert.equal(rig(['stage', 'feat/sliced-three', '--dropped', 'the UI moved to its own work', '--work', 'sliced']).code, 0)
  assert.match(rig(['next', '--work', 'sliced']).out, /rig pr --refresh/)
  assert.equal(rig(['pr', '--refresh', '--work', 'sliced']).code, 0)
  const body = github().repos['acme/billing'].prs.find(p => p.branch === 'feat/sliced-work').body
  assert.match(body, /\| `feat\/sliced-three` \| the UI \| — \| — \| dropped: the UI moved to its own work \|/)
})

test('pr --refresh with no open PR says so and opens nothing', () => {
  assert.equal(rig(['new', 'unopened', '--title', 'Not up yet', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'unopened']).code, 0)
  const before = github().repos['acme/billing'].prs.length
  const r = rig(['pr', '--refresh', '--work', 'unopened'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: no open PR — nothing to refresh/)
  assert.equal(github().repos['acme/billing'].prs.length, before)
})

test('rig next offers the refresh while an open PR says something the record no longer does', () => {
  assert.equal(rig(['ticket', 'acme/billing#13', '--work', 'reviewed-2']).code, 0)
  assert.match(rig(['next', '--work', 'reviewed-2']).out, /rig pr --refresh/)
  assert.equal(rig(['pr', '--refresh', '--work', 'reviewed-2']).code, 0)
  assert.doesNotMatch(rig(['next', '--work', 'reviewed-2']).out, /rig pr --refresh/)
})
