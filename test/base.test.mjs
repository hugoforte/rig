// The base a branch actually lands on, end to end — hugoforte/rig#24.
//
// `entry.base` is written once, at `rig attach`, from the repo's remote HEAD. Rebase the
// work onto another PR's branch and repoint the GitHub PR, and every display kept saying
// `main`: `rig status`, `rig list`, the generated AGENTS.md, and the ahead/behind fallback,
// which then counted the PR underneath as this work's own unpushed commits. The live base
// rides along with the PR state rig already fetches, so all four are answered by one
// lookup and nothing is recorded.
//
// `RIG_FAKE_REMOTES` points `bin/worktrees.mjs` at a directory of bare repos, so the
// mirror, the worktree, the branches and the rebase below are real git, only local; GitHub
// is the in-memory adapter and no `gh` is ever spawned. Nothing here needs a network, and
// nothing spawns npm.
//
// One temp installation, shared, and the tests run in order. test/harness.mjs builds it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall, readJson } from './harness.mjs'

const { tmp, dataRoot, workRoot, remotesDir, githubStateFile, rig, gitMust, cleanup } = makeInstall({
  prefix: 'rig-base-',
  author: 'rig base',
  email: 'base@example.invalid',
  remotes: true,
  github: { auth: 'ok', repos: { 'acme/billing': { language: 'JavaScript', prs: [] } } },
})

const BRANCH = 'feat/stacked-work'
const recordFile = path.join(dataRoot, 'work', 'stacked', 'work.json')
const recordBytes = () => fs.readFileSync(recordFile)
const record = () => readJson(recordFile)
// A base belongs to the branch it was cut for, not to the repo that carries it.
const workBranchOf = w => w.repos[0].branches.find(br => br.branch === w.branch)
const github = () => readJson(githubStateFile)
const setGithub = state => fs.writeFileSync(githubStateFile, JSON.stringify(state))
const worktree = path.join(workRoot, 'stacked', 'billing')
const generatedAgents = () => fs.readFileSync(path.join(workRoot, 'stacked', 'AGENTS.md'), 'utf8')
const bare = path.join(remotesDir, 'acme', 'billing.git')

// A bare repo standing in for `https://github.com/acme/billing.git`, and a checkout beside
// it that can push more branches to it — a colleague's clone.
const seed = path.join(tmp, 'seed', 'billing')
fs.mkdirSync(seed, { recursive: true })
gitMust(seed, 'init', '-q', '-b', 'main')
fs.writeFileSync(path.join(seed, 'README.md'), '# billing\n')
gitMust(seed, 'add', '-A')
gitMust(seed, 'commit', '-q', '-m', 'billing: first')
fs.mkdirSync(path.dirname(bare), { recursive: true })
gitMust(tmp, 'clone', '-q', '--bare', seed, bare)
gitMust(seed, 'remote', 'add', 'origin', bare)

// The PR this work will be stacked on: one commit past main, on its own branch.
const publishLowerPr = () => {
  gitMust(seed, 'checkout', '-q', '-B', 'feat/lower')
  fs.writeFileSync(path.join(seed, 'lower.md'), 'the PR underneath\n')
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', 'the PR underneath')
  gitMust(seed, 'push', '-q', 'origin', 'feat/lower')
}

// What repointing a PR on GitHub does, and nothing else: no rig command records it.
const repointPrAt = base => {
  const state = github()
  state.repos['acme/billing'].prs = [{
    branch: BRANCH, number: 7, state: 'OPEN', base,
    url: 'https://github.com/acme/billing/pull/7',
    openedAt: '2026-09-18T00:00:00Z', mergedAt: null, commits: ['2026-09-18T09:00:00Z'],
  }]
  setGithub(state)
}

assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
  '--orgs', 'acme', '--tracker', 'acme=none']).code, 0)

after(cleanup)

test('a work cut from main, then rebased onto another PR\'s branch and repointed at it', () => {
  assert.equal(rig(['new', 'stacked', '--title', 'Stacked work', '--type', 'feat', '--no-ticket']).code, 0)
  const r = rig(['attach', 'billing', '--work', 'stacked'])
  assert.equal(r.code, 0, r.out)
  assert.equal(workBranchOf(record()).base, 'main', 'the base the branch was cut from, recorded once')

  publishLowerPr()
  fs.writeFileSync(path.join(worktree, 'work.md'), 'the work\n')
  gitMust(worktree, 'add', '-A')
  gitMust(worktree, 'commit', '-qm', 'the work')
  // What a human stacking work does: fetch, rebase onto the branch below, repoint the PR.
  gitMust(worktree, 'fetch', '-q', 'origin')
  gitMust(worktree, 'rebase', '-q', 'origin/feat/lower')
  repointPrAt('feat/lower')

  // A cut branch tracks the base it was cut from, and while that upstream ref is there it
  // is what the distance is measured against. The base only answers once it is gone — the
  // branch pushed without `-u`, or its upstream pruned after a squash merge — which is the
  // shape this work's ahead/behind is read in from here on.
  gitMust(worktree, 'branch', '--unset-upstream')
})

test('status shows both bases, and measures the distance from the live one', () => {
  const before = recordBytes()
  const out = rig(['status', '--work', 'stacked']).out

  assert.match(out, /billing \(acme, base main → feat\/lower\)/,
    'the record alone would say `base main`, and a bare `feat/lower` would hide that it does')
  assert.match(out, /commits 1 ahead · 0 behind/,
    'one commit of this work — measured from main it would claim the PR underneath too')
  assert.match(out, /pr {6}#7 OPEN/)

  assert.deepEqual(recordBytes(), before, 'nothing about the live base is written down')
})

test('list badges the moved base beside the PR', () => {
  const out = rig(['list']).out
  assert.match(out, /billing\s+.*PR #7 open · base main → feat\/lower/)
})

test('the generated AGENTS.md says where the branch lands now, not where it was cut from', () => {
  const before = recordBytes()
  const r = rig(['save', '--work', 'stacked', '-m', 'stacked on the lower PR'])
  assert.equal(r.code, 0, r.out)

  assert.match(generatedAgents(), /- Base: `main → feat\/lower`/)
  assert.deepEqual(recordBytes(), before,
    'the record is #21\'s change and a record-format bump; this feature never writes to it')
  assert.equal(workBranchOf(record()).base, 'main')
})

test('when the stack unwinds, the display follows GitHub with no rig command run', () => {
  // A lower PR that merges: GitHub retargets the upper PR at main by itself, which is what
  // makes a recorded base stale in the other direction too.
  repointPrAt('main')
  const out = rig(['status', '--work', 'stacked']).out
  assert.match(out, /billing \(acme, base main\)/, 'record and reality agree again — one base, said once')
  assert.match(out, /commits 2 ahead/, 'measured from main, the branch below it included')
  assert.doesNotMatch(rig(['list']).out, /base main/, 'nothing moved, so the listing spends no badge on it')
})

test('a base GitHub would not answer for reads as the record, never as the live base', () => {
  const state = github()
  setGithub({ ...state, auth: 'missing' })
  try {
    const out = rig(['status', '--work', 'stacked']).out
    assert.match(out, /billing \(acme, base main \(recorded — GitHub would not say\)\)/)
    assert.match(out, /pr {6}unknown — .*gh not found on PATH/)
    assert.equal(rig(['save', '--work', 'stacked', '-m', 'offline']).code, 0)
    assert.match(generatedAgents(), /- Base: `main \(recorded — GitHub would not say\)`/,
      'the one place with no PR line of its own has to say it itself')
  } finally {
    setGithub(state)
  }
})
