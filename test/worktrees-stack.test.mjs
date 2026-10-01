// Reading a work's stack off its branches, against real git, in the shapes a stack in use
// takes: merged down into the work branch, a stage cut after the one below merged in, stages
// cut and not yet committed on, and a stack whose work branch has landed in the base branch.
// `chain()` is told the stages in declaration order and nothing else, and every stack is
// built by hand in a worktree the way someone would build it. The tree, the moves and the
// stacks are `test/worktrees-fixture.mjs`, which says why the family is three files.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { worktreesFixture } from './worktrees-fixture.mjs'

const f = worktreesFixture('rig-worktrees-stack-')
const { gitMust, stacked, trees } = f
beforeEach(f.reset)
after(f.cleanup)

test('a stack merged down into the work branch keeps its order, because the stages still say it', () => {
  const s = stacked('merged-down')
  for (const stage of ['feat/one', 'feat/two', 'feat/three']) {
    gitMust(s.dir, 'checkout', '-q', '-b', stage)
    s.commit(stage)
  }
  gitMust(s.dir, 'checkout', '-q', 'feat/work')
  gitMust(s.dir, 'merge', '-q', '--ff-only', 'feat/three')

  assert.deepEqual(s.bases(['feat/one', 'feat/two', 'feat/three']),
    { 'feat/one': 'feat/work', 'feat/two': 'feat/one', 'feat/three': 'feat/two' })
})

test('a stage cut from the work branch after the one below merged in sits on that one', () => {
  const s = stacked('merged-then-cut')
  gitMust(s.dir, 'checkout', '-q', '-b', 'feat/one')
  s.commit('the schema')
  gitMust(s.dir, 'checkout', '-q', 'feat/work')
  gitMust(s.dir, 'merge', '-q', '--no-ff', '-m', 'merge the schema', 'feat/one')
  gitMust(s.dir, 'checkout', '-q', '-b', 'feat/two')
  s.commit('the endpoints')

  assert.deepEqual(s.bases(['feat/one', 'feat/two']), { 'feat/one': 'feat/work', 'feat/two': 'feat/one' })
})

test('stages cut but not yet committed on sit on the work branch, one on the next', () => {
  const s = stacked('fresh')
  gitMust(s.dir, 'checkout', '-q', '-b', 'feat/one')
  gitMust(s.dir, 'checkout', '-q', '-b', 'feat/two')

  assert.deepEqual(s.bases(['feat/one', 'feat/two']), { 'feat/one': 'feat/work', 'feat/two': 'feat/one' })
})

test('a merged-down stack keeps its order after the work branch lands in the base branch', () => {
  const s = stacked('landed')
  for (const stage of ['feat/one', 'feat/two']) {
    gitMust(s.dir, 'checkout', '-q', '-b', stage)
    s.commit(stage)
  }
  gitMust(s.dir, 'checkout', '-q', 'feat/work')
  gitMust(s.dir, 'merge', '-q', '--ff-only', 'feat/two')
  gitMust(s.dir, 'push', '-q', 'origin', 'feat/work:main')

  assert.deepEqual(s.bases(['feat/one', 'feat/two']), { 'feat/one': 'feat/work', 'feat/two': 'feat/one' })
})

