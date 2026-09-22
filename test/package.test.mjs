// What ends up inside the published package.
//
// An installation from the registry is a *copy* of this tarball and nothing else — no `.git`,
// no checkout, no repository around it. So every file rig opens at runtime has to be in here,
// and the failure mode if one is not is the reason this suite exists rather than being left to
// a careful `files` field: **`bin/migrations/` decides `MAJOR`**, which is the record format
// (ADR 0002). `MIGRATION_FILES` is a `readdirSync` of that directory, so a package that shipped
// without it would not crash — it would quietly report a *lower* record format, and then
// migrate data roots backwards on machines that had already moved on.
//
// The other reads are ordinary but just as absent-able: `rig prompt` prints `prompts/`, the
// context doc and the rollout plan are scaffolded from `templates/`, and `AGENTS.md` is what an
// agent is told to read at `<root>/AGENTS.md` — for a packaged install that copy is the only
// one on the machine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { MIGRATION_FILES } from '../bin/version.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// `npm pack` rather than a reading of the `files` field: the question is what npm *does*, and
// re-implementing its glob and default rules here would be asserting this test's idea of
// packing rather than the packer's. `--dry-run` writes nothing.
const packed = (() => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.status !== 0) return null
  try { return JSON.parse(r.stdout)[0] } catch { return null }
})()

const paths = packed ? packed.files.map(f => f.path.replace(/\\/g, '/')) : []
// npm is a dependency of the *release*, not of rig, so a machine that cannot run it skips
// rather than fails: this suite must not turn a missing npm into a broken build.
const skip = packed ? false : 'npm pack could not be run here'

test('every migration is packed, because the count of them is the record format', { skip }, () => {
  assert.ok(MIGRATION_FILES.length > 0, 'the checkout has migrations to pack in the first place')
  for (const file of MIGRATION_FILES) {
    assert.ok(paths.includes(`bin/migrations/${file}`),
      `bin/migrations/${file} is not in the package — MAJOR would be ${paths.filter(p => p.startsWith('bin/migrations/')).length}, not ${MIGRATION_FILES.length}`)
  }
})

test('the markdown rig prints and scaffolds from is packed', { skip }, () => {
  for (const dir of ['prompts', 'templates']) {
    const here = fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.md'))
    assert.ok(here.length > 0, `${dir}/ has something to pack`)
    for (const file of here) {
      assert.ok(paths.includes(`${dir}/${file}`), `${dir}/${file} is read at runtime and is not in the package`)
    }
  }
})

test('the instructions an agent is told to read are packed', { skip }, () => {
  assert.ok(paths.includes('AGENTS.md'), 'a packaged install has no repository to read it from')
})

test('the tests and CI config are not packed — nothing installs them to run them', { skip }, () => {
  for (const prefix of ['test/', '.github/']) {
    const shipped = paths.filter(p => p.startsWith(prefix))
    assert.deepEqual(shipped, [], `${prefix} is in the package`)
  }
})

test('the package is scoped, because the bare name is taken on the registry', { skip }, () => {
  assert.equal(packed.name, '@hugoforte/rig')
})

test('nothing marks the package unpublishable', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.notEqual(pkg.private, true, '`private: true` refuses `npm publish` outright')
})
