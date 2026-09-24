// Reading a checkout — `describe`, `identify`, `countCommits`, `fetch` — from the two an installation owns,
// against real git. The module's seam is the runner it is handed, so these tests hand it one
// that spawns git for real — local bare remotes in a temp tree, no network, no `gh`, and no
// CLI subprocess. A fake runner appears only where standing the state up for real would prove
// less than it costs. The tree and the moves are `test/checkouts-fixture.mjs`, which says why
// the family is three files.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { checkouts, unreadable, FETCH_ENV } from '../bin/checkouts.mjs'
import { checkoutsFixture } from './checkouts-fixture.mjs'

const f = checkoutsFixture('rig-checkouts-read-')
const { tmp, env, run, git, gitMust, c, cloned, goneUpstream, onWip, pushFromElsewhere, plain, own, unborn } = f
after(f.cleanup)

test('a directory git cannot answer for reads as unversioned, in the same shape', () => {
  // `repo` is asserted against the literal and not only against `unreadable()`: three
  // callers word 'none' and 'nested' differently, and comparing the shape to itself would
  // pin them agreeing rather than what they agree on.
  assert.equal(c().describe(plain).repo, 'none')
  assert.deepEqual(c().describe(plain), unreadable())
  assert.deepEqual(c().identify(plain), unreadable())
})

test('a directory inside another checkout is nested, and says whose', () => {
  const nested = path.join(own, 'notes', 'rig-data')
  fs.mkdirSync(nested, { recursive: true })

  const state = c().describe(nested)
  assert.equal(state.repo, 'nested')
  // git prints the long real path; the temp dir may be an 8.3 short name (CI on Windows).
  assert.equal(fs.realpathSync.native(state.top).toLowerCase(), fs.realpathSync.native(own).toLowerCase())
})

test('a checkout of its own with no upstream is level with nothing, not unknown', () => {
  const state = c().describe(own)
  assert.equal(state.repo, 'own')
  assert.equal(state.branch, 'main')
  assert.equal(state.upstream, null)
  assert.deepEqual([state.ahead, state.behind, state.dirty, state.modified], [0, 0, 0, 0])
})

test('an unborn HEAD has a branch, no head, and nowhere to go', () => {
  // `git rev-parse HEAD` exits 128 here and prints the token `HEAD` on stdout, which
  // without the guard is stamped into the freshness cache as though it were a sha.
  assert.equal(c().identify(unborn).head, null)
  assert.equal(c().identify(unborn).branch, 'main')
  assert.equal(c().describe(unborn).dirty, 0)
  assert.equal(c().fastForward(unborn).outcome, 'no-upstream')
})

