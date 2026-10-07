// `rig attempt`: one branch of a work tried several ways at once, each attempt a sibling branch
// with a worktree of its own, compared, and one kept by a fast-forward (hugoforte/rig#321).
//
// Real git throughout, in the trees rig cut: the attempts are made by rig and written on by
// hand, exactly as an agent in each folder would. The check commands are `node -e` one-liners,
// so the suite stays offline and spawns no npm.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { billingInstall } from './billing-install.mjs'

const m = billingInstall('rig-attempt-')
const { rig, gitMust, git, commitWork, worktree, record, dataRoot, workRoot, cleanup } = m

after(cleanup)

const WORK = 'tried'
const BRANCH = 'feat/tried-work'
const STAGE = 'feat/tried-stage'
const folder = n => path.join(workRoot, WORK, `billing@${n}`)
const head = (dir, rev = 'HEAD') => gitMust(dir, 'rev-parse', rev)
const hasBranchIn = (dir, branch) => git(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).status === 0
const hasBranch = branch => git(worktree(WORK, 'billing'), 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).status === 0
const notes = () => fs.readFileSync(path.join(dataRoot, 'work', WORK, 'notes.tsv'), 'utf8')
const here = () => ({ cwd: worktree(WORK, 'billing') })

// Fails where the attempt carries a file named BROKEN, and passes everywhere else.
const CHECK = 'node -e "process.exit(require(\'fs\').existsSync(\'BROKEN\') ? 1 : 0)"'

before(() => {
  assert.equal(rig(['new', WORK, '--title', 'Tried work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', WORK]).code, 0)
  fs.writeFileSync(path.join(dataRoot, 'catalog', 'acme', 'billing.md'), `---
repo: billing
org: acme
stack: JavaScript
role: the repo the attempts are cut in
talks_to: []
setup: []
check:
  - ${CHECK}
---

Prose.
`)
})

test('--n outside a worktree says which repos it could have meant', () => {
  const r = rig(['attempt', '--n', '2', '--work', WORK])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--n cuts the attempts in one repo: run it inside one of tried's worktrees \(billing\)/)
})

test('a branch that is neither the work branch nor a stage is refused', () => {
  const r = rig(['attempt', 'feat/elsewhere', '--n', '2', '--work', WORK], here())
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /feat\/elsewhere is neither tried's work branch nor one of its stages/)
})

test('one attempt is the branch itself, so --n wants two or more', () => {
  const r = rig(['attempt', '--n', '1', '--work', WORK], here())
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--n wants two or more/)
})

test('--n cuts each attempt beside the repo, on a branch of its own, from the branch\'s tip', () => {
  commitWork(worktree(WORK, 'billing'), 'the start both attempts share')
  const r = rig(['attempt', '--n', '2', '--work', WORK], here())
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: cut 2 attempts at feat\/tried-work from feat\/tried-work/)
  for (const n of [1, 2]) {
    assert.equal(gitMust(folder(n), 'branch', '--show-current'), `${BRANCH}@${n}`)
    assert.ok(hasBranch(`${BRANCH}@${n}`))
    assert.equal(head(folder(n)), head(worktree(WORK, 'billing')))
  }
  const [set] = record(WORK).attempts
  assert.deepEqual({ branch: set.branch, count: set.count }, { branch: BRANCH, count: 2 })
})

test('doctor does not count an open attempt\'s folder as a stray', () => {
  assert.doesNotMatch(rig(['doctor']).out, /unmanaged entry "billing@/)
})

test('the generated AGENTS.md says what each attempt folder is', () => {
  const agents = fs.readFileSync(path.join(workRoot, WORK, 'AGENTS.md'), 'utf8')
  assert.ok(agents.includes(`- Attempt 2 at \`${BRANCH}\`: \`${folder(2)}\` on \`${BRANCH}@2\``), agents)
})

test('rig status names the open set', () => {
  assert.match(rig(['status', '--work', WORK]).out, /attempts feat\/tried-work — 2 open, billing@1, billing@2 here/)
})

test('rig next says how far the attempts have got, and offers the comparison once each has commits', () => {
  assert.match(rig(['next', '--work', WORK]).out, /2 attempts at feat\/tried-work are open — 0 of 2 have commits here so far/)
  commitWork(folder(1), 'one way')
  fs.writeFileSync(path.join(folder(1), 'BROKEN'), 'this way fails its checks\n')
  gitMust(folder(1), 'add', 'BROKEN')
  gitMust(folder(1), 'commit', '-qm', 'and it breaks')
  commitWork(folder(2), 'the other way')
  const out = rig(['next', '--work', WORK]).out
  assert.match(out, /the 2 attempts at feat\/tried-work each have commits here — compare them, then keep one/)
  assert.match(out, /rig attempt feat\/tried-work/)
})

test('the comparison shows each attempt\'s own commits and diff', () => {
  const out = rig(['attempt', '--work', WORK]).out
  assert.match(out, /billing@1 {2}2 commits · 2 files \+2 −0 · checks not run/)
  assert.match(out, /billing@2 {2}1 commit · 1 file \+1 −0 · checks not run/)
})

test('--run keeps a pass for each attempt whose checks pass, and the comparison reads it', () => {
  const r = rig(['attempt', '--run', '--work', WORK])
  assert.equal(r.code, 1, 'attempt 1 fails its checks, and the exit code says so')
  const passes = record(WORK).attempts[0].passes
  assert.deepEqual(passes.map(p => [p.n, p.repo, p.head]), [[2, 'billing', head(folder(2))]])
  assert.match(rig(['attempt', '--work', WORK]).out, /billing@2 {2}1 commit · 1 file \+1 −0 · checks passed at [0-9a-f]{7}/)
})

test('close refuses while attempts are open, and says how to end them', () => {
  const r = rig(['close', '--work', WORK])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /feat\/tried-work: 2 attempts still open — keep one \(`rig attempt feat\/tried-work --keep <n> --why "…"`\)/)
})

test('detach refuses while the repo carries open attempts', () => {
  const r = rig(['detach', 'billing', '--work', WORK])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing carries open attempts \(feat\/tried-work@1, feat\/tried-work@2\)/)
})

