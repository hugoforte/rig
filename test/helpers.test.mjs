import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseArgs, parseFrontmatter, parseTrackerFlag, isJiraKey, isGithubKey, slug, trackerFor, RigError,
  anyTrackerConfigured, orgForJiraKey, ticketsLabel, statusLabel, nextStatusAfterAttach, dataRootState,
} from '../bin/rig.mjs'

test('parseArgs: values, booleans, and a positional after a boolean flag', () => {
  const { flags, positional } = parseArgs(['new', '--ticket', 'my-id', '--title', 'T', '--type=chore', '--force'])
  assert.deepEqual(positional, ['new', 'my-id'])
  assert.equal(flags.ticket, true)
  assert.equal(flags.title, 'T')
  assert.equal(flags.type, 'chore')
  assert.equal(flags.force, true)
})

test('parseArgs: a value flag at the end is true, not undefined', () => {
  assert.equal(parseArgs(['--email']).flags.email, true)
})

test('parseArgs: -m is --message, and a short flag is never eaten as another flag\'s value', () => {
  const { flags, positional } = parseArgs(['save', '-m', 'design agreed', '--designed'])
  assert.deepEqual(positional, ['save'])
  assert.equal(flags.message, 'design agreed')
  assert.equal(flags.designed, true)
  const swapped = parseArgs(['save', '--work', '-m', 'note']).flags
  assert.equal(swapped.work, true, '--work sees a flag next, not a value')
  assert.equal(swapped.message, 'note')
})

test('parseArgs: an unknown short flag fails rather than swallowing a positional', () => {
  assert.throws(() => parseArgs(['detach', '-f', 'billing']), /unknown flag -f/)
})

