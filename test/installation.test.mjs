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
// `accept` tells a rewritten cache from the one that was already there.
const waitForCache = (accept = () => true, deadlineMs = 20000) => {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    try { const c = readJson(cacheFile()); if (accept(c)) return c } catch { /* absent or half-written */ }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)'])
  }
  return null
}
const head = () => git(install, 'rev-parse', 'HEAD').stdout.trim()
// A cache as a refresh would have left it, `hoursAgo` old, for the checkout as it stands.
const seedCache = ({ hoursAgo = 0, behind = 1 } = {}) => {
  const checkedAt = new Date(Date.now() - hoursAgo * 3600_000).toISOString()
  fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
  fs.writeFileSync(cacheFile(), JSON.stringify({ sha: head(), remote: 'origin/main', behind, checkedAt }) + '\n')
  return checkedAt
}
// rig.json in the data root, edited for the duration of `body` and put back afterwards.
const withDataRootConfig = (edit, body) => {
  const file = path.join(dataRoot, 'rig.json')
  const before = fs.readFileSync(file, 'utf8')
  const cfg = JSON.parse(before); edit(cfg)
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
  try { body() } finally { fs.writeFileSync(file, before) }
}
const withLocalConfig = (extra, body) => {
  const file = path.join(install, 'rig.local.json')
  const before = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, JSON.stringify({ dataRoot, workRoot, ...extra }, null, 2) + '\n')
  try { body() } finally { fs.writeFileSync(file, before) }
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

test('doctor writes the cache it measured, so the next command speaks from a live check', () => {
  fs.rmSync(cacheFile(), { force: true })
  rig(['doctor'])
  const cache = readJson(cacheFile())   // no wait: doctor fetched in-process, not in a child
  assert.equal(cache.behind, 1)
  assert.equal(cache.sha, head())
})

test('the next command prints the stale line on stderr, from the cache alone', () => {
  // The cache doctor just wrote: one behind, checked seconds ago, so nothing is due and no
  // refresh is armed — the line comes from the file or not at all.
  const r = spawnSync(process.execPath, [path.join(install, 'bin', 'rig.mjs'), 'list', '--quick'], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  assert.match(strip(r.stderr), /rig is 1 commit behind origin\/main — `rig update`/)
  assert.doesNotMatch(strip(r.stdout), /behind/, 'never in the stdout someone is piping')
})

test('freshness switched off in rig.json silences the line on every machine', () => {
  withDataRootConfig(cfg => { cfg.freshness = { enabled: false } }, () => {
    const r = rig(['list', '--quick'])
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /commit behind/)
  })
})

test('rig.local.json turns it back on for this machine alone', () => {
  withDataRootConfig(cfg => { cfg.freshness = { enabled: false } }, () => {
    withLocalConfig({ freshness: { enabled: true } }, () => {
      assert.match(rig(['list', '--quick']).out, /rig is 1 commit behind origin\/main/)
    })
  })
})

test('the interval comes from rig.json', () => {
  // Two hours old is fresh at the default of 24 and due at 1: only a rig that reads the
  // configured interval refreshes here.
  const stamped = seedCache({ hoursAgo: 2 })
  withDataRootConfig(cfg => { cfg.freshness = { everyHours: 1 } }, () => {
    assert.equal(rig(['list', '--quick']).code, 0)
    assert.ok(waitForCache(c => c.checkedAt !== stamped), 'the refresh ran')
  })
})

test('an interval that is not a number is corrected to the default, not believed', () => {
  // `Number('daily')` is NaN, and "now minus then >= NaN" is false forever: believed, it
  // would switch the check off without a word. Twenty-five hours old is due at the default.
  const stamped = seedCache({ hoursAgo: 25 })
  withDataRootConfig(cfg => { cfg.freshness = { everyHours: 'daily' } }, () => {
    assert.equal(rig(['list', '--quick']).code, 0)
    assert.ok(waitForCache(c => c.checkedAt !== stamped), 'the refresh ran at the default interval')
  })
})

