// The temp tree every file in the checkouts family reads and writes, and the moves the tests
// make in it: a bare remote with a checkout that tracks it, a checkout whose upstream has
// gone, one on a `(wip)` branch, and a push from another machine.
//
// Three files test `bin/checkouts.mjs`, each with a tree of its own built from here: reading a
// checkout in checkouts-read, fetching and fast-forwarding in checkouts-forward, committing
// and pushing in checkouts-push. They were one file, the slowest in the suite on its own at
// about 39 s on a Windows runner, and `node --test` parallelises by file: apart, no file of
// the family is above 20 s, which is what lets CI deal the suite across runners in parts of
// a similar size (hugoforte/rig#155). Every checkout a test reads is made by that test or
// here, so no test depends on another having run first.
//
// These helpers are this family's and not every scenario's, which is why they are not in
// `test/harness.mjs`: the harness builds installations, and this builds bare checkouts.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkouts } from '../bin/checkouts.mjs'
import { MOVED_BY } from '../bin/gitfs.mjs'

// `prefix` names the temp directory, so a failing run says which file left it behind.
export function checkoutsFixture (prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const env = { ...process.env }
  // The variables `gitfs.discover` steps aside for, which a developer's shell or a CI image
  // may set for reasons of its own.
  for (const name of MOVED_BY) delete env[name]
  // Keep every inherited setting — and anything a test writes — out of the real config.
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '')
  // Which config git reads is the sandbox, applied to every call. Who it commits as is not:
  // one test hands in an environment with no identity, and needs it to stay missing.
  const sandbox = { GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  Object.assign(env, sandbox)
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'rig checkouts'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'checkouts@example.invalid'

  // `run` is shaped the way rig.mjs passes it in: spawnSync's options, except that `opts.env`
  // names *additions* to the environment the runner already holds — `fetch` passes the prompt
  // guard alone and means it on top of everything else. `base` is a thunk because a test may
  // hand in an environment of its own. The sandbox goes on *last*, so the one call in the
  // family that adds anything cannot escape to the machine's real config.
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

  // The three checkouts with no remote in them, made once: a directory git knows nothing
  // about, a checkout of its own with a commit, and one whose HEAD was never born.
  const plain = path.join(tmp, 'plain')
  fs.mkdirSync(plain)
  const own = path.join(tmp, 'own')
  fs.mkdirSync(own)
  gitMust(own, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(own, 'README.md'), '# own\n')
  gitMust(own, 'add', '-A')
  gitMust(own, 'commit', '-q', '-m', 'first')
  const unborn = path.join(tmp, 'unborn')
  fs.mkdirSync(unborn)
  gitMust(unborn, 'init', '-q', '-b', 'main')

  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })

  return { tmp, env, run, runIn, git, gitMust, c, cloned, goneUpstream, onWip, pushFromElsewhere, plain, own, unborn, cleanup }
}
