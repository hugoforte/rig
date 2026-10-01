// Reading a work's stack off its branches, against real git, where a branch is not what a
// stage sits on: a stage cut from the base branch, with commits or without, and a stage
// nobody has committed on, beside one that has. `chain()` is told the stages in declaration
// order and nothing else, and every stack is built by hand in a worktree the way someone
// would build it. The tree, the moves and the stacks are `test/worktrees-fixture.mjs`, which
// says why the family is three files.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { worktreesFixture } from './worktrees-fixture.mjs'

const f = worktreesFixture('rig-worktrees-stack-edge-')
const { gitMust, stacked } = f
beforeEach(f.reset)
after(f.cleanup)

test('a stage cut from the base branch has no base, as it always had', () => {
  const s = stacked('off-stack')
  s.commit('the work branch has its own commit')
  gitMust(s.dir, 'checkout', '-q', '-b', 'feat/one')
  s.commit('the schema')
  gitMust(s.dir, 'checkout', '-q', '-b', 'feat/two', 'origin/main')
  s.commit('the endpoints')

  assert.deepEqual(s.bases(['feat/one', 'feat/two']), { 'feat/one': 'feat/work', 'feat/two': null })
})

test('a stage nobody has committed on is never what a stage with commits sits on', () => {
  // Cut up front, both on the work branch; only the first is worked on, and the work branch
  // then catches up with it. The empty one is still where both were cut, which is an ancestor
  // of everything — the shape a stage merged down first would have, with none of its commits.
  const s = stacked('cut-up-front')
  gitMust(s.dir, 'branch', 'feat/two')
  gitMust(s.dir, 'checkout', '-q', '-b', 'feat/one')
  s.commit('the schema')
  gitMust(s.dir, 'checkout', '-q', 'feat/work')
  gitMust(s.dir, 'merge', '-q', '--ff-only', 'feat/one')

  assert.deepEqual(s.bases(['feat/one', 'feat/two']), { 'feat/one': 'feat/work', 'feat/two': null })
})

test('a stage cut from the base branch and not committed on stays out of the stack', () => {
  const s = stacked('empty-off-stack')
  s.commit('the work branch has its own commit')
  gitMust(s.dir, 'checkout', '-q', '-b', 'feat/one')
  s.commit('the schema')
  gitMust(s.dir, 'branch', 'feat/stray', 'origin/main')

  assert.deepEqual(s.bases(['feat/one', 'feat/stray']), { 'feat/one': 'feat/work', 'feat/stray': null })
})

test('on a work branch nobody has committed on, a stage with commits still does not sit on an empty one', () => {
  const s = stacked('unmoved')
  gitMust(s.dir, 'branch', 'feat/two')
  gitMust(s.dir, 'checkout', '-q', '-b', 'feat/one')
  s.commit('the schema')

  assert.deepEqual(s.bases(['feat/one', 'feat/two']), { 'feat/one': 'feat/work', 'feat/two': 'feat/work' })
})
