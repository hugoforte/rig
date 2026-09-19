// `rig close` end to end, against a real worktree and the squash merge that made #52.
//
// `RIG_FAKE_REMOTES` points `bin/worktrees.mjs` at a directory of bare repos, so the
// mirror, the worktree, the push and the branch deletion below are all real git, only
// local; GitHub is the in-memory adapter and no `gh` is ever spawned. Nothing here needs
// a network, and nothing spawns npm.
//
// The case this file exists for: `main` requires linear history, so every PR lands as a
// squash and GitHub deletes the head branch. The worktree's upstream ref disappears, the
// pre-squash commits are nowhere on the base, and `close` used to read them as unpushed
// work and refuse — on every merged work, forever, with `--force` the only way past. A
// merged PR settles its branch; this is that rule, from the outside.
//
// One temp installation, shared, and the tests run in order. test/harness.mjs builds it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall, readJson } from './harness.mjs'

const { tmp, dataRoot, workRoot, remotesDir, githubStateFile, rig, git, gitMust, cleanup } = makeInstall({
  prefix: 'rig-close-',
  author: 'rig close',
  email: 'close@example.invalid',
  remotes: true,
  github: { auth: 'ok', repos: { 'acme/billing': { language: 'JavaScript', prs: [] } } },
})

const record = id => readJson(path.join(dataRoot, 'work', id, 'work.json'))
const github = () => readJson(githubStateFile)
const setGithub = state => fs.writeFileSync(githubStateFile, JSON.stringify(state))
const worktree = (id, repo) => path.join(workRoot, id, repo)
const bare = repo => path.join(remotesDir, 'acme', `${repo}.git`)

// A bare repo standing in for `https://github.com/acme/<repo>.git`, with one commit.
const publish = repo => {
  const seed = path.join(tmp, 'seed', repo)
  fs.mkdirSync(seed, { recursive: true })
  gitMust(seed, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', `${repo}: first`)
  fs.mkdirSync(path.dirname(bare(repo)), { recursive: true })
  gitMust(tmp, 'clone', '-q', '--bare', seed, bare(repo))
}

// What GitHub does when a PR lands on a repo that requires linear history: the branch's
// commits become one new commit on the base under a different sha, and the head branch is
// deleted. Everything the worktree knew about its upstream goes with it.
const squashMergeAndDeleteBranch = (repo, branch, prNumber) => {
  const tip = gitMust(bare(repo), 'rev-parse', branch)
  const tree = gitMust(bare(repo), 'rev-parse', `${branch}^{tree}`)
  const base = gitMust(bare(repo), 'rev-parse', 'main')
  const squashed = gitMust(bare(repo), 'commit-tree', tree, '-p', base, '-m', `${branch} (#${prNumber})`)
  assert.notEqual(squashed, tip, 'the commits landed under a different sha, which is the point')
  gitMust(bare(repo), 'update-ref', 'refs/heads/main', squashed)
  gitMust(bare(repo), 'update-ref', '-d', `refs/heads/${branch}`)
}

publish('billing')
assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
  '--orgs', 'acme', '--tracker', 'acme=none']).code, 0)

after(cleanup)