// Stages stacked on the work branch, and the first merged into the work branch the way GitHub's
// squash button does it: one new commit carrying the stage's changes. `moved` puts a commit of
// someone else's on the work branch first. `edited` changes the squash before it is committed,
// so it is not the stage as it stood. `fixed` adds a commit to the first stage after the
// second was cut from it. `stages` is how many are stacked.
const squashed = (repo, { how = 'squash', moved = false, edited = false, fixed = false, stages = 2 } = {}) => {
  const s = stacked(repo)
  const names = ['feat/one', 'feat/two', 'feat/three'].slice(0, stages)
  for (const b of names) {
    gitMust(s.dir, 'checkout', '-q', '-b', b)
    s.commit(b)
  }
  if (fixed) {
    gitMust(s.dir, 'checkout', '-q', 'feat/one')
    fs.writeFileSync(path.join(s.dir, 'FIX.md'), 'a review fix\n')
    gitMust(s.dir, 'add', 'FIX.md')
    gitMust(s.dir, 'commit', '-q', '-m', 'a review fix')
  }
  gitMust(s.dir, 'checkout', '-q', 'feat/work')
  if (moved) {
    fs.writeFileSync(path.join(s.dir, 'NOTES.md'), 'something else\n')
    gitMust(s.dir, 'add', 'NOTES.md')
    gitMust(s.dir, 'commit', '-q', '-m', 'something else')
  }
  if (how === 'squash') {
    gitMust(s.dir, 'merge', '-q', '--squash', 'feat/one')
    if (edited) {
      fs.writeFileSync(path.join(s.dir, 'EDIT.md'), 'changed in the merge\n')
      gitMust(s.dir, 'add', 'EDIT.md')
    }
    gitMust(s.dir, 'commit', '-q', '-m', 'the schema (#1)')
  } else {
    gitMust(s.dir, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1', 'feat/one')
  }
  gitMust(s.dir, 'push', '-q', 'origin', 'feat/work', ...names)
  const head = gitMust(s.dir, 'rev-parse', 'feat/one')
  const merge = gitMust(s.dir, 'rev-parse', 'feat/work')
  const replaced = (over = {}) => trees().replaced({ org: 'acme', repo, work: 'feat/work', head, merge, above: names.slice(1), ...over })
  return { ...s, head, merge, replaced }
}

test('a stage squashed into the work branch is found, with the stage above still carrying it (#193)', () => {
  assert.deepEqual(squashed('squashed').replaced(), { carriers: ['feat/two'], rebased: false, behind: [], sameTree: true })
})

test('the rebase that answers it replays only the stage above, the push is asked for, and then nothing is found', () => {
  const s = squashed('replayed')
  gitMust(s.dir, 'switch', '-q', 'feat/two')
  gitMust(s.dir, 'rebase', '-q', '--onto', 'origin/feat/work', s.head)
  assert.equal(gitMust(s.dir, 'rev-list', '--count', 'origin/feat/work..feat/two'), '1')
  assert.deepEqual(s.replaced(), { carriers: ['feat/two'], rebased: true, behind: ['feat/two'], sameTree: true }, 'rebased here, not yet pushed')
  gitMust(s.dir, 'push', '-q', '--force-with-lease', 'origin', 'feat/two')
  assert.equal(s.replaced(), null)
})

test('every stage above that carries it is found, and one rebase with --update-refs answers them all', () => {
  const s = squashed('three', { stages: 3 })
  assert.deepEqual(s.replaced().carriers, ['feat/two', 'feat/three'])
  gitMust(s.dir, 'switch', '-q', 'feat/three')
  gitMust(s.dir, 'rebase', '-q', '--update-refs', '--onto', 'origin/feat/work', s.head)
  gitMust(s.dir, 'push', '-q', '--force-with-lease', 'origin', 'feat/two', 'feat/three')
  assert.equal(s.replaced(), null)
  assert.equal(gitMust(s.dir, 'rev-list', '--count', 'origin/feat/work..feat/three'), '2')
})

test('a stage fixed after the one above was cut from it is still found', () => {
  assert.deepEqual(squashed('fixed', { fixed: true }).replaced().carriers, ['feat/two'])
})

test('a stale copy here does not count when the remote\'s copy was rebased elsewhere', () => {
  const s = squashed('elsewhere')
  const rebased = gitMust(s.dir, 'commit-tree', 'feat/two^{tree}', '-p', 'origin/feat/work', '-m', 'rebased elsewhere')
  gitMust(s.dir, 'push', '-q', '--force', 'origin', `${rebased}:refs/heads/feat/two`)
  assert.equal(s.replaced(), null)
})

test('a stage merged with a merge commit was not replaced', () => {
  assert.equal(squashed('merge-commit', { how: 'merge' }).replaced(), null)
})

test('a squash onto a work branch that had moved is still the stage as it stood', () => {
  assert.equal(squashed('moved-first', { moved: true }).replaced().sameTree, true)
})

test('a squash changed as it was made is found, and says it is not the stage as it stood', () => {
  assert.equal(squashed('edited', { edited: true }).replaced().sameTree, false)
})

test('a merge this mirror has not fetched is said, so the fetch can be offered', () => {
  assert.deepEqual(squashed('unfetched').replaced({ merge: 'f'.repeat(40) }), { unfetched: true })
})

test('a copy here the remote has moved past is named, so a replay from it cannot overwrite the remote', () => {
  const s = squashed('behind')
  const later = gitMust(s.dir, 'commit-tree', 'feat/two^{tree}', '-p', 'feat/two', '-m', 'pushed from elsewhere')
  gitMust(s.dir, 'push', '-q', 'origin', `${later}:refs/heads/feat/two`)
  assert.deepEqual(s.replaced().behind, ['feat/two'])
})
