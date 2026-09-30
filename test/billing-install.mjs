// One installation with `acme/billing` published and `rig init` run, and every move the tests
// that drive `close`, `abandon`, `next`, `stage`, `pr`, `plan` and the record corrections make
// against it.
//
// Seven files test them, each with an installation of its own built from here: close, abandon
// and next in test/close.test.mjs, stage across stages-e2e, stage-cut and stage-tickets, pr and
// plan in files of their own, and the corrections to a work's record in
// test/record-corrections.test.mjs. `node --test` runs files in parallel and the tests within a
// file in order, so subjects in one file wait on each other. Apart, each file costs an
// installation of extra work, and buys subjects that run without the others and a suite CI
// can divide by file into parts of a similar size. A full run gains less than that suggests:
// it is bound by process creation and I/O rather than by cores.
//
// The files are independent — each builds its own installation and its own works. What they
// share is the code below.
//
// These helpers are this scenario's and not every scenario's, which is why they are not in
// `test/harness.mjs`: five other test files publish a bare repo of their own, in five shapes,
// and unifying those is a different change from this one.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { makeInstall, readJson } from './harness.mjs'

// The installation every file in this family starts from: `acme/billing` on disk as a bare
// repo under `RIG_FAKE_REMOTES`, an in-memory GitHub with nothing in it yet, and an org whose
// tracker is `none` so no test has to decide about a ticket it is not testing.
//
// `prefix` names the temp directory, so a failing run says which file left it behind.
export function billingInstall (prefix) {
  const m = makeInstall({
    // Every file in this family is about a record, a branch or a line of output, so their
    // runs happen in the test's own process.
    inProcess: true,
    prefix,
    author: 'rig close',
    email: 'close@example.invalid',
    remotes: true,
    // Private, like most repos a work touches: whether the context-doc link may be written into
    // a PR or a ticket comment depends on it (hugoforte/rig#202), and a repo whose visibility
    // GitHub never said would have every body leave the link out.
    github: { auth: 'ok', repos: { 'acme/billing': { language: 'JavaScript', visibility: 'private', prs: [] } } },
    // An in-memory Jira with nothing in it, for the ticket keys that are Jira's.
    twg: { present: true, issues: {} },
  })
  const { tmp, dataRoot, workRoot, remotesDir, githubStateFile, rig, gitMust } = m

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
    gitMust(tmp, 'clone', '-q', '--bare', seed, bare(repo))
  }

  const github = () => readJson(githubStateFile)
  const jiraIssue = key => readJson(m.twgStateFile).issues[key]
  const seedJiraIssue = (key, title) => {
    const state = readJson(m.twgStateFile)
    state.issues[key] = { title, body: '', comments: [] }
    fs.writeFileSync(m.twgStateFile, JSON.stringify(state))
  }
  const setGithub = state => fs.writeFileSync(githubStateFile, JSON.stringify(state))

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

  // Cut a branch in the worktree, put a commit on it, and go back to the work branch. Real
  // git, in the tree rig cut: exactly what you would do by hand, and the only setup these
  // tests are allowed. A test that writes the rows into `work.json` to make the stack appear
  // is the bug report that produced hugoforte/rig#78, not a convenience.
  const commitWork = (dest, message) => {
    fs.appendFileSync(path.join(dest, 'README.md'), `${message}\n`)
    gitMust(dest, 'commit', '-qam', message)
  }

  const worktree = (id, repo) => path.join(workRoot, id, repo)

  const cutStage = ({ work, repo, branch, from, back, message }) => {
    const dest = worktree(work, repo)
    gitMust(dest, 'checkout', '-q', '-b', branch, from)
    commitWork(dest, message)
    gitMust(dest, 'checkout', '-q', back)
  }

  const seedIssue = (number, title) => {
    const state = github()
    const repo = state.repos['acme/billing']
    repo.issues = (repo.issues || []).concat([{ number, title, state: 'OPEN', comments: [] }])
    setGithub(state)
  }

  const seedPr = pr => {
    const state = github()
    state.repos['acme/billing'].prs.push({ openedAt: '2026-09-19T00:00:00Z', commits: ['2026-09-19T00:00:00Z'], ...pr })
    setGithub(state)
  }

  // Either step can fail, and the caller has not been handed `cleanup` yet to register it.
  try {
    publish('billing')
    assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
      '--orgs', 'acme', '--tracker', 'acme=none']).code, 0)
  } catch (e) {
    m.cleanup()
    throw e
  }

  // What a repo's visibility on GitHub is, as the next lookup will read it; `undefined` is a
  // repo GitHub will not say for.
  const setVisibility = (spec, visibility) => {
    const state = github()
    state.repos[spec] = { prs: [], ...state.repos[spec], visibility }
    setGithub(state)
  }
  // `fn`, run with a repo's visibility set, and the visibility it had put back afterwards.
  const withVisibility = (spec, visibility, fn) => {
    const was = github().repos[spec]?.visibility
    setVisibility(spec, visibility)
    try { return fn() } finally { setVisibility(spec, was) }
  }

  return {
    ...m,
    bare,
    publish,
    jiraIssue,
    seedJiraIssue,
    setVisibility,
    withVisibility,
    github,
    setGithub,
    squashMergeAndDeleteBranch,
    commitWork,
    cutStage,
    seedIssue,
    seedPr,
    worktree,
    record: id => readJson(path.join(dataRoot, 'work', id, 'work.json')),
    issueNumbered: n => github().repos['acme/billing'].issues.find(i => i.number === n),
    planFile: id => path.join(dataRoot, 'work', id, 'rollout-testing-plan.md'),
  }
}

// A work with two stages, the first landed and the second up for review — the state `stage`,
// `pr` and `plan` all need before they have anything to render. Three files build it, so it
// is built the same way in all three: real branches cut in the worktree, and the pull requests
// seeded so the live base wins over git the way it does in life.
export function slicedWork (m) {
  const { rig, cutStage, github, setGithub } = m
  assert.equal(rig(['new', 'sliced', '--title', 'Sliced work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'sliced']).code, 0)
  assert.equal(rig(['stage', 'feat/sliced-one', '--delivers', 'the schema', '--work', 'sliced']).code, 0)
  assert.equal(rig(['stage', 'feat/sliced-two', '--delivers', 'the endpoints', '--work', 'sliced']).code, 0)

  const opts = { work: 'sliced', repo: 'billing', back: 'feat/sliced-work' }
  cutStage({ ...opts, branch: 'feat/sliced-one', from: 'feat/sliced-work', message: 'the schema' })
  cutStage({ ...opts, branch: 'feat/sliced-two', from: 'feat/sliced-one', message: 'the endpoints' })

  const state = github()
  state.repos['acme/billing'].prs.push(
    { branch: 'feat/sliced-two', number: 11, state: 'OPEN', url: 'https://github.com/acme/billing/pull/11', base: 'feat/sliced-one', openedAt: '2026-09-19T00:00:00Z', mergedAt: null, commits: [] },
    { branch: 'feat/sliced-one', number: 10, state: 'MERGED', url: 'https://github.com/acme/billing/pull/10', base: 'feat/sliced-work', openedAt: '2026-09-18T00:00:00Z', mergedAt: '2026-09-18T12:00:00Z', commits: [] },
  )
  setGithub(state)
}
