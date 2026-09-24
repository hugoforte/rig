// Reading a work's stack off its branches, against real git, in the shapes a stack in use
// takes: merged down into the work branch, a stage cut after the one below merged in, stages
// cut and not yet committed on, and a stack whose work branch has landed in the base branch.
// `chain()` is told the stages in declaration order and nothing else, and every stack is
// built by hand in a worktree the way someone would build it. The tree, the moves and the
// stacks are `test/worktrees-fixture.mjs`, which says why the family is three files.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { worktreesFixture } from './worktrees-fixture.mjs'

const f = worktreesFixture('rig-worktrees-stack-')
const { gitMust, stacked } = f
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
