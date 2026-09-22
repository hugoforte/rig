// Attaching a real repo, end to end, through the CLI. `RIG_FAKE_REMOTES` names a
// directory of bare repos, so `bin/worktrees.mjs` resolves `acme/billing` to a repo on
// disk instead of github.com and every worktree below is a real one cut from a real
// mirror. That hook is what makes `attach`, `detach`, `close` with repos and `status`
// reachable at all; before it, the clone URL was hardcoded and none of them could run
// under test. GitHub itself is the in-memory adapter — no `gh` is ever spawned.
//
// One temp installation, shared, and the tests run in order: each leaves the work where
// the next one expects it. test/harness.mjs builds it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall, readJson } from './harness.mjs'

const { tmp, dataRoot, workRoot, remotesDir, rig, gitMust, cleanup } = makeInstall({
  prefix: 'rig-attach-',
  author: 'rig attach',
  email: 'attach@example.invalid',
  remotes: true,
  // Two repos rig can resolve, and no PRs on either: resolving a repo name to an org is
  // still GitHub's job, and it is the only thing gh is asked here.
  github: {
    auth: 'ok',
    repos: { 'acme/billing': { language: 'JavaScript' }, 'acme/orders': { language: 'Go' } },
  },
})

const record = () => readJson(path.join(dataRoot, 'work', 't1', 'work.json'))
const attached = name => record().repos.find(r => r.repo === name)
// The work branch as that repo records it: a base and a merged PR now belong to the branch
// they describe, since a repo carries several branches of one work once it has stages.
const onWorkBranch = name => attached(name).branches.find(b => b.branch === record().branch)
const worktree = repo => path.join(workRoot, 't1', repo)
const mirrorOf = repo => path.join(workRoot, '.mirrors', 'acme', `${repo}.git`)

// A bare repo standing in for `https://github.com/acme/<repo>.git`, with one commit.
const publish = (repo, branch) => {
  const seed = path.join(tmp, 'seed', repo)
  fs.mkdirSync(seed, { recursive: true })
  gitMust(seed, 'init', '-q', '-b', branch)
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', `${repo}: first`)
  const bare = path.join(remotesDir, 'acme', `${repo}.git`)
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  gitMust(tmp, 'clone', '-q', '--bare', seed, bare)
}

publish('billing', 'main')
publish('orders', 'trunk')

after(cleanup)

test('a set-up installation with an org and no identity for it', () => {
  const r = rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--tracker', 'acme=none'])
  assert.equal(r.code, 0, r.out)
  assert.match(rig(['doctor']).out, /identity for acme.*no mirror yet/,
    'nothing is mirrored, so there is nowhere to ask git what it would commit with')
})

