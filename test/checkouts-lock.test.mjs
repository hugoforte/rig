// The lock a data root is held by while a command moves its git state (DESIGN.md decisions
// 160–162), against real files in a real checkout's git dir. What it asks of the machine —
// the time, a sleep, whether a process is running, this machine's name — is handed in, so
// every wait here is a count of polls and every "second session" is the fake sleep letting go
// or holding on at a chosen poll. Nothing races, sleeps for real, or rides on the scheduler.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkoutsFixture } from './checkouts-fixture.mjs'
import { checkouts, LOCK_WAIT_MS, LOCK_POLL_MS, LOCK_STALE_MS, LOCK_UNREADABLE_MS } from '../bin/checkouts.mjs'

const f = checkoutsFixture('rig-checkouts-lock-')
const { env, run, gitMust, cloned } = f
after(f.cleanup)

// A machine whose clock moves only when something sleeps on it. `onSleep` is the other
// session: it runs after the nth sleep and may let go of the lock, take it, or do nothing.
const machine = ({ start = Date.now(), onSleep = () => {}, alive = () => true } = {}) => {
  const m = { at: start, sleeps: 0 }
  m.now = () => m.at
  m.sleep = ms => { m.sleeps++; m.at += ms; onSleep(m.sleeps) }
  m.alive = pid => alive(pid)
  m.hostname = os.hostname()
  return m
}
const c = m => checkouts({ run, env: () => env, machine: () => m })
const lockFile = dir => path.join(dir, '.git', 'rig.lock')
const holder = (over = {}) => ({ command: 'rig close', work: 'other-work', section: 'commit and push', ...over })

// Another process's lock, written the way `lock` writes one.
const plant = (dir, over = {}) => {
  const body = { pid: 4242, host: os.hostname(), ...holder(), since: new Date().toISOString(), nonce: 'theirs', ...over }
  fs.writeFileSync(lockFile(dir), JSON.stringify(body) + '\n')
  return body
}

test('the lock lives in the git dir and never shows in the tree', () => {
  const { local } = cloned('in-git-dir')
  const r = c(machine()).lock(local, holder())
  assert.equal(r.outcome, 'taken')
  assert.ok(fs.existsSync(lockFile(local)))
  assert.equal(gitMust(local, 'status', '--porcelain'), '')
  c(machine()).unlock(r.lock)
})

test('a free lock is taken at once, without sleeping', () => {
  const { local } = cloned('free')
  const m = machine()
  const r = c(m).lock(local, holder())
  assert.equal(r.outcome, 'taken')
  assert.equal(m.sleeps, 0)
  const written = JSON.parse(fs.readFileSync(lockFile(local), 'utf8'))
  assert.deepEqual([written.pid, written.command, written.work, written.section], [process.pid, 'rig close', 'other-work', 'commit and push'])
  c(m).unlock(r.lock)
})

test('a held lock is waited for, and taken on the poll after its holder lets go', () => {
  const { local } = cloned('waited')
  plant(local)
  const m = machine({ onSleep: n => { if (n === 3) fs.rmSync(lockFile(local)) } })
  const r = c(m).lock(local, holder({ command: 'rig save' }))
  assert.equal(r.outcome, 'taken')
  assert.equal(m.sleeps, 3)
  assert.equal(JSON.parse(fs.readFileSync(lockFile(local), 'utf8')).command, 'rig save')
  c(m).unlock(r.lock)
})

test('a lock held past the wait is busy, and names the command, the work and how long it has been held', () => {
  const { local } = cloned('busy')
  const start = Date.now()
  plant(local, { since: new Date(start - 10_000).toISOString() })
  const m = machine({ start })
  const r = c(m).lock(local, holder({ command: 'rig save' }))
  assert.equal(r.outcome, 'busy')
  assert.equal(m.sleeps, LOCK_WAIT_MS / LOCK_POLL_MS)
  assert.deepEqual([r.holder.command, r.holder.work, r.holder.pid], ['rig close', 'other-work', 4242])
  assert.equal(r.heldFor, 10_000 + LOCK_WAIT_MS)
  assert.equal(JSON.parse(fs.readFileSync(lockFile(local), 'utf8')).nonce, 'theirs', 'a busy lock is left alone')
})

test('a lock whose holder is no longer running is taken over, and names whose it was', () => {
  const { local } = cloned('gone')
  plant(local)
  const m = machine({ alive: pid => pid !== 4242 })
  const r = c(m).lock(local, holder({ command: 'rig save' }))
  assert.equal(r.outcome, 'taken-over')
  assert.equal(m.sleeps, 0)
  assert.equal(r.stale.why, 'gone')
  assert.deepEqual([r.stale.holder.command, r.stale.holder.work], ['rig close', 'other-work'])
  c(m).unlock(r.lock)
})

test('a lock from another machine is never judged by a pid on this one', () => {
  const { local } = cloned('elsewhere')
  plant(local, { host: 'another-machine' })
  const m = machine({ alive: () => false })
  const r = c(m).lock(local, holder())
  assert.equal(r.outcome, 'busy')
})

test('a lock older than any section could take is stale even when its pid is running', () => {
  const { local } = cloned('old')
  const start = Date.now()
  plant(local, { since: new Date(start - LOCK_STALE_MS - 1).toISOString() })
  const m = machine({ start })
  const r = c(m).lock(local, holder())
  assert.equal(r.outcome, 'taken-over')
  assert.equal(r.stale.why, 'old')
  c(m).unlock(r.lock)
})

test('an unreadable lock is held only for the moment it takes to write one', () => {
  const { local } = cloned('unreadable')
  fs.writeFileSync(lockFile(local), '')
  const written = fs.statSync(lockFile(local)).mtimeMs
  // Fresh, it is waited on for the window and no longer.
  const m = machine({ start: written })
  const r = c(m).lock(local, holder())
  assert.equal(r.outcome, 'taken-over')
  assert.equal(r.stale.why, 'unreadable')
  assert.equal(r.stale.holder, null)
  assert.equal(m.sleeps, Math.floor(LOCK_UNREADABLE_MS / LOCK_POLL_MS) + 1)
  c(m).unlock(r.lock)
})

test('letting go removes only a lock this process holds', () => {
  const { local } = cloned('only-mine')
  const m = machine()
  const r = c(m).lock(local, holder())
  // Taken over while it was held — by a command that judged it stale.
  plant(local, { nonce: 'taker' })
  assert.equal(c(m).unlock(r.lock), false)
  assert.equal(JSON.parse(fs.readFileSync(lockFile(local), 'utf8')).nonce, 'taker')
})

test('a directory that is no checkout cannot be locked, and says so rather than waiting', () => {
  const m = machine()
  const r = c(m).lock(f.plain, holder())
  assert.equal(r.outcome, 'failed')
  assert.equal(m.sleeps, 0)
})
