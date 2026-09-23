// The two checkouts an installation owns, against real git. The module's seam is the
// runner it is handed, so these tests hand it one that spawns git for real — local bare
// remotes in a temp tree, no network, no `gh`, and no CLI subprocess. A fake runner
// appears five times, and only where standing the state up for real would prove less than
// it costs: the spawn options `fetch` is given, an unmeasurable distance, a `git status`
// that fails, a refused `git add`, and a rebase whose abort fails too.
//
// One temp tree, shared. Every checkout a test reads is made by that test or in `before`,
// so no test depends on another having run first — `--test-name-pattern` has to work.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkouts, unreadable, FETCH_ENV } from '../bin/checkouts.mjs'

let tmp, env, sandbox

// `run` is shaped the way rig.mjs passes it in: spawnSync's options, except that `opts.env`
// names *additions* to the environment the runner already holds — `fetch` passes the prompt
// guard alone and means it on top of everything else. `base` is a thunk because the
// environment is built in `before`. The sandbox goes on *last*, so the one call in the file
// that adds anything cannot escape to the machine's real config.
const runIn = base => (cmd, args, opts = {}) => {
  const merged = { ...base(), ...(opts.env ?? {}), ...sandbox }
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: merged })
  if (r.error) throw r.error
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
const run = runIn(() => env)
const git = (dir, ...args) => run('git', ['-C', dir, ...args])
const gitMust = (dir, ...args) => {
  const r = git(dir, ...args)
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.err || r.out}`)
  return r.out
}
// Every instance reads the test's environment and never the process's: `gitfs.discover` hands
// the question back to git whenever one of git's discovery variables is set, and a shell that
// exports one would otherwise change which of this module's paths every test takes.
const c = (runner = run) => checkouts({ run: runner, env: () => env })

// A bare remote with one commit, and a checkout of it that tracks `main`.
const cloned = name => {
  const bare = path.join(tmp, `${name}.git`)
  const seed = path.join(tmp, `${name}-seed`)
  fs.mkdirSync(seed, { recursive: true })
  gitMust(seed, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${name}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', 'first')
  assert.equal(run('git', ['clone', '-q', '--bare', seed, bare]).code, 0)
  const local = path.join(tmp, name)
  assert.equal(run('git', ['clone', '-q', bare, local]).code, 0)
  return { bare, local }
}
// A checkout whose upstream is still configured and whose ref has gone: what a
// squash-merge-and-delete, or a remote renaming its default branch, leaves after a prune.
const goneUpstream = name => {
  const { bare, local } = cloned(name)
  gitMust(bare, 'branch', '-m', 'main', 'gone')
  gitMust(local, 'fetch', '-q', '--prune', 'origin')
  return local
}
// A checkout on a branch whose name starts with a parenthesis, tracking `main`. git accepts
// the name, and prints it in `branch.head` exactly as it prints its own `(detached)`.
const onWip = name => {
  const { bare, local } = cloned(name)
  gitMust(local, 'checkout', '-q', '-b', '(wip)', '--track', 'origin/main')
  return { bare, local }
}
// Another machine pushes, as it would while you were not looking.
const pushFromElsewhere = (bare, file, message) => {
  const theirs = path.join(tmp, `theirs-${path.basename(bare, '.git')}-${file}`)
  assert.equal(run('git', ['clone', '-q', bare, theirs]).code, 0)
  fs.writeFileSync(path.join(theirs, file), `${message}\n`)
  gitMust(theirs, 'add', '-A')
  gitMust(theirs, 'commit', '-q', '-m', message)
  gitMust(theirs, 'push', '-q')
}

let plain, own, unborn

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-checkouts-'))
  env = { ...process.env }
  // The variables `gitfs.discover` steps aside for, which a developer's shell or a CI image
  // may set for reasons of its own.
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']) delete env[name]
  // Keep every inherited setting — and anything a test writes — out of the real config.
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '')
  // Which config git reads is the sandbox, applied to every call. Who it commits as is not:
  // one test hands in an environment with no identity, and needs it to stay missing.
  sandbox = { GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  Object.assign(env, sandbox)
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'rig checkouts'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'checkouts@example.invalid'

  // The three checkouts with no remote in them, made once: a directory git knows nothing
  // about, a checkout of its own with a commit, and one whose HEAD was never born.
  plain = path.join(tmp, 'plain')
  fs.mkdirSync(plain)
  own = path.join(tmp, 'own')
  fs.mkdirSync(own)
  gitMust(own, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(own, 'README.md'), '# own\n')
  gitMust(own, 'add', '-A')
  gitMust(own, 'commit', '-q', '-m', 'first')
  unborn = path.join(tmp, 'unborn')
  fs.mkdirSync(unborn)
  gitMust(unborn, 'init', '-q', '-b', 'main')
})

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) })

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
  // branch `rel` as `heads/rel` — so where gitfs handed the question back, the same checkout
  // was on a branch of a different name.
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
  // Read as detached, `rig update` refused to move it and `rig save` would not push from it.
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
  assert.deepEqual(calls.map(a => a.split(' ').slice(2, 4).join(' ')), [
    'rev-parse --abbrev-ref',            // the upstream, which is config and not a path
    'symbolic-ref -q',                   // origin/HEAD
    'rev-parse --verify',                // and whether the branch it names is still there
    'rev-parse HEAD',
  ], calls.join('\n'))

  calls.length = 0
  assert.deepEqual(c(counting).identify(plain), unreadable())
  assert.deepEqual(calls, [], 'a directory that is no checkout is not worth a spawn to find out')
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
  // Read as unmeasurable, the same data root had `rig save` rebase onto a ref that is not
  // there and `rig update` refuse the migrations behind it.
  const local = goneUpstream('gone')
  assert.equal(c().describe(local).upstream, null)
  assert.equal(c().identify(local).upstream, null)
  assert.equal(c().fastForward(local).outcome, 'no-upstream')
})

test('describe, its fallback and identify agree on the branch and the upstream', () => {
  // Which of the three answers depends on the command and on whether the index could be
  // read, so a disagreement is one checkout with two outcomes. These are the two checkouts
  // they parted on: a gone upstream that only `describe` still named, and a `(wip)` branch
  // that only `describe` called detached.
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

test('commitAll stages everything present, including what nobody staged', () => {
  const { local } = cloned('committing')
  fs.writeFileSync(path.join(local, 'record.md'), 'a record\n')
  fs.appendFileSync(path.join(local, 'README.md'), 'edited\n')

  const r = c().commitAll(local, 'rig save: a record')
  assert.equal(r.outcome, 'committed')
  assert.equal(r.hash, gitMust(local, 'rev-parse', '--short', 'HEAD'))
  assert.equal(gitMust(local, 'log', '-1', '--format=%s'), 'rig save: a record')
  assert.equal(c().describe(local).dirty, 0)
})

test('nothing to commit is an outcome, not a failure', () => {
  const { local } = cloned('nothing')
  const r = c().commitAll(local, 'rig save: nothing happened')
  assert.equal(r.outcome, 'nothing')
  assert.equal(r.hash, null, 'no commit was made, so there is none to name — and no caller reads one')
})

test('a commit git refuses answers git\'s reason, and the change is still there', () => {
  // No identity to commit with — the case a fresh machine meets before `rig init`.
  const { local } = cloned('nameless')
  fs.writeFileSync(path.join(local, 'record.md'), 'a record\n')
  const nameless = { ...env }
  delete nameless.GIT_AUTHOR_NAME; delete nameless.GIT_AUTHOR_EMAIL
  delete nameless.GIT_COMMITTER_NAME; delete nameless.GIT_COMMITTER_EMAIL
  const bare = c(runIn(() => nameless))

  const r = bare.commitAll(local, 'rig save: a record')
  assert.equal(r.outcome, 'commit-failed')
  assert.ok(r.error)
  assert.equal(c().describe(local).dirty, 1, 'the change waits for the next command')
})

test('a stage git refuses is its own outcome, and nothing is committed', () => {
  // `git add` failing is what a permission problem or a lock looks like; real git will not
  // produce one on demand, and the caller's advice ("commit it by hand") turns on it.
  const seen = []
  const refuses = (cmd, args) => {
    seen.push(args.join(' '))
    return args.includes('add')
      ? { code: 128, out: '', err: 'fatal: Unable to create index.lock: File exists.' }
      : { code: 0, out: '', err: '' }
  }
  const r = c(refuses).commitAll('anywhere', 'rig save: blocked')
  assert.equal(r.outcome, 'stage-failed')
  assert.match(r.error, /index\.lock/)
  assert.equal(seen.some(c => c.includes('commit')), false, 'and it stopped there')
})

test('a `git diff --cached` that failed says nothing about what is staged', () => {
  // Exit 1 is "something is staged" and exit 0 is "nothing is"; above that git is failing
  // to say, and reading that as "something is" commits on the strength of an error.
  const broken = (cmd, args) => args.includes('--cached')
    ? { code: 129, out: '', err: 'fatal: unknown option' }
    : { code: 0, out: '', err: '' }
  const r = c(broken).commitAll('anywhere', 'rig save: unknowable')
  assert.equal(r.outcome, 'stage-failed')
})

test('pushRebasing puts ours on top of theirs and pushes the result', () => {
  const { bare, local } = cloned('pushing')
  pushFromElsewhere(bare, 'THEIRS.md', 'a record from the other machine')
  fs.writeFileSync(path.join(local, 'MINE.md'), 'a record of my own\n')
  assert.equal(c().commitAll(local, 'rig save: a record of my own').outcome, 'committed')

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'pushed')
  assert.equal(r.hash, gitMust(local, 'rev-parse', '--short', 'HEAD'), 'the hash is the rebase\'s, not the commit\'s')
  assert.ok(fs.existsSync(path.join(local, 'THEIRS.md')), 'the other machine\'s commit was rebased under ours')
  assert.equal(run('git', ['-C', bare, 'log', '-1', '--format=%s']).out, 'rig save: a record of my own')
})

test('a conflict aborts the rebase rather than leaving the tree mid-rebase', () => {
  const { bare, local } = cloned('conflicting')
  pushFromElsewhere(bare, 'README.md', 'their line')
  fs.writeFileSync(path.join(local, 'README.md'), 'my line\n')
  assert.equal(c().commitAll(local, 'rig save: my line').outcome, 'committed')

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'conflict')
  assert.equal(gitMust(local, 'log', '-1', '--format=%s'), 'rig save: my line', 'the local commit is kept')
  assert.equal(c().describe(local).dirty, 0, 'tree left clean')
  assert.ok(!fs.existsSync(path.join(local, '.git', 'rebase-merge')), 'never left mid-rebase')
  assert.equal(run('git', ['-C', bare, 'log', '-1', '--format=%s']).out, 'their line', 'nothing pushed')
})

test('a rebase already in progress is left alone, commit and all', () => {
  // The one that used to lose work: `git rebase` fails because a rebase is already
  // underway, the abort succeeds, and it takes the user's rebase *and* the commit rig
  // just made with it — reachable afterwards only from the reflog.
  const { local } = cloned('midrebase')
  gitMust(local, 'checkout', '-q', '-b', 'side')
  fs.writeFileSync(path.join(local, 'README.md'), 'the side line\n')
  gitMust(local, 'commit', '-q', '-am', 'the side line')
  gitMust(local, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(local, 'README.md'), 'the main line\n')
  gitMust(local, 'commit', '-q', '-am', 'the main line')
  assert.notEqual(run('git', ['-C', local, 'rebase', 'side']).code, 0, 'left mid-rebase, as a user would')
  const wedged = gitMust(local, 'rev-parse', 'HEAD')

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'underway')
  assert.equal(gitMust(local, 'rev-parse', 'HEAD'), wedged, 'nothing was moved')
  assert.equal(run('git', ['-C', local, 'rebase', '--abort']).code, 0, 'their rebase is still there to abort')
})

test('a rebase that never starts is refused, not called a conflict', () => {
  // No upstream to rebase onto: git declines before anything happens, and there is
  // nothing to abort. Calling this a conflict would send the reader looking for one.
  const { local } = cloned('nostart')
  gitMust(local, 'checkout', '-q', '-b', 'sidebranch')
  fs.writeFileSync(path.join(local, 'MINE.md'), 'a record of my own\n')
  assert.equal(c().commitAll(local, 'rig save: sideways').outcome, 'committed')

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'refused')
  assert.ok(r.error)
  assert.equal(gitMust(local, 'log', '-1', '--format=%s'), 'rig save: sideways', 'the commit is still there')
})

test('a conflict whose abort also fails is a different answer', () => {
  // The state that needs sorting out by hand, and the one real git will not stage for us:
  // the rebase this started conflicted, and the abort failed too. The fake answers the
  // in-progress probe the way git would — nothing there before, something there after.
  let started = false
  const stuck = (cmd, args) => {
    if (args.includes('fetch')) return { code: 0, out: '', err: '' }
    if (args.includes('--git-path')) return { code: 0, out: started ? tmp : path.join(tmp, 'no-rebase-here'), err: '' }
    if (args.includes('rebase') && args.includes('--abort')) return { code: 1, out: '', err: 'fatal: could not abort' }
    if (args.includes('rebase')) { started = true; return { code: 1, out: '', err: 'CONFLICT (content): Merge conflict' } }
    return { code: 0, out: '', err: '' }
  }
  const r = c(stuck).pushRebasing('anywhere')
  assert.equal(r.outcome, 'conflict-stuck')
})

test('a fetch that fails is never reported as a conflict', () => {
  const { local } = cloned('unreachable')
  fs.writeFileSync(path.join(local, 'MINE.md'), 'a record of my own\n')
  assert.equal(c().commitAll(local, 'rig save: offline').outcome, 'committed')
  gitMust(local, 'remote', 'set-url', 'origin', path.join(tmp, 'no-such-remote.git'))

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'fetch-failed')
  assert.equal(gitMust(local, 'log', '-1', '--format=%s'), 'rig save: offline')
})

test('a push the remote refuses keeps the commit and says whose refusal it was', () => {
  // A remote that fetches fine and refuses the push: a checked-out branch in a non-bare
  // repo is git's own default refusal, and the nearest thing to a protected branch.
  const { local } = cloned('refused')
  const theirs = path.join(tmp, 'refusing-remote')
  assert.equal(run('git', ['clone', '-q', path.join(tmp, 'refused.git'), theirs]).code, 0)
  gitMust(theirs, 'config', 'receive.denyCurrentBranch', 'refuse')
  gitMust(local, 'remote', 'set-url', 'origin', theirs)
  gitMust(local, 'fetch', '-q')
  gitMust(local, 'branch', '--set-upstream-to=origin/main')
  fs.writeFileSync(path.join(local, 'MINE.md'), 'a record of my own\n')
  assert.equal(c().commitAll(local, 'rig save: unpushable').outcome, 'committed')

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'push-failed')
  assert.equal(r.hash, gitMust(local, 'rev-parse', '--short', 'HEAD'), 'the caller can name what is waiting')
  assert.ok(r.error)
})
