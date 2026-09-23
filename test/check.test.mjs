// `rig check` end to end — hugoforte/rig#66.
//
// The catalogue knew how to *set up* a repo and not how to *check* one, so "is this slice
// done?" had no local answer. `check` sits beside `setup` in the frontmatter and follows
// the same rule (DESIGN.md decision 31): printed, never run, until `--run` asks for it.
//
// The check commands below are `git` ones rather than a real test runner, so this suite
// stays offline and spawns no npm; what is being asserted is that they run in the repo's
// own worktree, that a failure reaches the caller, and that nothing about the outcome is
// written down.
//
// `RIG_FAKE_REMOTES` points bin/worktrees.mjs at a directory of bare repos, so the mirror
// and the worktrees are real git, only local. GitHub is the in-memory adapter and no `gh`
// is ever spawned. One temp installation, shared, and the tests run in order — each leaves
// the work where the next one expects it. test/harness.mjs builds it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall } from './harness.mjs'

const { tmp, dataRoot, workRoot, remotesDir, rig, gitMust, cleanup } = makeInstall({
  // Everything but `--run`, which opts back out below.
  inProcess: true,
  prefix: 'rig-check-',
  author: 'rig check',
  email: 'check@example.invalid',
  remotes: true,
  github: {
    auth: 'ok',
    repos: {
      'acme/billing': { language: 'JavaScript' },
      'acme/orders': { language: 'Go' },
      'acme/web': { language: 'TypeScript' },
    },
  },
})

// `--run` is the one thing in this file whose subject is the process: a catalogue command
// inherits rig's stdio, so what it printed only reaches an assertion when rig is a child with
// a pipe on the other end of it.
const SUBPROCESS = { inProcess: false }

const BRANCH = 'feat/check-work'
const catalogEntry = repo => path.join(dataRoot, 'catalog', 'acme', `${repo}.md`)
const recordFile = path.join(dataRoot, 'work', 't1', 'work.json')
const generatedAgents = () => fs.readFileSync(path.join(workRoot, 't1', 'AGENTS.md'), 'utf8')

// A bare repo standing in for `https://github.com/acme/<repo>.git`, with one commit.
const publish = repo => {
  const seed = path.join(tmp, 'seed', repo)
  fs.mkdirSync(seed, { recursive: true })
  gitMust(seed, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', `${repo}: first`)
  const bare = path.join(remotesDir, 'acme', `${repo}.git`)
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  gitMust(tmp, 'clone', '-q', '--bare', seed, bare)
}

// The correction rule 4 asks for, made by hand: the commands that verify this repo, put
// where `rig attach` left an empty list.
const correct = (repo, check) => fs.writeFileSync(catalogEntry(repo), `---
repo: ${repo}
org: acme
stack: JavaScript
role: a repo with something to verify
talks_to: []
setup: []
check:
${check.map(c => `  - ${c}`).join('\n')}
---

Prose.
`)

publish('billing')
publish('orders')
publish('web')

after(cleanup)

test('a work with three repos attached, each drafted into the catalogue', () => {
  assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--tracker', 'acme=none', '--email', 'you@acme.example']).code, 0)
  assert.equal(rig(['new', 't1', '--title', 'Check work', '--type', 'feat', '--no-ticket']).code, 0)
  for (const repo of ['billing', 'orders', 'web']) {
    assert.equal(rig(['attach', repo, '--work', 't1']).code, 0)
  }
})

test('the drafted entry leaves a check to fill in, beside the setup', () => {
  assert.match(fs.readFileSync(catalogEntry('billing'), 'utf8'), /^check: \[\]$/m)
})

test('check prints what verifies each repo, and runs none of it', () => {
  correct('billing', ['git rev-parse --abbrev-ref HEAD'])
  correct('orders', ['git rev-parse --verify --quiet no-such-ref'])

  const r = rig(['check', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing[\s\S]*git rev-parse --abbrev-ref HEAD/)
  assert.match(r.out, /orders[\s\S]*git rev-parse --verify --quiet no-such-ref/)
  assert.doesNotMatch(r.out, new RegExp(BRANCH),
    'the branch is what billing\'s command prints, had anything run it')
})

test('a repo with nothing in its check says where to write one', () => {
  const r = rig(['check', 'web', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /web: no check commands in the catalogue/)
  assert.ok(r.out.includes(catalogEntry('web')), 'the file to correct, named')
})

test('--run runs them, in the repo\'s own worktree, and only for the repo named', () => {
  const r = rig(['check', 'billing', '--work', 't1', '--run'], SUBPROCESS)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, new RegExp(BRANCH), 'the worktree is where the command ran')
  assert.doesNotMatch(r.out, /no-such-ref/, 'the repo that was not named was not touched')
})

test('a run records nothing — not in the catalogue, not in the work record', () => {
  const before = [fs.readFileSync(catalogEntry('billing')), fs.readFileSync(recordFile)]
  assert.equal(rig(['check', 'billing', '--work', 't1', '--run'], SUBPROCESS).code, 0)
  assert.deepEqual([fs.readFileSync(catalogEntry('billing')), fs.readFileSync(recordFile)], before,
    'the catalogue holds the command; a result is nobody\'s durable fact')
})

test('a failed check is reported, and the exit code carries the verdict', () => {
  const r = rig(['check', '--work', 't1', '--run'], SUBPROCESS)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /check command failed: git rev-parse --verify --quiet no-such-ref/)
})

test('the generated work file carries the check beside the setup', () => {
  assert.equal(rig(['save', '-m', 'catalogue corrected', '--work', 't1']).code, 0)
  assert.match(generatedAgents(), /- Check: `git rev-parse --abbrev-ref HEAD`/)
})