test('dirty counts what `git status` reports; modified is what stops a fast-forward', () => {
  const { local } = cloned('counts')
  fs.writeFileSync(path.join(local, 'scratch.md'), 'never staged\n')
  assert.deepEqual([c().describe(local).dirty, c().describe(local).modified], [1, 0],
    'an untracked file makes the tree unsafe to commit into, and blocks nothing')

  fs.appendFileSync(path.join(local, 'README.md'), 'edited\n')
  assert.deepEqual([c().describe(local).dirty, c().describe(local).modified], [2, 1])
  gitMust(local, 'checkout', '-q', '--', 'README.md')
  fs.rmSync(path.join(local, 'scratch.md'))

  // An untracked *directory* is one entry, whatever is under it — which is why `dirty` is
  // "is there anything here" with a number beside it and not a file count.
  fs.mkdirSync(path.join(local, 'notes', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(local, 'notes', 'a.md'), 'one\n')
  fs.writeFileSync(path.join(local, 'notes', 'deep', 'b.md'), 'two\n')
  assert.deepEqual([c().describe(local).dirty, c().describe(local).modified], [1, 0])
  fs.rmSync(path.join(local, 'notes'), { recursive: true })
})

test('a stash is no change, and a rename and a conflict are one change each', () => {
  // The status header carries more than the branch — `# stash` among it, with
  // `status.showStash` on — and an entry is not always the `1 ` of an ordinary edit.
  const { local } = cloned('entries')
  gitMust(local, 'config', 'status.showStash', 'true')
  fs.appendFileSync(path.join(local, 'README.md'), 'put aside\n')
  gitMust(local, 'stash', '-q')
  assert.match(gitMust(local, 'status', '--porcelain=v2', '--branch'), /^# stash 1$/m)
  assert.deepEqual([c().describe(local).dirty, c().describe(local).modified], [0, 0], 'a stash is not the tree')

  gitMust(local, 'mv', 'README.md', 'READ.md')
  assert.deepEqual([c().describe(local).dirty, c().describe(local).modified], [1, 1], 'a staged rename')
  gitMust(local, 'mv', 'READ.md', 'README.md')

  gitMust(local, 'checkout', '-q', '-b', 'theirs')
  fs.writeFileSync(path.join(local, 'README.md'), 'theirs\n')
  gitMust(local, 'commit', '-q', '-am', 'theirs')
  gitMust(local, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(local, 'README.md'), 'ours\n')
  gitMust(local, 'commit', '-q', '-am', 'ours')
  assert.notEqual(git(local, 'merge', '-q', 'theirs').code, 0, 'the merge stops on the conflict')
  assert.deepEqual([c().describe(local).dirty, c().describe(local).modified], [1, 1], 'an unmerged file')
})

test('the upstream is its name, and distance is measured as last fetched', () => {
  const { bare, local } = cloned('distance')
  assert.equal(c().describe(local).upstream, 'origin/main')

  pushFromElsewhere(bare, 'THEIRS.md', 'from the other machine')
  assert.equal(c().describe(local).behind, 0, 'nothing is behind until something fetches')
  assert.equal(c().fetch(local).ok, true)
  assert.equal(c().describe(local).behind, 1)
})

test('a commit count git cannot answer is unknown, never zero', () => {
  const { local } = cloned('counting')
  assert.equal(c().countCommits(local, 'HEAD..HEAD'), 0)
  assert.equal(c().countCommits(local, 'refs/remotes/origin/gone..HEAD'), null)
  assert.equal(c().countCommits(path.join(tmp, 'plain'), 'HEAD..HEAD'), null)
})

test('identify answers the freshness questions and leaves the tree alone', () => {
  const { local } = cloned('freshness')
  const state = c().identify(local)
  assert.equal(state.repo, 'own')
  assert.equal(state.linked, false)
  assert.equal(state.branch, 'main')
  assert.equal(state.defaultBranch, 'main')
  assert.match(state.head, /^[0-9a-f]{7,}$/)
  assert.deepEqual([state.ahead, state.behind, state.dirty, state.modified], [null, null, null, null],
    'not measured is not zero')
})

test('a default branch the remote no longer has is not believed', () => {
  const { local } = cloned('renamed')
  // What a renamed default leaves behind: origin/HEAD still names the old branch, and the
  // ref it points at is gone. Believing it switched the freshness check off for good.
  gitMust(local, 'update-ref', '-d', 'refs/remotes/origin/main')
  assert.equal(c().identify(local).defaultBranch, null)
  assert.equal(c().identify(local).branch, 'main', 'the branch you are on is still yours')
})

test('the copy in a linked worktree knows it is one', () => {
  const { local } = cloned('linked')
  const worktree = path.join(tmp, 'linked-copy')
  gitMust(local, 'worktree', 'add', '-q', '-b', 'feat/x', worktree)
  assert.equal(c().identify(worktree).linked, true)
  assert.equal(c().identify(local).linked, false)
})

test('a branch sharing its name with a tag is named the same whether git or the filesystem reads it', () => {
  // `symbolic-ref --short` abbreviates for display, and beside a tag `rel` it prints the
  // branch `rel` as `heads/rel`. Where gitfs hands the question back git is asked for the full
  // ref instead, so both readings name the branch the same.
  const { local } = cloned('tagged')
  gitMust(local, 'checkout', '-q', '-b', 'rel')
  gitMust(local, 'tag', 'rel')
  // `discover` hands every question to git when one of git's discovery variables is in the
  // environment it reads. git never sees this one: the runner keeps its own.
  const askingGit = checkouts({ run, env: () => ({ ...env, GIT_CEILING_DIRECTORIES: path.join(tmp, 'nowhere') }) })
  assert.deepEqual([c().identify(local).branch, askingGit.identify(local).branch], ['rel', 'rel'])
})

test('a detached HEAD has no branch and still has a head', () => {
  const { local } = cloned('detached')
  gitMust(local, 'checkout', '-q', '--detach')
  const state = c().identify(local)
  assert.equal(state.branch, null)
  assert.match(state.head, /^[0-9a-f]{7,}$/)
})

test('a fetch that cannot reach its remote answers git\'s own words, and never dies', () => {
  const { local } = cloned('offline')
  gitMust(local, 'remote', 'set-url', 'origin', path.join(tmp, 'no-such-remote.git'))
  const r = c().fetch(local)
  assert.equal(r.ok, false)
  assert.ok(r.error, 'git said something, and it is what the caller reports')
})

test('a fetch may never stop to ask for credentials', () => {
  // The refresh is detached with no terminal to answer on: a fetch that prompts is a stuck
  // process for every command that armed one. The guard rides on the operation, so this
  // asserts the call and not a constant somebody could stop passing.
  let asked = null
  c((cmd, args, opts) => { asked = { cmd, args, opts }; return { code: 0, out: '', err: '' } })
    .fetch('anywhere')
  assert.equal(FETCH_ENV.GIT_TERMINAL_PROMPT, '0')
  assert.equal(asked.opts.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(asked.args.includes('fetch'), true)
})

test('the status call keeps more output than a spawn keeps by default', () => {
  // spawnSync keeps 1 MiB of a child's output and fails the call past it, and a v2 line
  // carries three modes and two object ids beside each path: a rewrite of some seven thousand
  // tracked files fills that, and every reading of the checkout would die with it.
  let kept = null
  const watching = (cmd, args, opts) => {
    if (args.includes('status')) kept = opts?.maxBuffer
    return run(cmd, args, opts)
  }
  c(watching).describe(own)
  assert.ok(kept > 1024 * 1024, `maxBuffer: ${kept}`)
})

test('describe reads a checkout in one git call, and pays the old six only when the tree fails', () => {
  // Pinned, because the symptom of it creeping back is invisible: six spawns answer the
  // same questions as one and every test still passes, and the only thing that changes is
  // that the suite takes another minute. A reading of a checkout runs at least twice per
  // mutating command, so this is the tool's own latency as much as the suite's.
  const { local } = cloned('counted')
  const calls = []
  const counting = (cmd, args) => { calls.push(args.join(' ')); return run(cmd, args) }
  c(counting).describe(local)
  assert.deepEqual(calls.map(a => a.split(' ')[2]), ['status'], calls.join('\n'))

  calls.length = 0
  const noTree = (cmd, args) => { calls.push(args.join(' ')); return args.includes('--porcelain=v2') ? { code: 128, out: '', err: 'fatal: unable to read index' } : run(cmd, args) }
  const state = c(noTree).describe(local)
  // The five the fallback costs, the first asking whether git will answer at all, plus the
  // one attempt that found out it had to. Bought on a path where git has already failed,
  // which is the trade the fallback exists to make.
  assert.equal(calls.length, 6, calls.join('\n'))
  assert.deepEqual([state.dirty, state.modified], [null, null], 'the tree is the half that went')
  assert.equal(state.branch, 'main', 'and the half that did not is still read')
})

test('placing a checkout costs no subprocess, and a directory that is none costs nothing at all', () => {
  // The question this module asks most often is where the checkout is, and the filesystem
  // answers it exactly: walking up for a `.git` entry is what git does. Pinned the same way
  // and for the same reason as the count above — the symptom of it creeping back is an
  // extra minute on the suite and nothing else.
  const { local } = cloned('placed')
  const calls = []
  const counting = (cmd, args) => { calls.push(args.join(' ')); return run(cmd, args) }
  const state = c(counting).identify(local)
  assert.deepEqual(state.branch, 'main', 'and the reading is still the reading')
  // origin/HEAD, whether the branch it names is still there, and HEAD's sha are read from the
  // files too (hugoforte/rig#153); what is left is the upstream, which is config and not a
  // ref.
  assert.deepEqual(calls.map(a => a.split(' ').slice(2, 4).join(' ')), [
    'rev-parse --abbrev-ref',
  ], calls.join('\n'))
  assert.equal(state.defaultBranch, 'main', 'and origin/HEAD is still read')
  assert.equal(state.head, gitMust(local, 'rev-parse', 'HEAD'))

  calls.length = 0
  assert.deepEqual(c(counting).identify(plain), unreadable())
  assert.deepEqual(calls, [], 'a directory that is no checkout is not worth a spawn to find out')
})

test('describe, its fallback and identify agree on the branch and the upstream', () => {
  // Which of the three answers depends on the command and on whether the index could be
  // read, so a disagreement is one checkout with two outcomes. These are the two checkouts
  // where the status header answers differently from the other readings: a gone upstream,
  // which the header still names, and a `(wip)` branch, printed there the way git prints its
  // own `(detached)`.
  const noTree = (cmd, args) => args.includes('--porcelain=v2')
    ? { code: 128, out: '', err: 'fatal: unable to read index' }
    : run(cmd, args)
  const named = ({ branch, upstream }) => ({ branch, upstream })
  for (const local of [goneUpstream('agree-gone'), onWip('agree-wip').local]) {
    const identified = named(c().identify(local))
    assert.deepEqual(named(c().describe(local)), identified, local)
    assert.deepEqual(named(c(noTree).describe(local)), identified, local)
  }
})
