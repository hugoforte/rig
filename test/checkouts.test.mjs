// The two checkouts an installation owns, against real git. The module's seam is the
// runner it is handed, so these tests hand it one that spawns git for real — local bare
// remotes in a temp tree, no network, no `gh`, and no CLI subprocess. A fake runner
// appears only where real git will not produce the answer on demand: an unmeasurable
// distance, a refused `git add`, and a rebase whose abort fails too.
//
// One temp tree, shared, and the tests run in order — each leaves the checkouts where the
// next one expects them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkouts, unreadable, FETCH_ENV } from '../bin/checkouts.mjs'

let tmp, env, sandbox

// `run` is spawnSync-shaped, the way rig.mjs passes it in. The sandbox goes on *last*:
// `fetch` builds its environment from `process.env` to add the prompt guard, the way
// rig.mjs's own runner does, and without this the one call in the file that does so would
// escape to the machine's real git config.
const run = (cmd, args, opts = {}) => {
  const merged = { ...(opts.env ?? env), ...sandbox }
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts, env: merged })
  if (r.error) throw r.error
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
const git = (dir, ...args) => run('git', ['-C', dir, ...args])
const gitMust = (dir, ...args) => {
  const r = git(dir, ...args)
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.err || r.out}`)
  return r.out
}
const c = () => checkouts({ run })

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
// Another machine pushes, as it would while you were not looking.
const pushFromElsewhere = (bare, file, message) => {
  const theirs = path.join(tmp, `theirs-${path.basename(bare, '.git')}-${file}`)
  assert.equal(run('git', ['clone', '-q', bare, theirs]).code, 0)
  fs.writeFileSync(path.join(theirs, file), `${message}\n`)
  gitMust(theirs, 'add', '-A')
  gitMust(theirs, 'commit', '-q', '-m', message)
  gitMust(theirs, 'push', '-q')
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-checkouts-'))
  env = { ...process.env }
  // Keep every inherited setting — and anything a test writes — out of the real config.
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '')
  // Which config git reads is the sandbox, applied to every call. Who it commits as is not:
  // one test hands in an environment with no identity, and needs it to stay missing.
  sandbox = { GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  Object.assign(env, sandbox)
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'rig checkouts'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'checkouts@example.invalid'
})

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) })

test('a directory git cannot answer for reads as unversioned, in the same shape', () => {
  const plain = path.join(tmp, 'plain')
  fs.mkdirSync(plain)
  assert.deepEqual(c().describe(plain), unreadable())
  assert.deepEqual(c().identify(plain), unreadable())
})

test('a directory inside another checkout is nested, and says whose', () => {
  const own = path.join(tmp, 'own')
  fs.mkdirSync(own)
  gitMust(own, 'init', '-q', '-b', 'main')
  const nested = path.join(own, 'notes', 'rig-data')
  fs.mkdirSync(nested, { recursive: true })

  const state = c().describe(nested)
  assert.equal(state.repo, 'nested')
  // git prints the long real path; the temp dir may be an 8.3 short name (CI on Windows).
  assert.equal(fs.realpathSync.native(state.top).toLowerCase(), fs.realpathSync.native(own).toLowerCase())
})

test('a checkout of its own with no upstream is level with nothing, not unknown', () => {
  const state = c().describe(path.join(tmp, 'own'))
  assert.equal(state.repo, 'own')
  assert.equal(state.branch, 'main')
  assert.equal(state.upstream, null)
  assert.deepEqual([state.ahead, state.behind, state.dirty, state.modified], [0, 0, 0, 0])
})

test('dirty is what `git add -A` would stage; modified is what stops a fast-forward', () => {
  const { local } = cloned('counts')
  fs.writeFileSync(path.join(local, 'scratch.md'), 'never staged\n')
  assert.deepEqual([c().describe(local).dirty, c().describe(local).modified], [1, 0],
    'an untracked file makes the tree unsafe to commit into, and blocks nothing')

  fs.appendFileSync(path.join(local, 'README.md'), 'edited\n')
  assert.deepEqual([c().describe(local).dirty, c().describe(local).modified], [2, 1])
  gitMust(local, 'checkout', '-q', '--', 'README.md')
  fs.rmSync(path.join(local, 'scratch.md'))
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
  checkouts({ run: (cmd, args, opts) => { asked = { cmd, args, opts }; return { code: 0, out: '', err: '' } } })
    .fetch('anywhere')
  assert.equal(FETCH_ENV.GIT_TERMINAL_PROMPT, '0')
  assert.equal(asked.opts.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(asked.args.includes('fetch'), true)
})

test('a checkout level with its upstream is current, and nothing moves', () => {
  const { local } = cloned('current')
  const r = c().fastForward(local)
  assert.equal(r.outcome, 'current')
  assert.equal(r.state.behind, 0)
})

test('behind and clean is the whole point: it moves, and says what arrived', () => {
  const { bare, local } = cloned('moving')
  pushFromElsewhere(bare, 'THEIRS.md', 'a record from the other machine')
  assert.equal(c().fetch(local).ok, true)

  const r = c().fastForward(local)
  assert.equal(r.outcome, 'moved')
  assert.equal(r.state.behind, 1)
  assert.deepEqual(c().arrived(local, r.from).map(l => l.replace(/^\S+ /, '')),
    ['a record from the other machine'])
  assert.ok(fs.existsSync(path.join(local, 'THEIRS.md')))
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

test('a tree git could not read is not a clean tree', () => {
  // `rig update` migrates on `dirty === 0`, so reading a failed `git status` as "nothing to
  // commit" would migrate a data root it could not see into. Same rule as the counts: null.
  const unreadableTree = (cmd, args) => {
    if (args.includes('status')) return { code: 128, out: '', err: 'fatal: unable to read index' }
    if (args.includes('--show-toplevel')) return { code: 0, out: args[1], err: '' }
    if (args.includes('symbolic-ref')) return { code: 0, out: 'main', err: '' }
    if (args.includes('@{u}')) return { code: 0, out: 'origin/main', err: '' }
    if (args.includes('rev-list')) return { code: 0, out: '1', err: '' }
    return { code: 1, out: '', err: '' }
  }
  const state = checkouts({ run: unreadableTree }).describe('anywhere')
  assert.deepEqual([state.dirty, state.modified], [null, null])
  assert.equal(state.behind, 1, 'the distance was measurable; the tree was not')
  assert.equal(checkouts({ run: unreadableTree }).fastForward('anywhere').outcome, 'unmeasurable',
    'and a checkout whose tree nobody could read is not one to move')
})

test('a distance git could not measure is not a reason to move anything', () => {
  // The one answer real git will not give on demand: an upstream that exists and a
  // rev-list that fails. A confident "0 behind" here would report a checkout as current
  // on the strength of a failed command.
  const fake = (cmd, args) => {
    const sub = args[2]
    if (sub === 'rev-parse' && args.includes('--show-toplevel')) return { code: 0, out: args[1], err: '' }
    if (sub === 'symbolic-ref') return { code: 0, out: 'main', err: '' }
    if (sub === 'rev-parse' && args.includes('@{u}')) return { code: 0, out: 'origin/main', err: '' }
    if (sub === 'status') return { code: 0, out: '', err: '' }
    if (sub === 'rev-list') return { code: 1, out: '', err: 'fatal: bad revision' }
    return { code: 1, out: '', err: `unexpected: ${args.join(' ')}` }
  }
  const r = checkouts({ run: fake }).fastForward(path.join(tmp, 'own'))
  assert.equal(r.outcome, 'unmeasurable')
  assert.equal(r.state.behind, null)
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
  assert.equal(r.hash, gitMust(local, 'rev-parse', '--short', 'HEAD'), 'and HEAD is still nameable')
})

test('a commit git refuses answers git\'s reason, and the change is still there', () => {
  // No identity to commit with — the case a fresh machine meets before `rig init`.
  const { local } = cloned('nameless')
  fs.writeFileSync(path.join(local, 'record.md'), 'a record\n')
  const nameless = { ...env }
  delete nameless.GIT_AUTHOR_NAME; delete nameless.GIT_AUTHOR_EMAIL
  delete nameless.GIT_COMMITTER_NAME; delete nameless.GIT_COMMITTER_EMAIL
  const bare = checkouts({ run: (cmd, args, opts = {}) => run(cmd, args, { env: nameless, ...opts }) })

  const r = bare.commitAll(local, 'rig save: a record')
  assert.equal(r.outcome, 'commit-failed')
  assert.ok(r.error)
  assert.equal(c().describe(local).dirty, 1, 'the change waits for the next command')
})

test('a stage git refuses is its own outcome, and nothing is committed', () => {
  // `git add` failing is what a permission problem or a lock looks like; real git will not
  // produce one on demand, and the caller's advice ("commit it by hand") turns on it.
  const refuses = (cmd, args) => args.includes('add')
    ? { code: 128, out: '', err: 'fatal: Unable to create index.lock: File exists.' }
    : { code: 0, out: '', err: '' }
  const r = checkouts({ run: refuses }).commitAll('anywhere', 'rig save: blocked')
  assert.equal(r.outcome, 'stage-failed')
  assert.match(r.error, /index\.lock/)
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

test('a conflict whose abort also fails is a different answer', () => {
  // The state that needs sorting out by hand, and the one real git will not stage for us.
  const stuck = (cmd, args) => {
    if (args.includes('fetch')) return { code: 0, out: '', err: '' }
    if (args.includes('rebase') && args.includes('--abort')) return { code: 1, out: '', err: 'fatal: could not abort' }
    if (args.includes('rebase')) return { code: 1, out: '', err: 'CONFLICT (content): Merge conflict' }
    return { code: 0, out: '', err: '' }
  }
  const r = checkouts({ run: stuck }).pushRebasing('anywhere')
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
