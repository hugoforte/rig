// The deal CI runs the suite by. What it must hold: every test file in exactly one shard,
// whether or not the weights know it, because a file in no shard never runs and nothing says
// so; and the same deal every time, because a shard's job is decided on one runner and read
// on another.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deal, parseShard, testFiles, weight, WEIGHTS } from '../bin/shards.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = testFiles(path.join(ROOT, 'test'))

test('every test file lands in exactly one shard, and a file the weights do not know is dealt like any other', () => {
  const dealt = deal([...files, 'brand-new.test.mjs'], 6).flatMap(s => s.files).sort()
  assert.deepEqual(dealt, [...files, 'brand-new.test.mjs'].sort())
  assert.equal(weight('brand-new.test.mjs'), 1)
})

test('the same files deal the same way every time, whatever order they arrive in', () => {
  const once = deal(files, 6)
  assert.deepEqual(deal([...files].reverse(), 6), once)
  assert.deepEqual(deal(files, 6), once)
})

test('the weights name files that exist, so a renamed test does not quietly weigh a second', () => {
  const gone = Object.keys(WEIGHTS).filter(f => !files.includes(f))
  assert.deepEqual(gone, [], 'weighed but not on disk')
})

test('the shards come out within one heaviest file of each other', () => {
  const weights = deal(files, 6).map(s => s.weight)
  const heaviest = Math.max(...files.map(weight))
  assert.ok(Math.max(...weights) - Math.min(...weights) <= heaviest, weights.join(' '))
})

test('a shard is <index>/<total>, one-based, and nothing else', () => {
  assert.deepEqual(parseShard('3/6'), { index: 3, total: 6 })
  for (const bad of ['0/6', '7/6', '3', '3/0', 'three/six', undefined]) assert.throws(() => parseShard(bad), new RegExp('<index>/<total>'))
})

test('--print names the shard without running it', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'shards.mjs'), '1/6', '--print'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^shard 1\/6: \d+ files, [\d.]+ s alone: installation\.test\.mjs/)
})
