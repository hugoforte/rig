// Two commands against one data root, in process (DESIGN.md decisions 160–162). The other
// command is a lock planted in the data root's git dir, and this process's pid is what it
// names, so it reads as running; the run is handed a machine whose clock moves only when it
// sleeps, and whose sleep is where the other command lets go or holds on. So every wait here
// is a count of polls, and nothing races.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeInstall } from './harness.mjs'

const { tmp, dataRoot, workRoot, rig, git, gitMust, cleanup } = makeInstall({ inProcess: true, prefix: 'rig-lock-', localConfig: true })
after(cleanup)

const lockFile = path.join(dataRoot, '.git', 'rig.lock')
const lastCommit = dir => gitMust(dir, 'log', '-1', '--format=%s')
const dirty = () => gitMust(dataRoot, 'status', '--porcelain')

// One instant for the planted lock's `since` and the machine's clock to start from, so how long
// the lock reads as held is the machine's sleeps alone. Read apart, the git calls between the two
// readings counted too, and under a loaded run "30 s" read "31 s".
const START = Date.now()

const machine = ({ onSleep = () => {}, alive = () => true } = {}) => {
  const m = { at: START, sleeps: 0 }
  m.now = () => m.at
  m.sleep = ms => { m.sleeps++; m.at += ms; onSleep(m.sleeps) }
  m.alive = pid => alive(pid)
  m.hostname = os.hostname()
  return m
}
const plant = (over = {}) => fs.writeFileSync(lockFile, JSON.stringify({
  pid: process.pid, host: os.hostname(), command: 'rig close', work: 'other-work',
  section: 'commit and push', since: new Date(START).toISOString(), nonce: 'theirs', ...over,
}) + '\n')
const note = text => fs.writeFileSync(path.join(dataRoot, 'work', 't1', 'notes.md'), `${text}\n`)

before(() => {
  const init = rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--tracker', 'acme=none', '--email', 'you@acme.example'])
  assert.equal(init.code, 0, init.out)
  const made = rig(['new', 't1', '--title', 'One work', '--no-ticket'])
  assert.equal(made.code, 0, made.out)
})

// With no remote, the fast-forward at the start has nothing to do and takes no lock, so the
// commit at the end is the section these first tests meet the other command in.

test('rig save waits out another command\'s commit, then commits its own under its own message', () => {
  plant()
  note('waited')
  const m = machine({ onSleep: n => { if (n === 2) fs.rmSync(lockFile) } })
  const r = rig(['save', '--work', 't1', '-m', 'mine'], { machine: m })
  assert.equal(r.code, 0, r.out)
  assert.equal(m.sleeps, 2)
  assert.equal(lastCommit(dataRoot), 'rig save t1: mine')
  assert.equal(dirty(), '')
  assert.ok(!fs.existsSync(lockFile), 'let go once committed')
})

test('rig save whose data root stays busy leaves its change in the tree and names who holds it', () => {
  plant()
  note('still waiting')
  const before = lastCommit(dataRoot)
  try {
    const r = rig(['save', '--work', 't1', '-m', 'blocked'], { machine: machine() })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /data root busy — `rig close` for other-work \(pid \d+\) has held it for 30 s to commit and push it; anything this command wrote waits in the tree/)
    assert.match(r.out, /rig\.lock/, 'names the file to delete if nothing is running')
    assert.equal(lastCommit(dataRoot), before)
    assert.notEqual(dirty(), '')
  } finally {
    fs.rmSync(lockFile, { force: true })
  }
  assert.equal(rig(['save', '--work', 't1', '-m', 'after']).code, 0)
})

test('a lock left by a command that is no longer running is taken over, and rig says whose it was', () => {
  plant({ pid: 4242 })
  note('taken over')
  const m = machine({ alive: pid => pid !== 4242 })
  const r = rig(['save', '--work', 't1', '-m', 'over'], { machine: m })
  assert.equal(r.code, 0, r.out)
  assert.equal(m.sleeps, 0)
  assert.match(r.out, /took over the lock held by `rig close` for other-work \(pid 4242\), which is no longer running/)
  assert.equal(lastCommit(dataRoot), 'rig save t1: over')
})

