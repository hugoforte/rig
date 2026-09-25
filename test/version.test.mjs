import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MIGRATIONS, MIGRATION_FILES, migrationNumber, MAJOR, FORMAT_STAMP, majorOf, dataMajor, stampUnreadable, unrunnableHook, pendingMigrations, writesBlocked, applyMigrations,
} from '../bin/version.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('the stamp is the record format and carries nothing else', () => {
  assert.equal(FORMAT_STAMP, `${MAJOR}.0.0`)
})

test('the migrations are numbered uniquely and contiguously from one', () => {
  // This is the guard that replaced git's. One file per migration means two branches that each
  // add an `0004-` merge cleanly — different files, no textual conflict — and land two
  // migrations claiming the same record format, with `MAJOR` jumping by two. Nothing else would
  // notice.
  //
  // What makes a semantic conflict as blocking as a textual one is anything that tests a change
  // in the state it lands in. `main`'s up-to-date rule is that, and it is what is on: the second
  // migration branch must update onto the first before it can merge, and this test then fails on
  // its own pull request. A merge queue would do the same job — ADR 0005 wanted one and could not
  // have one, which is why the rule it meant to replace is still what this rests on.
  const numbers = MIGRATION_FILES.map(migrationNumber)
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1),
    `bin/migrations is numbered ${numbers.join(', ')} — two migrations sharing a number is two pull requests that each added one`)
})

test('every migration names itself, because the name is what rig reports as pending', () => {
  for (const m of MIGRATIONS) assert.equal(typeof m.name, 'string', JSON.stringify(m))
})

test('what a data root is stamped with is readable as its record format', () => {
  assert.equal(majorOf(FORMAT_STAMP), MAJOR)
})

test('a stamp from before the format was derived still reads as its format', () => {
  // Data roots in the wild carry a real minor and patch, from when the stamp was the whole
  // version of the rig that migrated them. Both shapes have to keep meaning the same thing,
  // which is why moving to the derived stamp needs no migration.
  assert.equal(majorOf(`${MAJOR}.7.0`), MAJOR)
})

test('package.json carries no version for anything to read', () => {
  // ADR 0004: the tag is the version. A value here that parsed as one would invite something
  // to believe it, and the first believer was the record-format stamp.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(majorOf(pkg.version), null, 'package.json must not look like a version')
})

test('a data root written before stamping existed is record format 0, and readable', () => {
  assert.equal(dataMajor({}), 0)
  assert.equal(stampUnreadable({}), false)
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

test('migration 3 is additive on the way in and lossy on the way out, which is what moves the major', () => {
  // Both of the epic's record moves happen on the read path in `loadWork`, because there is
  // no mechanism to transform `work/*/work.json` at all (`unrunnableHook`): `status` is
  // dropped and `designed` becomes the `designedAt` gate, and `repos[].base`/`repos[].pr`
  // become the first entry of `repos[].branches[]`. Losslessly — so an older rig could *read*
  // the new shape. What it could not do is write it back: it would reintroduce `status` and
  // drop `branches[]` and `stages[]`, because it spreads the entry it read and knows none of
  // those keys. Additive reads are not enough when the write is lossy, and the write refusal
  // is exactly that distinction.
  assert.equal('config' in MIGRATIONS[2], false)
  assert.equal(unrunnableHook(MIGRATIONS[2]), null)
  const before = { orgs: ['acme'], writtenBy: '2.3.0' }
  const { config, ran } = applyMigrations(before, '3.0.0')
  assert.deepEqual(ran, [MIGRATIONS[2].name], 'a data root already at 2 has only migration 3 pending')
  assert.equal(config.writtenBy, '3.0.0')
  assert.deepEqual(config.orgs, before.orgs)
})

test('two record changes that ship together are one migration, because a major is a reachable format', () => {
  // The SDLC epic moved `work.json` twice and released once. A migration is a format someone's
  // data root can be *in*, not a changelog of shape edits — and no data root was ever stamped
  // between these two, because the intermediate state existed only on a work branch. Counting
  // them separately would claim a format nothing can be in and leave a hole in the published
  // majors. This is the assertion that would catch someone splitting them back apart.
  assert.equal(MAJOR, 3)
  assert.match(MIGRATIONS[2].name, /phase replaces status/)
  assert.match(MIGRATIONS[2].name, /stages/)
})

test('migrating twice changes nothing the second time', () => {
  const once = applyMigrations({ orgs: [] }, `${MAJOR}.0.0`).config
  const twice = applyMigrations(once, `${MAJOR}.0.0`)
  assert.deepEqual(twice.ran, [])
  assert.deepEqual(twice.config, once)
})

test('a data root stamped with something no rig wrote is refused, not treated as pristine', () => {
  for (const bad of ['v2.1.0', 'two.0.0', '', '-1.0.0', true]) {
    assert.equal(dataMajor({ writtenBy: bad }), null, `${JSON.stringify(bad)} is not a format`)
    assert.equal(stampUnreadable({ writtenBy: bad }), true)
    assert.equal(writesBlocked({ writtenBy: bad }), true, 'an unreadable stamp fails safe')
    assert.deepEqual(pendingMigrations({ writtenBy: bad }), [], 'and nothing is migrated over it')
  }
})

test('a migration carrying a hook rig cannot run is rejected, not reported as applied', () => {
  assert.equal(unrunnableHook({ name: 'a rig.json transform', config: c => c }), null)
  assert.equal(unrunnableHook({ name: 'the stamp' }), null)
  assert.equal(unrunnableHook({ name: 'rename a field in work.json', records: w => w }), 'records')
})

test('every migration rig ships is one rig can actually run', () => {
  for (const m of MIGRATIONS) assert.equal(unrunnableHook(m), null, m.name)
})