test('a repo holds one open set at a time, since its attempt folders do not say whose they are', () => {
  assert.equal(rig(['stage', 'feat/tried-other', '--delivers', 'something else', '--work', WORK]).code, 0)
  const r = rig(['attempt', 'feat/tried-other', '--n', '2', '--work', WORK], here())
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing already holds the attempts at feat\/tried-work — keep one or drop them first/)
})

test('rig check --run in an attempt\'s folder says it would check the repo, not the attempt', () => {
  const r = rig(['check', '--run', '--work', WORK], { cwd: folder(1) })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing@1 is attempt 1 at feat\/tried-work, and `rig check --run` checks billing's own worktree/)
})

test('--keep wants the reason the attempt won', () => {
  const r = rig(['attempt', '--keep', '2', '--work', WORK])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--why needs the reason attempt 2 won/)
})

test('--keep refuses, and moves nothing, while an attempt that lost has uncommitted changes', () => {
  const before = head(worktree(WORK, 'billing'))
  fs.writeFileSync(path.join(folder(1), 'scratch.txt'), 'unsaved\n')
  const r = rig(['attempt', '--keep', '2', '--why', 'it passes its checks', '--work', WORK])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /not keeping attempt 2 — nothing has moved/)
  assert.match(r.out, /billing@1: uncommitted changes in an attempt that did not win — commit them, or pass --force/)
  assert.equal(head(worktree(WORK, 'billing')), before)
  assert.ok(fs.existsSync(folder(2)))
})

test('--keep refuses a winner with uncommitted changes, which would not be part of what is kept', () => {
  fs.writeFileSync(path.join(folder(2), 'unsaved.txt'), 'not committed\n')
  const r = rig(['attempt', '--keep', '2', '--why', 'it passes its checks', '--force', '--work', WORK])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing@2: uncommitted changes — commit them, or they are not part of what is kept/)
  fs.rmSync(path.join(folder(2), 'unsaved.txt'))
})

test('--keep fast-forwards the branch to the winner, discards the rest, and notes why', () => {
  const winner = head(folder(2))
  const r = rig(['attempt', '--keep', '2', '--why', 'it passes its checks', '--force', '--work', WORK])
  assert.equal(r.code, 0, r.out)
  assert.equal(head(worktree(WORK, 'billing')), winner, 'the work branch, checked out in billing, moved by fast-forward')
  for (const n of [1, 2]) {
    assert.ok(!fs.existsSync(folder(n)), `billing@${n} is gone`)
    assert.ok(!hasBranch(`${BRANCH}@${n}`), `${BRANCH}@${n} is gone`)
  }
  const [set] = record(WORK).attempts
  assert.equal(set.kept, 2)
  assert.ok(set.keptAt)
  assert.equal(set.passes, undefined, 'the passes went with the attempts')
  assert.match(notes(), new RegExp(`kept attempt 2 of 2 at feat/tried-work\tit passes its checks\t${winner}`))
})

test('and the pass the winner carried is the repo\'s, since its diff did not change', () => {
  assert.match(rig(['status', '--work', WORK]).out, /billing[\s\S]*?\n {2}checks {2}verified at [0-9a-f]{7}/)
})

test('doctor counts a kept set\'s folder as a stray, since it is no longer one of the work\'s', () => {
  fs.mkdirSync(folder(1))
  assert.match(rig(['doctor']).out, /unmanaged entry "billing@1"/)
  fs.rmSync(folder(1), { recursive: true })
})

test('attempts at a stage nobody has started are cut from what the stage would be cut from, and keeping one starts it', () => {
  assert.equal(rig(['stage', STAGE, '--delivers', 'the endpoints', '--work', WORK]).code, 0)
  const from = head(worktree(WORK, 'billing'))
  const r = rig(['attempt', STAGE, '--n', '2', '--work', WORK], here())
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /cut 2 attempts at feat\/tried-stage from feat\/tried-work/)
  assert.equal(head(folder(1)), from)
  commitWork(folder(1), 'the endpoints, one way')
  commitWork(folder(2), 'the endpoints, the other way')
  const winner = head(folder(1))

  const kept = rig(['attempt', STAGE, '--keep', '1', '--why', 'smaller', '--evidence', 'README.md:1', '--work', WORK])
  assert.equal(kept.code, 0, kept.out)
  assert.equal(head(worktree(WORK, 'billing'), STAGE), winner, 'the stage branch now exists, at the winner')
  assert.match(kept.out, /billing is on feat\/tried-work: `git -C .* switch feat\/tried-stage`/)
  assert.match(rig(['stage', '--work', WORK]).out, /feat\/tried-stage[\s\S]*billing/)
  assert.match(notes(), new RegExp(`${STAGE}\tkept attempt 1 of 2 at ${STAGE}\tsmaller\tREADME.md:1,${winner}`))
})

test('--keep refuses when the branch has moved since the attempts were cut, and --dropped ends the set', () => {
  assert.equal(rig(['attempt', '--n', '2', '--work', WORK], here()).code, 0)
  commitWork(folder(1), 'an attempt')
  commitWork(worktree(WORK, 'billing'), 'the branch moves on without it')
  const moved = head(worktree(WORK, 'billing'))

  const r = rig(['attempt', '--keep', '1', '--why', 'it was first', '--work', WORK])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing: feat\/tried-work has moved since attempt 1 was cut/)
  assert.equal(head(worktree(WORK, 'billing')), moved)

  const dropped = rig(['attempt', '--dropped', 'the branch went another way', '--work', WORK])
  assert.equal(dropped.code, 0, dropped.out)
  assert.ok(!fs.existsSync(folder(1)) && !fs.existsSync(folder(2)))
  assert.equal(head(worktree(WORK, 'billing')), moved, 'dropping leaves the branch where it was')
  const set = record(WORK).attempts.at(-1)
  assert.equal(set.reason, 'the branch went another way')
  assert.ok(set.droppedAt)
})

