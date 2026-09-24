// Reading a work's stack off its branches, against real git: `chain()` is told the stages
// in declaration order and nothing else, and every shape a stack can be in is built by hand
// in a worktree the way someone would build it. The tree and the moves are
// `test/worktrees-fixture.mjs`, which says why the family is two files.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { worktreesFixture } from './worktrees-fixture.mjs'

const f = worktreesFixture('rig-worktrees-stack-')
const { gitMust, trees, workDir, publish, pushToRemote } = f
beforeEach(f.reset)
after(f.cleanup)

// A work's stack, built by hand in its worktree the way someone would build it: `stages`
// is declaration order, which is all `chain()` is told.
//
// The mirror is made by an earlier work and main moves on before this one is cut, because
// that is the mirror every work after the first gets: its own `refs/heads/main` is the clone's
// and never moves, so anything reading it for where this work began reads the wrong commit.
const stacked = repo => {
  const seed = publish('acme', repo)
  trees().cut({ org: 'acme', repo, branch: 'feat/earlier', dest: workDir('earlier', repo) })
  pushToRemote(seed, 'main', 'main moves on')
  const dir = workDir('stacked', repo)
  trees().cut({ org: 'acme', repo, branch: 'feat/work', dest: dir })
  return {
    dir,
    commit: message => {
      fs.appendFileSync(path.join(dir, 'README.md'), `${message}\n`)
      gitMust(dir, 'commit', '-q', '-am', message)
    },
    bases: stages => Object.fromEntries(
      trees().chain({ org: 'acme', repo, branch: 'feat/work', base: 'main', stages }).map(s => [s.branch, s.base])),
  }
}

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

test('on a work branch nobody has committed on, a stage with commits still does not sit on an empty one', () => {
  const s = stacked('unmoved')
  gitMust(s.dir, 'branch', 'feat/two')
  gitMust(s.dir, 'checkout', '-q', '-b', 'feat/one')
  s.commit('the schema')

  assert.deepEqual(s.bases(['feat/one', 'feat/two']), { 'feat/one': 'feat/work', 'feat/two': 'feat/work' })
})
