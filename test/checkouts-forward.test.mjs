// Fetching and fast-forwarding one of the two checkouts an installation owns,
// against real git. The module's seam is the runner it is handed, so these tests hand it one
// that spawns git for real — local bare remotes in a temp tree, no network, no `gh`, and no
// CLI subprocess. A fake runner appears only where standing the state up for real would prove
// less than it costs. The tree and the moves are `test/checkouts-fixture.mjs`, which says why
// the family is three files.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { unreadable } from '../bin/checkouts.mjs'
import { checkoutsFixture } from './checkouts-fixture.mjs'

const f = checkoutsFixture('rig-checkouts-forward-')
const { tmp, run, gitMust, c, cloned, goneUpstream, onWip, pushFromElsewhere } = f
after(f.cleanup)

test('a checkout level with its upstream is current, and nothing moves', () => {
  const { local } = cloned('current')
  const r = c().fastForward(local)
  assert.equal(r.outcome, 'current')
  assert.equal(r.state.behind, 0)
})

test('ahead of its upstream and behind nothing is current, not diverged', () => {
  // The ordinary state of a data root with unpushed commits, and the one that decides
  // whether `current` or `diverged` is asked first: reading it as diverged would make
  // `rig update` report a failure and refuse the migrations behind it.
  const { local } = cloned('ahead')
  fs.writeFileSync(path.join(local, 'MINE.md'), 'a record of my own\n')
  gitMust(local, 'add', '-A')
  gitMust(local, 'commit', '-q', '-m', 'a record of my own')

  const r = c().fastForward(local)
  assert.equal(r.outcome, 'current')
  assert.deepEqual([r.state.ahead, r.state.behind], [1, 0])
})

test('behind and clean is the whole point: it moves, and says what arrived', () => {
  const { bare, local } = cloned('moving')
  pushFromElsewhere(bare, 'THEIRS.md', 'a record from the other machine')
  pushFromElsewhere(bare, 'ALSO.md', 'and a second one')
  assert.equal(c().fetch(local).ok, true)

  const r = c().fastForward(local)
  assert.equal(r.outcome, 'moved')
  assert.equal(r.state.behind, 2)
  // Newest first, which is `git log`'s order and the order the caller truncates from.
  assert.deepEqual(c().arrived(local, r.from).map(l => l.replace(/^\S+ /, '')),
    ['and a second one', 'a record from the other machine'])
  assert.ok(fs.existsSync(path.join(local, 'THEIRS.md')))
})

test('the merge is --ff-only, which is what holds when the count that would have caught it is null', () => {
  // `diverged` is decided from `ahead`, and a count git could not make is null — so the
  // last thing between a diverged checkout and a merge commit nobody asked for is the
  // flag. Real git throughout, with the one count that decides it knocked out.
  const { bare, local } = cloned('ffonly')
  pushFromElsewhere(bare, 'THEIRS.md', 'a record from the other machine')
  fs.writeFileSync(path.join(local, 'MINE.md'), 'a record of my own\n')
  gitMust(local, 'add', '-A')
  gitMust(local, 'commit', '-q', '-m', 'a record of my own')
  assert.equal(c().fetch(local).ok, true)
  // Two knockouts, because one reading answers both counts: without the tree, `describe`
  // falls back to a `rev-list` per direction, and this is the forward one.
  const blind = (cmd, args) => args.includes('--porcelain=v2') || args.includes('@{u}..HEAD')
    ? { code: 1, out: '', err: 'fatal: bad revision' }
    : run(cmd, args)

  const r = c(blind).fastForward(local)
  assert.equal(r.state.ahead, null, 'nothing could tell it was diverged')
  assert.equal(r.outcome, 'failed')
  assert.match(r.error, /fast-forward/i, 'git refused, in its own words')
  assert.equal(gitMust(local, 'log', '-1', '--format=%s'), 'a record of my own')
  assert.equal(gitMust(local, 'rev-list', '--count', '--merges', 'HEAD'), '0', 'no merge commit')
})

