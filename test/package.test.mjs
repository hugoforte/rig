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
//
// What `npm install -g <the clone>` reads to make `rig` a command. The install itself — a link
// to the checkout, which is what lets `rig update` move the command by fast-forwarding it — is
// driven end to end by test/install.test.mjs, through the scripts the README hands people.

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

test('the documents AGENTS.md sends an agent to are packed with it', { skip }, () => {
  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8')
  for (const doc of ['DESIGN.md', 'CONTEXT.md']) {
    assert.ok(agents.includes(doc), `AGENTS.md no longer mentions ${doc}; drop it here`)
    assert.ok(paths.includes(doc), `AGENTS.md sends an agent to ${doc}, and a packaged install has no other copy`)
  }
})

// Only the release injects a real version (ADR 0004), so a publish by hand from a clone would
// put the placeholder on the registry as `latest`, where a version can never be published twice.
test('publishing the placeholder version is refused', () => {
  const r = spawnSync('npm', ['run', '-s', 'prepublishOnly'],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' })
  assert.notEqual(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stderr, /0\.0\.0-development/)
})

test('the agent skills are packed, because a packaged install has no checkout to link them from', { skip }, () => {
  const skills = fs.readdirSync(path.join(ROOT, 'skills'))
  assert.ok(skills.length > 0, 'skills/ has something to pack')
  for (const skill of skills) {
    assert.ok(paths.includes(`skills/${skill}/SKILL.md`), `skills/${skill} is not in the package`)
  }
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

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('package.json names rig as a command, pointing at a script a POSIX shell can run', () => {
  assert.equal(pkg.bin?.rig, 'bin/rig.mjs')
  const first = fs.readFileSync(path.join(ROOT, pkg.bin.rig), 'utf8').split('\n')[0]
  assert.equal(first, '#!/usr/bin/env node', 'a global install on Linux and macOS runs the file itself')
})
