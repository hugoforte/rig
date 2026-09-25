// How an installation hears that it is behind its remote: doctor's live check, the detached
// refresh an ordinary command leaves behind, the cache between them and the stale line read
// from it, and the settings that switch the check off or change how often it runs. The
// installation and the moves are `test/installation-fixture.mjs`, which says why the family
// is three files.
//
// One temp installation, shared, and the tests run in order: each leaves the installation
// where the next one expects it — from the second test on, one commit behind its remote.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { readJson, strip } from './harness.mjs'
import { installationFixture } from './installation-fixture.mjs'

const f = installationFixture('rig-install-freshness-')
const { tmp, origin, install, dataRoot, workRoot, env, rig, git, spawnRig, withLocalConfig, pushToOrigin } = f
after(f.cleanup)

const cacheFile = () => path.join(workRoot, '.rig', 'freshness.json')

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
  const r = spawnRig(['list', '--quick'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(strip(r.stderr), /rig is 1 commit behind origin\/main — `rig update`/)
  assert.doesNotMatch(strip(r.stdout), /behind/, 'never in the stdout someone is piping')
})

test('a checkout git is pointed at by GIT_DIR still hears that it is behind', () => {
  // With GIT_DIR set the filesystem walk hands the question back rather than answer it, and
  // the epilogue skips git only for a copy the walk has shown is no checkout. Read the other
  // way, the handed-back answer would silence the line for good on every machine that sets it.
  const r = rig(['list', '--quick'], { env: { ...env, GIT_DIR: path.join(install, '.git') } })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /rig is 1 commit behind origin\/main/)
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
