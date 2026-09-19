// `rig close` end to end, against a real worktree and the squash merge that made #52.
//
// `RIG_FAKE_REMOTES` points `bin/worktrees.mjs` at a directory of bare repos, so the
// mirror, the worktree, the push and the branch deletion below are all real git, only
// local; GitHub is the in-memory adapter and no `gh` is ever spawned. Nothing here needs
// a network, and nothing spawns npm.
//
// The case this file exists for: `main` requires linear history, so every PR lands as a
// squash and GitHub deletes the head branch. The worktree's upstream ref disappears, the
// pre-squash commits are nowhere on the base, and `close` used to read them as unpushed
// work and refuse — on every merged work, forever, with `--force` the only way past. A
// merged PR settles its branch; this is that rule, from the outside.
//
// One temp installation, shared, and the tests run in order.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let tmp, tool, dataRoot, workRoot, remotesDir, env

const strip = s => s.replace(/\x1b\[\d+m/g, '')
const rig = args => {
  const r = spawnSync(process.execPath, [path.join(tool, 'bin', 'rig.mjs'), ...args], { encoding: 'utf8', env, input: '' })
  return { code: r.status, out: strip(r.stdout + r.stderr), stdout: r.stdout }
}
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env })
const gitMust = (dir, ...args) => {
  const r = git(dir, ...args)
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const record = id => readJson(path.join(dataRoot, 'work', id, 'work.json'))
const github = () => readJson(env.RIG_FAKE_GITHUB)
const setGithub = state => fs.writeFileSync(env.RIG_FAKE_GITHUB, JSON.stringify(state))
const worktree = (id, repo) => path.join(workRoot, id, repo)
const bare = repo => path.join(remotesDir, 'acme', `${repo}.git`)

// A bare repo standing in for `https://github.com/acme/<repo>.git`, with one commit.
const publish = repo => {
  const seed = path.join(tmp, 'seed', repo)
  fs.mkdirSync(seed, { recursive: true })
  gitMust(seed, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', `${repo}: first`)
  fs.mkdirSync(path.dirname(bare(repo)), { recursive: true })
  assert.equal(spawnSync('git', ['clone', '-q', '--bare', seed, bare(repo)], { encoding: 'utf8', env }).status, 0)
}

// What GitHub does when a PR lands on a repo that requires linear history: the branch's
// commits become one new commit on the base under a different sha, and the head branch is
// deleted. Everything the worktree knew about its upstream goes with it.
const squashMergeAndDeleteBranch = (repo, branch, prNumber) => {
  const tip = gitMust(bare(repo), 'rev-parse', branch)
  const tree = gitMust(bare(repo), 'rev-parse', `${branch}^{tree}`)
  const base = gitMust(bare(repo), 'rev-parse', 'main')
  const squashed = gitMust(bare(repo), 'commit-tree', tree, '-p', base, '-m', `${branch} (#${prNumber})`)
  assert.notEqual(squashed, tip, 'the commits landed under a different sha, which is the point')
  gitMust(bare(repo), 'update-ref', 'refs/heads/main', squashed)
  gitMust(bare(repo), 'update-ref', '-d', `refs/heads/${branch}`)
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-close-'))
  tool = path.join(tmp, 'rig')
  for (const d of ['bin', 'prompts', 'templates']) fs.cpSync(path.join(SRC, d), path.join(tool, d), { recursive: true })
  fs.cpSync(path.join(SRC, 'package.json'), path.join(tool, 'package.json'))
  dataRoot = path.join(tmp, 'rig-data')
  workRoot = path.join(tmp, 'w')
  remotesDir = path.join(tmp, 'remotes')

  env = { ...process.env }
  env.RIG_FAKE_REMOTES = remotesDir
  env.RIG_FAKE_GITHUB = path.join(tmp, 'github.json')
  setGithub({ auth: 'ok', repos: { 'acme/billing': { language: 'JavaScript', prs: [] } } })
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '')
  env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'rig close'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'close@example.invalid'

  publish('billing')
  assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--tracker', 'acme=none']).code, 0)
})

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) })

