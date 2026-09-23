// The installation itself: a tool checkout with a real remote, which is the one thing
// test/smoke.test.mjs cannot be — it copies the tool without a `.git`, so every freshness
// path short-circuits there. Everything below is local: a bare repo on disk stands in for
// the remote, so no test here touches a network.
//
// One temp installation, shared, and the tests run in order: each leaves the installation
// where the next one expects it. test/harness.mjs builds it; `checkout` is what makes it a
// real clone rather than the bare copy the other suites run.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { MAJOR } from '../bin/version.mjs'
import { makeInstall, readJson, strip } from './harness.mjs'

const { tmp, origin, install, dataRoot, workRoot, env, rig, git, cleanup } = makeInstall({
  prefix: 'rig-install-',
  author: 'rig install test',
  email: 'install@example.invalid',
  checkout: true,
  // No tracker CLI is reached by anything here, but the in-memory adapter keeps it that way.
  github: { auth: 'missing' },
})

// The tool spawned directly, for the four tests that need the streams apart or an environment
// the harness's runner will not build. `cwd` is the temp directory for the same reason the
// runner defaults to it: rig resolves its data root partly from the folder it runs in, and
// this suite is itself run from inside a rig work folder often enough that inheriting would
// let that folder's `.rig/data` name a root the temp installation does not configure.
const spawnRig = (args, spawnEnv = env) =>
  spawnSync(process.execPath, [path.join(install, 'bin', 'rig.mjs'), ...args],
    { encoding: 'utf8', env: spawnEnv, cwd: tmp })

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

// A data root and work root for the installation, set up as `rig init` would leave them.
fs.mkdirSync(workRoot)
assert.equal(git(tmp, 'init', '-q', '-b', 'main', dataRoot).status, 0)
fs.writeFileSync(path.join(dataRoot, 'rig.json'),
  JSON.stringify({ orgs: ['acme'], tracker: { acme: { kind: 'none' } }, writtenBy: '1.0.0' }, null, 2) + '\n')
assert.equal(git(dataRoot, 'add', '-A').status, 0)
assert.equal(git(dataRoot, 'commit', '-q', '-m', 'rig.json').status, 0)
fs.writeFileSync(path.join(install, 'rig.local.json'), JSON.stringify({ dataRoot, workRoot }, null, 2) + '\n')

after(cleanup)

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
  // Adding the file is the whole fabrication. The major is the number of files in
  // `bin/migrations` and the stamp is derived from it, so nothing else in the clone has to be
  // edited to agree — which is the point of both changes: a release that adds a migration
  // touches one new file and no shared list.
  const next = String(MAJOR + 1).padStart(4, '0')
  fs.writeFileSync(path.join(clone, 'bin', 'migrations', `${next}-arrived-with-the-update.mjs`),
    "export default { name: 'a migration that arrived with the update' }\n")
  assert.equal(git(clone, 'add', '-A').status, 0)
  assert.equal(git(clone, 'commit', '-q', '-m', 'a release that adds a migration').status, 0)
  assert.equal(git(clone, 'push', '-q').status, 0)

  const r = rig(['update'])
  assert.match(r.out, /migrated: a migration that arrived with the update/,
    'the migration list that ran came from the code the update fetched')
  assert.equal(readJson(path.join(dataRoot, 'rig.json')).writtenBy, `${MAJOR + 1}.0.0`,
    'and the stamp moved to the format that arrived')
})

test('a command that needs no git still finishes on a machine with no git on PATH', () => {
  // The freshness epilogue runs outside `main`'s error handling and calls git, and `run`
  // throws when git is absent. Without the epilogue's own guard, `rig help` ends in a stack
  // trace on a machine that never had git.
  const noGit = { ...env }
  for (const k of Object.keys(noGit)) if (k.toLowerCase() === 'path') delete noGit[k]
  noGit.PATH = [path.dirname(process.execPath), 'C:\Windows\System32', 'C:\Windows'].join(path.delimiter)
  const r = spawnRig(['help'], noGit)
  const out = strip(r.stdout + r.stderr)
  assert.equal(r.status, 0, out)
  assert.match(out, /cross-repo work harness/, 'the command itself answered')
  assert.doesNotMatch(out, /not found on PATH/, 'and nothing leaked out of the epilogue')
})

