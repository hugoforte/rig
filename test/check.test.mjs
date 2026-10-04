// `rig check` end to end — hugoforte/rig#66.
//
// The catalogue knew how to *set up* a repo and not how to *check* one, so "is this slice
// done?" had no local answer. `check` sits beside `setup` in the frontmatter and follows
// the same rule (DESIGN.md decision 31): printed, never run, until `--run` asks for it.
//
// The check commands below are `git` ones rather than a real test runner, so this suite
// stays offline and spawns no npm; what is being asserted is that they run in the repo's
// own worktree, that a failure reaches the caller, and that a pass is recorded against the
// patch it ran at, and read back against the patch the repo carries now (hugoforte/rig#289).
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
const billingBranch = () => JSON.parse(fs.readFileSync(recordFile, 'utf8')).repos.find(r => r.repo === 'billing').branches[0]
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

test('a passing run records what it proved, pinned to the patch: head, base, patch-id and date', () => {
  const dest = path.join(workRoot, 't1', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'the work\n')
  gitMust(dest, 'commit', '-qam', 'the work')
  assert.equal(rig(['check', 'billing', '--work', 't1', '--run'], SUBPROCESS).code, 0)
  const { verified } = billingBranch()
  assert.deepEqual(
    { head: verified.head, base: verified.base },
    { head: gitMust(dest, 'rev-parse', 'HEAD'), base: gitMust(dest, 'merge-base', 'origin/main', 'HEAD') })
  assert.match(verified.patchId, /^[0-9a-f]{40}$/)
  assert.ok(!Number.isNaN(Date.parse(verified.at)), 'a pass on a date')
})

test('the pass is committed into the data root, since check --run now writes a record', () => {
  assert.equal(gitMust(dataRoot, 'log', '-1', '--format=%s'), 'rig check t1: verified billing')
})

test('status says a repo is verified at the patch it has now', () => {
  assert.match(rig(['status', '--work', 't1']).out, /billing[\s\S]*?\n {2}checks {2}verified at [0-9a-f]{7} on \d{4}-\d{2}-\d{2}\n/)
})

test('a commit that only rewords a message keeps the diff, and so the pass', () => {
  const dest = path.join(workRoot, 't1', 'billing')
  gitMust(dest, 'commit', '-q', '--amend', '-m', 'the work, reworded')
  assert.match(rig(['status', '--work', 't1']).out, /billing[\s\S]*?\n {2}checks {2}verified at [0-9a-f]{7}/)
})

test('a commit that changes the diff makes the pass stale', () => {
  const dest = path.join(workRoot, 't1', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'more work\n')
  gitMust(dest, 'commit', '-qam', 'more work')
  assert.match(rig(['status', '--work', 't1']).out, /billing[\s\S]*?\n {2}checks {2}stale — the diff changed since it passed at [0-9a-f]{7}/)
})

test('a repo no run has passed says so', () => {
  assert.match(rig(['status', '--work', 't1']).out, /orders[\s\S]*?\n {2}checks {2}not verified — `rig check orders --run`/)
})

test('a pass with uncommitted changes is not recorded, and says why', () => {
  const dest = path.join(workRoot, 't1', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'uncommitted\n')
  const before = fs.readFileSync(recordFile, 'utf8')
  const r = rig(['check', 'billing', '--work', 't1', '--run'], SUBPROCESS)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: passed with uncommitted changes, which are in no patch — not recorded/)
  assert.equal(fs.readFileSync(recordFile, 'utf8'), before)
  gitMust(dest, 'checkout', '--', 'README.md')
})

test('a failed run clears the pass recorded before', () => {
  assert.equal(rig(['check', 'billing', '--work', 't1', '--run'], SUBPROCESS).code, 0)
  assert.ok(billingBranch().verified, 'passed at the new patch')
  correct('billing', ['git rev-parse --verify --quiet no-such-ref'])
  assert.equal(rig(['check', 'billing', '--work', 't1', '--run'], SUBPROCESS).code, 1)
  assert.equal(billingBranch().verified, undefined)
  correct('billing', ['git rev-parse --abbrev-ref HEAD'])
})