test('restore puts back an open attempt whose folder is gone, from its branch', () => {
  assert.equal(rig(['attempt', '--n', '2', '--work', WORK], here()).code, 0)
  commitWork(folder(1), 'pushed so another machine can see it')
  gitMust(folder(1), 'push', '-q', 'origin', `${BRANCH}@1`)
  const pushed = head(folder(1))
  // As a second machine has it: no folder, and the branch only on the remote.
  gitMust(worktree(WORK, 'billing'), 'worktree', 'remove', '--force', folder(1))
  gitMust(worktree(WORK, 'billing'), 'branch', '-D', `${BRANCH}@1`)

  const r = rig(['restore', WORK])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /restored billing@1 on feat\/tried-work@1/)
  assert.equal(head(folder(1)), pushed)
})

test('--dropped names a copy on the remote rather than deleting it', () => {
  const r = rig(['attempt', '--dropped', 'only here to test restore', '--work', WORK])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: feat\/tried-work@1 is still on the remote, and rig never pushed it/)
  assert.equal(gitMust(m.bare('billing'), 'branch', '--list', `${BRANCH}@1`).replace(/^[*+ ]+/, ''), `${BRANCH}@1`)
})

test('a new set will not take over an attempt branch an earlier set left on the remote', () => {
  const r = rig(['attempt', '--n', '2', '--work', WORK], here())
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /feat\/tried-work@1 already exists in billing, left by an earlier set — rig will not take it over/)
  assert.ok(!fs.existsSync(folder(2)), 'nothing was cut')
  gitMust(worktree(WORK, 'billing'), 'push', '-q', 'origin', '--delete', `${BRANCH}@1`)
})

test('--n takes a whole number from two to nine', () => {
  for (const [n, says] of [['2.5', /--n takes a whole number, not "2.5"/], ['10', /--n takes at most 9/]]) {
    const r = rig(['attempt', '--n', n, '--work', WORK], here())
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, says)
  }
})

test('a set on a stage withdrawn from the plan can still be dropped, and a new one cannot be cut', () => {
  const later = 'feat/tried-later'
  assert.equal(rig(['stage', later, '--delivers', 'maybe later', '--work', WORK]).code, 0)
  assert.equal(rig(['attempt', later, '--n', '2', '--work', WORK], here()).code, 0)
  assert.equal(rig(['stage', later, '--dropped', 'not needed after all', '--work', WORK]).code, 0)
  const cut = rig(['attempt', later, '--n', '3', '--work', WORK], here())
  assert.equal(cut.code, 1, cut.out)
  assert.match(cut.out, /was withdrawn from the plan/)
  const kept = rig(['attempt', later, '--keep', '1', '--why', 'still', '--work', WORK])
  assert.equal(kept.code, 1, kept.out)
  assert.match(kept.out, /was withdrawn from the plan .* — there is nothing to try; `rig attempt feat\/tried-later --dropped "why"` ends its attempts/)
  const r = rig(['attempt', later, '--dropped', 'the stage went', '--work', WORK])
  assert.equal(r.code, 0, r.out)
  assert.ok(record(WORK).attempts.at(-1).droppedAt)
})

