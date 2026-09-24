// The temp tree the worktrees family works in, and the moves the tests make in it: a bare
// repo standing in for a GitHub remote, a commit pushed to it as a colleague would, and the
// module wired to that directory of remotes so every clone, fetch, push and `worktree add`
// is the real thing, only local. Nothing here needs a network or `gh`.
//
// Two files test `bin/worktrees.mjs`, each with a tree of its own built from here: the mirror
// and worktree lifecycle in worktrees, and reading a work's stack in worktrees-stack. They
// were one file, second-slowest in the suite on its own at about 35 s on a Windows runner,
// and `node --test` parallelises by file (hugoforte/rig#155).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { worktrees, remotesInDirectory } from '../bin/worktrees.mjs'

// `prefix` names the temp directory, so a failing run says which file left it behind.
export function worktreesFixture (prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  // The tree is built before the test file has registered `after(cleanup)`, so a build that
  // throws would leave it behind unless this removes it.
  try {
    return { ...build(tmp), cleanup }
  } catch (e) {
    cleanup()
    throw e
  }
}

function build (tmp) {
  const remotesDir = path.join(tmp, 'remotes')
  const mirrorRoot = path.join(tmp, 'w', '.mirrors')
  const workRoot = path.join(tmp, 'w')
  const env = { ...process.env }
  // Keep every inherited setting — and anything a test writes — out of the real config.
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '')
  env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'rig worktrees'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'worktrees@example.invalid'

  // What the module narrated, newest last. `reset` goes before every test, so `said()` only
  // ever reads — a test that narrates without asserting cannot then weaken the next one.
  let steps = []
  let warnings = []
  const reset = () => { steps = []; warnings = [] }
  const said = () => ({ steps: steps.join('\n'), warnings: warnings.join('\n') })

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

  // `env` is the run's, the way rig.mjs passes it in; `extra` is what a test adds to it to
  // see the module hand a question back to git.
  const trees = (extra = {}) => worktrees({
    mirrorRoot,
    remotes: remotesInDirectory(remotesDir),
    run,
    step: s => steps.push(s),
    warn: s => warnings.push(s),
    env: () => ({ ...env, ...extra }),
  })
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

  return { tmp, remotesDir, mirrorRoot, workRoot, run, git, gitMust, trees, said, reset, mirrorOf, remoteOf, workDir, publish, pushToRemote }
}