test('a branch whose name starts with a parenthesis is a branch, and moves', () => {
  // Read as detached, `rig update` would refuse to move it and `rig save` would not push from it.
  const { bare, local } = onWip('paren')
  pushFromElsewhere(bare, 'THEIRS.md', 'a record from the other machine')
  assert.equal(c().fetch(local).ok, true)

  assert.equal(c().fastForward(local).outcome, 'moved')
})

test('an untracked file does not block a fast-forward', () => {
  // The two implementations this replaced disagreed here, and this is the one that wins:
  // refusing on any untracked file lets one stray note wedge the installation.
  const { bare, local } = cloned('untracked')
  pushFromElsewhere(bare, 'THEIRS.md', 'another record')
  fs.writeFileSync(path.join(local, 'scratch.md'), 'a note nobody staged\n')
  assert.equal(c().fetch(local).ok, true)

  assert.equal(c().fastForward(local).outcome, 'moved')
  assert.ok(fs.existsSync(path.join(local, 'scratch.md')), 'and the note is still there')
})

test('an untracked file the merge would overwrite is git\'s refusal, not ours', () => {
  // Which is why refusing on untracked files was never what kept anyone safe: git checks
  // the one case that matters, and says so in words worth passing on.
  const { bare, local } = cloned('collision')
  pushFromElsewhere(bare, 'THEIRS.md', 'a record from the other machine')
  fs.writeFileSync(path.join(local, 'THEIRS.md'), 'mine, unstaged\n')
  assert.equal(c().fetch(local).ok, true)

  const r = c().fastForward(local)
  assert.equal(r.outcome, 'failed')
  assert.ok(r.error)
  assert.equal(fs.readFileSync(path.join(local, 'THEIRS.md'), 'utf8'), 'mine, unstaged\n')
})

test('a tracked change blocks the move, and the tree is left as it was', () => {
  const { bare, local } = cloned('blocked')
  pushFromElsewhere(bare, 'THEIRS.md', 'a record from the other machine')
  fs.appendFileSync(path.join(local, 'README.md'), 'a local edit\n')
  assert.equal(c().fetch(local).ok, true)

  const r = c().fastForward(local)
  assert.equal(r.outcome, 'blocked')
  assert.equal(r.state.modified, 1)
  assert.ok(!fs.existsSync(path.join(local, 'THEIRS.md')), 'nothing arrived')
})

test('a diverged checkout is never merged or rebased behind your back', () => {
  const { bare, local } = cloned('diverged')
  pushFromElsewhere(bare, 'THEIRS.md', 'a record from the other machine')
  fs.writeFileSync(path.join(local, 'MINE.md'), 'a record of my own\n')
  gitMust(local, 'add', '-A')
  gitMust(local, 'commit', '-q', '-m', 'a record of my own')
  assert.equal(c().fetch(local).ok, true)

  const r = c().fastForward(local)
  assert.equal(r.outcome, 'diverged')
  assert.deepEqual([r.state.behind, r.state.ahead], [1, 1])
  assert.equal(gitMust(local, 'log', '-1', '--format=%s'), 'a record of my own')
})

test('nothing to fast-forward from, and nowhere to do it', () => {
  const noUpstream = path.join(tmp, 'own')
  assert.equal(c().fastForward(noUpstream).outcome, 'no-upstream')
  assert.equal(c().fastForward(path.join(tmp, 'plain')).outcome, 'not-a-checkout')

  const { local } = cloned('headless')
  gitMust(local, 'checkout', '-q', '--detach')
  assert.equal(c().fastForward(local).outcome, 'detached')
})