test('the machine-readable surface answers on a machine with no git on PATH', () => {
  // `release` is the one field in the payload that needs git, and the records are the rest of
  // it. A missing release is how the payload says so; dying is not.
  const noGit = { ...env }
  for (const k of Object.keys(noGit)) if (k.toLowerCase() === 'path') delete noGit[k]
  noGit.PATH = [path.dirname(process.execPath), 'C:\Windows\System32', 'C:\Windows'].join(path.delimiter)
  const r = spawnRig(['list', '--json', '--quick'], noGit)
  const out = strip(r.stdout)
  assert.equal(r.status, 0, out + strip(r.stderr))
  const payload = JSON.parse(out)
  assert.equal(payload.release, null, 'no git, so no release to name')
  assert.equal(typeof payload.recordFormat, 'number', 'and the format still answers, needing nothing')
})

test('doctor reaches its verdict on a machine with no git on PATH', () => {
  // doctor is the command you run *because* something is broken, so every git-dependent
  // check is skipped rather than attempted. It used to die partway and lose everything
  // after it — the record format, the identities, the verdict line.
  const noGit = { ...env }
  for (const k of Object.keys(noGit)) if (k.toLowerCase() === 'path') delete noGit[k]
  noGit.PATH = [path.dirname(process.execPath), 'C:\Windows\System32', 'C:\Windows'].join(path.delimiter)
  const r = spawnRig(['doctor'], noGit)
  const out = strip(r.stdout + r.stderr)
  assert.match(out, /git — not on PATH/, 'it says what is wrong')
  assert.match(out, /thing\(s\) to look at|all clear/, 'and still reaches its verdict')
  assert.doesNotMatch(out, /git not found on PATH \(spawnSync/, 'it did not die on the way')
})

test('free space with nothing on PATH is answered on Windows, and never dies trying', () => {
  // Off Windows free space is asked of `df`, and with no `df` on PATH the check is dropped,
  // not attempted: `exec` dies on a command that is not there, and this is the last check
  // doctor makes, so dying here cost Linux and macOS the verdict line and a clean exit
  // (hugoforte/rig#7). On Windows `fs.statfsSync` is in the runtime, so the answer arrives on
  // a machine carrying nothing but node.
  const bare = { ...env }
  for (const k of Object.keys(bare)) if (k.toLowerCase() === 'path') delete bare[k]
  bare.PATH = path.dirname(process.execPath)
  const r = spawnRig(['doctor'], bare)
  const out = strip(r.stdout + r.stderr)
  if (process.platform === 'win32') assert.match(out, /disk on .+\d+ GB free/, 'answered without a probe to be missing')
  assert.doesNotMatch(out, /not found on PATH \(spawnSync/, 'and it did not die making it')
  assert.match(out, /thing\(s\) to look at|all clear/, 'the verdict still lands')
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
  const r = rig(['doctor'], { root: worktree })
  assert.match(r.out, /freshness not checked — the tool is running from a linked worktree/)
  assert.doesNotMatch(r.out, /commit\(s\) behind/)

  const updated = rig(['update'], { root: worktree })
  assert.match(updated.out, /copy in a worktree/)
  assert.doesNotMatch(updated.out, /fast-forwarded/)
})

// A data root with a remote of its own, as a second machine leaves it. `local` has one
// commit that was never pushed; the remote has one that was never pulled.
const divergedDataRoot = () => {
  const stamp = Math.random().toString(36).slice(2, 8)
  const remote = path.join(tmp, `data-origin-${stamp}.git`)
  assert.equal(git(tmp, 'init', '-q', '--bare', '-b', 'main', remote).status, 0)
  const local = path.join(tmp, `data-${stamp}`)
  assert.equal(git(tmp, 'init', '-q', '-b', 'main', local).status, 0)
  fs.writeFileSync(path.join(local, 'rig.json'),
    JSON.stringify({ orgs: ['acme'], tracker: { acme: { kind: 'none' } }, writtenBy: '1.0.0' }, null, 2) + '\n')
  assert.equal(git(local, 'add', '-A').status, 0)
  assert.equal(git(local, 'commit', '-q', '-m', 'rig.json').status, 0)
  assert.equal(git(local, 'remote', 'add', 'origin', remote).status, 0)
  assert.equal(git(local, 'push', '-q', '-u', 'origin', 'main').status, 0)

  const theirs = path.join(tmp, `data-theirs-${stamp}`)
  assert.equal(git(tmp, 'clone', '-q', remote, theirs).status, 0)
  fs.writeFileSync(path.join(theirs, 'NOTES.md'), 'a record from the other machine\n')
  assert.equal(git(theirs, 'add', '-A').status, 0)
  assert.equal(git(theirs, 'commit', '-q', '-m', 'a record from the other machine').status, 0)
  assert.equal(git(theirs, 'push', '-q').status, 0)

  fs.writeFileSync(path.join(local, 'LOCAL.md'), 'a record of my own\n')
  assert.equal(git(local, 'add', '-A').status, 0)
  assert.equal(git(local, 'commit', '-q', '-m', 'a record of my own').status, 0)
  return local
}

test('update leaves a pending migration alone while the data root is diverged', () => {
  // The migration commit would land on the stale branch and be rebased onto origin by the
  // next mutating command — replayed on top of a data root the other machine may already
  // have migrated. ADR 0002: clean *and* current, and diverged is not current.
  const diverged = divergedDataRoot()
  withLocalConfig({ dataRoot: diverged }, () => {
    const r = rig(['update'])
    assert.match(r.out, /data root: 1 behind and 1 ahead of its upstream — not updated/)
    assert.match(r.out, /migration\(s\) pending, not run — it has to be clean and current first/)
    assert.doesNotMatch(r.out, /migrated:/)
    assert.equal(readJson(path.join(diverged, 'rig.json')).writtenBy, '1.0.0', 'the stamp did not move')
    assert.equal(git(diverged, 'log', '-1', '--format=%s').stdout.trim(), 'a record of my own',
      'and nothing was committed on the stale branch')
  })
})

test('update leaves a pending migration alone when it cannot tell whether the data root is current', () => {
  // Offline, "current" is unknowable, and a migration committed blind is the diverged case
  // waiting to happen the moment the remote is reachable again.
  const unreachable = divergedDataRoot()
  assert.equal(git(unreachable, 'remote', 'set-url', 'origin', path.join(tmp, 'nowhere.git')).status, 0)
  withLocalConfig({ dataRoot: unreachable }, () => {
    const r = rig(['update'])
    assert.match(r.out, /data root: could not fetch .*— not updated/)
    assert.match(r.out, /migration\(s\) pending, not run/)
    assert.equal(readJson(path.join(unreachable, 'rig.json')).writtenBy, '1.0.0', 'the stamp did not move')
  })
})

test('doctor names the release the installation stands on, and how far past it when it is past one', () => {
  // The distance is the half that matters: a version and a sha name the same build twice,
  // and neither says whether what is running was ever published. The mark is the only number
  // on this line — there is no separate version beside it to disagree with (ADR 0004).
  assert.equal(git(install, 'tag', 'v9.9.9').status, 0)
  try {
    assert.match(rig(['doctor']).out, /rig v9\.9\.9 at /)
    assert.equal(git(install, 'commit', '-q', '--allow-empty', '-m', 'a commit past the release').status, 0)
    assert.match(rig(['doctor']).out, /rig 1 past v9\.9\.9, [0-9a-f]{7} at /)
  } finally {
    assert.equal(git(install, 'reset', '-q', '--hard', 'v9.9.9').status, 0)
    assert.equal(git(install, 'tag', '-d', 'v9.9.9').status, 0)
  }
})

test('doctor falls back to the commit when no release is in the history', () => {
  assert.match(rig(['doctor']).out, /rig [0-9a-f]{7} at /)
})