test('a half-written cache is measured again, not believed', () => {
  fs.writeFileSync(cacheFile(), '{"sha": "abc", "behi')
  const r = rig(['list', '--quick'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /behind|SyntaxError/, 'nothing said on the strength of half a file')
  assert.ok(waitForCache(c => c.behind === 1), 'and the refresh wrote it whole')
})

test('a cache that cannot be written is dropped without a word, and leaves no temp file', () => {
  // Something sits where the cache goes. The write fails quietly — a read-only work root is
  // no reason for every command to complain — and the temp file it went through is removed.
  // This guards the failure path of the write; that it goes through a temp file and a rename
  // is not observable from outside without a race.
  fs.rmSync(cacheFile(), { force: true })
  fs.mkdirSync(cacheFile())
  try {
    const r = rig(['freshness-refresh'])
    assert.equal(r.code, 0, r.out)
    assert.equal(r.out, '')
    assert.deepEqual(fs.readdirSync(path.dirname(cacheFile())).filter(f => f.endsWith('.tmp')), [])
  } finally {
    fs.rmdirSync(cacheFile())
  }
})

test('with no work root there is nothing to cache in, and the refresh does not make one', () => {
  // `rig doctor` checks for the work root and `rig init` makes it; a cache nobody asked for
  // must not.
  const missing = path.join(tmp, 'no-such-work-root')
  withLocalConfig({ workRoot: missing }, () => {
    const r = rig(['freshness-refresh'])
    assert.equal(r.code, 0, r.out)
    assert.equal(fs.existsSync(missing), false)
  })
})

test('update fast-forwards the installation, names what arrived, and hands over to the new code', () => {
  const r = rig(['update'])
  assert.match(r.out, /tool: fast-forwarded 1 commit\(s\)/)
  assert.match(r.out, /another machine, commit 1/)
  assert.match(r.out, /continuing with the code that just arrived/)
  assert.match(r.out, /installed rig .*up to date/, 'the doctor checks ran, from the new code')
})

test('update hands over to the code that arrived, not the code that started it', () => {
  // Asserting the announcement is not enough: remove the hop but keep the message and this
  // process carries on, holding the migration list that was on disk before the fetch. Only
  // the arrived code knows about the migration pushed below.
  const clone = path.join(tmp, 'push-migration')
  assert.equal(git(tmp, 'clone', '-q', origin, clone).status, 0)
  const versionFile = path.join(clone, 'bin', 'version.mjs')
  const before = fs.readFileSync(versionFile, 'utf8')
  assert.match(before, /^\]$/m, 'the marker the test appends to still exists')
  // Appended, not prepended: a migration's position in the list *is* its major.
  fs.writeFileSync(versionFile, before.replace(/^\]$/m,
    "  { name: 'a migration that arrived with the update' },\n]"))
  const pkgFile = path.join(clone, 'package.json')
  fs.writeFileSync(pkgFile, fs.readFileSync(pkgFile, 'utf8').replace(/"version": "\d+/, '"version": "2'))
  assert.equal(git(clone, 'add', '-A').status, 0)
  assert.equal(git(clone, 'commit', '-q', '-m', 'a release that adds a migration').status, 0)
  assert.equal(git(clone, 'push', '-q').status, 0)

  const r = rig(['update'])
  assert.match(r.out, /migrated: a migration that arrived with the update/,
    'the migration list that ran came from the code the update fetched')
  assert.equal(readJson(path.join(dataRoot, 'rig.json')).writtenBy, '2.0.0',
    'and the stamp moved to the format that arrived')
})

test('a command that needs no git still finishes on a machine with no git on PATH', () => {
  // The freshness epilogue runs outside `main`'s error handling and calls git, and `run`
  // throws when git is absent. Without the epilogue's own guard, `rig help` ends in a stack
  // trace on a machine that never had git.
  const noGit = { ...env }
  for (const k of Object.keys(noGit)) if (k.toLowerCase() === 'path') delete noGit[k]
  noGit.PATH = [path.dirname(process.execPath), 'C:\Windows\System32', 'C:\Windows'].join(path.delimiter)
  const r = spawnSync(process.execPath, [path.join(install, 'bin', 'rig.mjs'), 'help'],
    { encoding: 'utf8', env: noGit })
  const out = strip(r.stdout + r.stderr)
  assert.equal(r.status, 0, out)
  assert.match(out, /cross-repo work harness/, 'the command itself answered')
  assert.doesNotMatch(out, /not found on PATH/, 'and nothing leaked out of the epilogue')
})

test('doctor reaches its verdict on a machine with no git on PATH', () => {
  // doctor is the command you run *because* something is broken, so every git-dependent
  // check is skipped rather than attempted. It used to die partway and lose everything
  // after it — the record format, the identities, the verdict line.
  const noGit = { ...env }
  for (const k of Object.keys(noGit)) if (k.toLowerCase() === 'path') delete noGit[k]
  noGit.PATH = [path.dirname(process.execPath), 'C:\Windows\System32', 'C:\Windows'].join(path.delimiter)
  const r = spawnSync(process.execPath, [path.join(install, 'bin', 'rig.mjs'), 'doctor'],
    { encoding: 'utf8', env: noGit })
  const out = strip(r.stdout + r.stderr)
  assert.match(out, /git — not on PATH/, 'it says what is wrong')
  assert.match(out, /thing\(s\) to look at|all clear/, 'and still reaches its verdict')
  assert.doesNotMatch(out, /git not found on PATH \(spawnSync/, 'it did not die on the way')
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
