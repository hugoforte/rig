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

// What "Update branch" on GitHub does: a merge of main into the PR's branch, made on the
// remote, so the mirror never sees it. GitHub keeps the PR's head under `refs/pull/<n>/head`.
const updatedOnGithub = (branch, number) => {
  const tip = gitMust(bare('billing'), 'rev-parse', branch)
  const merge = gitMust(bare('billing'), 'commit-tree', `${tip}^{tree}`, '-p', tip, '-p', 'main', '-m', 'Merge main')
  gitMust(bare('billing'), 'update-ref', `refs/heads/${branch}`, merge)
  gitMust(bare('billing'), 'update-ref', `refs/pull/${number}/head`, merge)
  return merge
}

test('a branch updated on GitHub before it merged is still deleted: the close fetches the PR\'s head (#181)', () => {
  landedWork('updated', 46)
  const head = updatedOnGithub('feat/updated-work', 46)
  const state = github()
  state.repos['acme/billing'].prs.find(pr => pr.number === 46).head = head
  setGithub(state)
  assert.notEqual(git(mirror('billing'), 'cat-file', '-e', `${head}^{commit}`).status, 0, 'the mirror never saw the merge')

  const r = rig(['close', '--work', 'updated'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /deleted branch feat\/updated-work from billing \(mirror and remote\)/)
  assert.equal(hasBranch(mirror('billing'), 'feat/updated-work'), false)
})

test('a PR head that cannot be fetched keeps the copy, and the close gives the fetch\'s reason (#181)', () => {
  landedWork('unfetchable', 47)
  const state = github()
  state.repos['acme/billing'].prs.find(pr => pr.number === 47).head = 'f'.repeat(40)
  setGithub(state)

  const r = rig(['close', '--work', 'unfetchable'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /mirror copy of feat\/unfetchable-work kept — could not fetch PR #47's head: .*refs\/pull\/47\/head/)
  assert.doesNotMatch(strip(r.out), /commits the merged PR did not/)
  assert.equal(hasBranch(mirror('billing'), 'feat/unfetchable-work'), true)
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

// What GitHub does to a stack merged one pull request at a time (hugoforte/rig#257): the stage
// below merges into the work branch with a merge commit, and the one above is retargeted there
// and has its own commits re-made on that merge — same patches, new shas — before it merges in
// turn. The mirror still holds the branch as it was pushed.
const mergeOnGithub = (into, from) => {
  const merge = gitMust(bare('billing'), 'commit-tree', `${from}^{tree}`, '-p', into, '-p', from, '-m', `Merge ${from}`)
  gitMust(bare('billing'), 'update-ref', `refs/heads/${into}`, merge)
}
const rewriteOnGithub = (branch, onto, number) => {
  let tip = gitMust(bare('billing'), 'rev-parse', onto)
  for (const sha of gitMust(bare('billing'), 'rev-list', '--reverse', `${onto}..${branch}`).split('\n')) {
    const message = gitMust(bare('billing'), 'log', '-1', '--format=%B', sha)
    tip = gitMust(bare('billing'), 'commit-tree', `${sha}^{tree}`, '-p', tip, '-m', message)
  }
  gitMust(bare('billing'), 'update-ref', `refs/heads/${branch}`, tip)
  gitMust(bare('billing'), 'update-ref', `refs/pull/${number}/head`, tip)
  return tip
}

// Two stages, pushed, then merged the way GitHub merges a stack bottom-up. `extra` is a commit
// made on the second stage's copy here after it was pushed, which its pull request never saw.
const stackMergedBottomUp = (id, first, { extra = null } = {}) => {
  const work = `feat/${id}-work`
  const [one, two] = [`feat/${id}-one`, `feat/${id}-two`]
  assert.equal(rig(['new', id, '--title', `${id} work`, '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', id]).code, 0)
  for (const stage of [one, two]) assert.equal(rig(['stage', stage, '--delivers', stage, '--work', id]).code, 0)
  const dest = worktree(id, 'billing')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  cutStage({ work: id, repo: 'billing', branch: one, from: work, back: work, message: `${id}: the schema` })
  cutStage({ work: id, repo: 'billing', branch: two, from: one, back: work, message: `${id}: the endpoints` })
  gitMust(dest, 'push', '-q', 'origin', one, two)
  if (extra) {
    gitMust(dest, 'checkout', '-q', two)
    commitWork(dest, extra)
    gitMust(dest, 'checkout', '-q', work)
  }

  const oneHead = gitMust(bare('billing'), 'rev-parse', one)
  mergeOnGithub(work, one)
  const twoHead = rewriteOnGithub(two, work, first + 1)
  mergeOnGithub(work, two)
  const pr = (branch, number, head) => seedPr({
    branch, number, state: 'MERGED', head,
    url: `https://github.com/acme/billing/pull/${number}`, mergedAt: '2026-09-30T00:00:00Z',
  })
  pr(one, first, oneHead)
  pr(two, first + 1, twoHead)
  const workHead = gitMust(bare('billing'), 'rev-parse', work)
  gitMust(bare('billing'), 'update-ref', `refs/pull/${first + 2}/head`, workHead)
  pr(work, first + 2, workHead)
  assert.notEqual(git(mirror('billing'), 'merge-base', '--is-ancestor', `refs/heads/${two}`, twoHead).status, 0,
    'the copy here is not behind the head GitHub made')
  return two
}

test('a stage GitHub rewrote while merging the stack is deleted from the mirror and the remote (#257)', () => {
  const two = stackMergedBottomUp('rewritten', 60)
  const r = rig(['close', '--work', 'rewritten'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(strip(r.out), /copy of \S+ kept/)
  assert.match(r.out, /deleted branch feat\/rewritten-two from billing \(mirror and remote\)/)
  assert.equal(hasBranch(mirror('billing'), two), false)
})

test('a rewritten stage whose copy holds a commit the PR never carried is kept, and the close names the commit (#257)', () => {
  const two = stackMergedBottomUp('rewritten-extra', 63, { extra: 'rewritten-extra: an afterthought' })
  const r = rig(['close', '--work', 'rewritten-extra'])
  assert.equal(r.code, 0, r.out)
  const sha = gitMust(mirror('billing'), 'rev-parse', '--short', `refs/heads/${two}`)
  assert.match(strip(r.out), new RegExp(`mirror copy of feat/rewritten-extra-two kept — ${sha} "rewritten-extra: an afterthought" is not in what PR #64 merged`))
  assert.equal(hasBranch(mirror('billing'), two), true)
})

test('an abandoned work keeps its branches, merged PR or not', () => {
  landedWork('left-standing', 42)
  const r = rig(['close', '--work', 'left-standing', '--abandoned'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /deleted branch/)
  assert.equal(hasBranch(bare('billing'), 'feat/left-standing-work'), true)
})

test('a work whose lessons were reviewed closes without naming the review', () => {
  landedWork('reviewed', 45)
  assert.equal(rig(['save', '--work', 'reviewed', '-m', 'lessons reviewed', '--learned']).code, 0)
  const r = rig(['close', '--work', 'reviewed'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /lessons never reviewed/)
})

// ------------------------------------------------- the outcome

// What changed for someone, and why that is good: a statement made once the work has landed,
// which nothing can derive later. Named on the way out like the lesson review, and recordable
// after the close for the same reason.

test('a work closing with no outcome is named, with the command that records one', () => {
  landedWork('untold', 46)
  const r = rig(['close', '--work', 'untold'])
  assert.equal(r.code, 0, r.out)
  assert.match(strip(r.out), /no outcome recorded — what changed for someone, and why that is good: `rig save --work untold --outcome "…"`/)
})

test('the outcome is recorded after the close, with its date', () => {
  const r = rig(['save', '--work', 'untold', '--outcome', 'Refunds charge once, however often the client retries.'])
  assert.equal(r.code, 0, r.out)
  const { outcome } = record('untold')
  assert.equal(outcome.text, 'Refunds charge once, however often the client retries.')
  assert.ok(!Number.isNaN(Date.parse(outcome.at)), 'a statement made on a date')
})

test('recording it again replaces it, and dates it again', () => {
  const first = record('untold').outcome.at
  assert.equal(rig(['save', '--work', 'untold', '--outcome', '  A retried refund charges once.  ']).code, 0)
  const { outcome } = record('untold')
  assert.equal(outcome.text, 'A retried refund charges once.', 'the statement, without the padding around it')
  assert.ok(Date.parse(outcome.at) > Date.parse(first), 'dated when it was said, not when the first one was')
})

test('list --json carries the outcome, and null for a work with none', () => {
  const { works } = JSON.parse(rig(['list', '--json', '--quick']).stdout)
  assert.equal(works.find(w => w.id === 'untold').outcome.text, 'A retried refund charges once.')
  assert.equal(works.find(w => w.id === 'tidy').outcome, null)
})

test('status says the outcome', () => {
  assert.match(strip(rig(['status', '--work', 'untold']).out), /^outcome A retried refund charges once\. \(\d{4}-\d{2}-\d{2}\)$/m)
})

test('a work whose outcome was recorded closes without naming it', () => {
  landedWork('told', 47)
  assert.equal(rig(['save', '--work', 'told', '--outcome', 'Invoices carry the tax line.']).code, 0)
  const r = rig(['close', '--work', 'told'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /no outcome recorded/)
})

test('--outcome needs the outcome, on one line', () => {
  let r = rig(['save', '--work', 'told', '--outcome'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--outcome needs the outcome/)
  r = rig(['save', '--work', 'told', '--outcome', 'One line.\nAnd another.'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--outcome takes one line/)
  // The offers print `--outcome "…"`, and an agent runs an offered command as written.
  for (const empty of ['   ', '--outcome=', '…', '...']) {
    r = rig(['save', '--work', 'told', ...(empty.startsWith('--') ? [empty] : ['--outcome', empty])])
    assert.equal(r.code, 1, `${JSON.stringify(empty)}: ${r.out}`)
    assert.match(r.out, /--outcome needs the outcome/)
  }
  assert.equal(record('told').outcome.text, 'Invoices carry the tax line.', 'a refused outcome leaves the record alone')
})

// ------------------------------------------------- the user docs

test('the user-docs edit is recorded after the close, with its date, and listed', () => {
  const r = rig(['save', '--work', 'told', '-m', 'user docs updated', '--documented'])
  assert.equal(r.code, 0, r.out)
  assert.ok(!Number.isNaN(Date.parse(record('told').documentedAt)), 'a gate, with its date')
  const { works } = JSON.parse(rig(['list', '--json', '--quick']).stdout)
  assert.equal(works.find(w => w.id === 'told').documentedAt, record('told').documentedAt)
  assert.equal(works.find(w => w.id === 'tidy').documentedAt, null, 'null, not missing, for a work without it')
})

test('status names the QA evidence beside the context doc', () => {
  fs.writeFileSync(path.join(dataRoot, 'work', 'told', 'qa.md'), '# QA\n')
  assert.match(strip(rig(['status', '--work', 'told']).out), /^qa .*qa\.md/m)
})

// The offer read end to end: the docs target comes out of the repo's catalogue entry, and a
// work closed before the docs were done is told so on its way out, as with the lesson review.
const billingEntry = path.join(dataRoot, 'catalog', 'acme', 'billing.md')

test('a landed work is offered the docs edit from its catalogue entry, and closing without it is named', () => {
  const entry = fs.readFileSync(billingEntry, 'utf8')
  try {
    fs.writeFileSync(billingEntry, entry.replace(/^docs: \[\]$/m, 'docs:\n  - Help centre: https://acme.example/help/billing'))
    landedWork('docsy', 48)
    assert.match(strip(rig(['next', '--work', 'docsy']).out), /the rig-docs skill drafts the edit \(billing: `https:\/\/acme\.example\/help\/billing`\)/)
    const r = rig(['close', '--work', 'docsy'])
    assert.equal(r.code, 0, r.out)
    assert.match(strip(r.out), /user docs never updated — the rig-docs skill, then `rig save --work docsy -m "user docs updated" --documented`/)
  } finally {
    fs.writeFileSync(billingEntry, entry)
  }
})

test('a work whose repos name no docs target closes without mentioning them', () => {
  landedWork('undocumented', 49)
  assert.doesNotMatch(rig(['close', '--work', 'undocumented']).out, /user docs/)
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
  assert.doesNotMatch(r.out, /lessons never reviewed/, 'the command it would name refuses an abandoned work')
  assert.doesNotMatch(r.out, /no outcome recorded/, 'nothing landed to say an outcome of')
})

test('an abandoned work refuses an outcome, and records nothing', () => {
  const r = rig(['save', '--work', 'given-up', '--outcome', 'Nothing, in the end.'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /given-up was abandoned/)
  assert.equal(record('given-up').outcome, undefined)
})

test('an abandoned work refuses the lesson review, and records nothing', () => {
  const r = rig(['save', '--work', 'given-up', '-m', 'lessons reviewed', '--learned'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /given-up was abandoned/)
  assert.equal(record('given-up').learnedAt, undefined)
})

test('an abandoned work refuses the user-docs edit, and records nothing', () => {
  const r = rig(['save', '--work', 'given-up', '-m', 'user docs updated', '--documented'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /given-up was abandoned/)
  assert.equal(record('given-up').documentedAt, undefined)
})

test('an abandoned work refuses the adversarial review, and records nothing', () => {
  const r = rig(['save', '--work', 'given-up', '-m', 'adversarial review', '--reviewed'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /given-up was abandoned/)
  assert.equal(record('given-up').reviewedAt, undefined)
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
  assert.match(r.out, /rig save -m "design agreed" --designed --adversarial/)
})

test('and stops offering the gate once it has been recorded', () => {
  assert.equal(rig(['save', '--work', 'what-now', '--designed', '--adversarial']).code, 0)
  const r = rig(['next', '--work', 'what-now'])
  assert.doesNotMatch(r.out, /design gate/)
  assert.match(r.out, /yours to write/, 'nothing is written yet, and rig is not the tool that writes it')
})

test('an unpushed branch is offered a push by name, and once pushed with no PR, a PR', () => {
  const dest = worktree('what-now', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'some work\n')
  gitMust(dest, 'commit', '-qam', 'some work')

  let r = rig(['next', '--work', 'what-now'])
  assert.match(r.out, /commits that are not pushed/)
  assert.match(r.out, /git push origin feat\/what-now$/m, 'by name, since the branch\'s upstream is its base')
  assert.doesNotMatch(r.out, /no PR open/, 'one branch state, one offer')

  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  r = rig(['next', '--work', 'what-now'])
  assert.match(r.out, /billing is pushed with no PR open/)
})

test('an open PR is walked through its review: threads, then the adversarial review, then a human', () => {
  const state = github()
  state.repos['acme/billing'].prs.push({
    branch: 'feat/what-now', number: 9, state: 'OPEN', url: 'https://github.com/acme/billing/pull/9',
    openedAt: '2026-09-19T00:00:00Z', mergedAt: null, commits: [], reviewThreads: [{ resolved: false }, { resolved: true }],
  })
  setGithub(state)
  let r = rig(['next', '--work', 'what-now'])
  assert.match(r.out, /billing: 1 unresolved review thread/)
  assert.doesNotMatch(r.out, /adversarial review/, 'the review already on the PR comes first')

  state.repos['acme/billing'].prs.find(pr => pr.number === 9).reviewThreads[0].resolved = true
  setGithub(state)
  r = rig(['next', '--work', 'what-now'])
  assert.match(r.out, /the design chose an adversarial review/)
  assert.match(r.out, /rig save -m "adversarial review" --reviewed/)
  assert.doesNotMatch(r.out, /human reviewer/)

  assert.equal(rig(['save', '--work', 'what-now', '-m', 'adversarial review', '--reviewed']).code, 0)
  assert.ok(record('what-now').reviewedAt, 'the review is stored with its date')
  r = rig(['next', '--work', 'what-now'])
  assert.doesNotMatch(r.out, /human reviewer/, 'not while the PR says something the record does not')

  assert.equal(rig(['pr', '--refresh', '--work', 'what-now']).code, 0)
  r = rig(['next', '--work', 'what-now'])
  assert.match(r.out, /the PR is ready for a human reviewer/)

  const pr = state.repos['acme/billing'].prs.find(p => p.number === 9)
  pr.checks = 'PENDING'
  setGithub(state)
  assert.doesNotMatch(rig(['next', '--work', 'what-now']).out, /human reviewer/, 'not while its checks run')

  pr.checks = 'SUCCESS'
  pr.reviewUnknown = true
  setGithub(state)
  assert.doesNotMatch(rig(['next', '--work', 'what-now']).out, /human reviewer/, 'nor while GitHub will not say what the review is')
})

test('a closed work refuses the adversarial review, and records nothing', () => {
  const r = rig(['save', '--work', 'squashed', '-m', 'adversarial review', '--reviewed'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /squashed is closed/)
  assert.equal(record('squashed').reviewedAt, undefined)
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
