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
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall, readJson, strip } from './harness.mjs'

const { tmp, dataRoot, workRoot, remotesDir, rig, gitMust, env, cleanup } = makeInstall({
  // Nothing here is about the process rig runs in, so the runs happen in this one.
  inProcess: true,
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

test('attaching a repo names what the catalogue says it talks to and is not attached', () => {
  // Rule 5's fourth repo, offered rather than waited for. The entry is written before the
  // attach so `draftCatalogEntry` leaves it alone — a hand-corrected entry is what the offer
  // is only ever as good as (decision 27).
  publish('web', 'main')
  fs.writeFileSync(path.join(dataRoot, 'catalog', 'acme', 'web.md'), `---
repo: web
org: acme
stack: TypeScript
role: the storefront
talks_to:
  - repo: warehouse
    how: reads stock levels
    direction: upstream
setup: []
check: []
---

Prose.
`)
  // Two other works' records: one that paired web with a repo the catalogue says nothing
  // about, and one that no longer parses. The first is the observed half of the offer; the
  // second is what used to crash the attach after it had cut the worktree and saved the record,
  // which skipped the commit and left the data root half-written. Any record in the root is
  // read by the offer, so any one of them going bad must not cost the command it follows.
  const records = ['earlier', 'broken'].map(id => path.join(dataRoot, 'work', id))
  for (const dir of records) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(records[0], 'work.json'), JSON.stringify({ id: 'earlier', repos: [{ repo: 'web' }, { repo: 'ledger' }] }))
  fs.writeFileSync(path.join(records[1], 'work.json'), '{ "id": "broken", ')
  try {
    const r = rig(['attach', 'web', '--work', 't1'])
    assert.equal(r.code, 0, r.out)
    const out = strip(r.out)
    assert.match(out, /warehouse talks to web, and a change in it can break web — not attached \(`rig attach warehouse`\)/)
    assert.match(out, /ledger has shared 1 work with web, with nothing in talks_to to say why/)
    assert.match(out, /1 work record could not be read and was left out: broken/)
    assert.doesNotMatch(out, /billing|orders/, 'a neighbour already attached is not offered back')
    assert.equal(gitMust(dataRoot, 'status', '--porcelain'), '', 'the attach committed, as it did before the offer existed')

    // The same traversal from the command that runs all through the work, declared graph only.
    const next = strip(rig(['next', '--work', 't1']).out)
    assert.match(next, /warehouse talks to web \(a change in it can break web\) — not attached/)
    assert.doesNotMatch(next, /ledger/, 'a co-attachment is evidence about the catalogue, and next offers only the declared graph')
  } finally {
    for (const dir of records) fs.rmSync(dir, { recursive: true, force: true })
  }

  assert.equal(rig(['detach', 'web', '--work', 't1']).code, 0)
  assert.equal(record().repos.length, 2, 'the suite carries on from two attached repos')
})

test('the example in a drafted entry, uncommented, is a talks_to the reader actually reads', () => {
  // The field arrives in the template so it is in front of you at the moment rule 4 says the
  // knowledge is cheap. That is only true if the example survives the obvious edit: take out
  // the `talks_to: []` line and the `# ` in front of the example. `orders` was drafted by the
  // attach above; its file is put back afterwards, because later tests correct it themselves.
  const file = path.join(dataRoot, 'catalog', 'acme', 'orders.md')
  const drafted = fs.readFileSync(file, 'utf8')
  try {
    fs.writeFileSync(file, drafted.replace(/^talks_to: \[\]\r?\n/m, '').replace(/^# (talks_to:|  )/gm, '$1'))
    assert.match(strip(rig(['impact', 'orders']).out), /some-other-repo\s+downstream/,
      'how and direction both reach the reader, and the direction is not swallowed by a trailing comment')
  } finally {
    fs.writeFileSync(file, drafted)
  }
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

// The catalogue's own freshness. `doctor` measures each entry against the mirror of the repo
// it describes — no network, no rate limit — and the mirror is the reason this test lives here
// rather than in test/doctor.test.mjs, which has fixtures where this has git.
//
// A draft entry is left out of the measure: `attach` already reports it as a draft, so the
// entry is corrected first, which is what rule 4 asks for anyway.
test('a catalogue entry is reported as behind once the repo it describes has moved on', () => {
  const entry = path.join(dataRoot, 'catalog', 'acme', 'billing.md')
  // Appended rather than substituted for the DRAFT marker: the test above already corrected
  // this entry, so a marker-replace would be a no-op here and the commit would find nothing
  // staged. These tests share one installation in order, and this is the edit that has to land
  // whatever ran before it.
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(/<!-- DRAFT: unreviewed[\s\S]*?-->/, '')
    + '\nBilling, as somebody who had read it describes it.\n')
  gitMust(dataRoot, 'add', '-A')
  gitMust(dataRoot, 'commit', '-q', '-m', 'correct the billing entry')

  assert.doesNotMatch(rig(['doctor']).out, /catalogue entr\w+ behind/,
    'the repo has not moved since the entry was written, and zero is not news')

  // The repo moves on. The committer date is set rather than left to the clock: the measure is
  // "commits since the entry's own commit", and on a fast machine both land in the same second.
  const seed = path.join(tmp, 'seed', 'billing')
  fs.writeFileSync(path.join(seed, 'MOVED.md'), 'the repo moved on\n')
  gitMust(seed, 'add', '-A')
  const later = new Date(Date.now() + 86400000).toISOString()
  assert.equal(spawnSync('git', ['-C', seed, 'commit', '-q', '-m', 'billing: moved on'],
    { encoding: 'utf8', env: { ...env, GIT_AUTHOR_DATE: later, GIT_COMMITTER_DATE: later } }).status, 0)
  gitMust(seed, 'push', '-q', path.join(remotesDir, 'acme', 'billing.git'), 'main')
  // doctor does not fetch a mirror — an attach does (decision 9) — so it measures as of the
  // last fetch, which this stands in for.
  gitMust(mirrorOf('billing'), 'fetch', '-q', '--prune', 'origin')

  assert.match(rig(['doctor']).out,
    /1 catalogue entry behind its repo: billing \(1 commit since \d{4}-\d{2}-\d{2}\)/)
})

test('rig impact weighs a neighbour by how far behind its entry is', () => {
  // The same measure `doctor` reports, joined onto the edges `rig impact` prints — an edge
  // asserted by an entry the repo has moved on from is a weaker claim, and the reader is the
  // one who decides how much weaker (decision 93: the count and the date, and no verdict).
  // Asserted here rather than in test/impact.test.mjs because the measure needs a mirror, and
  // this installation is the one that has one.
  const entry = path.join(dataRoot, 'catalog', 'acme', 'orders.md')
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8')
    .replace(/^talks_to: \[\]$/m, `talks_to:
  - repo: billing
    how: settles against invoices
    direction: upstream`))
  gitMust(dataRoot, 'add', '-A')
  gitMust(dataRoot, 'commit', '-q', '-m', 'orders talks to billing')

  const out = strip(rig(['impact', 'orders']).out)
  assert.match(out, /billing\s+upstream.*entry 1 commit behind, since \d{4}-\d{2}-\d{2}/,
    'billing is upstream of orders, and its entry is a commit behind the repo it describes')
})

test('the measure reads what the mirror last fetched, not the ref frozen at clone time', () => {
  // The bug this pins: a mirror is cloned `--bare` and then given the refspec
  // `+refs/heads/*:refs/remotes/origin/*`, so its own `refs/heads/main` never moves again.
  // Measuring against it reported the drift as of the day the repo was first attached.
  assert.equal(gitMust(mirrorOf('billing'), 'rev-list', '--count', 'refs/heads/main..refs/remotes/origin/main'), '1',
    'the fetched ref is ahead of the frozen one, which is what makes the two distinguishable')
})

test('a symref left pointing at a renamed default branch falls back rather than going unmeasured', () => {
  // `git remote set-head` only runs on a fetch through rig, and doctor never fetches. So after an
  // upstream renames its default branch the mirror's symref still names the branch that is gone:
  // `symbolic-ref` exits 0 and the ref does not resolve. Taking its word for it left the entry
  // unmeasured with `refs/remotes/origin/main` sitting right there.
  gitMust(mirrorOf('billing'), 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/renamed-away')
  try {
    assert.match(rig(['doctor']).out, /1 catalogue entry behind its repo: billing \(1 commit since/)
  } finally {
    // In a `finally` because these tests share one installation in order: a mirror left with a
    // broken symref makes every measure below it answer null, and the test after this one would
    // pass for the wrong reason.
    gitMust(mirrorOf('billing'), 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  }
})

test('a commit landing in the same second as the entry is not one commit since it', () => {
  // `--since` is `--max-age` and inclusive, so the cutoff itself counts. An entry corrected the
  // moment a commit landed would report "1 commit since today", which is exactly the
  // zero-information line the measure drops.
  const head = gitMust(mirrorOf('billing'), 'log', '-1', '--format=%cI', 'refs/remotes/origin/main')
  const entry = path.join(dataRoot, 'catalog', 'acme', 'billing.md')
  fs.appendFileSync(entry, '\nCorrected again, in the same second as the commit.\n')
  gitMust(dataRoot, 'add', '-A')
  assert.equal(spawnSync('git', ['-C', dataRoot, 'commit', '-q', '-m', 'correct billing again'],
    { encoding: 'utf8', env: { ...env, GIT_AUTHOR_DATE: head, GIT_COMMITTER_DATE: head } }).status, 0)

  assert.doesNotMatch(rig(['doctor']).out, /catalogue entr\w+ behind/)
})

// Standing in a worktree is how rig is used — a command finds its work by walking up from where
// it runs — and the two commands that remove worktrees are the two that can pull the floor out
// from under the run. Every test above names its work with `--work` from the temp directory, so
// these stand inside the tree being removed. A second work, because t1 is closed.
const t2 = repo => path.join(workRoot, 't2', repo)
const t2Record = () => readJson(path.join(dataRoot, 'work', 't2', 'work.json'))

test('detach run from inside the worktree it removes finishes, and lets go of the repo', () => {
  assert.equal(rig(['new', 't2', '--title', 'Standing inside', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 't2']).code, 0)
  assert.equal(rig(['attach', 'orders', '--work', 't2']).code, 0)

  const r = rig(['detach', 'billing'], { cwd: t2('billing') })
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(t2Record().repos.map(x => x.repo), ['orders'])
})

test('close run from inside a worktree removes every worktree and records the close', () => {
  const r = rig(['close', '--abandoned'], { cwd: t2('orders') })
  assert.equal(r.code, 0, r.out)
  assert.ok(!fs.existsSync(path.join(workRoot, 't2')), 'the work folder and every tree in it are gone')
  assert.ok(t2Record().closedAt)
})
