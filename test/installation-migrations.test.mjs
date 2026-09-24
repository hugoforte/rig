// Whether `rig update` runs a data root's pending migrations, by where the data root stands
// against a remote of its own: diverged from it, unable to reach it, or tracking a branch it
// no longer has. The installation and the moves are `test/installation-fixture.mjs`, which
// says why the family is three files.
//
// One temp installation, shared, and each test points it at a data root of the test's own,
// so no test depends on another having run first.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { readJson } from './harness.mjs'
import { installationFixture } from './installation-fixture.mjs'

const f = installationFixture('rig-install-migrations-')
const { tmp, rig, git, withLocalConfig } = f
after(f.cleanup)

// A data root with a remote of its own, pushed and tracking `origin/main`, at a record format
// with migrations pending.
const pushedDataRoot = () => {
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
  return { stamp, remote, local }
}

// A data root with a remote of its own, as a second machine leaves it. `local` has one
// commit that was never pushed; the remote has one that was never pulled.
const divergedDataRoot = () => {
  const { stamp, remote, local } = pushedDataRoot()
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

test('a data root whose tracked branch has gone from its remote is local-only, and still migrates', () => {
  // The remote renamed its default branch and a prune dropped `origin/main` here, so the
  // config names an upstream that is not there. Nothing can be pushed onto it and nothing
  // arrives from it, which is a data root with no upstream — not one whose distance nobody
  // could measure, which would rebase onto nothing and refuse the migrations.
  const { remote, local } = pushedDataRoot()
  assert.equal(git(remote, 'branch', '-m', 'main', 'trunk').status, 0)
  assert.equal(git(local, 'fetch', '-q', '--prune').status, 0)
  // A work root of its own, so the work made here is not one the installation's root has to
  // account for.
  const works = path.join(tmp, 'work-gone-upstream')
  fs.mkdirSync(works)
  withLocalConfig({ dataRoot: local, workRoot: works }, () => {
    const made = rig(['new', 'w1', '--title', 'One', '--no-ticket'])
    assert.match(made.out, /data root: committed [0-9a-f]{7,} \(no upstream — not pushed\)/)
    const updated = rig(['update'])
    assert.match(updated.out, /data root: no upstream — nothing to update from/)
    assert.match(updated.out, /migrated:/)
    assert.notEqual(readJson(path.join(local, 'rig.json')).writtenBy, '1.0.0', 'the stamp moved')
  })
})
