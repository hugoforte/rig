// The deal CI runs the suite by. What it must hold: every test file in exactly one shard,
// whether or not the weights know it, because a file in no shard never runs and nothing says
// so; and the same deal every time, because a shard's job is decided on one runner and read
// on another.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deal, parseShard, testFiles, weight, WEIGHTS } from '../bin/shards.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = testFiles(path.join(ROOT, 'test'))

test('every test file lands in exactly one shard, and a file the weights do not know is dealt like any other', () => {
  const dealt = deal([...files, 'brand-new.test.mjs'], 8).flatMap(s => s.files).sort()
  assert.deepEqual(dealt, [...files, 'brand-new.test.mjs'].sort())
  assert.equal(weight('brand-new.test.mjs'), 1)
})

test('the same files deal the same way every time, whatever order they arrive in', () => {
  const once = deal(files, 8)
  assert.deepEqual(deal([...files].reverse(), 8), once)
  assert.deepEqual(deal(files, 8), once)
})

test('the weights name files that exist, so a renamed test does not quietly weigh a second', () => {
  const gone = Object.keys(WEIGHTS).filter(f => !files.includes(f))
  assert.deepEqual(gone, [], 'weighed but not on disk')
})

test('the shards come out within one heaviest file of each other', () => {
  const weights = deal(files, 8).map(s => s.weight)
  const heaviest = Math.max(...files.map(weight))
  assert.ok(Math.max(...weights) - Math.min(...weights) <= heaviest, weights.join(' '))
})

test('a shard is <index>/<total>, one-based, and nothing else', () => {
  assert.deepEqual(parseShard('3/6'), { index: 3, total: 6 })
  for (const bad of ['0/6', '7/6', '3', '3/0', 'three/six', undefined]) assert.throws(() => parseShard(bad), new RegExp('<index>/<total>'))
})

test('--print names the shard without running it', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'shards.mjs'), '1/8', '--print'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim().split(': ').at(-1), deal(files, 8)[0].files.join(' '))
  assert.doesNotMatch(r.stdout, /# tests/, 'nothing ran')
})

test('an empty shard runs nothing, because node --test with no files would run everything', () => {
  const spec = `${files.length + 1}/${files.length + 1}`
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'shards.mjs'), spec], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /: 0 files, /)
  assert.doesNotMatch(r.stdout, /# tests/, 'nothing ran')
})

// Plain `node --test`, which Ubuntu runs, takes every .js, .cjs and .mjs under test/ at any
// depth. The shards take `test/*.test.mjs`. A file in the gap runs on one platform and never
// on the other, and nothing would say so: this does. The helpers are named because they are
// the gap today (hugoforte/rig#154 runs them as empty tests on Ubuntu).
const HELPERS = ['harness.mjs', 'billing-install.mjs', 'checkouts-fixture.mjs', 'installation-fixture.mjs', 'worktrees-fixture.mjs']
const everything = fs.readdirSync(path.join(ROOT, 'test'), { recursive: true })
  .map(String).filter(f => /[.][cm]?js$/.test(f))

test('every file node would run as a test under test/ is dealt, or is a helper named here', () => {
  const undealt = everything.filter(f => !files.includes(f) && !HELPERS.includes(f))
  assert.deepEqual(undealt, [], 'run by node --test on Ubuntu and by no Windows shard')
})

// The gate is what the ruleset requires, and the two things that make it honest are a line of
// YAML each: without `if: always()` a failed shard leaves it skipped, and a skipped required
// check passes; and it must fail on any result but success. Read back rather than trusted.
test('the gate carries the required check name, always runs, and passes only when every shard did', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8')
  const gate = yml.slice(yml.indexOf('\n  windows:'))
  assert.notEqual(gate.length, yml.length, 'a job named windows')
  for (const line of ['name: test (windows-latest)', 'needs: shard', 'if: always()', 'test "$RESULT" = success']) {
    assert.ok(gate.includes(line), line)
  }
  const shard = yml.slice(yml.indexOf('\n  shard:'), yml.indexOf('\n  windows:'))
  assert.ok(shard.includes('node bin/shards.mjs ${{ matrix.shard }}/${{ strategy.job-total }}'), 'the total is the matrix length, written once')
})

// Two things about how a shard job runs that were each measured to matter (hugoforte/rig#160):
// the fixtures build under os.tmpdir(), which on the image is the system disk, so TEMP is
// moved to the runner's own; and Node 22 pinned, because the image's copy ran the same suite
// slower and less evenly. Read back rather than trusted, like the gate.
test('the shard jobs put the temp directory on the runner and run Node 22', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8')
  const shard = yml.slice(yml.indexOf('\n  shard:'), yml.indexOf('\n  windows:'))
  for (const line of ['node-version: 22', '"TEMP=$tmp" >> $env:GITHUB_ENV', '"TMP=$tmp" >> $env:GITHUB_ENV']) {
    assert.ok(shard.includes(line), line)
  }
  assert.ok(shard.indexOf('GITHUB_ENV') < shard.indexOf('node bin/shards.mjs'), 'the temp directory is set before the shard runs')
})
