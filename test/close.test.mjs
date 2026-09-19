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
import { makeInstall, readJson, strip } from './harness.mjs'

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

// `close` asks the stack whether a slice is still up for review and `list` does not, because
// a git pass and a GitHub call per stage per work is not what a listing is (decision 77). So
// `list` has to stop at what it measured: the two works below differ only in whether a stage
// was declared, and nothing here cuts a branch or opens a pull request — the hedge is read off
// the record, which is what makes it free.
const closeVerdictFor = (out, id) => strip(out).split(/\n(?=\S)/).find(b => b.startsWith(`${id} `))

test('`list` hedges its close verdict on a work that has stages, and not on one that has none', () => {
  for (const id of ['plain', 'stacked']) {
    assert.equal(rig(['new', id, '--title', `${id} work`, '--type', 'feat', '--no-ticket']).code, 0)
    assert.equal(rig(['attach', 'billing', '--work', id]).code, 0)
  }
  assert.equal(rig(['stage', 'feat/stacked-one', '--delivers', 'the schema', '--work', 'stacked']).code, 0)

  const out = rig(['list']).out
  assert.match(closeVerdictFor(out, 'stacked'),
    /nothing outstanding, but nothing merged either — `rig close` would not refuse \(stages not checked\)/)
  assert.doesNotMatch(closeVerdictFor(out, 'plain'), /stages not checked/,
    'a work with no stages reads exactly as it always did')
})

