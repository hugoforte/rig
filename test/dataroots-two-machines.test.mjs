// Two data roots shared by two machines through their remotes. Which root holds a work is read
// from every root's records, so a mutating command brings every root forward before it chooses
// one: a work moved on the other machine has moved only in what that machine pushed
// (DESIGN.md decision 192).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeInstall } from './harness.mjs'

const one = makeInstall({ prefix: 'two-machines-1-', localConfig: true, inProcess: true })
const two = makeInstall({ prefix: 'two-machines-2-', localConfig: true, inProcess: true })
test.after(() => { one.cleanup(); two.cleanup() })

// Machine one makes both roots and pushes each to a bare remote of its own.
const roots = { a: 'rig-data', b: 'rig-data-b' }
const remote = name => path.join(one.tmp, `${name}.git`)
for (const [name, dir] of Object.entries(roots)) {
  const init = one.rig(['init', '--data-root', path.join(one.tmp, dir), '--work-root', one.workRoot,
    '--orgs', `org-${name}`, '--email', 'hugo@example.invalid', '--name', name])
  assert.equal(init.code, 0, init.out)
  one.gitMust(one.tmp, 'init', '-q', '--bare', '-b', 'main', remote(name))
  one.gitMust(path.join(one.tmp, dir), 'remote', 'add', 'origin', remote(name))
  one.gitMust(path.join(one.tmp, dir), 'push', '-q', '-u', 'origin', 'main')
}
assert.equal(one.rig(['use', 'a']).code, 0)
assert.equal(one.rig(['new', 'w', '--title', 'Starts in a', '--no-ticket']).code, 0)

// Machine two clones both, with the same registry pointed at its own paths.
for (const [name, dir] of Object.entries(roots)) two.gitMust(two.tmp, 'clone', '-q', remote(name), path.join(two.tmp, dir))
const machine = JSON.parse(fs.readFileSync(one.localConfig, 'utf8'))
for (const [name, dir] of Object.entries(roots)) machine.dataRoots[name].path = path.join(two.tmp, dir)
fs.writeFileSync(two.localConfig, JSON.stringify({ ...machine, dataRoot: undefined, workRoot: two.workRoot, mirrorRoot: undefined }))
fs.mkdirSync(two.workRoot, { recursive: true })

const lastCommit = dir => one.gitMust(dir, 'log', '-1', '--format=%s', 'main')

test('a work moved on the other machine is saved into the root it moved to, though this one never pulled', () => {
  // Machine one moves `w` to b and abandons the copy in a, and pushes both.
  const inA = path.join(one.tmp, roots.a, 'work', 'w')
  fs.cpSync(inA, path.join(one.tmp, roots.b, 'work', 'w'), { recursive: true })
  const record = path.join(inA, 'work.json')
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, 'utf8')), closedAt: '2026-10-02T00:00:00Z', abandonedAt: '2026-10-02T00:00:00Z' }))
  for (const dir of Object.values(roots)) {
    one.gitMust(path.join(one.tmp, dir), 'add', '-A')
    one.gitMust(path.join(one.tmp, dir), 'commit', '-q', '-m', 'w moves to b')
    one.gitMust(path.join(one.tmp, dir), 'push', '-q')
  }
  const r = two.rig(['save', '--work', 'w', '-m', 'from machine two'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /data root b: fast-forwarded 1 commit\(s\) from origin/)
  assert.equal(lastCommit(remote('b')), 'rig save w: from machine two')
  assert.equal(lastCommit(remote('a')), 'w moves to b', 'nothing written into the abandoned copy')
})

test('a work id taken in another root on the other machine is refused before it is recorded twice', () => {
  assert.equal(one.rig(['new', 'taken', '--title', 'In b', '--no-ticket', '--data', 'b']).code, 0)
  const r = two.rig(['new', 'taken', '--title', 'Also in a', '--no-ticket'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /work "taken" belongs to data root "b" — pick another id/)
  assert.ok(!fs.existsSync(path.join(two.tmp, roots.a, 'work', 'taken')))
})

test('a root whose remote cannot be reached is said, resolved from what is here, and not asked again at once', () => {
  two.gitMust(path.join(two.tmp, roots.b), 'remote', 'set-url', 'origin', path.join(two.tmp, 'gone.git'))
  fs.appendFileSync(path.join(two.tmp, roots.b, 'work', 'w', 'context.md'), '\nWritten offline.\n')
  const r = two.rig(['save', '--work', 'w', '-m', 'offline'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /data root b: could not fetch .* — working from what is here/)
  assert.equal(lastCommit(path.join(two.tmp, roots.b)), 'rig save w: offline')
  // Remembered for that root, and for no other: a moves on, and is still fetched.
  assert.equal(one.rig(['new', 'later', '--title', 'Pushed to a', '--no-ticket', '--data', 'a']).code, 0)
  const again = two.rig(['save', '--work', 'w', '-m', 'offline again'])
  assert.equal(again.code, 0, again.out)
  assert.doesNotMatch(again.out, /data root b: could not fetch/)
  assert.match(again.out, /data root a: fast-forwarded 1 commit\(s\) from origin/)
})

test('a root this command will not commit into, busy with another command, is said and worked from as it is', () => {
  const lock = path.join(two.tmp, roots.a, '.git', 'rig.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), command: 'rig close', work: 'other',
    section: 'commit and push', since: new Date().toISOString(), nonce: 'theirs' }) + '\n')
  try {
    fs.appendFileSync(path.join(two.tmp, roots.b, 'work', 'w', 'context.md'), '\nWhile a is busy.\n')
    // A machine whose clock moves only when it sleeps, so the 30 s wait is a count of polls.
    const m = { at: Date.now(), now: () => m.at, sleep: ms => { m.at += ms }, alive: () => true, hostname: os.hostname() }
    const r = two.rig(['save', '--work', 'w', '-m', 'a is busy'], { machine: m })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /data root a busy — `rig close` for other .* — working from what is here/)
    assert.equal(lastCommit(path.join(two.tmp, roots.b)), 'rig save w: a is busy')
  } finally { fs.rmSync(lock, { force: true }) }
})

