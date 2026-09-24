// Committing into and pushing from one of the two checkouts an installation owns,
// against real git. The module's seam is the runner it is handed, so these tests hand it one
// that spawns git for real — local bare remotes in a temp tree, no network, no `gh`, and no
// CLI subprocess. A fake runner appears only where standing the state up for real would prove
// less than it costs. The tree and the moves are `test/checkouts-fixture.mjs`, which says why
// the family is three files.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { checkoutsFixture } from './checkouts-fixture.mjs'

const f = checkoutsFixture('rig-checkouts-push-')
const { tmp, env, run, runIn, gitMust, c, cloned, pushFromElsewhere } = f
after(f.cleanup)

test('commitAll stages everything present, including what nobody staged', () => {
  const { local } = cloned('committing')
  fs.writeFileSync(path.join(local, 'record.md'), 'a record\n')
  fs.appendFileSync(path.join(local, 'README.md'), 'edited\n')

  const r = c().commitAll(local, 'rig save: a record')
  assert.equal(r.outcome, 'committed')
  assert.equal(r.hash, gitMust(local, 'rev-parse', 'HEAD').slice(0, 7))
  assert.equal(gitMust(local, 'log', '-1', '--format=%s'), 'rig save: a record')
  // Seven characters is rig's display choice, not git's abbreviation (DESIGN.md decision 103).
  gitMust(local, 'config', 'core.abbrev', '12')
  fs.writeFileSync(path.join(local, 'record.md'), 'a second record\n')
  const again = c().commitAll(local, 'rig save: again')
  assert.equal(gitMust(local, 'rev-parse', '--short', 'HEAD').length, 12, 'git prints twelve here')
  assert.equal(again.hash, gitMust(local, 'rev-parse', 'HEAD').slice(0, 7))
  assert.equal(c().describe(local).dirty, 0)
})

test('nothing to commit is an outcome, not a failure', () => {
  const { local } = cloned('nothing')
  const r = c().commitAll(local, 'rig save: nothing happened')
  assert.equal(r.outcome, 'nothing')
  assert.equal(r.hash, null, 'no commit was made, so there is none to name — and no caller reads one')
})

test('a commit git refuses answers git\'s reason, and the change is still there', () => {
  // No identity to commit with — the case a fresh machine meets before `rig init`.
  const { local } = cloned('nameless')
  fs.writeFileSync(path.join(local, 'record.md'), 'a record\n')
  const nameless = { ...env }
  delete nameless.GIT_AUTHOR_NAME; delete nameless.GIT_AUTHOR_EMAIL
  delete nameless.GIT_COMMITTER_NAME; delete nameless.GIT_COMMITTER_EMAIL
  const bare = c(runIn(() => nameless))

  const r = bare.commitAll(local, 'rig save: a record')
  assert.equal(r.outcome, 'commit-failed')
  assert.ok(r.error)
  assert.equal(c().describe(local).dirty, 1, 'the change waits for the next command')
})

test('a stage git refuses is its own outcome, and nothing is committed', () => {
  // `git add` failing is what a permission problem or a lock looks like; real git will not
  // produce one on demand, and the caller's advice ("commit it by hand") turns on it.
  const seen = []
  const refuses = (cmd, args) => {
    seen.push(args.join(' '))
    return args.includes('add')
      ? { code: 128, out: '', err: 'fatal: Unable to create index.lock: File exists.' }
      : { code: 0, out: '', err: '' }
  }
  const r = c(refuses).commitAll('anywhere', 'rig save: blocked')
  assert.equal(r.outcome, 'stage-failed')
  assert.match(r.error, /index\.lock/)
  assert.equal(seen.some(c => c.includes('commit')), false, 'and it stopped there')
})

test('a `git diff --cached` that failed says nothing about what is staged', () => {
  // Exit 1 is "something is staged" and exit 0 is "nothing is"; above that git is failing
  // to say, and reading that as "something is" commits on the strength of an error.
  const broken = (cmd, args) => args.includes('--cached')
    ? { code: 129, out: '', err: 'fatal: unknown option' }
    : { code: 0, out: '', err: '' }
  const r = c(broken).commitAll('anywhere', 'rig save: unknowable')
  assert.equal(r.outcome, 'stage-failed')
})

test('pushRebasing puts ours on top of theirs and pushes the result', () => {
  const { bare, local } = cloned('pushing')
  pushFromElsewhere(bare, 'THEIRS.md', 'a record from the other machine')
  fs.writeFileSync(path.join(local, 'MINE.md'), 'a record of my own\n')
  assert.equal(c().commitAll(local, 'rig save: a record of my own').outcome, 'committed')

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'pushed')
  assert.equal(r.hash, gitMust(local, 'rev-parse', 'HEAD').slice(0, 7), 'the hash is the rebase\'s, not the commit\'s')
  assert.ok(fs.existsSync(path.join(local, 'THEIRS.md')), 'the other machine\'s commit was rebased under ours')
  assert.equal(run('git', ['-C', bare, 'log', '-1', '--format=%s']).out, 'rig save: a record of my own')
})