test('--keep moves the branch in every repo that carries the winner', () => {
  m.publish('ledger')
  m.setVisibility('acme/ledger', 'private')
  assert.equal(rig(['new', 'pair', '--title', 'Pair work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'pair']).code, 0)
  assert.equal(rig(['attach', 'ledger', '--work', 'pair']).code, 0)
  const pairFolder = (repo, n) => path.join(workRoot, 'pair', `${repo}@${n}`)
  for (const repo of ['billing', 'ledger']) {
    assert.equal(rig(['attempt', '--n', '2', '--work', 'pair'], { cwd: worktree('pair', repo) }).code, 0)
    commitWork(pairFolder(repo, 1), `${repo}, one way`)
    commitWork(pairFolder(repo, 2), `${repo}, the other way`)
  }
  const winners = ['billing', 'ledger'].map(repo => head(pairFolder(repo, 2)))
  const r = rig(['attempt', '--keep', '2', '--why', 'both halves agree', '--work', 'pair'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(['billing', 'ledger'].map(repo => head(worktree('pair', repo))), winners)
})

test('a set counts only the repos it was cut in, so a branch an earlier set left in another repo is never kept', () => {
  const pairFolder = (repo, n) => path.join(workRoot, 'pair', `${repo}@${n}`)
  const pairBranch = 'feat/pair-work'
  for (const repo of ['billing', 'ledger']) assert.equal(rig(['attempt', '--n', '2', '--work', 'pair'], { cwd: worktree('pair', repo) }).code, 0)
  commitWork(pairFolder('ledger', 1), 'ledger, a way that will be dropped')
  gitMust(pairFolder('ledger', 1), 'push', '-q', 'origin', `${pairBranch}@1`)
  assert.equal(rig(['attempt', '--dropped', 'neither', '--work', 'pair']).code, 0)

  assert.equal(rig(['attempt', '--n', '2', '--work', 'pair'], { cwd: worktree('pair', 'billing') }).code, 0)
  commitWork(pairFolder('billing', 1), 'billing, the way that wins')
  const ledgerWas = head(worktree('pair', 'ledger'))
  const r = rig(['attempt', '--keep', '1', '--why', 'billing alone', '--work', 'pair'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /ledger: feat\/pair-work →/)
  assert.equal(head(worktree('pair', 'ledger')), ledgerWas, 'ledger never had this set, so its work branch did not move')

  const again = rig(['attempt', '--n', '2', '--work', 'pair'], { cwd: worktree('pair', 'ledger') })
  assert.equal(again.code, 1, again.out)
  assert.match(again.out, /feat\/pair-work@1 already exists in ledger, left by an earlier set/)
})

test('--keep fetches first, so a push to the branch from another machine is the branch moving', () => {
  const pairFolder = (repo, n) => path.join(workRoot, 'pair', `${repo}@${n}`)
  gitMust(worktree('pair', 'billing'), 'push', '-q', 'origin', 'feat/pair-work')
  assert.equal(rig(['attempt', '--n', '2', '--work', 'pair'], { cwd: worktree('pair', 'billing') }).code, 0)
  commitWork(pairFolder('billing', 1), 'an attempt')
  const elsewhere = path.join(m.tmp, 'other-machine')
  gitMust(m.tmp, 'clone', '-q', '-b', 'feat/pair-work', m.bare('billing'), elsewhere)
  commitWork(elsewhere, 'pushed from another machine')
  gitMust(elsewhere, 'push', '-q', 'origin', 'feat/pair-work')

  const r = rig(['attempt', '--keep', '1', '--why', 'it was first', '--work', 'pair'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing: feat\/pair-work has moved since attempt 1 was cut/)
  assert.equal(rig(['attempt', '--dropped', 'the branch moved on', '--force', '--work', 'pair']).code, 0)
})

test('restore puts back the attempts it can when git refuses one', () => {
  const pairFolder = (repo, n) => path.join(workRoot, 'pair', `${repo}@${n}`)
  assert.equal(rig(['attempt', '--n', '2', '--work', 'pair'], { cwd: worktree('pair', 'billing') }).code, 0)
  commitWork(pairFolder('billing', 1), 'pushed')
  gitMust(pairFolder('billing', 1), 'push', '-q', 'origin', 'feat/pair-work@1')
  gitMust(pairFolder('billing', 1), 'commit', '-q', '--amend', '-m', 'and rewritten here, so the two copies diverge')
  for (const n of [1, 2]) gitMust(worktree('pair', 'billing'), 'worktree', 'remove', '--force', pairFolder('billing', n))

  const r = rig(['restore', 'pair'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing@1: branch feat\/pair-work@1 in the mirror of acme\/billing has diverged/)
  assert.ok(fs.existsSync(pairFolder('billing', 2)), 'attempt 2 came back all the same')
  assert.equal(rig(['attempt', '--dropped', 'done with it', '--work', 'pair']).code, 0)
  gitMust(worktree('pair', 'billing'), 'push', '-q', 'origin', '--delete', 'feat/pair-work@1')
})

test('--n again with a larger number cuts only the attempts that are missing', () => {
  const pairFolder = n => path.join(workRoot, 'pair', `billing@${n}`)
  assert.equal(rig(['attempt', '--n', '2', '--work', 'pair'], { cwd: worktree('pair', 'billing') }).code, 0)
  const r = rig(['attempt', '--n', '3', '--work', 'pair'], { cwd: worktree('pair', 'billing') })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing@1 is already here[\s\S]*billing@2 is already here[\s\S]*cut 1 attempt at feat\/pair-work/)
  assert.ok(fs.existsSync(pairFolder(3)))
  const set = record('pair').attempts.at(-1)
  assert.deepEqual([set.count, set.repos], [3, [{ repo: 'billing', count: 3 }]])
})

test('--keep and --dropped refuse while an attempt\'s folder is off its branch, as mid-rebase', () => {
  const one = path.join(workRoot, 'pair', 'billing@1')
  gitMust(one, 'checkout', '-q', '--detach')
  for (const act of [['--keep', '2', '--why', 'x'], ['--dropped', 'x']]) {
    const r = rig(['attempt', ...act, '--work', 'pair'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /billing@1: not on feat\/pair-work@1, so rig cannot say what it holds/)
  }
  gitMust(one, 'checkout', '-q', 'feat/pair-work@1')
  assert.equal(rig(['attempt', '--dropped', 'done', '--work', 'pair']).code, 0)
})

test('--keep takes an attempt\'s remote copy where another machine pushed it further', () => {
  const one = path.join(workRoot, 'pair', 'billing@1')
  // Level with what the other machine pushed in the test before, so only the attempt has moved.
  gitMust(worktree('pair', 'billing'), 'fetch', '-q', 'origin')
  gitMust(worktree('pair', 'billing'), 'merge', '-q', '--ff-only', 'origin/feat/pair-work')
  assert.equal(rig(['attempt', '--n', '2', '--work', 'pair'], { cwd: worktree('pair', 'billing') }).code, 0)
  commitWork(one, 'started here')
  gitMust(one, 'push', '-q', 'origin', 'feat/pair-work@1')
  const elsewhere = path.join(m.tmp, 'other-machine')
  gitMust(elsewhere, 'fetch', '-q', 'origin')
  gitMust(elsewhere, 'checkout', '-q', '-b', 'feat/pair-work@1', 'origin/feat/pair-work@1')
  commitWork(elsewhere, 'finished on another machine')
  gitMust(elsewhere, 'push', '-q', 'origin', 'feat/pair-work@1')
  const finished = head(elsewhere)

  const r = rig(['attempt', '--keep', '1', '--why', 'finished elsewhere', '--work', 'pair'])
  assert.equal(r.code, 0, r.out)
  assert.equal(head(worktree('pair', 'billing')), finished)
})

test('a set counts each repo up to the number cut there, so a stale branch past it is never kept', () => {
  const ledger = worktree('pair', 'ledger')
  // Both repos' @1 copies, left on the remote by the tests before, would be refused as stale.
  gitMust(ledger, 'push', '-q', 'origin', '--delete', 'feat/pair-work@1')
  gitMust(worktree('pair', 'billing'), 'push', '-q', 'origin', '--delete', 'feat/pair-work@1')
  assert.equal(rig(['attempt', '--n', '3', '--work', 'pair'], { cwd: ledger }).code, 0)
  commitWork(path.join(workRoot, 'pair', 'ledger@3'), 'a way that will be dropped')
  gitMust(path.join(workRoot, 'pair', 'ledger@3'), 'push', '-q', 'origin', 'feat/pair-work@3')
  assert.equal(rig(['attempt', '--dropped', 'none', '--work', 'pair']).code, 0)

  assert.equal(rig(['attempt', '--n', '2', '--work', 'pair'], { cwd: ledger }).code, 0)
  assert.equal(rig(['attempt', '--n', '3', '--work', 'pair'], { cwd: worktree('pair', 'billing') }).code, 0)
  commitWork(path.join(workRoot, 'pair', 'billing@3'), 'the way that wins')
  const ledgerWas = head(ledger)
  const r = rig(['attempt', '--keep', '3', '--why', 'billing\'s third', '--work', 'pair'])
  assert.equal(r.code, 0, r.out)
  assert.equal(head(ledger), ledgerWas, 'ledger was cut two, so its stale @3 is no attempt of this set')
  assert.doesNotMatch(r.out, /ledger: feat\/pair-work →/)
})

test('--n will not take over a folder of an attempt\'s name that is something else', () => {
  assert.equal(rig(['new', 'occupied', '--title', 'Occupied work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'occupied']).code, 0)
  const mine = path.join(workRoot, 'occupied', 'billing@1')
  fs.mkdirSync(mine)
  fs.writeFileSync(path.join(mine, 'mine.txt'), 'mine\n')
  const r = rig(['attempt', '--n', '2', '--work', 'occupied'], { cwd: worktree('occupied', 'billing') })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing@1 already exists in the work folder and is not on feat\/occupied-work@1/)
  assert.equal(record('occupied').attempts, undefined, 'nothing was recorded')
  fs.rmSync(mine, { recursive: true })
})

test('an abandoned close refuses over an attempt folder off its branch, and otherwise ends the set with the work', () => {
  assert.equal(rig(['attempt', '--n', '2', '--work', 'occupied'], { cwd: worktree('occupied', 'billing') }).code, 0)
  const two = path.join(workRoot, 'occupied', 'billing@2')
  gitMust(two, 'checkout', '-q', '--detach')
  fs.writeFileSync(path.join(two, 'precious.txt'), 'mid-rebase, say\n')
  const r = rig(['close', '--abandoned', '--work', 'occupied'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing@2: not on feat\/occupied-work@2, so rig cannot say what it holds/)
  assert.ok(fs.existsSync(path.join(two, 'precious.txt')))

  fs.rmSync(path.join(two, 'precious.txt'))
  gitMust(two, 'checkout', '-q', 'feat/occupied-work@2')
  const closed = rig(['close', '--abandoned', '--work', 'occupied'])
  assert.equal(closed.code, 0, closed.out)
  assert.equal(record('occupied').attempts[0].reason, 'the work was abandoned')
})

test('--dropped refuses while the repo\'s own worktree has an attempt\'s branch checked out', () => {
  assert.equal(rig(['new', 'switched', '--title', 'Switched work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'switched']).code, 0)
  const own = worktree('switched', 'billing')
  assert.equal(rig(['attempt', '--n', '2', '--work', 'switched'], { cwd: own }).code, 0)
  gitMust(own, 'worktree', 'remove', path.join(workRoot, 'switched', 'billing@1'))
  gitMust(own, 'switch', '-q', 'feat/switched-work@1')
  commitWork(own, 'made on the attempt, in the repo\'s own worktree')

  const r = rig(['attempt', '--dropped', 'none', '--work', 'switched'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /feat\/switched-work@1 is checked out in .*billing — switch that worktree off it first/)
  assert.equal(gitMust(own, 'branch', '--show-current'), 'feat/switched-work@1', 'its branch is still there')
  gitMust(own, 'switch', '-q', 'feat/switched-work')
  assert.equal(rig(['attempt', '--dropped', 'none', '--work', 'switched']).code, 0)
})

test('--n fetches first and cuts from the remote\'s copy where another machine pushed it further', () => {
  const own = worktree('switched', 'billing')
  gitMust(own, 'push', '-q', 'origin', 'feat/switched-work')
  const elsewhere = path.join(m.tmp, 'third-machine')
  gitMust(m.tmp, 'clone', '-q', '-b', 'feat/switched-work', m.bare('billing'), elsewhere)
  commitWork(elsewhere, 'pushed from another machine')
  gitMust(elsewhere, 'push', '-q', 'origin', 'feat/switched-work')

  const r = rig(['attempt', '--n', '2', '--work', 'switched'], { cwd: own })
  assert.equal(r.code, 0, r.out)
  assert.equal(head(path.join(workRoot, 'switched', 'billing@1')), head(elsewhere))
  commitWork(path.join(workRoot, 'switched', 'billing@1'), 'an attempt')
  const kept = rig(['attempt', '--keep', '1', '--why', 'the only one', '--force', '--work', 'switched'])
  assert.equal(kept.code, 0, kept.out)
})

test('a kept attempt\'s pass does not replace a pass the repo still has for the branch it is on', () => {
  const own = worktree('switched', 'billing')
  assert.equal(rig(['check', '--run', '--work', 'switched']).code, 0)
  const before = record('switched').repos[0].branches[0].verified
  assert.equal(before.branch, 'feat/switched-work')
  assert.equal(rig(['stage', 'feat/switched-stage', '--delivers', 'a slice', '--work', 'switched']).code, 0)
  assert.equal(rig(['attempt', 'feat/switched-stage', '--n', '2', '--work', 'switched'], { cwd: own }).code, 0)
  commitWork(path.join(workRoot, 'switched', 'billing@1'), 'the slice')
  assert.equal(rig(['attempt', 'feat/switched-stage', '--run', '--work', 'switched']).code, 0)

  const r = rig(['attempt', 'feat/switched-stage', '--keep', '1', '--why', 'passes', '--work', 'switched'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: the pass attempt 1 had is not carried — the one recorded for feat\/switched-work stands/)
  assert.deepEqual(record('switched').repos[0].branches[0].verified, before)
})

test('--keep on a stage nobody has started refuses when the stage below has moved since the cut', () => {
  const own = worktree('switched', 'billing')
  const later = 'feat/switched-later'
  assert.equal(rig(['stage', later, '--delivers', 'the next slice', '--work', 'switched']).code, 0)
  const cut = rig(['attempt', later, '--n', '2', '--work', 'switched'], { cwd: own })
  assert.equal(cut.code, 0, cut.out)
  assert.match(cut.out, /from feat\/switched-stage/)
  commitWork(path.join(workRoot, 'switched', 'billing@1'), 'the next slice')
  gitMust(own, 'switch', '-q', 'feat/switched-stage')
  commitWork(own, 'the stage below moves on')
  gitMust(own, 'switch', '-q', 'feat/switched-work')

  const r = rig(['attempt', later, '--keep', '1', '--why', 'first', '--work', 'switched'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing: feat\/switched-stage, which feat\/switched-later sits on, has moved since attempt 1 was cut/)
  assert.ok(!hasBranchIn(own, later), 'the stage was not started')
})

test('--keep refuses prose for evidence and a reason that would break the notes row', () => {
  const later = 'feat/switched-later'
  const prose = rig(['attempt', later, '--keep', '1', '--why', 'first', '--evidence', 'it just works', '--work', 'switched'])
  assert.equal(prose.code, 1, prose.out)
  assert.match(prose.out, /--evidence is a pointer/)
  const tabbed = rig(['attempt', later, '--keep', '1', '--why', 'first\tsecond', '--work', 'switched'])
  assert.equal(tabbed.code, 1, tabbed.out)
  assert.match(tabbed.out, /--why takes one line, with no tab/)
  assert.equal(rig(['attempt', later, '--dropped', 'the stage below moved', '--force', '--work', 'switched']).code, 0)
})

test('restore says when an open set\'s attempts were never pushed, so none can come back', () => {
  const own = worktree('switched', 'billing')
  assert.equal(rig(['attempt', '--n', '2', '--work', 'switched'], { cwd: own }).code, 0)
  for (const n of [1, 2]) {
    gitMust(own, 'worktree', 'remove', path.join(workRoot, 'switched', `billing@${n}`))
    gitMust(own, 'branch', '-q', '-D', `feat/switched-work@${n}`)
  }
  const r = rig(['restore', 'switched'])
  assert.match(r.out, /feat\/switched-work: 2 attempts are open and none could be put back — they were never pushed from the machine that cut them/)
  assert.equal(rig(['attempt', '--dropped', 'lost with the other machine', '--work', 'switched']).code, 0)
})

test('a set ended on another machine leaves folders the close removes, not strays it refuses on', () => {
  assert.equal(rig(['new', 'ended', '--title', 'Ended work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'ended']).code, 0)
  assert.equal(rig(['attempt', '--n', '2', '--work', 'ended'], { cwd: worktree('ended', 'billing') }).code, 0)
  // What this machine reads once the other machine's drop is pulled: the set, ended.
  const file = path.join(dataRoot, 'work', 'ended', 'work.json')
  const w = JSON.parse(fs.readFileSync(file, 'utf8'))
  w.attempts[0].droppedAt = '2026-10-07T00:00:00.000Z'
  w.attempts[0].reason = 'dropped on another machine'
  fs.writeFileSync(file, JSON.stringify(w, null, 2))

  assert.doesNotMatch(rig(['doctor']).out, /unmanaged entry "billing@/)
  const r = rig(['close', '--abandoned', '--work', 'ended'])
  assert.equal(r.code, 0, r.out)
  assert.ok(!fs.existsSync(path.join(workRoot, 'ended')))
})

test('a forced close ends an open set with the work, so nothing reads it as open afterwards', () => {
  assert.equal(rig(['new', 'forced', '--title', 'Forced work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'forced']).code, 0)
  assert.equal(rig(['attempt', '--n', '2', '--work', 'forced'], { cwd: worktree('forced', 'billing') }).code, 0)
  const r = rig(['close', '--force', '--work', 'forced'])
  assert.equal(r.code, 0, r.out)
  assert.ok(!fs.existsSync(path.join(workRoot, 'forced')))
  const [set] = record('forced').attempts
  assert.equal(set.reason, 'the work was closed past it with --force')
  assert.ok(set.droppedAt)
})

test('--dropped still ends a set a closed work holds open, as a record from before the close dropped it would', () => {
  const file = path.join(dataRoot, 'work', 'forced', 'work.json')
  const w = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete w.attempts[0].droppedAt
  delete w.attempts[0].reason
  fs.writeFileSync(file, JSON.stringify(w, null, 2))
  const r = rig(['attempt', '--dropped', 'ended after the close', '--work', 'forced'])
  assert.equal(r.code, 0, r.out)
  assert.equal(record('forced').attempts[0].reason, 'ended after the close')
})

test('a first close refuses over a folder rig did not put in the work folder', () => {
  assert.equal(rig(['new', 'strayed', '--title', 'Strayed work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'strayed']).code, 0)
  fs.mkdirSync(path.join(workRoot, 'strayed', 'my-notes'))
  const r = rig(['close', '--work', 'strayed', '--abandoned'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /my-notes: not one of the work's repos, so rig cannot say what it holds/)
  assert.ok(fs.existsSync(path.join(workRoot, 'strayed', 'my-notes')), 'and nothing was deleted')
})

test('--keep refuses an attempt whose copy here and the remote\'s have diverged, rather than drop the remote\'s commits', () => {
  assert.equal(rig(['new', 'diverged', '--title', 'Diverged work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'diverged']).code, 0)
  const own = worktree('diverged', 'billing')
  const one = path.join(workRoot, 'diverged', 'billing@1')
  assert.equal(rig(['attempt', '--n', '2', '--work', 'diverged'], { cwd: own }).code, 0)
  commitWork(one, 'started here')
  gitMust(one, 'push', '-q', 'origin', 'feat/diverged-work@1')
  const elsewhere = path.join(m.tmp, 'diverging-machine')
  gitMust(m.tmp, 'clone', '-q', '-b', 'feat/diverged-work@1', m.bare('billing'), elsewhere)
  commitWork(elsewhere, 'finished on another machine')
  gitMust(elsewhere, 'push', '-q', 'origin', 'feat/diverged-work@1')
  commitWork(one, 'carried on here, never pushed')
  const was = head(own)

  const r = rig(['attempt', '--keep', '1', '--why', 'first', '--work', 'diverged'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing@1: feat\/diverged-work@1 here and on the remote have diverged/)
  assert.equal(head(own), was, 'the branch did not move')
})

test('a cut git refuses leaves no attempt branch behind, and says git\'s reason', () => {
  assert.equal(rig(['new', 'badcut', '--title', 'Badcut work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'badcut']).code, 0)
  const own = worktree('badcut', 'billing')
  // A tip no checkout can write: a tree with a `.git` folder in it, which git refuses everywhere.
  const blob = spawnSync('git', ['-C', own, 'hash-object', '-w', '--stdin'], { input: 'x\n', encoding: 'utf8' }).stdout.trim()
  const inner = spawnSync('git', ['-C', own, 'mktree'], { input: `100644 blob ${blob}\tx\n`, encoding: 'utf8' }).stdout.trim()
  const outer = spawnSync('git', ['-C', own, 'mktree'], { input: `040000 tree ${inner}\t.git\n`, encoding: 'utf8' }).stdout.trim()
  const bad = gitMust(own, 'commit-tree', outer, '-p', 'HEAD', '-m', 'unwritable')
  gitMust(own, 'update-ref', 'refs/heads/feat/badcut-work', bad)

  const r = rig(['attempt', '--n', '2', '--work', 'badcut'], { cwd: own })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /could not cut feat\/badcut-work@1 — (fatal|error): /)
  assert.ok(!hasBranchIn(own, 'feat/badcut-work@1'), 'the branch git made before it refused is gone')
  assert.equal(record('badcut').attempts, undefined, 'nothing was recorded')
})

test('--n will not cut afresh an attempt the set says was cut on another machine, and restore names it', () => {
  assert.equal(rig(['new', 'recut', '--title', 'Recut work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'recut']).code, 0)
  const own = worktree('recut', 'billing')
  assert.equal(rig(['attempt', '--n', '2', '--work', 'recut'], { cwd: own }).code, 0)
  // What this machine reads once the other machine's third cut is pulled: one it never pushed.
  const file = path.join(dataRoot, 'work', 'recut', 'work.json')
  const w = JSON.parse(fs.readFileSync(file, 'utf8'))
  w.attempts[0].count = 3
  w.attempts[0].repos = [{ repo: 'billing', count: 3 }]
  fs.writeFileSync(file, JSON.stringify(w, null, 2))

  const restored = rig(['restore', 'recut'])
  assert.match(restored.out, /feat\/recut-work: billing@3 is not here, and was never pushed from the machine that cut it/)
  const r = rig(['attempt', '--n', '3', '--work', 'recut'], { cwd: own })
  assert.match(r.out, /billing@3: feat\/recut-work@3 was cut on another machine and never pushed — push it from there/)
  assert.ok(!fs.existsSync(path.join(workRoot, 'recut', 'billing@3')))
  assert.ok(!hasBranchIn(own, 'feat/recut-work@3'), 'no second attempt 3 was made')
})

test('a folder an ended set left is that set\'s, though a newer set at another branch has an attempt of its name', () => {
  assert.equal(rig(['new', 'reused', '--title', 'Reused work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'reused']).code, 0)
  assert.equal(rig(['stage', 'feat/reused-stage', '--delivers', 'a slice', '--work', 'reused']).code, 0)
  assert.equal(rig(['attempt', '--n', '2', '--work', 'reused'], { cwd: worktree('reused', 'billing') }).code, 0)
  // What this machine reads once another machine's keep, and its new set on the stage, are pulled.
  const file = path.join(dataRoot, 'work', 'reused', 'work.json')
  const w = JSON.parse(fs.readFileSync(file, 'utf8'))
  w.attempts[0].kept = 1
  w.attempts[0].keptAt = '2026-10-07T00:00:00.000Z'
  w.attempts.push({ branch: 'feat/reused-stage', count: 1, at: '2026-10-07T00:00:00.000Z', repos: [{ repo: 'billing', count: 1 }] })
  fs.writeFileSync(file, JSON.stringify(w, null, 2))

  const dropped = rig(['attempt', 'feat/reused-stage', '--dropped', 'none', '--work', 'reused'])
  assert.equal(dropped.code, 0, dropped.out)
  const closed = rig(['close', '--abandoned', '--work', 'reused'])
  assert.equal(closed.code, 0, closed.out)
  assert.ok(!fs.existsSync(path.join(workRoot, 'reused')))
})

test('--n refuses while the branch here and on the remote have diverged, since no attempt cut from either could be kept', () => {
  assert.equal(rig(['new', 'gaps', '--title', 'Gaps work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'gaps']).code, 0)
  const own = worktree('gaps', 'billing')
  commitWork(own, 'pushed')
  gitMust(own, 'push', '-q', 'origin', 'feat/gaps-work')
  gitMust(own, 'commit', '-q', '--amend', '-m', 'and rewritten here, so the two copies diverge')

  const r = rig(['attempt', '--n', '2', '--work', 'gaps'], { cwd: own })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing: feat\/gaps-work here and on the remote have diverged — bring them together, then cut the attempts/)
  assert.equal(record('gaps').attempts, undefined, 'nothing was recorded')
  gitMust(own, 'push', '-q', '--force', 'origin', 'feat/gaps-work')
})

test('the comparison says an attempt\'s pass is stale once its diff has changed since it passed', () => {
  const own = worktree('gaps', 'billing')
  assert.equal(rig(['attempt', '--n', '2', '--work', 'gaps'], { cwd: own }).code, 0)
  const one = path.join(workRoot, 'gaps', 'billing@1')
  commitWork(one, 'an attempt')
  assert.equal(rig(['attempt', '--run', '--work', 'gaps']).code, 0)
  commitWork(one, 'and more since it passed')

  const r = rig(['attempt', '--work', 'gaps'])
  assert.match(r.out, /billing@1 {2}2 commits .* · checks stale — the diff changed since they passed/)
})

test('tidy clears the folders a closed work\'s ended set left, as the close that ran elsewhere would have', () => {
  // What this machine reads once another machine's drop and close are pulled.
  const file = path.join(dataRoot, 'work', 'gaps', 'work.json')
  const w = JSON.parse(fs.readFileSync(file, 'utf8'))
  w.attempts[0].droppedAt = '2026-10-07T00:00:00.000Z'
  w.attempts[0].reason = 'dropped on another machine'
  w.closedAt = w.abandonedAt = '2026-10-07T00:00:00.000Z'
  fs.writeFileSync(file, JSON.stringify(w, null, 2))

  const r = rig(['tidy'])
  assert.equal(r.code, 0, r.out)
  assert.ok(!fs.existsSync(path.join(workRoot, 'gaps')))
})

test('a set cut again at a branch whose last set was dropped has its folders read as its own', () => {
  assert.equal(rig(['new', 'retried', '--title', 'Retried work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'retried']).code, 0)
  const own = worktree('retried', 'billing')
  assert.equal(rig(['attempt', '--n', '2', '--work', 'retried'], { cwd: own }).code, 0)
  assert.equal(rig(['attempt', '--dropped', 'neither', '--work', 'retried']).code, 0)
  assert.equal(rig(['attempt', '--n', '2', '--work', 'retried'], { cwd: own }).code, 0)

  const agents = fs.readFileSync(path.join(workRoot, 'retried', 'AGENTS.md'), 'utf8')
  assert.ok(agents.includes('- Attempt 1 at `feat/retried-work`'), agents)
  const r = rig(['check', '--run', '--work', 'retried'], { cwd: path.join(workRoot, 'retried', 'billing@1') })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing@1 is attempt 1 at feat\/retried-work/)
})

test('restore names an attempt whose folder is taken by a worktree on another branch, rather than guess why', () => {
  const own = worktree('retried', 'billing')
  const one = path.join(workRoot, 'retried', 'billing@1')
  commitWork(one, 'pushed')
  gitMust(one, 'push', '-q', 'origin', 'feat/retried-work@1')
  gitMust(own, 'worktree', 'remove', one)
  gitMust(own, 'worktree', 'add', '-q', '-b', 'feat/retried-other', one)

  const r = rig(['restore', 'retried'])
  assert.match(r.out, /billing@1: here on feat\/retried-other, not feat\/retried-work@1 — remove that worktree, then `rig restore`/)
  gitMust(own, 'worktree', 'remove', one)
  assert.equal(rig(['restore', 'retried']).code, 0)
  assert.equal(gitMust(one, 'branch', '--show-current'), 'feat/retried-work@1')
  assert.equal(rig(['attempt', '--dropped', 'done', '--work', 'retried']).code, 0)
  gitMust(own, 'push', '-q', 'origin', '--delete', 'feat/retried-work@1')
})

test('a cut whose checkout succeeded but whose post-checkout hook failed is still an attempt, said with git\'s complaint', () => {
  const own = worktree('retried', 'billing')
  const hooks = path.join(m.tmp, 'failing-hooks')
  fs.mkdirSync(hooks, { recursive: true })
  fs.writeFileSync(path.join(hooks, 'post-checkout'), '#!/bin/sh\necho "the hook says no" >&2\nexit 1\n', { mode: 0o755 })
  gitMust(own, 'config', 'core.hooksPath', hooks)
  try {
    const r = rig(['attempt', '--n', '2', '--work', 'retried'], { cwd: own })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /feat\/retried-work@1: cut, but git ended with an error after the checkout — /)
    for (const n of [1, 2]) assert.equal(gitMust(path.join(workRoot, 'retried', `billing@${n}`), 'branch', '--show-current'), `feat/retried-work@${n}`)
    assert.equal(record('retried').attempts.at(-1).count, 2)
  } finally {
    gitMust(own, 'config', '--unset', 'core.hooksPath')
  }
})

test('folders a set ended on another machine left are its own, though an earlier ended set had the same names', () => {
  assert.equal(rig(['new', 'twice', '--title', 'Twice work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'twice']).code, 0)
  assert.equal(rig(['stage', 'feat/twice-stage', '--delivers', 'a slice', '--work', 'twice']).code, 0)
  const own = worktree('twice', 'billing')
  assert.equal(rig(['attempt', 'feat/twice-stage', '--n', '2', '--work', 'twice'], { cwd: own }).code, 0)
  assert.equal(rig(['attempt', 'feat/twice-stage', '--dropped', 'neither', '--work', 'twice']).code, 0)
  assert.equal(rig(['attempt', '--n', '2', '--work', 'twice'], { cwd: own }).code, 0)
  // What this machine reads once another machine's keep of the second set is pulled.
  const file = path.join(dataRoot, 'work', 'twice', 'work.json')
  const w = JSON.parse(fs.readFileSync(file, 'utf8'))
  w.attempts[1].kept = 1
  w.attempts[1].keptAt = '2026-10-07T00:00:00.000Z'
  fs.writeFileSync(file, JSON.stringify(w, null, 2))

  assert.doesNotMatch(rig(['doctor']).out, /unmanaged entry "billing@/)
  const r = rig(['close', '--abandoned', '--work', 'twice'])
  assert.equal(r.code, 0, r.out)
  assert.ok(!fs.existsSync(path.join(workRoot, 'twice')))
})

test('--keep refuses a winner the set counts in a repo where this machine has no copy of it, rather than keep half of it', () => {
  assert.equal(rig(['new', 'halves', '--title', 'Halves work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'halves']).code, 0)
  assert.equal(rig(['attach', 'ledger', '--work', 'halves']).code, 0)
  const at = (repo, n) => path.join(workRoot, 'halves', `${repo}@${n}`)
  for (const repo of ['billing', 'ledger']) {
    assert.equal(rig(['attempt', '--n', '2', '--work', 'halves'], { cwd: worktree('halves', repo) }).code, 0)
    commitWork(at(repo, 1), `${repo}, one way`)
  }
  // Ledger's half, cut on another machine and never pushed.
  gitMust(worktree('halves', 'ledger'), 'worktree', 'remove', at('ledger', 1))
  gitMust(worktree('halves', 'ledger'), 'branch', '-q', '-D', 'feat/halves-work@1')
  const was = head(worktree('halves', 'billing'))

  const r = rig(['attempt', '--keep', '1', '--why', 'one', '--work', 'halves'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /ledger@1: feat\/halves-work@1 is in neither the mirror nor the remote — it was never pushed from the machine that cut it/)
  assert.equal(head(worktree('halves', 'billing')), was, 'billing did not move either')
})