test('and it hedges the merged verdict the same way, which is the one that reads as a recommendation', () => {
  const state = github()
  for (const [i, id] of ['plain', 'stacked'].entries()) {
    state.repos['acme/billing'].prs.push({
      branch: `feat/${id}-work`, number: 30 + i, state: 'MERGED',
      url: `https://github.com/acme/billing/pull/${30 + i}`,
      openedAt: '2026-09-19T00:00:00Z', mergedAt: '2026-09-19T01:00:00Z', commits: [],
    })
  }
  setGithub(state)

  const out = rig(['list']).out
  assert.match(closeVerdictFor(out, 'stacked'),
    /all PRs merged, nothing uncommitted — safe to `rig close` \(stages not checked\)/)
  assert.match(closeVerdictFor(out, 'plain'),
    /all PRs merged, nothing uncommitted — safe to `rig close`\n/)
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

// Cut a branch in the worktree, put a commit on it, and go back to the work branch. Real
// git, in the tree rig cut: exactly what you would do by hand, and the only setup these
// tests are allowed. A test that writes the rows into `work.json` to make the stack appear
// is the bug report that produced hugoforte/rig#78, not a convenience.
const commitWork = (dest, message) => {
  fs.appendFileSync(path.join(dest, 'README.md'), `${message}\n`)
  gitMust(dest, 'commit', '-qam', message)
}

const cutStage = ({ work, repo, branch, from, back, message }) => {
  const dest = worktree(work, repo)
  gitMust(dest, 'checkout', '-q', '-b', branch, from)
  fs.appendFileSync(path.join(dest, 'README.md'), `${message}
`)
  gitMust(dest, 'commit', '-qam', message)
  gitMust(dest, 'checkout', '-q', back)
}

test('a stage branch cut in a repo is found, and nothing is written to the record', () => {
  cutStage({ work: 'sliced', repo: 'billing', branch: 'feat/sliced-one', from: 'feat/sliced-work', back: 'feat/sliced-work', message: 'the schema' })

  const r = rig(['stage', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1\. feat\/sliced-one/)
  assert.match(r.out, /billing/)
  assert.doesNotMatch(r.out, /not cut in any repo yet/)
  assert.deepEqual(record('sliced').repos[0].branches, [{ branch: 'feat/sliced-work', base: 'main' }],
    'the stack is derived: the record still holds the work branch alone')
})

test('a second stage, stacked on the first, is placed under it with no PR to ask', () => {
  assert.equal(rig(['stage', 'feat/sliced-two', '--delivers', 'the endpoints', '--work', 'sliced']).code, 0)
  cutStage({ work: 'sliced', repo: 'billing', branch: 'feat/sliced-two', from: 'feat/sliced-one', back: 'feat/sliced-work', message: 'the endpoints' })

  const out = rig(['stage', '--work', 'sliced']).out
  assert.ok(out.indexOf('feat/sliced-one') < out.indexOf('feat/sliced-two'), 'the chain orders them, not the array')
  assert.match(out, /1\. feat\/sliced-one/)
  assert.match(out, /2\. feat\/sliced-two/)
})

test('and a pull request, once one exists, answers the base over git', () => {
  const state = github()
  state.repos['acme/billing'].prs.push(
    { branch: 'feat/sliced-two', number: 11, state: 'OPEN', url: 'https://github.com/acme/billing/pull/11', base: 'feat/sliced-one', openedAt: '2026-09-19T00:00:00Z', mergedAt: null, commits: [] },
    { branch: 'feat/sliced-one', number: 10, state: 'MERGED', url: 'https://github.com/acme/billing/pull/10', base: 'feat/sliced-work', openedAt: '2026-09-18T00:00:00Z', mergedAt: '2026-09-18T12:00:00Z', commits: [] },
  )
  setGithub(state)

  const out = rig(['stage', '--work', 'sliced']).out
  assert.match(out, /1\. feat\/sliced-one/)
  assert.match(out, /2\. feat\/sliced-two/)
  assert.match(out, /PR #10 merged/)
  assert.match(out, /PR #11 open/)
  assert.deepEqual(record('sliced').repos[0].branches, [{ branch: 'feat/sliced-work', base: 'main' }],
    'a pull request is read, never recorded, until it is merged and the work closes')
})

test('the chain outranks the order the stages were declared in', () => {
  // Declared late-then-early and stacked early-then-late, so the array and the branches
  // disagree. Nothing stores an order, so where the commits sit is the only thing that can
  // tell them apart — and it is the one that survives someone re-stacking the work.
  assert.equal(rig(['new', 'restacked', '--title', 'Restacked work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'restacked']).code, 0)
  assert.equal(rig(['stage', 'feat/restacked-late', '--delivers', 'the endpoints', '--work', 'restacked']).code, 0)
  assert.equal(rig(['stage', 'feat/restacked-early', '--delivers', 'the schema', '--work', 'restacked']).code, 0)

  const opts = { work: 'restacked', repo: 'billing', back: 'feat/restacked-work' }
  cutStage({ ...opts, branch: 'feat/restacked-early', from: 'feat/restacked-work', message: 'the schema' })
  cutStage({ ...opts, branch: 'feat/restacked-late', from: 'feat/restacked-early', message: 'the endpoints' })

  const out = rig(['stage', '--work', 'restacked']).out
  assert.match(out, /1\. feat\/restacked-early/)
  assert.match(out, /2\. feat\/restacked-late/)
  assert.ok(out.indexOf('restacked-early') < out.indexOf('restacked-late'), 'the branches order them, not the array')
})

test('a closed pull request is not up for review', () => {
  // CLOSED is neither merged nor open, and reading "not merged" as "up for review" makes a
  // stage somebody gave up on look like one that is waiting for a reviewer.
  assert.equal(rig(['new', 'shelved', '--title', 'Shelved work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'shelved']).code, 0)
  assert.equal(rig(['stage', 'feat/shelved-one', '--delivers', 'the schema', '--work', 'shelved']).code, 0)
  cutStage({ work: 'shelved', repo: 'billing', branch: 'feat/shelved-one', from: 'feat/shelved-work', back: 'feat/shelved-work', message: 'the schema' })

  const state = github()
  state.repos['acme/billing'].prs.push(
    { branch: 'feat/shelved-one', number: 20, state: 'CLOSED', url: 'https://github.com/acme/billing/pull/20', base: 'feat/shelved-work', openedAt: '2026-09-19T00:00:00Z', mergedAt: null, commits: [] },
  )
  setGithub(state)

  assert.equal(rig(['plan', '--work', 'shelved']).code, 0)
  const text = fs.readFileSync(planFile('shelved'), 'utf8')
  assert.match(text, /\| `feat\/shelved-one` \|.*\| in progress \|/)
  assert.doesNotMatch(text, /up for review/)
})

test('a pull request lookup GitHub refused reads as unknown, never as no PR', () => {
  // `branchRows` has always computed the error and the stack has always dropped it, so a
  // rate-limited lookup rendered as a stage nobody has opened anything on. rig has a rule
  // for this everywhere else: a lookup that failed is unknown, and says so.
  assert.equal(rig(['new', 'refused', '--title', 'Refused work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'refused']).code, 0)
  assert.equal(rig(['stage', 'feat/refused-one', '--delivers', 'the schema', '--work', 'refused']).code, 0)
  cutStage({ work: 'refused', repo: 'billing', branch: 'feat/refused-one', from: 'feat/refused-work', back: 'feat/refused-work', message: 'the schema' })

  const state = github()
  setGithub({ ...state, auth: 'missing' })
  const out = rig(['stage', '--work', 'refused']).out
  const plan = rig(['plan', '--work', 'refused'])
  setGithub({ ...github(), auth: 'ok' })

  assert.match(out, /PR state unknown/)
  assert.equal(plan.code, 0, plan.out)
  assert.match(fs.readFileSync(planFile('refused'), 'utf8'), /\| `feat\/refused-one` \|.*\| PR state unknown \|/)
})

test('a stage whose line contains $& is rendered as written, not as a regex replacement', () => {
  // `String.replace` reads `$&` in the *replacement* as the whole match, so a refresh used to
  // paste the old region back into the new one and corrupt the document.
  assert.equal(rig(['new', 'dollar', '--title', 'Dollar work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'dollar']).code, 0)
  assert.equal(rig(['stage', 'feat/dollar-one', '--delivers', 'the $& path', '--work', 'dollar']).code, 0)
  assert.equal(rig(['plan', '--work', 'dollar']).code, 0)
  assert.equal(rig(['stage', 'feat/dollar-two', '--delivers', 'the rest', '--work', 'dollar']).code, 0)
  assert.equal(rig(['plan', '--work', 'dollar', '--refresh']).code, 0)

  const text = fs.readFileSync(planFile('dollar'), 'utf8')
  assert.match(text, /the \$& path/)
  assert.equal(text.match(/rig:deploy-order/g).length, 2, 'one region, not a region pasted inside itself')
})

// ------------------------------------------------- cutting one

test('--cut outside a worktree says which repos it could have meant', () => {
  assert.equal(rig(['new', 'cutter', '--title', 'Cutter work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'cutter']).code, 0)
  const r = rig(['stage', 'feat/cutter-one', '--delivers', 'the schema', '--cut', '--work', 'cutter'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /run it inside one of cutter's worktrees \(billing\)/)
})

test('--cut makes the branch on the work branch, and rig finds it without being told', () => {
  const dest = worktree('cutter', 'billing')
  const r = rig(['stage', 'feat/cutter-one', '--delivers', 'the schema', '--cut', '--work', 'cutter'], { cwd: dest })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: cut feat\/cutter-one on feat\/cutter-work/)
  assert.equal(gitMust(dest, 'branch', '--show-current'), 'feat/cutter-one')

  const out = rig(['stage', '--work', 'cutter']).out
  assert.match(out, /1\. feat\/cutter-one/)
  assert.match(out, /billing/)
  assert.doesNotMatch(out, /not cut in any repo yet/)
  assert.deepEqual(record('cutter').repos[0].branches, [{ branch: 'feat/cutter-work', base: 'main' }],
    'rig watched itself cut the branch and still wrote nothing down')
})

test('a second --cut stacks on the first, because that is where this repo has reached', () => {
  const dest = worktree('cutter', 'billing')
  commitWork(dest, 'the schema')
  const r = rig(['stage', 'feat/cutter-two', '--delivers', 'the endpoints', '--cut', '--work', 'cutter'], { cwd: dest })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: cut feat\/cutter-two on feat\/cutter-one/)

  const out = rig(['stage', '--work', 'cutter']).out
  assert.match(out, /1\. feat\/cutter-one/)
  assert.match(out, /2\. feat\/cutter-two/)
})

test('--cut reaches a stage declared long before anyone made its branch', () => {
  // The ordinary order, and the case #78 ruled out recording at declaration time for.
  assert.equal(rig(['stage', 'feat/cutter-three', '--delivers', 'the UI', '--work', 'cutter']).code, 0)
  const dest = worktree('cutter', 'billing')
  commitWork(dest, 'the endpoints')

  const r = rig(['stage', 'feat/cutter-three', '--cut', '--work', 'cutter'], { cwd: dest })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: cut feat\/cutter-three on feat\/cutter-two/)
  assert.equal(record('cutter').stages.filter(st => st.branch === 'feat/cutter-three').length, 1,
    'cutting a declared stage does not declare it twice')
  assert.match(rig(['stage', '--work', 'cutter']).out, /3\. feat\/cutter-three/)
})

test('and declaring the same stage twice is still refused when nothing is being cut', () => {
  const r = rig(['stage', 'feat/cutter-three', '--work', 'cutter'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /already a stage/)
})

test('the next stage is the first that has not landed', () => {
  assert.match(rig(['stage', '--work', 'sliced']).out, /feat\/sliced-two.*← next/s)
})

test('and rig next says which stage you are on rather than the whole stack', () => {
  const out = rig(['next', '--work', 'sliced']).out
  assert.match(out, /stage 2 of 2: feat\/sliced-two — the endpoints/)
  assert.doesNotMatch(out, /sliced-one/, 'the whole stack is what rig stage is for; this is one line about where you are')
})

test('a stage whose branch is gone but whose PR merged is landed, not uncut', () => {
  // The branch is deleted when the slice lands, and until `rig close` records the merged
  // pull request there is nothing in the record either. Git cannot answer, so GitHub is
  // asked — for the branches git could not find, and only those.
  assert.equal(rig(['new', 'vanished', '--title', 'Vanished work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'vanished']).code, 0)
  const dest = worktree('vanished', 'billing')
  assert.equal(rig(['stage', 'feat/vanished-one', '--delivers', 'the schema', '--cut', '--work', 'vanished'], { cwd: dest }).code, 0)
  commitWork(dest, 'the schema')
  gitMust(dest, 'checkout', '-q', 'feat/vanished-work')
  gitMust(dest, 'merge', '-q', '--no-ff', '-m', 'merge the schema', 'feat/vanished-one')
  seedPr({ branch: 'feat/vanished-one', number: 60, state: 'MERGED', base: 'feat/vanished-work', url: 'https://github.com/acme/billing/pull/60', mergedAt: '2026-09-19T12:00:00Z' })
  gitMust(dest, 'branch', '-D', 'feat/vanished-one')

  const out = rig(['stage', '--work', 'vanished']).out
  assert.ok(out.includes('billing'), out)
  assert.ok(!out.includes('not cut in any repo yet'), out)
  assert.ok(out.includes('PR #60 merged'), out)
})

test('and a stage nobody has cut anywhere is still reported as not started', () => {
  assert.equal(rig(['stage', 'feat/vanished-two', '--delivers', 'the endpoints', '--work', 'vanished']).code, 0)
  const out = rig(['stage', '--work', 'vanished']).out
  assert.ok(out.includes('not cut in any repo yet'), out)
})

// ------------------------------------------------- a stage's own ticket, and closing

const seedIssue = (number, title) => {
  const state = github()
  const repo = state.repos['acme/billing']
  repo.issues = (repo.issues || []).concat([{ number, title, state: 'OPEN', comments: [] }])
  setGithub(state)
}

const seedPr = pr => {
  const state = github()
  state.repos['acme/billing'].prs.push({ openedAt: '2026-09-19T00:00:00Z', commits: ['2026-09-19T00:00:00Z'], ...pr })
  setGithub(state)
}

const issueNumbered = n => github().repos['acme/billing'].issues.find(i => i.number === n)

test('a slice that landed closes its own ticket, at the one moment rig speaks', () => {
  // GitHub fires a closing keyword only for a pull request that merges into the default
  // branch, and a stage's pull request never does — so a slice's ticket cannot close itself.
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