test('a conflict aborts the rebase rather than leaving the tree mid-rebase', () => {
  const { bare, local } = cloned('conflicting')
  pushFromElsewhere(bare, 'README.md', 'their line')
  fs.writeFileSync(path.join(local, 'README.md'), 'my line\n')
  assert.equal(c().commitAll(local, 'rig save: my line').outcome, 'committed')

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'conflict')
  assert.equal(gitMust(local, 'log', '-1', '--format=%s'), 'rig save: my line', 'the local commit is kept')
  assert.equal(c().describe(local).dirty, 0, 'tree left clean')
  assert.ok(!fs.existsSync(path.join(local, '.git', 'rebase-merge')), 'never left mid-rebase')
  assert.equal(run('git', ['-C', bare, 'log', '-1', '--format=%s']).out, 'their line', 'nothing pushed')
})

test('a rebase already in progress is left alone, commit and all', () => {
  // The one that used to lose work: `git rebase` fails because a rebase is already
  // underway, the abort succeeds, and it takes the user's rebase *and* the commit rig
  // just made with it — reachable afterwards only from the reflog.
  const { local } = cloned('midrebase')
  gitMust(local, 'checkout', '-q', '-b', 'side')
  fs.writeFileSync(path.join(local, 'README.md'), 'the side line\n')
  gitMust(local, 'commit', '-q', '-am', 'the side line')
  gitMust(local, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(local, 'README.md'), 'the main line\n')
  gitMust(local, 'commit', '-q', '-am', 'the main line')
  assert.notEqual(run('git', ['-C', local, 'rebase', 'side']).code, 0, 'left mid-rebase, as a user would')
  const wedged = gitMust(local, 'rev-parse', 'HEAD')

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'underway')
  assert.equal(gitMust(local, 'rev-parse', 'HEAD'), wedged, 'nothing was moved')
  assert.equal(run('git', ['-C', local, 'rebase', '--abort']).code, 0, 'their rebase is still there to abort')
})

test('a rebase that never starts is refused, not called a conflict', () => {
  // No upstream to rebase onto: git declines before anything happens, and there is
  // nothing to abort. Calling this a conflict would send the reader looking for one.
  const { local } = cloned('nostart')
  gitMust(local, 'checkout', '-q', '-b', 'sidebranch')
  fs.writeFileSync(path.join(local, 'MINE.md'), 'a record of my own\n')
  assert.equal(c().commitAll(local, 'rig save: sideways').outcome, 'committed')

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'refused')
  assert.ok(r.error)
  assert.equal(gitMust(local, 'log', '-1', '--format=%s'), 'rig save: sideways', 'the commit is still there')
})

test('a conflict whose abort also fails is a different answer', () => {
  // The state that needs sorting out by hand, and the one real git will not stage for us:
  // the rebase this started conflicted, and the abort failed too. The fake answers the
  // in-progress probe the way git would — nothing there before, something there after.
  let started = false
  const stuck = (cmd, args) => {
    if (args.includes('fetch')) return { code: 0, out: '', err: '' }
    if (args.includes('--git-path')) return { code: 0, out: started ? tmp : path.join(tmp, 'no-rebase-here'), err: '' }
    if (args.includes('rebase') && args.includes('--abort')) return { code: 1, out: '', err: 'fatal: could not abort' }
    if (args.includes('rebase')) { started = true; return { code: 1, out: '', err: 'CONFLICT (content): Merge conflict' } }
    return { code: 0, out: '', err: '' }
  }
  const r = c(stuck).pushRebasing('anywhere')
  assert.equal(r.outcome, 'conflict-stuck')
})

test('a fetch that fails is never reported as a conflict', () => {
  const { local } = cloned('unreachable')
  fs.writeFileSync(path.join(local, 'MINE.md'), 'a record of my own\n')
  assert.equal(c().commitAll(local, 'rig save: offline').outcome, 'committed')
  gitMust(local, 'remote', 'set-url', 'origin', path.join(tmp, 'no-such-remote.git'))

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'fetch-failed')
  assert.equal(gitMust(local, 'log', '-1', '--format=%s'), 'rig save: offline')
})

test('a push the remote refuses keeps the commit and says whose refusal it was', () => {
  // A remote that fetches fine and refuses the push: a checked-out branch in a non-bare
  // repo is git's own default refusal, and the nearest thing to a protected branch.
  const { local } = cloned('refused')
  const theirs = path.join(tmp, 'refusing-remote')
  assert.equal(run('git', ['clone', '-q', path.join(tmp, 'refused.git'), theirs]).code, 0)
  gitMust(theirs, 'config', 'receive.denyCurrentBranch', 'refuse')
  gitMust(local, 'remote', 'set-url', 'origin', theirs)
  gitMust(local, 'fetch', '-q')
  gitMust(local, 'branch', '--set-upstream-to=origin/main')
  fs.writeFileSync(path.join(local, 'MINE.md'), 'a record of my own\n')
  assert.equal(c().commitAll(local, 'rig save: unpushable').outcome, 'committed')

  const r = c().pushRebasing(local)
  assert.equal(r.outcome, 'push-failed')
  assert.equal(r.hash, gitMust(local, 'rev-parse', 'HEAD').slice(0, 7), 'the caller can name what is waiting')
  assert.ok(r.error)
})
