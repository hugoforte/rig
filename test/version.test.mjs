import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MIGRATIONS, MAJOR, toolVersion, majorOf, dataMajor, stampUnreadable, unrunnableHook, pendingMigrations, writesBlocked, applyMigrations,
} from '../bin/version.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the major comes from the migrations, not from whatever package.json says', () => {
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

test('migration 2 is additive too: offline, no hook, and only the major moves', () => {
  // `repos[].pr` needs no `config` transform — absence already means "not yet known", which
  // is what `rig backfill` looks for — so this migration's only effect is the stamp.
  assert.equal('config' in MIGRATIONS[1], false)
  assert.equal(unrunnableHook(MIGRATIONS[1]), null)
  const before = { orgs: ['acme'], tracker: { acme: { kind: 'github' } }, writtenBy: '1.4.0' }
  const { config, ran } = applyMigrations(before, '2.0.0')
  assert.equal(ran[0], MIGRATIONS[1].name, 'a data root already at 1 starts at migration 2')
  assert.equal(config.writtenBy, '2.0.0')
  assert.deepEqual(config.orgs, before.orgs)
  assert.deepEqual(config.tracker, before.tracker)
})

test('migration 3 is additive too: the record move happens on the read path', () => {
  // `status` is dropped and `designed` becomes the `designedAt` gate in `loadWork`, because
  // there is no mechanism to transform `work/*/work.json` at all (`unrunnableHook`). So this
  // migration's only job is to move the major, which is what stops an older rig writing the
  // deleted field back into a record.
  assert.equal('config' in MIGRATIONS[2], false)
  assert.equal(unrunnableHook(MIGRATIONS[2]), null)
  const before = { orgs: ['acme'], writtenBy: '2.3.0' }
  const { config, ran } = applyMigrations(before, '3.0.0')
  assert.deepEqual(ran, [MIGRATIONS[2].name], 'a data root already at 2 has only migration 3 pending')
  assert.equal(config.writtenBy, '3.0.0')
  assert.deepEqual(config.orgs, before.orgs)
})

test('migrating twice changes nothing the second time', () => {
  const once = applyMigrations({ orgs: [] }, `${MAJOR}.0.0`).config
  const twice = applyMigrations(once, `${MAJOR}.0.0`)
  assert.deepEqual(twice.ran, [])
  assert.deepEqual(twice.config, once)
})

test('the stamp is applyMigrations to write, not migration 1', () => {
  // When only migration 1 wrote `writtenBy`, a data root already at 1 was never stamped
  // again, so every later major silently failed to take and the write refusal never fired.
  assert.equal('config' in MIGRATIONS[0], false, 'migration 1 must not carry the stamp itself')
  assert.equal(applyMigrations({}, '1.0.0').config.writtenBy, '1.0.0')
})

test('a data root stamped with something no rig wrote is refused, not treated as pristine', () => {
  for (const bad of ['v2.1.0', 'two.0.0', '', '-1.0.0', true]) {
    assert.equal(dataMajor({ writtenBy: bad }), null, `${JSON.stringify(bad)} is not a format`)
    assert.equal(stampUnreadable({ writtenBy: bad }), true)
    assert.equal(writesBlocked({ writtenBy: bad }), true, 'an unreadable stamp fails safe')
    assert.deepEqual(pendingMigrations({ writtenBy: bad }), [], 'and nothing is migrated over it')
  }
})

test('no stamp at all is format 0, which is readable and migratable', () => {
  assert.equal(stampUnreadable({}), false)
  assert.equal(dataMajor({}), 0)
})

test('a migration carrying a hook rig cannot run is rejected, not reported as applied', () => {
  assert.equal(unrunnableHook({ name: 'a rig.json transform', config: c => c }), null)
  assert.equal(unrunnableHook({ name: 'the stamp' }), null)
  assert.equal(unrunnableHook({ name: 'rename a field in work.json', records: w => w }), 'records')
})

test('every migration rig ships is one rig can actually run', () => {
  for (const m of MIGRATIONS) assert.equal(unrunnableHook(m), null, m.name)
})
