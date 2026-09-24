// What `rig update` does to a tool checkout behind its remote — fast-forwarding it, handing
// over to the code that arrived, and refusing a checkout it must not move — and what the tool
// says of the installation it stands on: on a machine with no git on PATH, from a linked
// worktree, and by release. The installation and the moves are
// `test/installation-fixture.mjs`, which says why the family is three files.
//
// One temp installation, shared, and the tests run in order: each leaves the installation
// where the next one expects it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { MAJOR } from '../bin/version.mjs'
import { readJson, strip } from './harness.mjs'
import { installationFixture } from './installation-fixture.mjs'

const f = installationFixture('rig-install-update-')
const { tmp, origin, install, dataRoot, workRoot, env, rig, git, spawnRig, pushToOrigin } = f
after(f.cleanup)

test('update fast-forwards the installation, names what arrived, and hands over to the new code', () => {
  pushToOrigin('another machine, commit 1')
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
  // Off Windows, the check is dropped rather than answered from the runtime, whose block size
  // is wrong on Linux. Only where node's own directory holds no `df`, which is every CI image
  // (setup-node puts node in a tool cache) but not a machine with node in /usr/bin.
  else if (!fs.existsSync(path.join(path.dirname(process.execPath), 'df'))) {
    assert.doesNotMatch(out, /disk on/, 'no df, so no disk line')
  }
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
