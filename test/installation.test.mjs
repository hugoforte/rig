// The installation itself: a tool checkout with a real remote, which is the one thing
// test/smoke.test.mjs cannot be — it copies the tool without a `.git`, so every freshness
// path short-circuits there. Everything below is local: a bare repo on disk stands in for
// the remote, so no test here touches a network.
//
// One temp installation, shared, and the tests run in order: each leaves the installation
// where the next one expects it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let tmp, origin, install, dataRoot, workRoot, env

const strip = s => s.replace(/\x1b\[\d+m/g, '')
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env })
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const cacheFile = () => path.join(workRoot, '.rig', 'freshness.json')

const rig = (args, root = install) => {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'rig.mjs'), ...args], { encoding: 'utf8', env })
  return { code: r.status, out: strip(r.stdout + r.stderr) }
}

// The refresh is detached, so its cache appears after the command has already returned.
const waitForCache = (deadlineMs = 20000) => {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    try { return readJson(cacheFile()) } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']) }
  }
  return null
}

const pushToOrigin = message => {
  const clone = path.join(tmp, `push-${Math.random().toString(36).slice(2, 8)}`)
  assert.equal(git(tmp, 'clone', '-q', origin, clone).status, 0)
  fs.appendFileSync(path.join(clone, 'NOTES.md'), `${message}\n`)
  assert.equal(git(clone, 'add', '-A').status, 0)
  assert.equal(git(clone, 'commit', '-q', '-m', message).status, 0)
  assert.equal(git(clone, 'push', '-q').status, 0)
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-install-'))
  env = { ...process.env }
  env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig')
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'rig install test'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'install@example.invalid'
  // No tracker CLI is reached by anything here, but the in-memory adapters keep it that way.
  env.RIG_FAKE_GITHUB = path.join(tmp, 'github.json')
  fs.writeFileSync(env.RIG_FAKE_GITHUB, JSON.stringify({ auth: 'missing' }))
  delete env.RIG_UPDATE_RESTARTED

  // The remote everyone clones from, seeded with this tool.
  const seed = path.join(tmp, 'seed')
  for (const d of ['bin', 'prompts', 'templates']) fs.cpSync(path.join(SRC, d), path.join(seed, d), { recursive: true })
  fs.cpSync(path.join(SRC, 'package.json'), path.join(seed, 'package.json'))
  // The real tool gitignores rig.local.json; without that the machine's own config would read
  // as an uncommitted change and `rig update` would refuse to move a perfectly clean install.
  fs.cpSync(path.join(SRC, '.gitignore'), path.join(seed, '.gitignore'))
  assert.equal(git(tmp, 'init', '-q', '-b', 'main', seed).status, 0)
  assert.equal(git(seed, 'add', '-A').status, 0)
  assert.equal(git(seed, 'commit', '-q', '-m', 'the tool').status, 0)
  origin = path.join(tmp, 'origin.git')
  assert.equal(git(tmp, 'init', '-q', '--bare', '-b', 'main', origin).status, 0)
  assert.equal(git(seed, 'push', '-q', origin, 'main').status, 0)

  install = path.join(tmp, 'install')
  assert.equal(git(tmp, 'clone', '-q', origin, install).status, 0)

  // A data root and work root for it, set up as `rig init` would leave them.
  dataRoot = path.join(tmp, 'rig-data')
  workRoot = path.join(tmp, 'w')
  fs.mkdirSync(workRoot)
  assert.equal(git(tmp, 'init', '-q', '-b', 'main', dataRoot).status, 0)
  fs.writeFileSync(path.join(dataRoot, 'rig.json'),
    JSON.stringify({ orgs: ['acme'], tracker: { acme: { kind: 'none' } }, writtenBy: '1.0.0' }, null, 2) + '\n')
  assert.equal(git(dataRoot, 'add', '-A').status, 0)
  assert.equal(git(dataRoot, 'commit', '-q', '-m', 'rig.json').status, 0)
  fs.writeFileSync(path.join(install, 'rig.local.json'), JSON.stringify({ dataRoot, workRoot }, null, 2) + '\n')
})

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) })