// The races decision 192 settles: a work moved on machine one while machine two cannot bring
// every root forward. `pull` stands in for machine two having seen the work where it started.
const here = (machineOf, name) => path.join(machineOf.tmp, roots[name])
const moveToB = id => {
  for (const name of ['a', 'b']) one.gitMust(here(one, name), 'pull', '-q', '--rebase')
  fs.cpSync(path.join(here(one, 'a'), 'work', id), path.join(here(one, 'b'), 'work', id), { recursive: true })
  const record = path.join(here(one, 'a'), 'work', id, 'work.json')
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, 'utf8')), closedAt: '2026-10-02T00:00:00Z', abandonedAt: '2026-10-02T00:00:00Z' }))
  for (const name of ['a', 'b']) {
    one.gitMust(here(one, name), 'add', '-A')
    one.gitMust(here(one, name), 'commit', '-q', '-m', `${id} moves to b`)
    one.gitMust(here(one, name), 'push', '-q')
  }
}
const busy = name => {
  const lock = path.join(here(two, name), '.git', 'rig.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), command: 'rig close', work: 'other',
    section: 'commit and push', since: new Date().toISOString(), nonce: 'theirs' }) + '\n')
  return () => fs.rmSync(lock, { force: true })
}
// A machine whose clock moves only when it sleeps, so a wait for a lock is a count of polls.
const clock = () => {
  const m = { at: Date.now(), slept: 0, alive: () => true, hostname: os.hostname() }
  m.now = () => m.at
  m.sleep = ms => { m.at += ms; m.slept++ }
  return m
}

test('a work moved while the root it moved to is busy is refused, naming that root, and nothing is written', () => {
  two.gitMust(here(two, 'b'), 'remote', 'set-url', 'origin', remote('b'))
  two.gitMust(here(two, 'b'), 'push', '-q')
  fs.rmSync(path.join(two.workRoot, '.rig', 'datafetch-roots.json'), { force: true })
  assert.equal(one.rig(['new', 'v', '--title', 'Starts in a', '--no-ticket', '--data', 'a']).code, 0)
  two.gitMust(here(two, 'a'), 'pull', '-q')
  moveToB('v')
  const free = busy('b')
  try {
    const m = clock()
    const r = two.rig(['save', '--work', 'v', '-m', 'into a?'], { machine: m })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /data root b busy — `rig close` for other .*nothing was done/)
    assert.equal(lastCommit(here(two, 'a')), 'v moves to b', 'nothing committed into the abandoned copy')
    assert.equal(m.slept, 0, 'a root other than the one the records choose is tried once, not waited for')
  } finally { free() }
})

test('a busy root the records chose before the sync does not stop a command the sync sent elsewhere', () => {
  const free = busy('a')
  try {
    const r = two.rig(['save', '--work', 'v', '-m', 'into b'], { machine: clock() })
    assert.equal(r.code, 0, r.out)
    assert.equal(lastCommit(remote('b')), 'rig save v: into b')
  } finally { free() }
})

test('the root the command commits into, busy, stops it, named', () => {
  const free = busy('b')
  try {
    const r = two.rig(['save', '--work', 'v', '-m', 'busy'], { machine: clock() })
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /data root b busy — .*nothing was done/)
  } finally { free() }
})

test('a work moved while the root it moved to cannot fast-forward is warned about, naming that root', () => {
  assert.equal(one.rig(['new', 'u', '--title', 'Starts in a', '--no-ticket', '--data', 'a']).code, 0)
  two.gitMust(here(two, 'a'), 'pull', '-q')
  moveToB('u')
  const tracked = path.join(here(two, 'b'), 'work', 'v', 'context.md')
  fs.appendFileSync(tracked, '\nIn the way.\n')
  try {
    const r = two.rig(['save', '--work', 'u', '-m', 'blocked b'])
    assert.match(r.out, /data root b: 1 commit\(s\) behind origin with uncommitted changes — commit or stash the changes in .*, then it will fast-forward/)
    assert.match(r.out, /! data root b could not be brought forward, so data root "a" was chosen from this machine's records/)
  } finally { two.gitMust(here(two, 'b'), 'checkout', '--', '.') }
})
