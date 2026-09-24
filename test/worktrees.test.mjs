// The mirror and worktree lifecycle, against real git. The module's seam is where a repo's
// remote lives, so these tests point it at a directory of bare repos: every clone, fetch,
// push and `worktree add` below is the real thing, only local. The tree and the moves are
// `test/worktrees-fixture.mjs`, which says why the family is two files.
//
// One temp tree, shared, and the tests run in order — each leaves the mirrors and
// worktrees where the next one expects them.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { remotesOnGitHub } from '../bin/worktrees.mjs'
import { RigError } from '../bin/errors.mjs'
import { worktreesFixture } from './worktrees-fixture.mjs'

const f = worktreesFixture('rig-worktrees-')
const { tmp, remotesDir, run, git, gitMust, trees, said, mirrorOf, remoteOf, workDir, publish, pushToRemote } = f
beforeEach(f.reset)
after(f.cleanup)

test('the production adapter resolves a repo to its github.com clone URL', () => {
  assert.equal(remotesOnGitHub().url('acme', 'billing'), 'https://github.com/acme/billing.git')
})

test('cut mirrors the repo on first use and cuts a worktree on the work branch', () => {
  publish('acme', 'billing')
  const dest = workDir('t1', 'billing')
  const { base } = trees().cut({ org: 'acme', repo: 'billing', branch: 'feat/t1', dest })

  assert.equal(base, 'main')
  assert.equal(gitMust(dest, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/t1')
  assert.ok(fs.existsSync(path.join(dest, 'README.md')), 'the remote\'s content is there')
  const { steps: narrated } = said()
  assert.match(narrated, /mirroring acme\/billing \(first use\)/)
  assert.match(narrated, /worktree billing → feat\/t1 \(base main\)/)
})

test('the mirror is bare, rig-owned, and keeps remote branches out of its own refs', () => {
  const mirror = mirrorOf('acme', 'billing')
  assert.equal(gitMust(mirror, 'rev-parse', '--is-bare-repository'), 'true')
  assert.equal(gitMust(mirror, 'config', 'remote.origin.fetch'), '+refs/heads/*:refs/remotes/origin/*')
  assert.equal(gitMust(mirror, 'rev-parse', '--verify', 'refs/remotes/origin/main'),
    gitMust(path.join(tmp, 'seed', 'acme-billing'), 'rev-parse', 'HEAD'),
    'the mirror holds what the remote calls main')
})

test('the base is the repo\'s own remote HEAD, not a global default', () => {
  publish('acme', 'orders', 'trunk')
  const { base } = trees().cut({ org: 'acme', repo: 'orders', branch: 'feat/t1', dest: workDir('t1', 'orders') })
  assert.equal(base, 'trunk')
})

test('cut refuses rather than cutting a second worktree over a directory that exists', () => {
  assert.throws(
    () => trees().cut({ org: 'acme', repo: 'billing', branch: 'feat/t9', dest: workDir('t1', 'billing') }),
    e => e instanceof RigError && /already exists/.test(e.message))
})

test('a fresh worktree is clean and level with its base', () => {
  assert.deepEqual(trees().state({ dir: workDir('t1', 'billing'), base: 'main' }),
    { missing: false, pushed: false, dirty: 0, ahead: 0, behind: 0 })
})

test('state counts uncommitted changes, then the commits they became', () => {
  const dest = workDir('t1', 'billing')
  fs.writeFileSync(path.join(dest, 'NOTES.md'), 'scratch\n')
  fs.appendFileSync(path.join(dest, 'README.md'), 'edited\n')
  assert.equal(trees().state({ dir: dest, base: 'main' }).dirty, 2)

  gitMust(dest, 'add', '-A')
  gitMust(dest, 'commit', '-q', '-m', 'work in progress')
  assert.deepEqual(trees().state({ dir: dest, base: 'main' }),
    { missing: false, pushed: false, dirty: 0, ahead: 1, behind: 0 })
})

test('every cut fetches, so a later worktree sees what the remote gained', () => {
  pushToRemote(path.join(tmp, 'seed', 'acme-billing'), 'main', 'someone else pushed')
  const dest = workDir('t2', 'billing')
  trees().cut({ org: 'acme', repo: 'billing', branch: 'feat/t2', dest })

  assert.match(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), /someone else pushed/)
  const { steps: narrated } = said()
  assert.match(narrated, /fetching acme\/billing/)
  assert.doesNotMatch(narrated, /mirroring/, 'the mirror is made once, not per cut')
  // And the fetch moved the shared mirror's idea of main, so the earlier worktree is behind.
  assert.deepEqual(trees().state({ dir: workDir('t1', 'billing'), base: 'main' }),
    { missing: false, pushed: false, dirty: 0, ahead: 1, behind: 1 })
})

test('pushed asks whether the branch reached the remote, never whether it has an upstream', () => {
  // Cutting a branch from `refs/remotes/origin/main` makes git set tracking to *main*, so
  // `@{u}` resolves from the moment `rig attach` runs and says nothing about who pushed.
  // `rig next` leans on this to tell "nothing written yet" from "waiting for a PR".
  const dest = workDir('t1', 'billing')
  assert.equal(git(dest, 'rev-parse', '--abbrev-ref', '@{u}').code, 0, 'an upstream exists either way')
  assert.equal(trees().state({ dir: dest, base: 'main', branch: 'feat/t1' }).pushed, false)

  gitMust(dest, 'push', '-q', 'origin', 'HEAD:refs/heads/feat/t1')
  gitMust(mirrorOf('acme', 'billing'), 'fetch', '-q', '--prune', 'origin')
  assert.equal(trees().state({ dir: dest, base: 'main', branch: 'feat/t1' }).pushed, true)
})

test('state measures against the recorded base when the branch has no upstream', () => {
  const dest = workDir('t1', 'billing')
  gitMust(dest, 'branch', '--unset-upstream')
  assert.notEqual(git(dest, 'rev-parse', '--abbrev-ref', '@{u}').code, 0, 'no upstream to lean on')
  assert.deepEqual(trees().state({ dir: dest, base: 'main' }),
    { missing: false, pushed: false, dirty: 0, ahead: 1, behind: 1 })
})

test('state measures against the live base when the PR was repointed at another branch', () => {
  // The stacked case (hugoforte/rig#24): the branch is 1 ahead of `main` and level with the
  // branch it was rebased onto. Measured from the base recorded at `rig attach`, the PR
  // underneath reads as this work's own outstanding commits.
  const dest = workDir('t1', 'billing')
  gitMust(dest, 'push', '-q', 'origin', 'HEAD:refs/heads/feat/lower')
  gitMust(mirrorOf('acme', 'billing'), 'fetch', '-q', '--prune', 'origin')

  assert.deepEqual(trees().state({ dir: dest, base: 'feat/lower', recordedBase: 'main' }),
    { missing: false, pushed: false, dirty: 0, ahead: 0, behind: 0 })
  assert.deepEqual(trees().state({ dir: dest, base: 'main', recordedBase: 'main' }),
    { missing: false, pushed: false, dirty: 0, ahead: 1, behind: 1 }, 'the record alone still measures from main')
})

test('state falls back to the recorded base when the live base is not in the mirror', () => {
  // GitHub can name a base this mirror has never fetched — a PR stacked on a branch made
  // after the repo was attached. Refusing to measure there would turn a distance rig can
  // read into a blocker at `rig close`.
  const dest = workDir('t1', 'billing')
  assert.deepEqual(trees().state({ dir: dest, base: 'feat/never-fetched', recordedBase: 'main' }),
    { missing: false, pushed: false, dirty: 0, ahead: 1, behind: 1 })
})

test('a distance git could not measure answers null with the reason, never a confident zero', () => {
  // What a squash merge leaves behind: the upstream ref is gone with the deleted head
  // branch, and the base it falls back to is not in the mirror either. Answering `0 ahead`
  // there claims the branch has nothing outstanding, which is a different thing from
  // nobody being able to tell.
  const dest = workDir('t1', 'billing')
  assert.notEqual(git(dest, 'rev-parse', '--abbrev-ref', '@{u}').code, 0, 'no upstream to lean on')

  const s = trees().state({ dir: dest, base: 'gone' })
  assert.equal(s.ahead, null)
  assert.equal(s.behind, null)
  assert.match(s.distanceUnknown, /gone/, 'git\'s own first line, naming the ref it could not resolve')
  assert.equal(s.dirty, 0, 'what could be measured still is')
})

test('a branch already on the remote is checked out and tracked, loudly, not created', () => {
  const seed = path.join(tmp, 'seed', 'acme-billing')
  gitMust(seed, 'checkout', '-q', '-b', 'feat/theirs')
  pushToRemote(seed, 'feat/theirs', 'their work')
  const dest = workDir('t3', 'billing')

  const { base } = trees().cut({ org: 'acme', repo: 'billing', branch: 'feat/theirs', dest })

  assert.equal(base, 'main', 'the base is still the remote HEAD')
  assert.equal(gitMust(dest, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feat/theirs')
  assert.match(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), /their work/)
  const { warnings: complained } = said()
  assert.match(complained, /branch feat\/theirs already exists on acme\/billing — checking it out \(not creating\)/)
})

test('state reports a worktree whose directory is gone, without asking git anything', () => {
  assert.deepEqual(trees().state({ dir: workDir('t9', 'nothing'), base: 'main' }),
    { missing: true, dirty: 0, ahead: 0, behind: 0 })
})

test('remove refuses a dirty worktree, answering git\'s reason rather than throwing', () => {
  const dest = workDir('t3', 'billing')
  fs.writeFileSync(path.join(dest, 'NOTES.md'), 'unsaved\n')
  const failed = trees().remove({ org: 'acme', repo: 'billing', dir: dest })
  assert.match(failed, /contains modified or untracked files/)
  assert.ok(fs.existsSync(dest), 'nothing torn down')
})

test('remove --force takes a dirty worktree away, and prunes the mirror\'s record of it', () => {
  const dest = workDir('t3', 'billing')
  assert.equal(trees().remove({ org: 'acme', repo: 'billing', dir: dest, force: true }), null)
  assert.ok(!fs.existsSync(dest))
  // The work directory as a path segment: the temp directory's random suffix can spell `t3`.
  assert.doesNotMatch(gitMust(mirrorOf('acme', 'billing'), 'worktree', 'list'), /\/t3\//)
})

test('remove takes a clean worktree away without being forced', () => {
  const dest = workDir('t2', 'billing')
  assert.equal(trees().remove({ org: 'acme', repo: 'billing', dir: dest }), null)
  assert.ok(!fs.existsSync(dest))
})

// Every worktree cut on a branch leaves the mirror a copy of it in `refs/heads`, because a
// worktree shares the mirror's ref store — t3 above left one of `feat/theirs`. Cutting on
// that branch again is the ordinary way back into a closed work (hugoforte/rig#149).
test('a copy left in the mirror is moved up to the remote rather than refused', () => {
  pushToRemote(path.join(tmp, 'seed', 'acme-billing'), 'feat/theirs', 'more of their work')
  const dest = workDir('t10', 'billing')

  trees().cut({ org: 'acme', repo: 'billing', branch: 'feat/theirs', dest })

  assert.equal(gitMust(dest, 'rev-parse', 'HEAD'), gitMust(dest, 'rev-parse', 'origin/feat/theirs'))
  assert.equal(gitMust(dest, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feat/theirs')
})

test('a copy left in the mirror ahead of the remote is checked out as it is, commits kept', () => {
  const left = workDir('t10', 'billing')
  fs.writeFileSync(path.join(left, 'NOTES.md'), 'never pushed\n')
  gitMust(left, 'add', '-A')
  gitMust(left, 'commit', '-q', '-m', 'never pushed')
  const kept = gitMust(left, 'rev-parse', 'HEAD')
  assert.equal(trees().remove({ org: 'acme', repo: 'billing', dir: left }), null)
  const dest = workDir('t11', 'billing')

  trees().cut({ org: 'acme', repo: 'billing', branch: 'feat/theirs', dest })

  assert.equal(gitMust(dest, 'rev-parse', 'HEAD'), kept)
  assert.equal(gitMust(dest, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feat/theirs')
})

test('a copy left in the mirror that has diverged from the remote is refused and left alone', () => {
  const left = workDir('t11', 'billing')
  assert.equal(trees().remove({ org: 'acme', repo: 'billing', dir: left }), null)
  const mirror = mirrorOf('acme', 'billing')
  const kept = gitMust(mirror, 'rev-parse', 'refs/heads/feat/theirs')
  pushToRemote(path.join(tmp, 'seed', 'acme-billing'), 'feat/theirs', 'their work moved on')
  const dest = workDir('t12', 'billing')

  assert.throws(
    () => trees().cut({ org: 'acme', repo: 'billing', branch: 'feat/theirs', dest }),
    e => e instanceof RigError && /has diverged/.test(e.message) && /branch -D feat\/theirs/.test(e.message))
  assert.equal(gitMust(mirror, 'rev-parse', 'refs/heads/feat/theirs'), kept, 'the mirror\'s copy is untouched')
  assert.ok(!fs.existsSync(dest), 'no worktree cut')
  assert.doesNotMatch(said().warnings, /checking it out/, 'nothing claims a checkout that did not happen')
})

test('a copy left in the mirror of a branch gone from the remote is checked out as it is', () => {
  const left = workDir('t13', 'billing')
  trees().cut({ org: 'acme', repo: 'billing', branch: 'feat/t13', dest: left })
  fs.writeFileSync(path.join(left, 'NOTES.md'), 'only here\n')
  gitMust(left, 'add', '-A')
  gitMust(left, 'commit', '-q', '-m', 'only here')
  const kept = gitMust(left, 'rev-parse', 'HEAD')
  assert.equal(trees().remove({ org: 'acme', repo: 'billing', dir: left }), null)
  const dest = workDir('t14', 'billing')

  trees().cut({ org: 'acme', repo: 'billing', branch: 'feat/t13', dest })

  assert.equal(gitMust(dest, 'rev-parse', 'HEAD'), kept)
  assert.match(said().warnings, /feat\/t13 is not on acme\/billing but the mirror kept a copy/)
})

test('a worktree folder deleted by hand does not keep its branch from being cut again', () => {
  const left = workDir('t14', 'billing')
  const kept = gitMust(left, 'rev-parse', 'HEAD')
  fs.rmSync(left, { recursive: true, force: true, maxRetries: 5 })
  const dest = workDir('t15', 'billing')

  trees().cut({ org: 'acme', repo: 'billing', branch: 'feat/t13', dest })

  assert.equal(gitMust(dest, 'rev-parse', 'HEAD'), kept)
})

test('anyMirror finds a mirror to ask git about an org, and answers nothing for an org with none', () => {
  assert.equal(trees().anyMirror('acme'), mirrorOf('acme', 'billing'))
  assert.equal(trees().anyMirror('nobody'), null)
})

test('the base falls back to a conventional branch when the remote never says what HEAD is', () => {
  publish('acme', 'shipping')
  // A remote whose HEAD points at a branch that does not exist: `remote set-head -a` has
  // nothing to copy, so nothing ever writes refs/remotes/origin/HEAD in the mirror.
  gitMust(remoteOf('acme', 'shipping'), 'symbolic-ref', 'HEAD', 'refs/heads/nope')

  const { base } = trees().cut({ org: 'acme', repo: 'shipping', branch: 'feat/t4', dest: workDir('t4', 'shipping') })
  assert.equal(base, 'main')
  assert.notEqual(git(mirrorOf('acme', 'shipping'), 'symbolic-ref', 'refs/remotes/origin/HEAD').code, 0,
    'the mirror was never told what the remote calls HEAD')
})

test('a repo with no branches at all fails by name instead of guessing a base', () => {
  const bare = remoteOf('acme', 'empty')
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  assert.equal(run('git', ['init', '-q', '--bare', bare]).code, 0)

  assert.throws(
    () => trees().cut({ org: 'acme', repo: 'empty', branch: 'feat/t5', dest: workDir('t5', 'empty') }),
    e => e instanceof RigError && /cannot determine the remote HEAD of acme\/empty/.test(e.message))
})

test('a repo with no remote to clone from fails on the clone, in git\'s own words', () => {
  assert.throws(
    () => trees().cut({ org: 'acme', repo: 'imaginary', branch: 'feat/t7', dest: workDir('t7', 'imaginary') }),
    e => e instanceof RigError && /git clone --bare/.test(e.message))
  assert.ok(!fs.existsSync(mirrorOf('acme', 'imaginary')), 'no half-made mirror left behind')
})

test('an unreachable remote warns and works from what the mirror already has', () => {
  fs.rmSync(path.join(remotesDir, 'acme', 'orders.git'), { recursive: true, force: true })
  const { base } = trees().cut({ org: 'acme', repo: 'orders', branch: 'feat/t6', dest: workDir('t6', 'orders') })

  assert.equal(base, 'trunk')
  assert.ok(fs.existsSync(path.join(workDir('t6', 'orders'), 'README.md')))
  const { warnings: complained } = said()
  assert.match(complained, /fetch failed for acme\/orders/)
})

test('remove answers git\'s reason when there is no mirror to remove the worktree from', () => {
  const failed = trees().remove({ org: 'nobody', repo: 'nothing', dir: workDir('t8', 'nothing') })
  assert.ok(failed, 'a removal that could not happen is reported, never reported as done')
})
