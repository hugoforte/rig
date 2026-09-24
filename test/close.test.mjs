// `rig close` and `rig close --abandoned` end to end, and what `rig next` offers around them.
//
// The case this file exists for: `main` requires linear history, so every PR lands as a
// squash and GitHub deletes the head branch. The worktree's upstream ref disappears, the
// pre-squash commits are nowhere on the base, and `close` used to read them as unpushed
// work and refuse — on every merged work, forever, with `--force` the only way past. A
// merged PR settles its branch; this is that rule, from the outside.
//
// One installation, shared, and the tests run in order: each subject builds its own works,
// and the ones `next` is asked about are the closed and abandoned works above it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { strip, readJson } from './harness.mjs'
import { billingInstall } from './billing-install.mjs'

const { dataRoot, workRoot, rig, git, gitMust, github, setGithub, squashMergeAndDeleteBranch, bare, commitWork, cutStage, seedPr, worktree, record, cleanup } = billingInstall('rig-close-')

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

// ------------------------------------------------- branches of a work that landed

// A repo that does not delete a head branch on merge leaves it on the remote, and every
// worktree ever cut leaves a copy in the mirror (#149). A close on a work that landed takes
// both — but only a copy whose every commit is in what the PR merged.
const mirror = repo => path.join(workRoot, '.mirrors', 'acme', `${repo}.git`)
const hasBranch = (dir, branch) => git(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).status === 0

const landedWork = (id, number) => {
  assert.equal(rig(['new', id, '--title', `${id} work`, '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', id]).code, 0)
  const dest = worktree(id, 'billing')
  commitWork(dest, `${id}: the work`)
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  seedPr({
    branch: `feat/${id}-work`, number, state: 'MERGED', head: gitMust(dest, 'rev-parse', 'HEAD'),
    url: `https://github.com/acme/billing/pull/${number}`, mergedAt: '2026-09-20T00:00:00Z',
  })
  return dest
}

test('closing a work that landed deletes its branch from the mirror and the remote', () => {
  landedWork('tidy', 40)
  const r = rig(['close', '--work', 'tidy'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /deleted branch feat\/tidy-work from billing \(mirror and remote\)/)
  assert.equal(hasBranch(bare('billing'), 'feat/tidy-work'), false, 'gone from the remote')
  assert.equal(hasBranch(mirror('billing'), 'feat/tidy-work'), false, 'gone from the mirror')
})

test('a branch pushed to after its PR merged is kept, and the close says why', () => {
  const dest = landedWork('pushed-after', 41)
  commitWork(dest, 'pushed-after: after the merge')
  gitMust(dest, 'push', '-q')

  const r = rig(['close', '--work', 'pushed-after'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /remote copy of feat\/pushed-after-work kept — it has moved since the PR merged/)
  assert.equal(hasBranch(bare('billing'), 'feat/pushed-after-work'), true, 'the later commit is still somewhere')
  assert.equal(hasBranch(mirror('billing'), 'feat/pushed-after-work'), true)
})

test('a stage that landed goes with the work branch', () => {
  assert.equal(rig(['new', 'sliced', '--title', 'sliced work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'sliced']).code, 0)
  assert.equal(rig(['stage', 'feat/sliced-one', '--delivers', 'the schema', '--work', 'sliced']).code, 0)
  const dest = worktree('sliced', 'billing')
  cutStage({ work: 'sliced', repo: 'billing', branch: 'feat/sliced-one', from: 'feat/sliced-work', back: 'feat/sliced-work', message: 'the schema' })
  gitMust(dest, 'push', '-q', 'origin', 'feat/sliced-one')
  gitMust(dest, 'merge', '-q', '--ff-only', 'feat/sliced-one')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  const merged = (branch, number) => seedPr({
    branch, number, state: 'MERGED', head: gitMust(dest, 'rev-parse', branch),
    url: `https://github.com/acme/billing/pull/${number}`, mergedAt: '2026-09-20T00:00:00Z',
  })
  merged('feat/sliced-one', 43)
  merged('feat/sliced-work', 44)

  const r = rig(['close', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /deleted branch feat\/sliced-one from billing \(mirror and remote\)/)
  assert.equal(hasBranch(bare('billing'), 'feat/sliced-one'), false)
})

test('an abandoned work keeps its branches, merged PR or not', () => {
  landedWork('left-standing', 42)
  const r = rig(['close', '--work', 'left-standing', '--abandoned'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /deleted branch/)
  assert.equal(hasBranch(bare('billing'), 'feat/left-standing-work'), true)
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
