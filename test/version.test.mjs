import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MIGRATIONS, MAJOR, toolVersion, majorOf, dataMajor, pendingMigrations, writesBlocked, applyMigrations,
} from '../bin/version.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the major is the number of migrations, not a number anyone types', () => {
  assert.equal(MAJOR, MIGRATIONS.length)
  assert.equal(toolVersion({ version: '9.3.1' }), `${MAJOR}.3.1`)
})

test('package.json agrees with the derived major', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(majorOf(pkg.version), MAJOR, 'bump package.json when you add a migration')
})

test('a data root written before stamping existed is record format 0', () => {
  assert.equal(dataMajor({}), 0)
  assert.equal(dataMajor({ writtenBy: '1.2.0' }), 1)
})

test('every migration is pending against an unstamped data root', () => {
  assert.deepEqual(pendingMigrations({}), MIGRATIONS)
  assert.deepEqual(pendingMigrations({ writtenBy: `${MAJOR}.0.0` }), [])
})

test('writes are blocked only when the data root is ahead of what this rig understands', () => {
  assert.equal(writesBlocked({}), false, 'an older data root is migrated, not refused')
  assert.equal(writesBlocked({ writtenBy: `${MAJOR}.9.9` }), false)
  assert.equal(writesBlocked({ writtenBy: `${MAJOR + 1}.0.0` }), true)
})

test('migration 1 stamps the version and leaves everything else alone', () => {
  const before = { orgs: ['acme'], tracker: { acme: { kind: 'github' } } }
  const { config, ran } = applyMigrations(before, '1.0.0')
  assert.equal(ran.length, MAJOR)
  assert.equal(config.writtenBy, '1.0.0')
  assert.deepEqual(config.orgs, before.orgs)
  assert.deepEqual(config.tracker, before.tracker)
})

test('migrating twice changes nothing the second time', () => {
  const once = applyMigrations({ orgs: [] }, '1.0.0').config
  const twice = applyMigrations(once, '1.0.0')
  assert.deepEqual(twice.ran, [])
  assert.deepEqual(twice.config, once)
})