test('a work with a repo attached, one commit pushed, and a PR open on it', () => {
  assert.equal(rig(['new', 'squashed', '--title', 'Squashed work', '--type', 'feat', '--no-ticket']).code, 0)
  const r = rig(['attach', 'billing', '--work', 'squashed'])
  assert.equal(r.code, 0, r.out)

  const dest = worktree('squashed', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'the work\n')
  gitMust(dest, 'commit', '-qam', 'the work')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')

  const state = github()
  state.repos['acme/billing'].prs = [{
    branch: 'feat/squashed-work', number: 5, state: 'OPEN',
    url: 'https://github.com/acme/billing/pull/5',
    openedAt: '2026-09-17T00:00:00Z', mergedAt: null, commits: ['2026-09-17T09:00:00Z'],
  }]
  setGithub(state)

  assert.match(rig(['list']).out, /PR #5 open/)
})

test('close refuses while the PR is open, as it always has', () => {
  const r = rig(['close', '--work', 'squashed'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing: PR #5 still open/)
  assert.ok(fs.existsSync(worktree('squashed', 'billing')), 'nothing torn down')
})

test('the squash merge lands the work under a new sha and deletes the head branch', () => {
  squashMergeAndDeleteBranch('billing', 'feat/squashed-work', 5)
  const state = github()
  Object.assign(state.repos['acme/billing'].prs[0], { state: 'MERGED', mergedAt: '2026-09-18T00:00:00Z' })
  setGithub(state)

  // The worktree is now exactly as #52 describes it: its upstream ref is gone, so the
  // distance falls back to the base, where its commit has never been seen.
  const dest = worktree('squashed', 'billing')
  gitMust(dest, 'fetch', '-q', '--prune', 'origin')
  assert.notEqual(git(dest, 'rev-parse', '--abbrev-ref', '@{u}').status, 0, 'the upstream ref went with the branch')
  const out = rig(['status', '--work', 'squashed']).out
  assert.match(out, /#5 MERGED/)
  assert.match(out, /commits 1 ahead/,
    'git reads the squashed commit as outstanding — which is what `close` used to refuse on')
})

test('close succeeds on the merged work with no --force, and says nothing was in the way', () => {
  const r = rig(['close', '--work', 'squashed'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /unfinished business/)
  assert.doesNotMatch(r.out, /unpushed commit/, 'the commits are merged, under another sha')
  assert.match(r.out, /removed worktree billing/)
  assert.ok(record('squashed').closedAt, 'closing records the gate and no status')
})

test('and it still recorded the merged PR\'s terminal facts on the way out', () => {
  const stored = record('squashed').repos[0].branches.find(b => b.branch === 'feat/squashed-work').pr
  assert.equal(stored.number, 5)
  assert.equal(stored.mergedAt, '2026-09-18T00:00:00Z')
})

test('a work whose tree is dirty still refuses, merged PR or not', () => {
  assert.equal(rig(['new', 'dirty', '--title', 'Dirty work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'dirty']).code, 0)
  const dest = worktree('dirty', 'billing')
  fs.writeFileSync(path.join(dest, 'NOTES.md'), 'unsaved\n')

  const state = github()
  state.repos['acme/billing'].prs.push({
    branch: 'feat/dirty-work', number: 6, state: 'MERGED',
    url: 'https://github.com/acme/billing/pull/6',
    openedAt: '2026-09-18T00:00:00Z', mergedAt: '2026-09-18T01:00:00Z', commits: ['2026-09-18T00:30:00Z'],
  })
  setGithub(state)

  const r = rig(['close', '--work', 'dirty'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing: 1 uncommitted change\(s\)/, 'a merge settles the branch, never the working tree')
  assert.ok(fs.existsSync(path.join(dest, 'NOTES.md')))
})

test('a work with nothing attached closes, and `list` said so before it did', () => {
  assert.equal(rig(['new', 'empty', '--title', 'Empty work', '--type', 'chore', '--no-ticket']).code, 0)
  assert.doesNotMatch(rig(['list']).out, /empty[\s\S]*?nothing outstanding/,
    'a work with no repos is not offered up as finished')
  assert.equal(rig(['close', '--work', 'empty']).code, 0)
})

// ------------------------------------------------- abandoning

// The exit a work needs when it is stopped rather than finished. Before this the only two
// options were to leave it idling forever in `rig list`, or `rig close --force`, which tears
// down identically but records a work that landed — a lie about the one thing the record is
// for.

test('abandoning drops the did-it-land checks that would refuse a close', () => {
  assert.equal(rig(['new', 'given-up', '--title', 'Given up', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'given-up']).code, 0)

  const dest = worktree('given-up', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'half a thought\n')
  gitMust(dest, 'commit', '-qam', 'half a thought')

  // Unpushed commits and no PR: the two things that make `close` refuse, and the two things
  // being abandoned actually looks like.
  let r = rig(['close', '--work', 'given-up'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /1 unpushed commit/)

  r = rig(['close', '--work', 'given-up', '--abandoned'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /unfinished business/)
  assert.match(r.out, /abandoned given-up/)
})

test('it records the decision and the teardown as two dates, and reads back as abandoned', () => {
  const w = record('given-up')
  assert.ok(w.abandonedAt, 'the decision, which nothing else could recover')
  assert.ok(w.closedAt, 'and the teardown that ran, which is a different fact')
  assert.equal(w.status, undefined)
  assert.match(rig(['list', '--quick']).out, /given-up[\s\S]*?Abandoned/)
})

test('an uncommitted change still refuses, because that is the one thing this can destroy', () => {
  assert.equal(rig(['new', 'messy', '--title', 'Messy work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'messy']).code, 0)
  const dest = worktree('messy', 'billing')
  fs.writeFileSync(path.join(dest, 'NOTES.md'), 'unsaved\n')

  const r = rig(['close', '--work', 'messy', '--abandoned'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /not abandoning — unfinished business/)
  assert.match(r.out, /billing: 1 uncommitted change\(s\)/)
  assert.ok(fs.existsSync(path.join(dest, 'NOTES.md')), 'nothing torn down')
})

test('an open PR is named and left alone, never closed', () => {
  fs.rmSync(path.join(worktree('messy', 'billing'), 'NOTES.md'))
  const dest = worktree('messy', 'billing')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')

  const state = github()
  state.repos['acme/billing'].prs.push({
    branch: 'feat/messy-work', number: 7, state: 'OPEN',
    url: 'https://github.com/acme/billing/pull/7',
    openedAt: '2026-09-19T00:00:00Z', mergedAt: null, commits: [],
  })
  setGithub(state)

  const r = rig(['close', '--work', 'messy', '--abandoned'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /PR #7 left open/)
  // Closing someone's pull request is an outward-facing act rig does not take on its own.
  const after = github().repos['acme/billing'].prs.find(pr => pr.number === 7)
  assert.equal(after.state, 'OPEN', 'rig did not touch it')
})

test('doctor reports a contradiction as an error, not a warning', () => {
  // Only reachable by editing a record by hand, which is the point: since the phase is
  // derived, drift cannot produce one. A gate the teardown never ran behind is rig's bug.
  const f = path.join(dataRoot, 'work', 'given-up', 'work.json')
  const w = readJson(f)
  delete w.closedAt
  fs.writeFileSync(f, JSON.stringify(w, null, 2))

  const r = rig(['doctor'])
  assert.match(r.out, /given-up: abandoned, but no `closedAt`/)
  assert.match(r.out, /should not be possible; please file an issue/)
})

// ------------------------------------------------- what now

test('next points a fresh work at the repo interview, then at the design gate', () => {
  assert.equal(rig(['new', 'what-now', '--title', 'What now', '--type', 'feat', '--no-ticket']).code, 0)
  let r = rig(['next', '--work', 'what-now'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Planning/)
  assert.match(r.out, /nothing is attached yet/)
  assert.match(r.out, /rig prompt select-repos/)

  assert.equal(rig(['attach', 'billing', '--work', 'what-now']).code, 0)
  r = rig(['next', '--work', 'what-now'])
  assert.match(r.out, /Direction is still `_TODO_`/, 'the scaffolded stub is read, not guessed at')
  assert.match(r.out, /rig save -m "design agreed" --designed/)
})

test('and stops offering the gate once it has been recorded', () => {
  assert.equal(rig(['save', '--work', 'what-now', '--designed']).code, 0)
  const r = rig(['next', '--work', 'what-now'])
  assert.doesNotMatch(r.out, /design gate/)
  assert.match(r.out, /yours to write/, 'nothing is written yet, and rig is not the tool that writes it')
})

test('a pushed branch with no PR is offered one; an unpushed one is offered a push', () => {
  const dest = worktree('what-now', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'some work\n')
  gitMust(dest, 'commit', '-qam', 'some work')

  let r = rig(['next', '--work', 'what-now'])
  assert.match(r.out, /commits that are not pushed/)
  assert.doesNotMatch(r.out, /no PR open/, 'one branch state, one offer')

  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  r = rig(['next', '--work', 'what-now'])
  assert.match(r.out, /billing is pushed with no PR open/)
})

test('a closed work has nothing to suggest, and says so rather than inventing something', () => {
  const r = rig(['next', '--work', 'squashed'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /nothing — this work is done/)
})

test('next never reproaches, whatever state it is handed', () => {
  // The guardrail, from the outside: `rig next` only ever offers. A warning belongs in
  // `doctor`, and only for a contradiction.
  for (const id of ['what-now', 'squashed', 'given-up']) {
    const out = rig(['next', '--work', id]).out
    assert.doesNotMatch(out, /should have|you failed|must |required/i, `"${out}" reproaches`)
    assert.doesNotMatch(out, /^!/m, 'no warnings')
  }
})

// ------------------------------------------------- stages

test('a work starts with no stages, and says so without making it sound like a deficiency', () => {
  assert.equal(rig(['new', 'sliced', '--title', 'Sliced work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'sliced']).code, 0)
  const r = rig(['stage', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /no stages/)
  assert.match(r.out, /how every work starts/)
})

test('the record keeps a base per branch now, not one per repo', () => {
  const entry = record('sliced').repos[0]
  assert.equal(entry.base, undefined, 'a base belongs to the branch it was cut for')
  assert.deepEqual(entry.branches, [{ branch: 'feat/sliced-work', base: 'main' }])
})

test('declaring a stage stores the branch and the one line, and nothing else', () => {
  const r = rig(['stage', 'feat/sliced-one', '--delivers', 'the schema', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('sliced').stages, [{ branch: 'feat/sliced-one', delivers: 'the schema' }])
})

test('the work branch cannot be a stage of itself', () => {
  const r = rig(['stage', 'feat/sliced-work', '--work', 'sliced'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /the work branch itself/)
})

test('and a stage is not declared twice', () => {
  const r = rig(['stage', 'feat/sliced-one', '--work', 'sliced'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /already a stage/)
})

test('a declared stage nobody has cut is listed, and reported as not started', () => {
  const r = rig(['stage', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1\. feat\/sliced-one/)
  assert.match(r.out, /the schema/)
  assert.match(r.out, /not cut in any repo yet/)
})

test('order comes from the chain the branches are actually stacked in', () => {
  // Two stages, declared in the wrong order on purpose, then cut in the right one.
  assert.equal(rig(['stage', 'feat/sliced-two', '--delivers', 'the endpoints', '--work', 'sliced']).code, 0)

  const dest = worktree('sliced', 'billing')
  const state = github()
  state.repos['acme/billing'].prs.push(
    { branch: 'feat/sliced-two', number: 11, state: 'OPEN', url: 'https://github.com/acme/billing/pull/11', base: 'feat/sliced-one', openedAt: '2026-09-19T00:00:00Z', mergedAt: null, commits: [] },
    { branch: 'feat/sliced-one', number: 10, state: 'MERGED', url: 'https://github.com/acme/billing/pull/10', base: 'feat/sliced-work', openedAt: '2026-09-18T00:00:00Z', mergedAt: '2026-09-18T12:00:00Z', commits: [] },
  )
  setGithub(state)
  // The branches have to be in the record for rig to ask about them at all.
  const f = path.join(dataRoot, 'work', 'sliced', 'work.json')
  const w = readJson(f)
  w.repos[0].branches.push(
    { branch: 'feat/sliced-two', base: 'feat/sliced-one' },
    { branch: 'feat/sliced-one', base: 'feat/sliced-work' },
  )
  fs.writeFileSync(f, JSON.stringify(w, null, 2))
  assert.ok(fs.existsSync(dest))

  const out = rig(['stage', '--work', 'sliced']).out
  assert.ok(out.indexOf('feat/sliced-one') < out.indexOf('feat/sliced-two'), 'the chain orders them, not the array')
  assert.match(out, /1\. feat\/sliced-one/)
  assert.match(out, /2\. feat\/sliced-two/)
  assert.match(out, /PR #10 merged/)
  assert.match(out, /PR #11 open/)
})

test('the next stage is the first that has not landed', () => {
  assert.match(rig(['stage', '--work', 'sliced']).out, /feat\/sliced-two.*← next/s)
})

test('and rig next says which stage you are on rather than the whole stack', () => {
  const out = rig(['next', '--work', 'sliced']).out
  assert.match(out, /stage 2 of 2: feat\/sliced-two — the endpoints/)
  assert.doesNotMatch(out, /sliced-one/, 'the whole stack is what rig stage is for; this is one line about where you are')
})

// ------------------------------------------------- opening the pull request

// Review is the phase rig was most obviously absent from: it has read PR state everywhere
// since it existed and had never opened one. Not a gate — a command you run when the stages
// are in.

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

test('pr opens one per repo, work branch to the base it was cut from', () => {
  const dest = worktree('to-review', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'reviewable\n')
  gitMust(dest, 'commit', '-qam', 'reviewable')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')

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
  const doc = path.join(dataRoot, 'work', 'to-review', 'context.md')
  // The scaffolded `_TODO_` says nothing, and an empty section is worse than none.
  assert.doesNotMatch(github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/work-to-review').body,
    /## Direction/)

  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('_TODO_', 'Because the adjacent effort would have cost a third major.'))
  assert.equal(rig(['new', 'reviewed-2', '--title', 'Second', '--type', 'feat', '--no-ticket']).code, 0)

  // Re-read through a second work so the first is left as it is for the idempotence test.
  const body = fs.readFileSync(doc, 'utf8')
  assert.match(body, /Because the adjacent effort/)
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

// ------------------------------------------------- the rollout plan, made live

const planFile = id => path.join(dataRoot, 'work', id, 'rollout-testing-plan.md')

test('plan scaffolds with the deploy order already rendered from the stack', () => {
  const r = rig(['plan', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  const text = fs.readFileSync(planFile('sliced'), 'utf8')
  assert.match(text, /rig:deploy-order/)
  assert.match(text, /\| 1 \| `feat\/sliced-one` \| the schema \|/)
  assert.match(text, /\| 2 \| `feat\/sliced-two` \| the endpoints \|/)
  assert.doesNotMatch(text, /\{\{DEPLOY_ORDER\}\}/, 'the placeholder was filled, not left in')
})

test('the prose around it is still the template prose, which is the part that earns the file', () => {
  const text = fs.readFileSync(planFile('sliced'), 'utf8')
  for (const heading of ['Why deploy order is mandatory', 'The rejection window', 'Configuration prerequisites', 'Rollback']) {
    assert.ok(text.includes(heading), `${heading} survived`)
  }
})

test('refresh is a no-op while the document already agrees with the stack', () => {
  const r = rig(['plan', '--work', 'sliced', '--refresh'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /already up to date/)
})

test('a stage declared after the plan was written makes it stale, and rig next says so', () => {
  assert.equal(rig(['stage', 'feat/sliced-three', '--delivers', 'the UI', '--work', 'sliced']).code, 0)
  const out = rig(['next', '--work', 'sliced']).out
  assert.match(out, /no longer matches the stack/, 'something reads the artifact back — the test the epic uses')
  assert.match(out, /rig plan --refresh/)
})

test('and refreshing brings it back, rewriting only the generated region', () => {
  const before = fs.readFileSync(planFile('sliced'), 'utf8')
  // A hand edit in the prose half, to prove the refresh does not touch it.
  fs.writeFileSync(planFile('sliced'), before.replace('## Rollback', '## Rollback\n\nRevert the migration; it is additive.'))

  const r = rig(['plan', '--work', 'sliced', '--refresh'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /refreshed the deploy order/)

  const after = fs.readFileSync(planFile('sliced'), 'utf8')
  assert.match(after, /feat\/sliced-three/, 'the new stage reached the table')
  assert.match(after, /Revert the migration; it is additive\./, 'the hand-written prose is untouched')
  assert.doesNotMatch(rig(['next', '--work', 'sliced']).out, /no longer matches the stack/)
})

test('a plan whose markers were removed is refused, not silently appended to', () => {
  const text = fs.readFileSync(planFile('sliced'), 'utf8')
  fs.writeFileSync(planFile('sliced'), text.replace(/<!-- \/?rig:deploy-order.*?-->/g, ''))
  const r = rig(['plan', '--work', 'sliced', '--refresh'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no `rig:deploy-order` region/)
})

test('refresh on a work with no plan says to write one first', () => {
  const r = rig(['plan', '--work', 'to-review', '--refresh'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /does not exist/)
})