test('list --json carries what each branch was verified at', () => {
  assert.equal(rig(['check', 'billing', '--work', 't1', '--run'], SUBPROCESS).code, 0)
  const { works } = JSON.parse(rig(['list', '--json', '--quick']).stdout)
  const billing = works.find(w => w.id === 't1').repos.find(r => r.repo === 'billing')
  assert.deepEqual(billing.branches[0].verified, billingBranch().verified)
})

test('a change of whitespace alone changes the diff, so it makes the pass stale', () => {
  // Indentation is code in Python and YAML, and `git patch-id` would not see it.
  const dest = path.join(workRoot, 't1', 'billing')
  const readme = path.join(dest, 'README.md')
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('more work', '  more work'))
  gitMust(dest, 'commit', '-qam', 'indent')
  assert.match(rig(['status', '--work', 't1']).out, /billing[\s\S]*?\n {2}checks {2}stale/)
})

test('a rebase onto a base that moved, leaving the diff alone, keeps the pass', () => {
  const dest = path.join(workRoot, 't1', 'billing')
  assert.equal(rig(['check', 'billing', '--work', 't1', '--run'], SUBPROCESS).code, 0)
  const other = path.join(tmp, 'other-billing')
  gitMust(tmp, 'clone', '-q', path.join(remotesDir, 'acme', 'billing.git'), other)
  fs.writeFileSync(path.join(other, 'NOTES.md'), 'landed elsewhere\n')
  gitMust(other, 'add', '-A')
  gitMust(other, 'commit', '-qm', 'landed elsewhere')
  gitMust(other, 'push', '-q', 'origin', 'main')
  gitMust(dest, 'fetch', '-q', 'origin')
  gitMust(dest, 'rebase', '-q', 'origin/main')
  assert.match(rig(['status', '--work', 't1']).out, /billing[\s\S]*?\n {2}checks {2}verified at [0-9a-f]{7}/)
})

test('a run leaves the catalogue as it was: it holds the command, never a verdict', () => {
  const before = fs.readFileSync(catalogEntry('billing'))
  assert.equal(rig(['check', 'billing', '--work', 't1', '--run'], SUBPROCESS).code, 0)
  assert.deepEqual(fs.readFileSync(catalogEntry('billing')), before)
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

// Where a repo's user documentation lives: a path in the repo or a page elsewhere. rig never
// edits it; the `rig-docs` skill drafts the edit, and the work's generated file says where.

test('the drafted entry leaves a docs target to fill in', () => {
  assert.match(fs.readFileSync(catalogEntry('web'), 'utf8'), /^docs: \[\]$/m)
})

test('the generated work file says where each repo\'s user docs live', () => {
  fs.writeFileSync(catalogEntry('web'), `---
repo: web
org: acme
stack: TypeScript
role: the site
talks_to: []
setup: []
check: []
docs:
  - docs/guide.md
  - https://acme.atlassian.net/wiki/spaces/HELP/pages/42
  - Help centre: https://help.acme.example/web
---

Prose.
`)
  assert.equal(rig(['save', '-m', 'catalogue corrected', '--work', 't1']).code, 0)
  assert.match(generatedAgents(), /- Docs: `docs\/guide\.md` · `https:\/\/acme\.atlassian\.net\/wiki\/spaces\/HELP\/pages\/42` · `https:\/\/help\.acme\.example\/web`/,
    'a labelled target is read as its address, never as `[object Object]`')
})

test('an entry whose org is written in another case is still the repo\'s entry', () => {
  const entry = fs.readFileSync(catalogEntry('web'), 'utf8')
  fs.writeFileSync(catalogEntry('web'), entry.replace(/^org: acme$/m, 'org: Acme'))
  assert.equal(rig(['save', '-m', 'catalogue corrected', '--work', 't1']).code, 0)
  assert.match(generatedAgents(), /- Docs: `docs\/guide\.md`/)
})
