import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { versionFromTag, bumpFor, expectedVersion, checkVersion, releaseVerdict } from '../bin/release.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// A PR that would land as a minor: what `rig new --type feat` writes, and no labels.
const featPr = { branch: 'feat/name-the-release', labels: [] }

test('a tag names a version whether or not it wears the v', () => {
  assert.equal(versionFromTag('v1.2.3'), '1.2.3')
  assert.equal(versionFromTag('1.2.3'), '1.2.3')
})

test('anything that is not a release tag names no version', () => {
  for (const junk of ['v1.2', 'nightly', 'v1.2.3-rc1', '', null, undefined]) {
    assert.equal(versionFromTag(junk), null, `${JSON.stringify(junk)} is not a release tag`)
  }
})

test('the branch prefix rig already writes is the bump', () => {
  assert.equal(bumpFor(featPr).bump, 'minor')
  assert.equal(bumpFor({ branch: 'fix/doctor-exits-1-on-linux', labels: [] }).bump, 'patch')
})

test('a release label overrides the prefix, because the prefix is a default not a decree', () => {
  assert.equal(bumpFor({ ...featPr, labels: ['enhancement', 'release:patch'] }).bump, 'patch')
  assert.equal(bumpFor({ branch: 'fix/typo', labels: ['release:none'] }).bump, 'none')
})

test('a branch prefix rig never writes asks for a label rather than guessing', () => {
  const { bump, reason } = bumpFor({ branch: 'chore/tidy-the-tests', labels: [] })
  assert.equal(bump, null)
  assert.match(reason, /release:minor/)
  assert.match(reason, /chore\/tidy-the-tests/)
})

test('two release labels are a contradiction to resolve, not a race to read', () => {
  const { bump, reason } = bumpFor({ ...featPr, labels: ['release:minor', 'release:patch'] })
  assert.equal(bump, null)
  assert.match(reason, /release:minor, release:patch/)
})

test('a feature moves the minor and zeroes the patch', () => {
  assert.equal(expectedVersion({ latestTag: 'v1.4.2', bump: 'minor', major: 1 }), '1.5.0')
})

test('a fix moves the patch', () => {
  assert.equal(expectedVersion({ latestTag: 'v1.4.2', bump: 'patch', major: 1 }), '1.4.3')
})

test('release:none holds the version exactly where the last release left it', () => {
  assert.equal(expectedVersion({ latestTag: 'v1.4.2', bump: 'none', major: 1 }), '1.4.2')
})

test('adding a migration takes the version to the derived major, whatever the PR asked for', () => {
  // The major is `MIGRATIONS.length` (ADR 0002) and is never chosen by a label. A PR that
  // adds a migration lands as `MAJOR.0.0` even when it is labelled `release:none`.
  for (const bump of ['minor', 'patch', 'none']) {
    assert.equal(expectedVersion({ latestTag: 'v1.4.2', bump, major: 2 }), '2.0.0', bump)
  }
})

test('the first release is the derived major at zero', () => {
  assert.equal(expectedVersion({ latestTag: null, bump: 'minor', major: 1 }), '1.0.0')
})

test('a package.json that already says what this PR lands as passes', () => {
  const v = checkVersion({ pkgVersion: '1.5.0', latestTag: 'v1.4.2', ...featPr, major: 1 })
  assert.equal(v.ok, true)
  assert.equal(v.expected, '1.5.0')
  assert.equal(v.bump, 'minor')
})

test('a package.json that disagrees fails naming the value to write', () => {
  const v = checkVersion({ pkgVersion: '1.4.2', latestTag: 'v1.4.2', ...featPr, major: 1 })
  assert.equal(v.ok, false)
  assert.equal(v.expected, '1.5.0')
  assert.match(v.message, /1\.4\.2/)
  assert.match(v.message, /1\.5\.0/)
})

test('a PR whose bump cannot be read fails on that, not on the version', () => {
  const v = checkVersion({ pkgVersion: '1.4.2', latestTag: 'v1.4.2', branch: 'chore/x', labels: [], major: 1 })
  assert.equal(v.ok, false)
  assert.equal(v.expected, null)
  assert.match(v.message, /release:minor/)
})

test('a release cut from a format this code does not contain is a broken state, not a bump', () => {
  // The major only ever grows, so a tag ahead of `MIGRATIONS.length` means the tag came from
  // something this branch is missing — reporting a next version over the top of that would
  // release a downgrade under a higher number.
  const v = checkVersion({ pkgVersion: '1.5.0', latestTag: 'v2.0.0', ...featPr, major: 1 })
  assert.equal(v.ok, false)
  assert.match(v.message, /v2\.0\.0/)
})

test('a merge whose version is ahead of the latest tag is the release', () => {
  const r = releaseVerdict({ pkgVersion: '1.5.0', latestTag: 'v1.4.2' })
  assert.equal(r.release, true)
  assert.equal(r.tag, 'v1.5.0')
  assert.equal(r.previousTag, 'v1.4.2')
})

test('a merge that held the version releases nothing and says so', () => {
  const r = releaseVerdict({ pkgVersion: '1.4.2', latestTag: 'v1.4.2' })
  assert.equal(r.release, false)
  assert.equal(r.ok, true)
  assert.match(r.message, /release:none|already released|nothing to release/)
})

test('a merge that landed behind the latest release fails loudly instead of skipping', () => {
  // Two PRs computed the same next version and both merged: the second carries a version that
  // is already tagged content. Skipping would lose its release note silently.
  const r = releaseVerdict({ pkgVersion: '1.4.0', latestTag: 'v1.4.2' })
  assert.equal(r.release, false)
  assert.equal(r.ok, false)
  assert.match(r.message, /1\.4\.0/)
  assert.match(r.message, /v1\.4\.2/)
})

test('the first release of all has no previous tag and still releases', () => {
  const r = releaseVerdict({ pkgVersion: '1.0.0', latestTag: null })
  assert.equal(r.release, true)
  assert.equal(r.tag, 'v1.0.0')
  assert.equal(r.previousTag, null)
})

// The seam the workflow actually runs: `node bin/release.mjs`, reading this package.json.
// Both cases are stated relative to the version in the file, so they keep meaning something
// after a release moves it.

const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'release.mjs'), ...args], { encoding: 'utf8' })

test('the check passes when package.json already says what the PR lands as', () => {
  const r = run('check', '--tag', `v${pkg.version}`, '--branch', 'feat/x', '--labels', 'release:none')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(r.stdout.includes(`lands as ${pkg.version}`), r.stdout)
})

test('the check exits non-zero and names the version to write when it does not', () => {
  const r = run('check', '--tag', `v${pkg.version}`, '--branch', 'feat/x')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /set "version"/)
})

test('the verdict prints what the merge workflow reads, on stdout, alone', () => {
  const r = run('verdict', '--tag', `v${pkg.version}`)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { release: false, tag: null, previousTag: `v${pkg.version}`, version: pkg.version })
})