test('a work with a repo attached, one commit pushed, and a PR open on it', () => {
  assert.equal(rig(['new', 'squashed', '--title', 'Squashed work', '--type', 'feat', '--no-ticket']).code, 0)
  const r = rig(['attach', 'billing', '--work', 'squashed'])
  assert.equal(r.code, 0, r.out)

  const dest = worktree('squashed', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'the work\n')
  gitMust(dest, 'commit', '-qam', 'the work')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')

  const state = github()
  state.repos['acme/billing'].prs = [{
    branch: 'feat/squashed-work', number: 5, state: 'OPEN',
    url: 'https://github.com/acme/billing/pull/5',
    openedAt: '2026-09-17T00:00:00Z', mergedAt: null, commits: ['2026-09-17T09:00:00Z'],
  }]
  setGithub(state)

  assert.match(rig(['list']).out, /PR #5 open/)
})

test('close refuses while the PR is open, as it always has', () => {
  const r = rig(['close', '--work', 'squashed'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing: PR #5 still open/)
  assert.ok(fs.existsSync(worktree('squashed', 'billing')), 'nothing torn down')
})

test('the squash merge lands the work under a new sha and deletes the head branch', () => {
  squashMergeAndDeleteBranch('billing', 'feat/squashed-work', 5)
  const state = github()
  Object.assign(state.repos['acme/billing'].prs[0], { state: 'MERGED', mergedAt: '2026-09-18T00:00:00Z' })
  setGithub(state)

  // The worktree is now exactly as #52 describes it: its upstream ref is gone, so the
  // distance falls back to the base, where its commit has never been seen.
  const dest = worktree('squashed', 'billing')
  gitMust(dest, 'fetch', '-q', '--prune', 'origin')
  assert.notEqual(git(dest, 'rev-parse', '--abbrev-ref', '@{u}').status, 0, 'the upstream ref went with the branch')
  const out = rig(['status', '--work', 'squashed']).out
  assert.match(out, /#5 MERGED/)
  assert.match(out, /commits 1 ahead/,
    'git reads the squashed commit as outstanding — which is what `close` used to refuse on')
})

test('close succeeds on the merged work with no --force, and says nothing was in the way', () => {
  const r = rig(['close', '--work', 'squashed'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /unfinished business/)
  assert.doesNotMatch(r.out, /unpushed commit/, 'the commits are merged, under another sha')
  assert.match(r.out, /removed worktree billing/)
  assert.equal(record('squashed').status, 'closed')
})

test('and it still recorded the merged PR\'s terminal facts on the way out', () => {
  const stored = record('squashed').repos[0].pr
  assert.equal(stored.number, 5)
  assert.equal(stored.mergedAt, '2026-09-18T00:00:00Z')
})

test('a work whose tree is dirty still refuses, merged PR or not', () => {
  assert.equal(rig(['new', 'dirty', '--title', 'Dirty work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'dirty']).code, 0)
  const dest = worktree('dirty', 'billing')
  fs.writeFileSync(path.join(dest, 'NOTES.md'), 'unsaved\n')

  const state = github()
  state.repos['acme/billing'].prs.push({
    branch: 'feat/dirty-work', number: 6, state: 'MERGED',
    url: 'https://github.com/acme/billing/pull/6',
    openedAt: '2026-09-18T00:00:00Z', mergedAt: '2026-09-18T01:00:00Z', commits: ['2026-09-18T00:30:00Z'],
  })
  setGithub(state)

  const r = rig(['close', '--work', 'dirty'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing: 1 uncommitted change\(s\)/, 'a merge settles the branch, never the working tree')
  assert.ok(fs.existsSync(path.join(dest, 'NOTES.md')))
})

test('a work with nothing attached closes, and `list` said so before it did', () => {
  assert.equal(rig(['new', 'empty', '--title', 'Empty work', '--type', 'chore', '--no-ticket']).code, 0)
  assert.doesNotMatch(rig(['list']).out, /empty[\s\S]*?nothing outstanding/,
    'a work with no repos is not offered up as finished')
  assert.equal(rig(['close', '--work', 'empty']).code, 0)
})