test('an installation level with its remote reports itself up to date', () => {
  const r = rig(['doctor'])
  assert.match(r.out, /installed rig .*up to date with origin\/main/)
})

test('doctor fetches, so it sees a remote that moved since the last command', () => {
  pushToOrigin('another machine, commit 1')
  const r = rig(['doctor'])
  assert.match(r.out, /installed rig — 1 commit\(s\) behind origin\/main — run `rig update`/)
  assert.equal(r.code, 1, 'being behind is one of the things doctor counts')
})

test('an ordinary command leaves a detached refresh behind that measures the distance', () => {
  fs.rmSync(cacheFile(), { force: true })
  const r = rig(['list', '--quick'])
  assert.equal(r.code, 0, r.out)
  const cache = waitForCache()
  assert.ok(cache, 'the refresh wrote the cache')
  assert.equal(cache.behind, 1)
  assert.equal(cache.remote, 'origin/main')
  assert.equal(cache.sha, git(install, 'rev-parse', 'HEAD').stdout.trim())
})

test('a refresh that cannot reach the remote records the failed check rather than retrying forever', () => {
  // The regression this guards: the child used to write nothing on a failed fetch, so its own
  // epilogue found a due cache and spawned a replacement, endlessly, on any offline machine.
  const moved = `${origin}.moved`
  fs.renameSync(origin, moved)
  try {
    fs.rmSync(cacheFile(), { force: true })
    const r = rig(['freshness-refresh'])
    assert.equal(r.code, 0, r.out)
    assert.equal(r.out, '', 'the refresh says nothing to anyone')
    const cache = readJson(cacheFile())
    assert.equal(cache.behind, null, 'unknown, not a green zero')
    assert.ok(Date.parse(cache.checkedAt) > 0, 'stamped, so the next command backs off for the interval')
  } finally {
    fs.renameSync(moved, origin)
  }
})

test('update fast-forwards the installation, names what arrived, and hands over to the new code', () => {
  const r = rig(['update'])
  assert.match(r.out, /tool: fast-forwarded 1 commit\(s\)/)
  assert.match(r.out, /another machine, commit 1/)
  assert.match(r.out, /continuing with the code that just arrived/)
  assert.match(r.out, /installed rig .*up to date/, 'the doctor checks ran, from the new code')
})

test('update refuses a tool checkout with uncommitted changes, and still updates the data root', () => {
  pushToOrigin('another machine, commit 2')
  fs.appendFileSync(path.join(install, 'bin', 'rig.mjs'), '\n// local hack\n')
  try {
    const r = rig(['update'])
    assert.match(r.out, /tool: 1 uncommitted change\(s\) — not updated/)
    assert.doesNotMatch(r.out, /fast-forwarded/)
  } finally {
    assert.equal(git(install, 'checkout', '-q', '--', 'bin/rig.mjs').status, 0)
  }
})

test('update refuses a diverged tool checkout rather than merging it', () => {
  fs.appendFileSync(path.join(install, 'LOCAL.md'), 'a commit of my own\n')
  assert.equal(git(install, 'add', '-A').status, 0)
  assert.equal(git(install, 'commit', '-q', '-m', 'local commit').status, 0)
  const r = rig(['update'])
  assert.match(r.out, /tool: \d+ behind and \d+ ahead of its upstream — not updated/)
  assert.equal(git(install, 'log', '-1', '--format=%s').stdout.trim(), 'local commit', 'nothing was rebased under it')
})

test('the copy inside a linked worktree is never judged, and says so', () => {
  const worktree = path.join(tmp, 'work-copy')
  assert.equal(git(install, 'worktree', 'add', '-q', '-b', 'feat/x', worktree).status, 0)
  fs.writeFileSync(path.join(worktree, 'rig.local.json'), JSON.stringify({ dataRoot, workRoot }, null, 2) + '\n')
  const r = rig(['doctor'], worktree)
  assert.match(r.out, /freshness not checked — the tool is running from a linked worktree/)
  assert.doesNotMatch(r.out, /commit\(s\) behind/)

  const updated = rig(['update'], worktree)
  assert.match(updated.out, /copy in a worktree/)
  assert.doesNotMatch(updated.out, /fast-forwarded/)
})