test('a lock that cannot be taken is said, and the commit goes ahead without it', () => {
  // A directory in the lock's place: it can be neither made nor read, and the lock is advisory.
  fs.mkdirSync(lockFile)
  note('unlocked')
  try {
    const r = rig(['save', '--work', 't1', '-m', 'unlocked'], { machine: machine() })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /could not take its lock \(.*rig\.lock could be neither made nor read\) — going on without it/)
    assert.equal(lastCommit(dataRoot), 'rig save t1: unlocked')
  } finally {
    fs.rmSync(lockFile, { recursive: true, force: true })
  }
})

test('read-only commands never wait on a held lock', () => {
  plant()
  try {
    const m = machine({ onSleep: () => { throw new Error('a read-only command slept on the lock') } })
    for (const args of [['status', '--work', 't1'], ['list'], ['next', '--work', 't1'], ['catalog']]) {
      const r = rig(args, { machine: m })
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.out}`)
    }
    assert.equal(m.sleeps, 0)
  } finally {
    fs.rmSync(lockFile, { force: true })
  }
})

// From here the data root has a remote, so the fast-forward at the start is a section too.
// Each test asks for it, so any one of them can be run on its own.
const withRemote = () => {
  const remote = path.join(tmp, 'rig-data-remote.git')
  if (fs.existsSync(remote)) return
  gitMust(tmp, 'init', '-q', '--bare', '-b', 'main', remote)
  gitMust(dataRoot, 'remote', 'add', 'origin', remote)
  gitMust(dataRoot, 'push', '-q', '-u', 'origin', 'main')
}

test('a command lets go of the lock after its fast-forward and its commit, and so does rig update', () => {
  withRemote()
  note('let go')
  // Any wait at all would be this run waiting on its own lock.
  const m = machine({ onSleep: () => { throw new Error('waited on a lock nobody else holds') } })
  const r = rig(['save', '--work', 't1', '-m', 'let go'], { machine: m })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /and pushed/)
  assert.ok(!fs.existsSync(lockFile))
  rig(['update'], { machine: m })
  assert.equal(m.sleeps, 0)
  assert.ok(!fs.existsSync(lockFile))
})

test('a mutating command refuses before it runs when the fast-forward cannot get the lock', () => {
  withRemote()
  plant({ command: 'rig attach', section: 'fast-forward' })
  note('never started')
  const before = lastCommit(dataRoot)
  try {
    const r = rig(['save', '--work', 't1', '-m', 'refused'], { machine: machine() })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /data root busy — `rig attach` for other-work \(pid \d+\) has held it for 30 s to fast-forward it; nothing was done/)
    assert.equal(lastCommit(dataRoot), before)
    assert.equal(git(dataRoot, 'rev-parse', 'HEAD').stdout.trim(), git(dataRoot, 'rev-parse', '@{u}').stdout.trim(), 'nothing pushed')
  } finally {
    fs.rmSync(lockFile, { force: true })
  }
})

test('rig update leaves a data root it cannot lock alone, and says who holds it', () => {
  withRemote()
  // Clean first: uncommitted changes stop an update before it would take the lock.
  assert.equal(rig(['save', '--work', 't1', '-m', 'before the update']).code, 0)
  plant({ command: 'rig save', work: 't9', section: 'commit and push' })
  try {
    const r = rig(['update'], { machine: machine() })
    assert.notEqual(r.code, 0)
    assert.match(r.out, /data root busy — `rig save` for t9 \(pid \d+\) has held it for 30 s to commit and push it; not updated/)
  } finally {
    fs.rmSync(lockFile, { force: true })
  }
})
