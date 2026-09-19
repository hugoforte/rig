// The mirror and worktree lifecycle, against real git. The module's seam is where a
// repo's remote lives, so these tests point it at a directory of bare repos with
// `remotesInDirectory`: every clone, fetch, push and `worktree add` below is the real
// thing, only local. Nothing here needs a network or `gh`.
//
// One temp tree, shared, and the tests run in order — each leaves the mirrors and
// worktrees where the next one expects them.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { worktrees, remotesOnGitHub, remotesInDirectory } from '../bin/worktrees.mjs'
import { RigError } from '../bin/errors.mjs'

let tmp, remotesDir, mirrorRoot, workRoot, env
// What the module narrated, newest last. Reset before every test, so `said()` only ever
// reads — a test that narrates without asserting cannot then weaken the next one.
let steps = []
let warnings = []

// `run` is spawnSync-shaped, the way rig.mjs passes it in.
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env })
  if (r.error) throw r.error
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
const git = (dir, ...args) => run('git', ['-C', dir, ...args])
const gitMust = (dir, ...args) => {
  const r = git(dir, ...args)
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.err || r.out}`)
  return r.out
}

const trees = () => worktrees({
  mirrorRoot,
  remotes: remotesInDirectory(remotesDir),
  run,
  step: s => steps.push(s),
  warn: s => warnings.push(s),
})
const said = () => ({ steps: steps.join('\n'), warnings: warnings.join('\n') })
const mirrorOf = (org, repo) => path.join(mirrorRoot, org, `${repo}.git`)
const remoteOf = (org, repo) => path.join(remotesDir, org, `${repo}.git`)
const workDir = (work, repo) => path.join(workRoot, work, repo)

// A bare repo standing in for `https://github.com/<org>/<repo>.git`, with one commit on
// `branch` and a checkout beside it that can push more.
const publish = (org, repo, branch = 'main') => {
  const seed = path.join(tmp, 'seed', `${org}-${repo}`)
  fs.mkdirSync(seed, { recursive: true })
  gitMust(seed, 'init', '-q', '-b', branch)
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', `${repo}: first`)
  const bare = remoteOf(org, repo)
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  assert.equal(run('git', ['clone', '-q', '--bare', seed, bare]).code, 0)
  gitMust(seed, 'remote', 'add', 'origin', bare)
  return seed
}
// One more commit on the remote, as a colleague would leave it.
const pushToRemote = (seed, branch, message) => {
  fs.appendFileSync(path.join(seed, 'README.md'), `${message}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', message)
  gitMust(seed, 'push', '-q', 'origin', branch)
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-worktrees-'))
  remotesDir = path.join(tmp, 'remotes')
  mirrorRoot = path.join(tmp, 'w', '.mirrors')
  workRoot = path.join(tmp, 'w')
  env = { ...process.env }
  // Keep every inherited setting — and anything a test writes — out of the real config.
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '')
  env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'rig worktrees'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'worktrees@example.invalid'
})

beforeEach(() => { steps = []; warnings = [] })

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) })

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
  assert.doesNotMatch(gitMust(mirrorOf('acme', 'billing'), 'worktree', 'list'), /t3/)
})

test('remove takes a clean worktree away without being forced', () => {
  const dest = workDir('t2', 'billing')
  assert.equal(trees().remove({ org: 'acme', repo: 'billing', dir: dest }), null)
  assert.ok(!fs.existsSync(dest))
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
