// `rig attempt`: one branch of a work tried several ways at once, each attempt a sibling branch
// with a worktree of its own, compared, and one kept by a fast-forward (hugoforte/rig#321).
//
// Real git throughout, in the trees rig cut: the attempts are made by rig and written on by
// hand, exactly as an agent in each folder would. The check commands are `node -e` one-liners,
// so the suite stays offline and spawns no npm.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
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
  assert.match(rig(['next', '--work', WORK]).out, /2 attempts at feat\/tried-work are open — 0 of 2 have commits so far/)
  commitWork(folder(1), 'one way')
  fs.writeFileSync(path.join(folder(1), 'BROKEN'), 'this way fails its checks\n')
  gitMust(folder(1), 'add', 'BROKEN')
  gitMust(folder(1), 'commit', '-qm', 'and it breaks')
  commitWork(folder(2), 'the other way')
  const out = rig(['next', '--work', WORK]).out
  assert.match(out, /the 2 attempts at feat\/tried-work each have commits — compare them, then keep one/)
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
  assert.match(r.out, /billing carries open attempts \(billing@1, billing@2\)/)
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

test('a first close refuses over a folder rig did not put in the work folder', () => {
  assert.equal(rig(['new', 'strayed', '--title', 'Strayed work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'strayed']).code, 0)
  fs.mkdirSync(path.join(workRoot, 'strayed', 'my-notes'))
  const r = rig(['close', '--work', 'strayed', '--abandoned'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /my-notes: not one of the work's repos, so rig cannot say what it holds/)
  assert.ok(fs.existsSync(path.join(workRoot, 'strayed', 'my-notes')), 'and nothing was deleted')
})