test('a tree git could not read is not a clean tree, and not a blocked one either', () => {
  // `rig update` migrates on `dirty === 0`, so reading a failed `git status` as "nothing
  // to commit" would migrate a data root it could not see into: the counts are null.
  // But null is not "there are changes in the way" either — saying that would be a guess
  // worded as a finding, so the merge runs and git says what is actually wrong.
  const unreadableTree = (cmd, args) => {
    if (args.includes('status')) return { code: 128, out: '', err: 'fatal: unable to read index' }
    if (args.includes('--show-toplevel')) return { code: 0, out: args[1], err: '' }
    if (args.includes('symbolic-ref')) return { code: 0, out: 'refs/heads/main', err: '' }
    if (args.includes('merge')) return { code: 128, out: '', err: 'fatal: .git/index: index file smaller than expected' }
    if (args.includes('@{u}..HEAD')) return { code: 0, out: '0', err: '' }
    if (args.includes('@{u}')) return { code: 0, out: 'origin/main', err: '' }
    if (args.includes('rev-list')) return { code: 0, out: '1', err: '' }
    return { code: 1, out: '', err: '' }
  }
  const state = c(unreadableTree).describe('anywhere')
  assert.deepEqual([state.dirty, state.modified], [null, null])
  assert.equal(state.behind, 1, 'the distance was measurable; the tree was not')
  const r = c(unreadableTree).fastForward('anywhere')
  assert.equal(r.outcome, 'failed')
  assert.match(r.error, /index file smaller/, 'git named the index, which no guess would have')
})

test('a count the fallback could not make is unknown, and nothing moves on it', () => {
  // The fallback counts the distance itself, and the count towards the upstream is the one
  // that decides whether anything moves: `status` failed, the upstream resolves, and that
  // count fails too. A confident "0 behind" would report the checkout current on the
  // strength of a question nothing answered.
  const uncounted = (cmd, args) => {
    if (args.includes('status')) return { code: 128, out: '', err: 'fatal: unable to read index' }
    if (args.includes('--show-toplevel')) return { code: 0, out: args[1], err: '' }
    if (args.includes('symbolic-ref')) return { code: 0, out: 'refs/heads/main', err: '' }
    if (args.includes('HEAD..@{u}')) return { code: 128, out: '', err: 'fatal: bad revision' }
    if (args.includes('@{u}')) return { code: 0, out: 'origin/main', err: '' }
    if (args.includes('rev-list')) return { code: 0, out: '0', err: '' }
    return { code: 1, out: '', err: '' }
  }
  const r = c(uncounted).fastForward('anywhere')
  assert.equal(r.state.behind, null)
  assert.equal(r.outcome, 'unmeasurable')
})

test('a repository git refuses outright is no checkout, not one with no upstream', () => {
  // A config git cannot parse, or an owner `safe.directory` turns away: the filesystem still
  // finds the `.git`, and every git command fails. Read as a failed `@{u}`, that was a
  // checkout confidently level with nothing, and doctor told a data root whose config names
  // `origin/main` that it had no upstream.
  const { local } = cloned('badconfig')
  fs.appendFileSync(path.join(local, '.git', 'config'), 'this is not config\n')
  assert.deepEqual(c().describe(local), unreadable())
  assert.equal(c().fastForward(local).outcome, 'not-a-checkout')
})

test('a distance git could not measure is not a reason to move anything', () => {
  // A branch with no commit of its own yet, set to track one that exists: `status
  // --porcelain=v2 --branch` names the upstream and leaves `branch.ab` out, because there is
  // nothing to count from. A confident "0 behind" here would report a checkout as current on
  // the strength of a question nothing answered.
  const { local } = cloned('unmeasurable')
  gitMust(local, 'switch', '-q', '--orphan', 'fresh')
  gitMust(local, 'config', 'branch.fresh.remote', 'origin')
  gitMust(local, 'config', 'branch.fresh.merge', 'refs/heads/main')

  const state = c().describe(local)
  assert.equal(state.upstream, 'origin/main')
  assert.deepEqual([state.ahead, state.behind], [null, null])

  const r = c().fastForward(local)
  assert.equal(r.outcome, 'unmeasurable')
})

test('an upstream whose ref has gone is no upstream, whichever reading asks', () => {
  // There is nothing to move towards and nothing to push onto, which is what "no upstream"
  // already tells every caller: `rig save` keeps the commit local and `rig update` migrates.
  // Read as unmeasurable instead, `rig save` would rebase onto a ref that is not there and
  // `rig update` would refuse the migrations behind it.
  const local = goneUpstream('gone')
  assert.equal(c().describe(local).upstream, null)
  assert.equal(c().identify(local).upstream, null)
  assert.equal(c().fastForward(local).outcome, 'no-upstream')
})