test('dataRootState: a plain directory, a checkout of its own, and a directory nested in another repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-state-'))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env })
  try {
    const plain = path.join(tmp, 'plain'); fs.mkdirSync(plain)
    assert.equal(dataRootState(plain).repo, 'none')

    const own = path.join(tmp, 'own'); fs.mkdirSync(own)
    assert.equal(git(own, 'init', '-q', '-b', 'main').status, 0)
    assert.deepEqual(dataRootState(own), { repo: 'own', branch: 'main', upstream: false, ahead: 0 })

    const nested = path.join(own, 'notes', 'rig-data'); fs.mkdirSync(nested, { recursive: true })
    const state = dataRootState(nested)
    assert.equal(state.repo, 'nested')
    // git prints the long real path; the temp dir may be an 8.3 short name (CI on Windows).
    assert.equal(fs.realpathSync.native(state.top).toLowerCase(), fs.realpathSync.native(own).toLowerCase())
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('parseFrontmatter: scalars, an empty list, and a list of objects', () => {
  const { data, body } = parseFrontmatter(`---
repo: billing
org: acme
setup: []
talks_to:
  - repo: orders-api
    how: emits OrderReturned
  - repo: orders-web
---

Prose here.`)
  assert.equal(data.repo, 'billing')
  assert.deepEqual(data.setup, [])
  assert.deepEqual(data.talks_to, [{ repo: 'orders-api', how: 'emits OrderReturned' }, { repo: 'orders-web' }])
  assert.equal(body.trim(), 'Prose here.')
})

test('parseFrontmatter: no frontmatter means empty data and the whole text as body', () => {
  const { data, body } = parseFrontmatter('just text')
  assert.deepEqual(data, {})
  assert.equal(body, 'just text')
})

test('isJiraKey: upper-case PROJECT-number only', () => {
  assert.ok(isJiraKey('PROJ-42'))
  assert.ok(!isJiraKey('proj-42'))
  assert.ok(!isJiraKey('PROJ-42-slug'))
})

test('isGithubKey: owner/repo#number only', () => {
  assert.ok(isGithubKey('acme/platform#7'))
  assert.ok(!isGithubKey('platform#7'))
  assert.ok(!isGithubKey('acme/platform'))
})

test('slug: lower-case, dashed, bounded', () => {
  assert.equal(slug('Refunds double-charge on retry!'), 'refunds-double-charge-on-retry')
  assert.equal(slug('x'.repeat(80)).length, 48)
})

test('parseTrackerFlag: every kind, merged into one object', () => {
  assert.deepEqual(parseTrackerFlag('a=github:acme/platform,b=jira:PROJ,c=none'), {
    a: { kind: 'github', repo: 'acme/platform' },
    b: { kind: 'jira', project: 'PROJ' },
    c: { kind: 'none' },
  })
})

test('parseTrackerFlag: rejects bad shapes with a RigError', () => {
  for (const bad of ['a=github', 'a=github:noslash', 'a=jira:proj', 'a=none:junk', 'a=svn:x', 'nonsense']) {
    assert.throws(() => parseTrackerFlag(bad), RigError, bad)
  }
})

const oneTracker = { tracker: { a: { kind: 'github', repo: 'x/y' }, b: { kind: 'none' } } }
const twoTrackers = { tracker: { a: { kind: 'github', repo: 'x/y' }, b: { kind: 'jira', project: 'P' } } }

test('trackerFor: the only live tracker wins without --org', () => {
  assert.deepEqual(trackerFor(oneTracker), { org: 'a', kind: 'github', repo: 'x/y' })
})

test('trackerFor: several live trackers need --org', () => {
  assert.throws(() => trackerFor(twoTrackers), /pass --org/)
  assert.equal(trackerFor(twoTrackers, 'b').project, 'P')
})

test('trackerFor: none configured, or an unknown --org, dies', () => {
  assert.throws(() => trackerFor({ tracker: {} }), /no tracker configured/)
  assert.throws(() => trackerFor(twoTrackers, 'zzz'), /no tracker configured for org/)
})

test('anyTrackerConfigured: true when any org has a live tracker, false for none/absent', () => {
  assert.equal(anyTrackerConfigured({ tracker: { a: { kind: 'github', repo: 'x/y' } } }), true)
  assert.equal(anyTrackerConfigured({ tracker: { a: { kind: 'none' } } }), false)
  assert.equal(anyTrackerConfigured({ tracker: {} }), false)
  assert.equal(anyTrackerConfigured({}), false)
})

test('orgForJiraKey: the org whose tracker project matches the key\'s prefix', () => {
  const cfg = { tracker: { linenmaster: { kind: 'jira', project: 'KTLO' }, acme: { kind: 'github', repo: 'x/y' } } }
  assert.equal(orgForJiraKey(cfg, 'KTLO-42'), 'linenmaster')
  assert.equal(orgForJiraKey(cfg, 'OTHER-1'), null)
  assert.equal(orgForJiraKey(cfg, 'acme/platform#3'), null, 'not a Jira key at all')
})

test('orgForJiraKey: null (not a guess) when two orgs claim the same project', () => {
  const cfg = { tracker: { a: { kind: 'jira', project: 'KTLO' }, b: { kind: 'jira', project: 'KTLO' } } }
  assert.equal(orgForJiraKey(cfg, 'KTLO-1'), null)
})

test('ticketsLabel: keys joined, declined, or the placeholder', () => {
  assert.equal(ticketsLabel({ tickets: ['PROJ-1', 'PROJ-2'] }), 'PROJ-1, PROJ-2')
  assert.equal(ticketsLabel({ tickets: [], ticketsDeclined: true }), 'none (declined)')
  assert.equal(ticketsLabel({ tickets: [] }), '_none_')
})

test('statusLabel: the fixed vocabulary, title-cased for the doc header', () => {
  assert.equal(statusLabel('planning'), 'Planning')
  assert.equal(statusLabel('in-progress'), 'In progress')
  assert.equal(statusLabel('designed'), 'Designed')
  assert.equal(statusLabel('closed'), 'Closed')
})

test('nextStatusAfterAttach: planning moves to in-progress on the first repo, not later ones', () => {
  assert.equal(nextStatusAfterAttach({ status: 'planning', repos: [] }), 'in-progress')
  assert.equal(nextStatusAfterAttach({ status: 'planning', repos: [{ repo: 'a' }] }), 'planning')
})

test('nextStatusAfterAttach: any other status is left alone', () => {
  assert.equal(nextStatusAfterAttach({ status: 'designed', repos: [] }), 'designed')
  assert.equal(nextStatusAfterAttach({ status: 'closed', repos: [] }), 'closed')
})
