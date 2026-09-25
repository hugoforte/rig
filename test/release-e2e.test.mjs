// The release path, end to end: a real git repository with real tags, canned GitHub answers,
// and the three commands `.github/workflows/release.yml` actually runs, in order.
//
// This file exists because of what the unit tests cannot see. `bin/release.mjs` is pure and
// covered, and every defect this release path has had lived *outside* it — in the shell that
// gathered the set: a `first // null` that kept one arbitrary pull request per commit, a payload
// shape that drifted from what the decisions read, and release notes whose headings collided
// with the titles above them. Each was caught by running the commands by hand, which is a test
// nobody runs twice. So the gathering moved into `bin/release-gather.mjs`, and this drives it.
//
// The one thing still not covered is the YAML itself — the `$GITHUB_ENV` and `$GITHUB_OUTPUT`
// plumbing. What is left in that file after this is three `node` calls, which is about as small
// as the untested surface gets without a runner for Actions.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAJOR } from '../bin/version.mjs'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ORG = 'e2e-rel'
const REPO = `${ORG}/widgets`

const temps = []
process.on('exit', () => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
const gitMust = (dir, ...args) => {
  const r = git(dir, ...args)
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r
}

// A repository with a tagged release and some commits after it, plus the pull requests GitHub
// would say those commits belong to. `prs` is the canned GitHub state: each names the shas it
// contains, which is how the in-memory adapter answers `pullsForCommit`.
// The fixture's tag lives in *this* tool's record-format major, because these run the real
// `bin/release.mjs`: a tag below `MAJOR` is the state where a migration has landed, and the
// version follows the format rather than the bump (ADR 0002). That is its own case, not the
// background for every other one.
function repoWith ({ commits, prs, tag = `v${MAJOR}.4.2` }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-rel-'))
  temps.push(tmp)
  const dir = path.join(tmp, 'repo')
  fs.mkdirSync(dir, { recursive: true })
  gitMust(dir, 'init', '-q', '-b', 'main')
  gitMust(dir, 'config', 'user.email', 'e2e@example.com')
  gitMust(dir, 'config', 'user.name', 'e2e')
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  gitMust(dir, 'add', '-A')
  gitMust(dir, 'commit', '-q', '-m', 'the commit the release tag is on')
  gitMust(dir, 'tag', tag)

  // One commit per entry, remembered by sha so the canned pull requests can name them.
  const shas = {}
  for (const label of commits) {
    fs.writeFileSync(path.join(dir, `${label}.txt`), `${label}\n`)
    gitMust(dir, 'add', '-A')
    gitMust(dir, 'commit', '-q', '-m', label)
    shas[label] = gitMust(dir, 'rev-parse', 'HEAD').stdout.trim()
  }

  const state = { auth: 'ok', repos: { [REPO]: { prs: prs(shas) } } }
  const fake = path.join(tmp, 'github.json')
  fs.writeFileSync(fake, JSON.stringify(state))
  return { dir, tag, fake, shas }
}

// The three steps of `release.yml`, run as the workflow runs them.
const runIn = (dir, fake, args, input) => spawnSync(process.execPath, args, {
  cwd: dir, encoding: 'utf8', input: input ?? '', env: { ...process.env, RIG_FAKE_GITHUB: fake },
})

function release ({ dir, tag, fake }, { base = 'main' } = {}) {
  const gathered = runIn(dir, fake, [path.join(SRC, 'bin', 'release-gather.mjs'), '--repo', REPO, '--previous', tag])
  assert.equal(gathered.status, 0, gathered.stderr)
  const verdict = runIn(dir, fake, [path.join(SRC, 'bin', 'release.mjs'), 'verdict', '--tag', tag, '--base', base], gathered.stdout)
  const notes = runIn(dir, fake, [path.join(SRC, 'bin', 'release.mjs'), 'notes', '--tag', 'vX', '--previous', tag, '--repo', REPO, '--base', base], gathered.stdout)
  return { commits: JSON.parse(gathered.stdout), verdict, notes: notes.stdout, decision: verdict.stdout.trim() ? JSON.parse(verdict.stdout) : null }
}

test('e2e: a feature and a fix since the tag release as a minor, with both descriptions', () => {
  const repo = repoWith({
    commits: ['add-retries', 'fix-the-probe'],
    prs: s => [
      { number: 7, branch: 'feat/add-retries', base: 'main', title: 'Add retries', body: 'Why retries.', commits: [s['add-retries']] },
      { number: 8, branch: 'fix/the-probe', base: 'main', title: 'Fix the probe', body: 'Why the probe.', commits: [s['fix-the-probe']] },
    ],
  })
  const { decision, notes } = release(repo)
  assert.equal(decision.release, true)
  assert.equal(decision.tag, `v${MAJOR}.5.0`, 'a feature in the set makes it a minor')
  assert.match(notes, /Why retries\./)
  assert.match(notes, /Why the probe\./)
})

test('e2e: a staged work describes itself once, not once per stage', () => {
  // The shape that produced duplicate release notes on a real release: every commit is in its
  // stage's pull request *and* in the work branch's, and only the work branch landed on `main`.
  const repo = repoWith({
    commits: ['stage-one', 'stage-two'],
    prs: s => [
      { number: 1, branch: 'feat/stage-one', base: 'feat/the-work', title: 'Stage one', body: 'Stage one detail.', commits: [s['stage-one']] },
      { number: 2, branch: 'feat/stage-two', base: 'feat/the-work', title: 'Stage two', body: 'Stage two detail.', commits: [s['stage-two']] },
      { number: 9, branch: 'feat/the-work', base: 'main', title: 'The work', body: 'What the work is.', commits: [s['stage-one'], s['stage-two']] },
    ],
  })
  const { commits, decision, notes } = release(repo)
  assert.deepEqual(commits.map(c => c.pulls.length), [2, 2], 'every commit is in two pull requests')
  assert.equal(decision.release, true)
  assert.equal((notes.match(/^## /gm) || []).length, 1, notes)
  assert.match(notes, /What the work is\./)
  assert.doesNotMatch(notes, /Stage one detail\./, 'the stage merged into the work branch, not into this one')
})

test('e2e: a commit GitHub names no pull request for fails the release and tags nothing', () => {
  const repo = repoWith({
    commits: ['landed-somehow'],
    prs: () => [],
  })
  const { decision, verdict } = release(repo)
  assert.equal(verdict.status, 1)
  assert.equal(decision.release, false)
  assert.equal(decision.tag, null)
  assert.match(verdict.stderr, /no pull request/)
})

test('e2e: a range whose pull requests all ask for nothing releases nothing', () => {
  const repo = repoWith({
    commits: ['tidy'],
    prs: s => [{ number: 5, branch: 'docs/tidy', base: 'main', title: 'Tidy', body: '', commits: [s.tidy] }],
  })
  const { verdict, decision } = release(repo)
  assert.equal(verdict.status, 0, verdict.stderr)
  assert.equal(decision.release, false)
  assert.match(verdict.stderr, /nothing to release/)
})

test('e2e: the gathering reads the range oldest first, so the notes read in order', () => {
  const repo = repoWith({
    commits: ['first', 'second'],
    prs: s => [
      { number: 1, branch: 'fix/first', base: 'main', title: 'First', body: '', commits: [s.first] },
      { number: 2, branch: 'fix/second', base: 'main', title: 'Second', body: '', commits: [s.second] },
    ],
  })
  const { commits, notes } = release(repo)
  assert.deepEqual(commits.map(c => c.pulls[0].number), [1, 2], 'oldest commit first')
  assert.ok(notes.indexOf('First') < notes.indexOf('Second'), notes)
})
