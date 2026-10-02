// Two data roots shared by two machines through their remotes. Which root holds a work is read
// from every root's records, so a mutating command brings every root forward before it chooses
// one: a work moved on the other machine has moved only in what that machine pushed
// (DESIGN.md decision 192).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
  const r =two.rig(['save', '--work', 'w', '-m', 'offline'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /data root b: could not fetch .* — working from what is here/)
  assert.equal(lastCommit(path.join(two.tmp, roots.b)), 'rig save w: offline')
  const again = two.rig(['save', '--work', 'w', '-m', 'offline again'])
  assert.doesNotMatch(again.out, /data root b: could not fetch/, 'the failure is remembered for that root')
})