test('attach cuts a real worktree from a mirror rig makes on first use', () => {
  assert.equal(rig(['new', 't1', '--title', 'Attach work', '--type', 'feat', '--no-ticket']).code, 0)

  const r = rig(['attach', 'billing', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /mirroring acme\/billing \(first use\)/)
  assert.match(r.out, /worktree billing → feat\/attach-work \(base main\)/)

  assert.equal(fs.readFileSync(path.join(worktree('billing'), 'README.md'), 'utf8'), '# billing\n')
  assert.equal(gitMust(worktree('billing'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/attach-work')
  assert.equal(gitMust(mirrorOf('billing'), 'rev-parse', '--is-bare-repository'), 'true')
})

test('the record keeps the org and the base, and never the path', () => {
  assert.equal(attached('billing').org, 'acme')
  assert.equal(onWorkBranch('billing').base, 'main')
  assert.equal(attached('billing').path, undefined, 'the path is derived from this machine\'s work root')
  assert.equal(record().status, undefined, 'the phase is derived; nothing about it is stored')
})

test('attaching a repo the catalogue has never seen drafts an entry to correct', () => {
  const entry = path.join(dataRoot, 'catalog', 'acme', 'billing.md')
  assert.match(fs.readFileSync(entry, 'utf8'), /DRAFT: unreviewed/)
  assert.match(fs.readFileSync(entry, 'utf8'), /^stack: JavaScript$/m)
})


test('next offers the draft entry for correction, while the worktree is still on disk', () => {
  const r = rig(['next', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /catalogue entry for billing is still a draft/)
})
test('with no identity configured, the mirror is where git is asked what it would commit with', () => {
  assert.match(rig(['doctor']).out, /identity for acme.*git has no user\.email to commit with/)
  gitMust(mirrorOf('billing'), 'config', 'user.email', 'git-decided@acme.example')
  assert.match(rig(['doctor']).out, /identity for acme.*git-decided@acme\.example — from git, not rig/)
})

test('a configured identity is written onto the worktree as it is cut', () => {
  assert.equal(rig(['init', '--email', 'you@acme.example']).code, 0)
  const r = rig(['attach', 'orders', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /identity you@acme\.example/)
  assert.equal(gitMust(worktree('orders'), 'config', 'user.email'), 'you@acme.example')
})

test('each repo is based on its own remote HEAD, not on one default for the work', () => {
  assert.equal(onWorkBranch('orders').base, 'trunk')
  assert.equal(onWorkBranch('billing').base, 'main')
})

test('attaching the same repo twice does nothing', () => {
  const r = rig(['attach', 'billing', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing already attached/)
  assert.equal(record().repos.length, 2)
})

test('status reads each worktree live: clean, then the change, then the commit', () => {
  let out = rig(['status', '--work', 't1']).out
  assert.match(out, /billing \(acme, base main\)/)
  assert.match(out, /changes none/)
  assert.match(out, /commits 0 ahead · 0 behind/)
  assert.match(out, /pr\s+none/)

  fs.appendFileSync(path.join(worktree('billing'), 'README.md'), 'a change\n')
  assert.match(rig(['status', '--work', 't1']).out, /changes 1/)

  gitMust(worktree('billing'), 'commit', '-qam', 'a change')
  assert.match(rig(['status', '--work', 't1']).out, /commits 1 ahead · 0 behind/)
})

test('status says so when a worktree has been deleted out from under the work', () => {
  fs.rmSync(worktree('orders'), { recursive: true, force: true })
  const out = rig(['status', '--work', 't1']).out
  // The whole orders block: its path, marked missing, and then straight to the PR line —
  // nothing is asked of a tree that is gone.
  assert.match(out, /orders \(acme, base trunk\)\n {2}path {4}\S[^\n]*MISSING\n {2}pr {6}/)
})

test('detach removes the worktree and the record, and prunes the mirror', () => {
  // The directory is already gone (the test above deleted it) and `git worktree remove`
  // refuses that; --force is what carries it through to the prune.
  assert.equal(rig(['detach', 'orders', '--work', 't1', '--force']).code, 0)
  assert.equal(record().repos.length, 1)
  // The work id as a *path segment*, not as a substring: `mkdtemp` hands out names like
  // `rig-attach-t12cTO`, and a bare /t1/ fails on the temp directory rather than on a worktree
  // that is still there. Flaky on the entropy of a directory name is still flaky.
  assert.doesNotMatch(gitMust(mirrorOf('orders'), 'worktree', 'list'), /[\\/]t1[\\/]/)
})

test('detach refuses uncommitted work, and says how to get past it', () => {
  fs.writeFileSync(path.join(worktree('billing'), 'NOTES.md'), 'unsaved\n')
  const r = rig(['detach', 'billing', '--work', 't1'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing has uncommitted changes — commit, or pass --force/)
  assert.ok(fs.existsSync(worktree('billing')), 'nothing torn down')
  assert.equal(record().repos.length, 1, 'still attached')
})

test('close refuses while a worktree has unfinished business, and tears nothing down', () => {
  let r = rig(['close', '--work', 't1'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing: 1 uncommitted change\(s\)/)
  assert.match(r.out, /billing: 1 unpushed commit\(s\)/)
  assert.ok(fs.existsSync(worktree('billing')))

  fs.rmSync(path.join(worktree('billing'), 'NOTES.md'))
  r = rig(['close', '--work', 't1'])
  assert.equal(r.code, 1, r.out)
  assert.doesNotMatch(r.out, /uncommitted/)
  assert.match(r.out, /billing: 1 unpushed commit\(s\)/)
})

test('close removes every worktree and the work folder once the work is pushed', () => {
  gitMust(worktree('billing'), 'push', '-q', '-u', 'origin', 'HEAD')

  const r = rig(['close', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /removed worktree billing/)
  assert.match(r.out, /catalogue still a draft for billing — correct it and `rig save --work t1 -m "catalogue corrections"`/,
    'the last call: next offers the correction while the trees exist, close names what nobody made')
  assert.ok(!fs.existsSync(path.join(workRoot, 't1')), 'work folder removed')
  assert.doesNotMatch(gitMust(mirrorOf('billing'), 'worktree', 'list'), /[\\/]t1[\\/]/)
  assert.equal(record().closedAt !== undefined, true, 'closing records the gate and no status')
  // The mirror outlives the work: it is a cache under the work root, not part of the work.
  assert.ok(fs.existsSync(mirrorOf('billing')))
})

test('the command close hands over works after the work folder is gone', () => {
  // The last call names `rig save --work <id>` and not a bare `rig save`, because `save`
  // resolves its work from the folder it is run in and close has just deleted that folder.
  // Closed is not a refusal here: only `--designed` is behind the gate.
  assert.ok(!fs.existsSync(path.join(workRoot, 't1')), 'the folder a bare `rig save` would need')
  const entry = path.join(dataRoot, 'catalog', 'acme', 'billing.md')
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8')
    .replace(/<!-- DRAFT: unreviewed[\s\S]*?-->/, 'Billing, corrected after the work closed.'))

  const r = rig(['save', '--work', 't1', '-m', 'catalogue corrections'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(fs.readFileSync(entry, 'utf8'), /DRAFT: unreviewed/)
  assert.equal(gitMust(dataRoot, 'status', '--porcelain'), '', 'and the correction is committed')
})
