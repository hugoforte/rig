// The commit identity rig reports for an org.
//
// `identities` in rig.local.json is an override rig writes onto a worktree. Without one, git
// decides — and git's answer is per-repo, because a conditional include can be keyed on the
// remote URL (`includeIf "hasconfig:remote.*.url:…"`). rig used to assume "no entry means the
// global address", which is false on any machine with such an include, so these tests pin the
// resolution to what git actually says.
//
// GIT_CONFIG_GLOBAL + GIT_CONFIG_NOSYSTEM keep the machine's real gitconfig out of it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { effectiveIdentity } from '../bin/rig.mjs'

// A mirror root as `rig attach` leaves one: <root>/<org>/<repo>.git, each a bare repo whose
// remote.origin.url is what a conditional include matches on.
const fixture = (orgs, globalConfig) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-identity-'))
  const gitconfig = path.join(tmp, 'gitconfig')
  fs.writeFileSync(gitconfig, globalConfig)
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, n: process.env.GIT_CONFIG_NOSYSTEM }
  process.env.GIT_CONFIG_GLOBAL = gitconfig
  process.env.GIT_CONFIG_NOSYSTEM = '1'

  const mirrorRoot = path.join(tmp, '.mirrors')
  for (const [org, repos] of Object.entries(orgs)) {
    for (const repo of repos) {
      const dir = path.join(mirrorRoot, org, `${repo}.git`)
      fs.mkdirSync(dir, { recursive: true })
      assert.equal(spawnSync('git', ['-C', dir, 'init', '-q', '--bare'], { encoding: 'utf8' }).status, 0)
      assert.equal(spawnSync('git', ['-C', dir, 'remote', 'add', 'origin',
        `https://github.com/${org}/${repo}.git`], { encoding: 'utf8' }).status, 0)
    }
  }
  const restore = () => {
    if (saved.g === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.g
    if (saved.n === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = saved.n
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return { mirrorRoot, restore }
}

const GLOBAL_WITH_INCLUDE = orgConfigPath => `[user]
\temail = me@personal.example
[includeIf "hasconfig:remote.*.url:https://github.com/acme/**"]
\tpath = ${orgConfigPath.split(path.sep).join('/')}
`

test('an identity recorded in rig.local.json is reported as rig\'s own, without asking git', () => {
  const { mirrorRoot, restore } = fixture({ acme: ['billing'] }, '[user]\n\temail = me@personal.example\n')
  try {
    assert.deepEqual(effectiveIdentity({ mirrorRoot, identities: { acme: 'set@by.rig' } }, 'acme'),
      { email: 'set@by.rig', source: 'rig' })
  } finally { restore() }
})

test('with no identity recorded, the org resolves to what git would commit with', () => {
  const { mirrorRoot, restore } = fixture({ acme: ['billing'] }, '[user]\n\temail = me@personal.example\n')
  try {
    assert.deepEqual(effectiveIdentity({ mirrorRoot, identities: {} }, 'acme'),
      { email: 'me@personal.example', source: 'git' })
  } finally { restore() }
})

test('a conditional include keyed on the remote URL resolves to the include\'s address, not the global one', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-identity-org-'))
  const orgConfig = path.join(tmp, 'gitconfig-acme')
  fs.writeFileSync(orgConfig, '[user]\n\temail = me@acme.example\n')
  const { mirrorRoot, restore } = fixture({ acme: ['billing'], other: ['site'] }, GLOBAL_WITH_INCLUDE(orgConfig))
  try {
    assert.deepEqual(effectiveIdentity({ mirrorRoot, identities: {} }, 'acme'),
      { email: 'me@acme.example', source: 'git' },
      'this is the case the old config-only check got wrong')
    assert.deepEqual(effectiveIdentity({ mirrorRoot, identities: {} }, 'other'),
      { email: 'me@personal.example', source: 'git' },
      'an org the include does not match still falls through to the global address')
  } finally { restore(); fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('an org with no mirror yet is unknown — rig reports that rather than guessing', () => {
  const { mirrorRoot, restore } = fixture({ acme: ['billing'] }, '[user]\n\temail = me@personal.example\n')
  try {
    assert.deepEqual(effectiveIdentity({ mirrorRoot, identities: {} }, 'never-cloned'),
      { email: null, source: 'unknown' })
  } finally { restore() }
})

test('an org git can answer for but has no email at all is the one genuinely broken state', () => {
  const { mirrorRoot, restore } = fixture({ acme: ['billing'] }, '')
  try {
    assert.deepEqual(effectiveIdentity({ mirrorRoot, identities: {} }, 'acme'),
      { email: null, source: 'none' })
  } finally { restore() }
})

test('a missing mirror root is unknown, not a crash', () => {
  assert.deepEqual(effectiveIdentity({ mirrorRoot: path.join(os.tmpdir(), 'rig-no-such-mirror-root'), identities: {} }, 'acme'),
    { email: null, source: 'unknown' })
})
