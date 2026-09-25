// A work picked up on a second machine: the record came across with the data root and nothing
// else did (hugoforte/rig#112). One journey, because what it proves is the second machine's
// first command against a record the first machine wrote.
//
// Three repos, one for each way a recorded branch can stand once the first machine is gone:
// pushed with an open PR (and a stack somebody built on it without telling rig), carried only
// by a stage because the work branch was never pushed, and deleted from the remote after its
// PR closed unmerged. The second machine is the same installation with its work folder and its
// mirrors deleted, which is exactly what a clone of the data root on a new machine has.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { scenario, step, readJson } from './harness.mjs'

const ORG = 'e2e-restore'
const ID = 'e2e-rs'
const WORK_BRANCH = 'feat/e2e-restore-work'
const SLICE = 'feat/e2e-rs-slice'
const EXTRA = 'feat/e2e-rs-extra'
const [PUSHED, STAGED, CLOSED] = ['e2e-rs-pushed', 'e2e-rs-staged', 'e2e-rs-closed']

const publish = ({ tmp, remotesDir, gitMust }, repo) => {
  const seed = path.join(tmp, 'seed', repo)
  fs.mkdirSync(seed, { recursive: true })
  gitMust(seed, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', `${repo}: first`)
  const bare = path.join(remotesDir, ORG, `${repo}.git`)
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  gitMust(tmp, 'clone', '-q', '--bare', seed, bare)
}

const worktree = (m, repo) => path.join(m.workRoot, ID, repo)
const recordFile = m => path.join(m.dataRoot, 'work', ID, 'work.json')
const headOf = (m, repo) => m.gitMust(worktree(m, repo), 'rev-parse', '--abbrev-ref', 'HEAD')
const commit = (m, repo, message) => {
  fs.appendFileSync(path.join(worktree(m, repo), 'README.md'), `${message}\n`)
  m.gitMust(worktree(m, repo), 'add', '-A')
  m.gitMust(worktree(m, repo), 'commit', '-q', '-m', message)
}
const pr = (repo, number, branch, base, state) =>
  ({ number, branch, base, state, url: `https://github.com/${ORG}/${repo}/pull/${number}`, openedAt: '2026-09-25T00:00:00Z', mergedAt: null, commits: [] })
const addPrs = (m, repo, ...prs) => {
  const state = readJson(m.githubStateFile)
  state.repos[`${ORG}/${repo}`].prs.push(...prs)
  fs.writeFileSync(m.githubStateFile, JSON.stringify(state))
}

scenario('a work is restored on a second machine from its record alone', {
  inProcess: true,
  prefix: 'e2e-restore-',
  remotes: true,
  github: {
    auth: 'ok',
    repos: Object.fromEntries([PUSHED, STAGED, CLOSED].map(r => [`${ORG}/${r}`, { language: 'JavaScript', prs: [] }])),
  },
}, [
  step('the first machine attaches three repos and leaves each branch a different way', m => {
    for (const r of [PUSHED, STAGED, CLOSED]) publish(m, r)
    assert.equal(m.rig(['init', '--data-root', m.dataRoot, '--work-root', m.workRoot,
      '--orgs', ORG, '--tracker', `${ORG}=none`, '--email', 'restore@e2e.invalid']).code, 0)
    assert.equal(m.rig(['new', ID, '--title', 'E2E restore work', '--type', 'feat', '--no-ticket']).code, 0)
    for (const r of [PUSHED, STAGED, CLOSED]) {
      const a = m.rig(['attach', r, '--work', ID])
      assert.equal(a.code, 0, a.out)
    }

    // Pushed, with its PR open — and a branch stacked on it that rig was never told about.
    commit(m, PUSHED, 'the work')
    m.gitMust(worktree(m, PUSHED), 'push', '-q', 'origin', WORK_BRANCH)
    m.gitMust(worktree(m, PUSHED), 'checkout', '-q', '-b', EXTRA)
    commit(m, PUSHED, 'more, on top')
    m.gitMust(worktree(m, PUSHED), 'push', '-q', 'origin', EXTRA)
    m.gitMust(worktree(m, PUSHED), 'checkout', '-q', WORK_BRANCH)
    addPrs(m, PUSHED, pr(PUSHED, 1, WORK_BRANCH, 'main', 'OPEN'), pr(PUSHED, 2, EXTRA, WORK_BRANCH, 'OPEN'))

    // All of this repo's work is on a declared stage; the work branch never left the machine.
    assert.equal(m.rig(['stage', SLICE, '--delivers', 'the slice', '--work', ID]).code, 0)
    m.gitMust(worktree(m, STAGED), 'checkout', '-q', '-b', SLICE)
    commit(m, STAGED, 'the slice')
    m.gitMust(worktree(m, STAGED), 'push', '-q', 'origin', SLICE)

    // Pushed, reviewed, closed unmerged, and its branch deleted.
    commit(m, CLOSED, 'not wanted after all')
    m.gitMust(worktree(m, CLOSED), 'push', '-q', 'origin', WORK_BRANCH)
    addPrs(m, CLOSED, pr(CLOSED, 3, WORK_BRANCH, 'main', 'CLOSED'))
    m.gitMust(worktree(m, CLOSED), 'push', '-q', 'origin', '--delete', WORK_BRANCH)
  }),

  step('the second machine has the record and nothing else, and next offers the restore', m => {
    fs.rmSync(path.join(m.workRoot, ID), { recursive: true, force: true, maxRetries: 5 })
    fs.rmSync(path.join(m.workRoot, '.mirrors'), { recursive: true, force: true, maxRetries: 5 })
    m.recorded = fs.readFileSync(recordFile(m))

    const next = m.rig(['next', '--work', ID])
    assert.equal(next.code, 0, next.out)
    assert.match(next.out, new RegExp(`${PUSHED}, ${STAGED} are not on this machine[^\\n]*\\n\\s*rig restore ${ID}`))
    assert.match(m.rig(['doctor']).out, new RegExp(`${ID}: work folder missing but not closed — \`rig restore ${ID}\``))
  }),

  step('restore puts each repo on the top of its stack and names the one it cannot', m => {
    const r = m.rig(['restore', ID])
    assert.equal(r.code, 0, r.out)
    assert.equal(headOf(m, PUSHED), WORK_BRANCH)
    assert.equal(headOf(m, STAGED), SLICE, 'the stage carries the work; the unpushed work branch does not exist here')
    assert.ok(!fs.existsSync(worktree(m, CLOSED)), 'a branch the remote lost is never recreated')
    assert.match(r.out, new RegExp(`${CLOSED}: ${WORK_BRANCH} is on neither the remote nor the mirror — not recreated; PR #3 CLOSED`))
    assert.match(r.out, new RegExp(`stacked on ${WORK_BRANCH}, not in the record: ${EXTRA} \\(#2\\)`))
    assert.match(r.out, /restored 2 of 3/)
  }),

  step('and writes nothing down, while the folder is whole again', m => {
    assert.ok(fs.readFileSync(recordFile(m)).equals(m.recorded), 'work.json is byte-identical')
    assert.equal(fs.readFileSync(path.join(m.workRoot, ID, '.rig', 'id'), 'utf8').trim(), ID)
    assert.ok(fs.existsSync(path.join(m.workRoot, ID, 'AGENTS.md')))
    assert.equal(m.gitMust(worktree(m, STAGED), 'config', 'user.email'), 'restore@e2e.invalid')

    const status = m.rig(['status', '--work', ID]).out
    for (const r of [PUSHED, STAGED]) assert.doesNotMatch(status, new RegExp(`${r}[\\\\/]?\\s+MISSING`))
    assert.doesNotMatch(m.rig(['doctor']).out, /work folder missing/)
    assert.doesNotMatch(m.rig(['next', '--work', ID]).out, /rig restore/, 'the closed PR\'s repo is not offered again')
  }),

  step('restoring again changes nothing', m => {
    const r = m.rig(['restore', ID])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, new RegExp(`${PUSHED} is already here`))
    assert.equal(headOf(m, STAGED), SLICE)
  }),

  step('attach on a recorded repo whose worktree is gone puts it back, not "nothing to do"', m => {
    fs.rmSync(worktree(m, STAGED), { recursive: true, force: true, maxRetries: 5 })
    const r = m.rig(['attach', STAGED, '--work', ID])
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /nothing to do/)
    assert.equal(headOf(m, STAGED), SLICE)
    assert.ok(fs.readFileSync(recordFile(m)).equals(m.recorded), 'attachedAt and the rest are untouched')
  }),

  step('--tip checks out the top of the stack the record does not know', m => {
    fs.rmSync(worktree(m, PUSHED), { recursive: true, force: true, maxRetries: 5 })
    const r = m.rig(['restore', ID, '--tip'])
    assert.equal(r.code, 0, r.out)
    assert.equal(headOf(m, PUSHED), EXTRA)
    assert.match(r.out, new RegExp(`rig stage ${EXTRA}`))
  }),

  step('a stage whose PR merged is not the top, even with its branch still on the remote', m => {
    // A squash: the work branch never holds the stage's commits, so only the PR can say it landed.
    addPrs(m, STAGED, pr(STAGED, 4, SLICE, WORK_BRANCH, 'MERGED'))
    fs.rmSync(worktree(m, STAGED), { recursive: true, force: true, maxRetries: 5 })
    const r = m.rig(['restore', ID])
    assert.doesNotMatch(r.out, new RegExp(`restored ${STAGED} on ${SLICE}`))
    assert.match(r.out, new RegExp(`${STAGED}: ${WORK_BRANCH} is on neither the remote nor the mirror`))
  }),
])
