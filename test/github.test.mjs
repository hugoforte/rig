// The GitHub module is the seam between rig and `gh`. Two adapters satisfy the same
// interface: `githubViaGh` shells out (its `exec` is injected here so the output
// parsers run without gh), and `githubInMemory` holds canned repos, PRs and issues.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { githubViaGh, githubInMemory, GithubError } from '../bin/github.mjs'
import { NO_PROMPT_ENV } from '../bin/remote-env.mjs'

// A canned `gh`: `reply(args)` returns stdout, or a { code, err } object.
const canned = reply => {
  const calls = []
  const exec = args => {
    calls.push(args)
    const r = reply(args)
    return typeof r === 'string' ? { status: 0, stdout: r, stderr: '' } : { status: r.code, stdout: r.out || '', stderr: r.err || '' }
  }
  return { calls, github: githubViaGh({ exec }) }
}

test('gh adapter: createIssue reads the issue number from the URL gh prints', () => {
  const { calls, github } = canned(() => 'https://github.com/acme/platform/issues/12\n')
  assert.equal(github.createIssue('acme/platform', 'A title', 'A body'), 12)
  assert.deepEqual(calls[0], ['issue', 'create', '--repo', 'acme/platform', '--title', 'A title', '--body', 'A body'])
})

test('gh adapter: createIssue says the issue may have been created when its answer has no issue URL', () => {
  // gh exited 0, so the issue exists whether or not its answer can be read, and a retry would
  // make a second one (DESIGN.md decision 172, the twin of 150).
  const { github } = canned(() => 'Creating issue in acme/platform\n')
  assert.throws(() => github.createIssue('acme/platform', 'A title', 'b'),
    /gh exited 0 but rig could not read the new issue's number from its answer, so the issue may have been created\. Search acme\/platform for "A title" before retrying, then record it on this work with `rig ticket acme\/platform#<n> --work <id>`\.\ngh's answer:\nCreating issue in acme\/platform/)
})

test('gh adapter: createIssue fails with gh\'s own error when gh fails', () => {
  const { github } = canned(() => ({ code: 1, err: 'GraphQL: Resource not accessible' }))
  assert.throws(() => github.createIssue('acme/platform', 't', 'b'), /Resource not accessible/)
})

test('gh adapter: prForBranch parses the newest PR from gh\'s JSON', () => {
  const { calls, github } = canned(() => '[{"number":12,"state":"MERGED","baseRefName":"main","headRefOid":"abc123","mergeCommit":{"oid":"def456"},"url":"https://github.com/acme/platform/pull/12","createdAt":"2026-01-02T00:00:00Z","mergedAt":"2026-01-03T00:00:00Z","title":"A title","body":"A body","labels":[{"id":"L1","name":"release:minor","color":"0e8a16"}]}]')
  assert.deepEqual(github.prForBranch('acme', 'platform', 'feat/x'),
    { number: 12, state: 'MERGED', base: 'main', head: 'abc123', merge: 'def456', url: 'https://github.com/acme/platform/pull/12',
      openedAt: '2026-01-02T00:00:00Z', mergedAt: '2026-01-03T00:00:00Z', title: 'A title', body: 'A body', labels: ['release:minor'] })
  assert.deepEqual(calls[0], ['pr', 'list', '--repo', 'acme/platform', '--head', 'feat/x',
    '--state', 'all', '--json', 'number,state,baseRefName,headRefOid,mergeCommit,url,createdAt,mergedAt,title,body,labels', '--limit', '1'])
})

test('gh adapter: labels lists the names of every label a repo has, across pages', () => {
  const { calls, github } = canned(() => 'bug\nrelease:minor\n')
  assert.deepEqual(github.labels('acme', 'platform'), ['bug', 'release:minor'])
  assert.deepEqual(calls[0], ['api', 'repos/acme/platform/labels', '--paginate', '--jq', '.[].name'])
})

test('gh adapter: a repo with no labels has none, and one gh cannot list for throws', () => {
  assert.deepEqual(canned(() => '').github.labels('acme', 'platform'), [])
  assert.throws(() => canned(() => ({ code: 1, err: 'gh: Bad credentials (HTTP 401)' })).github.labels('acme', 'platform'), GithubError)
})

test("gh adapter: editPr rewrites a PR's title and body by number", () => {
  const { calls, github } = canned(() => 'https://github.com/acme/platform/pull/12\n')
  github.editPr('acme', 'platform', 12, { title: 'New title', body: 'New body' })
  assert.deepEqual(calls[0], ['pr', 'edit', '12', '--repo', 'acme/platform', '--title', 'New title', '--body', 'New body'])
})

test("gh adapter: editPr fails with gh's own error when gh fails", () => {
  const { github } = canned(() => ({ code: 1, err: 'GraphQL: Resource not accessible' }))
  assert.throws(() => github.editPr('acme', 'platform', 12, { title: 't', body: 'b' }), /Resource not accessible/)
})

test('gh adapter: an open PR has no merge commit', () => {
  const { github } = canned(() => '[{"number":12,"state":"OPEN","mergeCommit":null,"url":"u","createdAt":"2026-01-02T00:00:00Z","mergedAt":null}]')
  assert.equal(github.prForBranch('acme', 'platform', 'feat/x').merge, null)
})

test('gh adapter: prForBranch answers the base the PR lands on now, in the same call', () => {
  // A PR repointed at another PR's branch: the base rig recorded at `rig attach` is `main`
  // and this is what makes the stack visible without a second round trip.
  const { calls, github } = canned(() => '[{"number":12,"state":"OPEN","baseRefName":"feat/other-work","url":"u","createdAt":"2026-01-02T00:00:00Z","mergedAt":null}]')
  assert.equal(github.prForBranch('acme', 'platform', 'feat/x').base, 'feat/other-work')
  assert.equal(calls.length, 1, 'the base rides along with the PR state')
})

test('gh adapter: a PR gh answered for without a base reads as no base, not undefined', () => {
  const { github } = canned(() => '[{"number":12,"state":"OPEN","url":"u","createdAt":"2026-01-02T00:00:00Z","mergedAt":null}]')
  assert.equal(github.prForBranch('acme', 'platform', 'feat/x').base, null)
})

test('gh adapter: an open PR has no mergedAt', () => {
  const { github } = canned(() => '[{"number":12,"state":"OPEN","url":"u","createdAt":"2026-01-02T00:00:00Z","mergedAt":null}]')
  assert.equal(github.prForBranch('acme', 'platform', 'feat/x').mergedAt, null)
})

test('gh adapter: prTimeline asks the PR, not the branch, and takes commits and reviews in one call', () => {
  const { calls, github } = canned(() =>
    '{"firstCommitAt":"2026-01-01T09:00:00Z","firstReviewAt":"2026-01-02T10:00:00Z","approvedAt":null}')
  assert.deepEqual(github.prTimeline('acme', 'platform', 12),
    { firstCommitAt: '2026-01-01T09:00:00Z', firstReviewAt: '2026-01-02T10:00:00Z', approvedAt: null })
  assert.equal(calls.length, 1, 'one round trip, not one per field')
  assert.deepEqual(calls[0].slice(0, 7), ['pr', 'view', '12', '--repo', 'acme/platform', '--json', 'commits,reviews'])
  assert.match(calls[0][8], /select\(\.submittedAt != null\)/, 'a review still being written is not a first look')
})

test('gh adapter: prTimeline throws when gh could not answer, and is null when gh answered nothing', () => {
  const { github } = canned(() => ({ code: 1, err: 'GraphQL: Could not resolve to a PullRequest with the number of 12. (repository.pullRequest)' }))
  assert.throws(() => github.prTimeline('acme', 'platform', 12), e => e instanceof GithubError && /Could not resolve to a PullRequest/.test(e.message))
  assert.equal(canned(() => '').github.prTimeline('acme', 'platform', 12), null)
})

test('gh adapter: prReview adds up the unresolved threads on every page and reads the checks off the first', () => {
  const { calls, github } = canned(() => '2 PENDING\n0 PENDING\n1 PENDING\n')
  assert.deepEqual(github.prReview('acme', 'platform', 12), { unresolved: 3, checks: 'PENDING' })
  assert.deepEqual(calls[0].slice(0, 3), ['api', 'graphql', '--paginate'])
  assert.match(calls[0].find(a => a.startsWith('query=')), /\$endCursor: String/, 'pagination walks the cursor')
  assert.match(calls[0].find(a => a.startsWith('query=')), /statusCheckRollup \{ state \}/)
})

test('gh adapter: prReview sends owner and name as strings, so a repo named 2048 is not a number', () => {
  const { calls, github } = canned(() => '0 SUCCESS\n')
  github.prReview('acme', '2048', 12)
  const flagOf = value => calls[0][calls[0].indexOf(value) - 1]
  assert.equal(flagOf('owner=acme'), '-f')
  assert.equal(flagOf('name=2048'), '-f')
  assert.equal(flagOf('number=12'), '-F', 'the number stays typed: the query takes an Int!')
})

test('gh adapter: prReview is null when gh cannot answer, and says no checks where none are set up', () => {
  assert.equal(canned(() => ({ code: 1, err: 'no such PR' })).github.prReview('acme', 'platform', 12), null)
  assert.equal(canned(() => 'oops').github.prReview('acme', 'platform', 12), null)
  assert.equal(canned(() => '3\n').github.prReview('acme', 'platform', 12), null, 'a line without its rollup is not read')
  assert.deepEqual(canned(() => '0 NONE\n').github.prReview('acme', 'platform', 12), { unresolved: 0, checks: null })
})

test('gh adapter: prForBranch is null when there is no PR', () => {
  const { github } = canned(() => '[]')
  assert.equal(github.prForBranch('acme', 'platform', 'feat/x'), null)
})

test('gh adapter: prForBranch throws when gh exits non-zero', () => {
  // A branch with no PR is `[]` and exit 0; anything non-zero is gh failing to answer, and must
  // never read as "no PR" (DESIGN.md decision 169).
  for (const err of ['HTTP 401: Bad credentials (https://api.github.com/graphql)', 'Post "https://api.github.com/graphql": dial tcp: connection refused']) {
    const { github } = canned(() => ({ code: 1, err }))
    assert.throws(() => github.prForBranch('acme', 'platform', 'feat/x'), e => e instanceof GithubError && e.message.includes(err))
  }
})

test('gh adapter: prForBranch fails as a GithubError, not a TypeError, when gh prints a non-array', () => {
  const { github } = canned(() => '{"message":"unexpected"}')
  assert.throws(() => github.prForBranch('acme', 'platform', 'feat/x'), GithubError)
  assert.throws(() => github.prForBranch('acme', 'platform', 'feat/x'), /gh pr list.*not a list/)
})

test('gh adapter: repo returns GitHub\'s canonical name, language and visibility', () => {
  const { calls, github } = canned(() => '{"name":"Platform","language":"TypeScript","visibility":"public"}')
  assert.deepEqual(github.repo('acme', 'platform'), { name: 'Platform', language: 'TypeScript', visibility: 'public' })
  assert.deepEqual(calls[0], ['api', 'repos/acme/platform', '--jq', '{name,language,visibility}'])
})

test('gh adapter: a repo GitHub names no visibility for reads as unknown, not as private', () => {
  const { github } = canned(() => '{"name":"Platform","language":"TypeScript"}')
  assert.equal(github.repo('acme', 'platform').visibility, null)
})

test('gh adapter: repo is null on HTTP 404 and throws when gh could not answer', () => {
  // The wording gh 2.83 gives for each, captured 2026-10-01.
  assert.equal(canned(() => ({ code: 1, err: 'gh: Not Found (HTTP 404)' })).github.repo('acme', 'nope'), null)
  for (const r of [
    { code: 1, err: 'gh: Bad credentials (HTTP 401)' },
    { code: 4, err: 'To get started with GitHub CLI, please run:  gh auth login' },
    { code: 1, err: 'Get "https://api.github.com/repos/acme/nope": proxyconnect tcp: dial tcp 127.0.0.1:9: connectex: No connection could be made because the target machine actively refused it.' },
  ]) assert.throws(() => canned(() => r).github.repo('acme', 'nope'), e => e instanceof GithubError && e.message.includes(r.err))
})

test('gh adapter: auth is "missing" when gh cannot be spawned', () => {
  assert.equal(githubViaGh({ exec: () => ({ error: new Error('ENOENT') }) }).auth(), 'missing')
})

test('gh adapter: auth is "unauthenticated" when gh auth status fails', () => {
  assert.equal(canned(() => ({ code: 1, err: 'not logged in' })).github.auth(), 'unauthenticated')
})

test('gh adapter: auth is "ok" when gh auth status succeeds', () => {
  assert.equal(canned(() => 'Logged in').github.auth(), 'ok')
})

test('gh adapter: every other call fails when gh is missing', () => {
  const github = githubViaGh({ exec: () => ({ error: new Error('spawn gh ENOENT') }) })
  assert.throws(() => github.repo('acme', 'platform'), /gh not found on PATH/)
})

test('gh adapter: a failed write surfaces the whole of gh\'s stderr, not just its first line', () => {
  // `gh repo clone` streams git, whose first stderr line is "Cloning into ..." and whose
  // cause ("fatal: ...") comes later; truncating to one line would hide it.
  const { github } = canned(() => ({ code: 1, err: "Cloning into 'x'...\nfatal: could not read Username" }))
  assert.throws(() => github.clone('acme/rig-data', 'x'), /gh repo clone: Cloning into 'x'\.\.\.\nfatal: could not read Username/)
  assert.throws(() => github.closeIssue('acme/platform', 3), /gh issue close: Cloning into/)
})

test('gh adapter: repoExists is false on HTTP 404 and throws when gh could not answer', () => {
  const { calls, github } = canned(() => 'rig-data')
  assert.equal(github.repoExists('acme/rig-data'), true)
  assert.deepEqual(calls[0], ['api', 'repos/acme/rig-data', '--jq', '.name'])
  assert.equal(canned(() => ({ code: 1, err: 'gh: Not Found (HTTP 404)' })).github.repoExists('acme/rig-data'), false)
  assert.throws(() => canned(() => ({ code: 4, err: 'To get started with GitHub CLI, please run:  gh auth login' })).github.repoExists('acme/rig-data'), GithubError)
})

test('gh adapter: prsOnto and pullsForCommit throw when gh could not answer, and answer none only when gh says so', () => {
  const { github } = canned(() => ({ code: 1, err: 'gh: Bad credentials (HTTP 401)' }))
  assert.throws(() => github.prsOnto('acme', 'platform', 'feat/x'), GithubError)
  assert.throws(() => github.pullsForCommit('acme', 'platform', 'abc123'), GithubError)
  assert.deepEqual(canned(() => '[]').github.prsOnto('acme', 'platform', 'feat/x'), [])
  assert.deepEqual(canned(() => '[]').github.pullsForCommit('acme', 'platform', 'abc123'), [])
})

test('gh adapter: clone and createRepo pass the right argv and fail on error', () => {
  const { calls, github } = canned(() => '')
  github.clone('acme/rig-data', '/tmp/rig-data')
  github.createRepo('acme/rig-data', { source: '/tmp/rig-data', description: 'd' })
  assert.deepEqual(calls, [
    ['repo', 'clone', 'acme/rig-data', '/tmp/rig-data'],
    ['repo', 'create', 'acme/rig-data', '--private', '--source', '/tmp/rig-data', '--push', '--description', 'd'],
  ])
  const failing = canned(() => ({ code: 1, err: 'HTTP 403: no permission' })).github
  assert.throws(() => failing.createRepo('acme/rig-data', { source: '/tmp/x', description: 'd' }), /no permission/)
})

test('gh adapter: clone and createRepo never stop to ask for credentials', () => {
  const envs = []
  const github = githubViaGh({ exec: (args, opts = {}) => { envs.push(opts.env); return { status: 0, stdout: '', stderr: '' } } })
  github.clone('acme/rig-data', '/tmp/rig-data')
  github.createRepo('acme/rig-data', { source: '/tmp/rig-data', description: 'd' })
  assert.deepEqual(envs, [NO_PROMPT_ENV, NO_PROMPT_ENV])
})

const world = () => ({
  auth: 'ok',
  repos: {
    'acme/Platform': {
      language: 'TypeScript',
      prs: [{ branch: 'feat/x', number: 12, state: 'MERGED', url: 'https://github.com/acme/Platform/pull/12' }],
      issues: [{ number: 3, title: 'Existing', body: '', state: 'OPEN', comments: [] }],
    },
  },
})

test('in-memory adapter: repo matches case-insensitively and returns the canonical name', () => {
  const github = githubInMemory(world())
  assert.deepEqual(github.repo('acme', 'platform'), { name: 'Platform', language: 'TypeScript', visibility: null })
  assert.equal(github.repo('acme', 'nope'), null)
})

test('in-memory adapter: repo answers the visibility a fixture gives it', () => {
  const state = world()
  state.repos['acme/Platform'].visibility = 'private'
  assert.equal(githubInMemory(state).repo('acme', 'platform').visibility, 'private')
})

test('in-memory adapter: prTimeline answers the earliest commit, first look and approval', () => {
  const state = { repos: { 'acme/platform': { prs: [{
    branch: 'feat/x', number: 12, state: 'OPEN',
    commits: ['2026-01-04T00:00:00Z', '2026-01-02T00:00:00Z'],
    reviews: [
      { state: 'APPROVED', submittedAt: '2026-01-06T00:00:00Z' },
      { state: 'COMMENTED', submittedAt: '2026-01-05T00:00:00Z' },
      { state: 'PENDING', submittedAt: null },
    ],
  }] } } }
  assert.deepEqual(githubInMemory(state).prTimeline('acme', 'platform', 12), {
    firstCommitAt: '2026-01-02T00:00:00Z',
    firstReviewAt: '2026-01-05T00:00:00Z',
    approvedAt: '2026-01-06T00:00:00Z',
  })
  assert.equal(githubInMemory(state).prTimeline('acme', 'platform', 99), null, 'no such PR')
})

test('in-memory adapter: prTimeline on a PR with no reviews dates the commit and nothing else', () => {
  const state = { repos: { 'acme/platform': { prs: [{ branch: 'feat/x', number: 12, commits: ['2026-01-02T00:00:00Z'] }] } } }
  assert.deepEqual(githubInMemory(state).prTimeline('acme', 'platform', 12),
    { firstCommitAt: '2026-01-02T00:00:00Z', firstReviewAt: null, approvedAt: null })
})

test('in-memory adapter: prReview counts the fixture threads not resolved, beside its checks', () => {
  const state = { repos: { 'acme/platform': { prs: [
    { branch: 'feat/x', number: 12, checks: 'FAILURE', reviewThreads: [{ resolved: false }, { resolved: true }, { resolved: false }] },
    { branch: 'feat/y', number: 13 },
    { branch: 'feat/z', number: 14, reviewUnknown: true },
  ] } } }
  assert.deepEqual(githubInMemory(state).prReview('acme', 'platform', 12), { unresolved: 2, checks: 'FAILURE' })
  assert.deepEqual(githubInMemory(state).prReview('acme', 'platform', 13), { unresolved: 0, checks: null }, 'no review on it, no checks set up')
  assert.equal(githubInMemory(state).prReview('acme', 'platform', 14), null, 'GitHub would not say')
  assert.equal(githubInMemory(state).prReview('acme', 'platform', 99), null, 'no such PR')
})

test('in-memory adapter: editPr rewrites the title and body prForBranch then reads', () => {
  const github = githubInMemory({ repos: { 'acme/platform': { prs: [{ branch: 'feat/x', number: 12, state: 'OPEN', title: 'Old', body: 'old' }] } } })
  github.editPr('acme', 'platform', 12, { title: 'New', body: 'new' })
  const pr = github.prForBranch('acme', 'platform', 'feat/x')
  assert.deepEqual([pr.title, pr.body], ['New', 'new'])
})

test('in-memory adapter: editPr refuses a pull request that does not exist', () => {
  const github = githubInMemory({ repos: { 'acme/platform': { prs: [] } } })
  assert.throws(() => github.editPr('acme', 'platform', 12, { title: 't', body: 'b' }), /no such pull request/)
})

test('in-memory adapter: prForBranch finds the PR by branch', () => {
  const github = githubInMemory(world())
  assert.equal(github.prForBranch('acme', 'platform', 'feat/x').number, 12)
  assert.equal(github.prForBranch('acme', 'platform', 'feat/other'), null)
})

test('in-memory adapter: labels answers what a fixture gives a repo and its PRs', () => {
  const state = world()
  state.repos['acme/Platform'].labels = ['release:patch']
  state.repos['acme/Platform'].prs[0].labels = ['release:minor']
  const github = githubInMemory(state)
  assert.deepEqual(github.labels('acme', 'platform'), ['release:patch'])
  assert.deepEqual(github.prForBranch('acme', 'platform', 'feat/x').labels, ['release:minor'])
  assert.throws(() => githubInMemory(world()).labels('acme', 'platform'), GithubError, 'a fixture that gives none is one GitHub would not list')
})

test('in-memory adapter: prForBranch carries the base a seeded PR lands on', () => {
  // The fixture field is `base`, as `branch` and `openedAt` are: the in-memory world speaks
  // the interface's language, and `baseRefName` is gh's name for it in the adapter above.
  const state = world()
  assert.equal(githubInMemory(state).prForBranch('acme', 'platform', 'feat/x').base, null, 'no base seeded')
  state.repos['acme/Platform'].prs[0].base = 'feat/other-work'
  assert.equal(githubInMemory(state).prForBranch('acme', 'platform', 'feat/x').base, 'feat/other-work')
})

test('in-memory adapter: prForBranch answers the newest PR on a branch, as gh --limit 1 does', () => {
  // A closed PR re-opened as a new one: the close safety check must see the open one.
  const state = world()
  state.repos['acme/Platform'].prs = [
    { branch: 'feat/x', number: 5, state: 'CLOSED', url: 'u5' },
    { branch: 'feat/x', number: 9, state: 'OPEN', url: 'u9' },
  ]
  assert.equal(githubInMemory(state).prForBranch('acme', 'platform', 'feat/x').number, 9)
})

test('in-memory adapter: createIssue numbers after the highest existing issue and records it', () => {
  const state = world()
  const github = githubInMemory(state)
  assert.equal(github.createIssue('acme/Platform', 'New', 'body'), 4)
  assert.deepEqual(state.repos['acme/Platform'].issues[1], { number: 4, title: 'New', body: 'body', state: 'OPEN', comments: [] })
})

test('in-memory adapter: commentIssue and closeIssue mutate the issue; unknown issues fail', () => {
  const state = world()
  const github = githubInMemory(state)
  github.commentIssue('acme/Platform', 3, 'done')
  github.closeIssue('acme/Platform', 3)
  assert.deepEqual(state.repos['acme/Platform'].issues[0].comments, ['done'])
  assert.equal(state.repos['acme/Platform'].issues[0].state, 'CLOSED')
  assert.throws(() => github.commentIssue('acme/Platform', 99, 'x'), /acme\/Platform#99/)
})

test('in-memory adapter: commentIssue tolerates a seeded issue with no comments array', () => {
  const state = world()
  state.repos['acme/Platform'].issues = [{ number: 3, title: 'Bare', body: '', state: 'OPEN' }]
  githubInMemory(state).commentIssue('acme/Platform', 3, 'done')
  assert.deepEqual(state.repos['acme/Platform'].issues[0].comments, ['done'])
})

test('in-memory adapter: clone names the missing `source` when the repo exists but has none', () => {
  const state = world()
  state.repos['acme/rig-data'] = {}
  assert.throws(() => githubInMemory(state).clone('acme/rig-data', '/tmp/y'), /acme\/rig-data.*no `source`/)
})

test('in-memory adapter: with gh "missing", every call but auth fails as the real one would', () => {
  const github = githubInMemory({ ...world(), auth: 'missing' })
  assert.equal(github.auth(), 'missing')
  assert.throws(() => github.repo('acme', 'platform'), /gh not found on PATH/)
})

test('in-memory adapter: when "unauthenticated", lookups and writes throw, as with the real gh', () => {
  const github = githubInMemory({ ...world(), auth: 'unauthenticated' })
  for (const call of [
    () => github.repo('acme', 'platform'),
    () => github.repoExists('acme/Platform'),
    () => github.prForBranch('acme', 'Platform', 'feat/x'),
    () => github.prTimeline('acme', 'Platform', 12),
    () => github.labels('acme', 'Platform'),
    () => github.stacks('acme', 'Platform'),
    () => github.prsOnto('acme', 'Platform', 'main'),
    () => github.pullsForCommit('acme', 'Platform', 'abc'),
    () => github.createIssue('acme/Platform', 't', 'b'),
  ]) assert.throws(call, e => e instanceof GithubError && /not authenticated/.test(e.message))
})

test('in-memory adapter: one branch\'s lookup fails while the rest answer', () => {
  const state = world()
  state.repos['acme/Platform'].branchLookupFails = { 'feat/x': 'HTTP 502: Bad Gateway' }
  state.repos['acme/Platform'].prs.push({ branch: 'feat/y', number: 13, state: 'OPEN', url: 'u' })
  const github = githubInMemory(state)
  assert.throws(() => github.prForBranch('acme', 'Platform', 'feat/x'), e => e instanceof GithubError && /HTTP 502/.test(e.message))
  assert.equal(github.prForBranch('acme', 'Platform', 'feat/y').number, 13)
})

test('in-memory adapter: one repo\'s lookups fail while another\'s answer', () => {
  const state = world()
  state.repos['acme/Platform'].lookupFails = 'HTTP 403: API rate limit exceeded'
  state.repos['acme/Other'] = { prs: [{ branch: 'feat/x', number: 1, state: 'OPEN', url: 'u' }] }
  const github = githubInMemory(state)
  for (const call of [
    () => github.repo('acme', 'platform'),
    () => github.repoExists('acme/Platform'),
    () => github.prForBranch('acme', 'Platform', 'feat/x'),
    () => github.prTimeline('acme', 'Platform', 12),
    () => github.labels('acme', 'Platform'),
    () => github.stacks('acme', 'Platform'),
    () => github.prsOnto('acme', 'Platform', 'main'),
    () => github.pullsForCommit('acme', 'Platform', 'abc'),
  ]) assert.throws(call, e => e instanceof GithubError && /rate limit/.test(e.message))
  assert.equal(github.prForBranch('acme', 'Other', 'feat/x').number, 1)
})

test('in-memory adapter: createRepo makes the repo exist; clone needs it to exist', () => {
  const state = world()
  const github = githubInMemory(state)
  assert.equal(github.repoExists('acme/rig-data'), false)
  github.createRepo('acme/rig-data', { source: '/tmp/x', description: 'd' })
  assert.equal(github.repoExists('acme/rig-data'), true)
  assert.throws(() => github.clone('acme/nope', '/tmp/y'), /acme\/nope/)
})

// ---------------------------------------------------------------- stacks (hugoforte/rig#224)

test('gh adapter: stacks reads every stack a repo has from the REST answer, one per line', () => {
  const { calls, github } = canned(() => '{"base":"feat/work","number":7,"open":true,"prs":[3,4],"openPrs":[4]}\n{"base":"main","number":2,"open":false,"prs":[1],"openPrs":[]}\n')
  assert.deepEqual(github.stacks('acme', 'platform'), [
    { number: 7, open: true, base: 'feat/work', prs: [3, 4], openPrs: [4] },
    { number: 2, open: false, base: 'main', prs: [1], openPrs: [] },
  ])
  assert.deepEqual(calls[0], ['api', 'repos/acme/platform/stacks', '--paginate', '--jq',
    '.[] | {number, open, base: .base.ref, prs: [.pull_requests[].number], openPrs: [.pull_requests[] | select(.state == "open") | .number]}'])
})

test('gh adapter: a repo with no stacks has none, and one GitHub would not list them for throws', () => {
  assert.deepEqual(canned(() => '').github.stacks('acme', 'platform'), [])
  assert.throws(() => canned(() => ({ code: 1, err: 'gh: Not Found (HTTP 404)' })).github.stacks('acme', 'platform'), GithubError)
})

test('gh adapter: linkStack links pull requests by URL onto the base, for the repo it names', () => {
  const calls = []
  const github = githubViaGh({ exec: (args, opts) => { calls.push({ args, env: opts?.env }); return { status: 0, stdout: '', stderr: '' } } })
  const urls = ['https://github.com/acme/platform/pull/3', 'https://github.com/acme/platform/pull/4']
  github.linkStack('acme', 'platform', { base: 'feat/work', urls })
  assert.deepEqual(calls, [{ args: ['stack', 'link', '--base', 'feat/work', ...urls], env: { GH_REPO: 'acme/platform' } }])
})

test('gh adapter: linkStack fails with gh stack\'s own error', () => {
  const { github } = canned(() => ({ code: 4, err: 'failed to look up PR #3' }))
  assert.throws(() => github.linkStack('acme', 'platform', { base: 'feat/work', urls: [] }), e => e instanceof GithubError && /failed to look up PR #3/.test(e.message))
})

test('gh adapter: mergeStack merges up to the PR with a merge commit, unprompted, for the repo it names', () => {
  const calls = []
  const github = githubViaGh({ exec: (args, opts) => { calls.push({ args, env: opts?.env }); return { status: 0, stdout: '', stderr: '' } } })
  github.mergeStack('acme', 'platform', 4)
  assert.deepEqual(calls, [{ args: ['stack', 'merge', '4', '--merge', '--yes'], env: { GH_REPO: 'acme/platform' } }])
})

test('gh adapter: mergePr merges the PR with a merge commit', () => {
  const { calls, github } = canned(() => '')
  github.mergePr('acme', 'platform', 4)
  assert.deepEqual(calls[0], ['pr', 'merge', '4', '--repo', 'acme/platform', '--merge'])
})

test('gh adapter: a merge GitHub refuses fails with gh\'s own error', () => {
  const { github } = canned(() => ({ code: 1, err: 'Pull request #4 is not mergeable' }))
  assert.throws(() => github.mergeStack('acme', 'platform', 4), e => e instanceof GithubError && /not mergeable/.test(e.message))
  assert.throws(() => github.mergePr('acme', 'platform', 4), e => e instanceof GithubError && /not mergeable/.test(e.message))
})

test('gh adapter: prReadiness reads the draft, the review decision, the open review requests, conflicts, the head and the checks', () => {
  const { calls, github } = canned(() => '{"draft":false,"decision":"APPROVED","requested":1,"mergeable":"MERGEABLE","head":"abc123","checks":"SUCCESS"}')
  assert.deepEqual(github.prReadiness('acme', 'platform', 12), { draft: false, decision: 'APPROVED', requested: 1, mergeable: 'MERGEABLE', head: 'abc123', checks: 'SUCCESS' })
  assert.deepEqual(calls[0].slice(0, 2), ['api', 'graphql'])
})

test('gh adapter: prReadiness counts only the review requests someone made, not a code owner\'s', () => {
  const { calls, github } = canned(() => '{"draft":false,"decision":null,"requested":0,"mergeable":"MERGEABLE","head":"abc123","checks":null}')
  github.prReadiness('acme', 'platform', 12)
  assert.match(calls[0].find(a => a.startsWith('query=')), /reviewRequests\(first: 100\) \{ nodes \{ asCodeOwner \} \}/)
  assert.match(calls[0][calls[0].indexOf('--jq') + 1], /select\(\.asCodeOwner \| not\)/)
})

test('gh adapter: prReadiness is null when gh cannot answer, and says no checks where none are set up', () => {
  assert.equal(canned(() => ({ code: 1, err: 'no such PR' })).github.prReadiness('acme', 'platform', 12), null)
  assert.equal(canned(() => 'oops').github.prReadiness('acme', 'platform', 12), null)
  assert.equal(canned(() => 'null').github.prReadiness('acme', 'platform', 12), null)
  assert.deepEqual(canned(() => '{"draft":true,"decision":null,"requested":0,"mergeable":null,"head":null,"checks":null}').github.prReadiness('acme', 'platform', 12),
    { draft: true, decision: null, requested: 0, mergeable: null, head: null, checks: null })
})

test('gh adapter: mergePr given the head that was checked merges only while the PR is still at it', () => {
  const { calls, github } = canned(() => '')
  github.mergePr('acme', 'platform', 4, { head: 'abc123' })
  assert.deepEqual(calls[0], ['pr', 'merge', '4', '--repo', 'acme/platform', '--merge', '--match-head-commit', 'abc123'])
})

test('gh adapter: stackTool asks for the subcommand it is told, link by default', () => {
  assert.equal(canned(() => 'Remote operations:\n  link        Link PRs\n').github.stackTool('merge'), 'old')
  assert.equal(canned(() => 'Remote operations:\n  merge       Merge a stack\n').github.stackTool('merge'), 'ok')
})

test('in-memory adapter: mergeStack merges the stack up to the PR and leaves the rest open', () => {
  const state = { repos: { 'acme/platform': { prs: [3, 4, 5].map(n => ({ branch: `s${n}`, number: n, state: 'OPEN' })), stacks: [{ number: 9, open: true, base: 'feat/work', prs: [3, 4, 5] }] } } }
  githubInMemory(state).mergeStack('acme', 'platform', 4)
  assert.deepEqual(state.repos['acme/platform'].prs.map(p => p.state), ['MERGED', 'MERGED', 'OPEN'])
  assert.deepEqual(state.merges, [{ repo: 'acme/platform', via: 'stack', number: 4 }])
})

test('in-memory adapter: mergeStack refuses a PR in no open stack, and mergeFails fails it', () => {
  const state = { repos: { 'acme/platform': { prs: [{ branch: 's3', number: 3, state: 'OPEN' }], stacks: [] } } }
  assert.throws(() => githubInMemory(state).mergeStack('acme', 'platform', 3), /not in an open stack/)
  state.mergeFails = 'not mergeable'
  assert.throws(() => githubInMemory(state).mergePr('acme', 'platform', 3), /not mergeable/)
  assert.equal(state.repos['acme/platform'].prs[0].state, 'OPEN')
})

test('in-memory adapter: prReadiness reads the fixture, and is null where GitHub would not say', () => {
  const state = { repos: { 'acme/platform': { prs: [
    { branch: 'a', number: 3, draft: true, reviewDecision: 'CHANGES_REQUESTED', reviewRequests: 2, mergeable: 'CONFLICTING', head: 'abc', checks: 'FAILURE' },
    { branch: 'b', number: 4 },
    { branch: 'c', number: 5, readinessUnknown: true },
  ] } } }
  const github = githubInMemory(state)
  assert.deepEqual(github.prReadiness('acme', 'platform', 3), { draft: true, decision: 'CHANGES_REQUESTED', requested: 2, mergeable: 'CONFLICTING', head: 'abc', checks: 'FAILURE' })
  assert.deepEqual(github.prReadiness('acme', 'platform', 4), { draft: false, decision: null, requested: 0, mergeable: 'MERGEABLE', head: 'head-of-4', checks: null })
  assert.equal(github.prReadiness('acme', 'platform', 5), null)
})

test('in-memory adapter: mergePr refuses a PR in an open stack, as GitHub does', () => {
  const state = { repos: { 'acme/platform': { prs: [{ branch: 's3', number: 3, state: 'OPEN' }], stacks: [{ number: 9, open: true, base: 'feat/work', prs: [3] }] } } }
  assert.throws(() => githubInMemory(state).mergePr('acme', 'platform', 3), /must be merged with the stack/)
  assert.equal(state.repos['acme/platform'].prs[0].state, 'OPEN')
})

test('gh adapter: stackTool tells a missing gh stack from one too old to link', () => {
  assert.equal(canned(() => ({ code: 1, err: 'unknown command "stack" for "gh"' })).github.stackTool(), 'missing')
  assert.equal(canned(() => 'Stack management:\n  add  Add a branch\n  init Initialize\n').github.stackTool(), 'old')
  const { calls, github } = canned(() => 'Remote operations:\n  link        Link PRs into a stack on GitHub\n  merge       Merge a stack\n')
  assert.equal(github.stackTool(), 'ok')
  assert.deepEqual(calls[0], ['stack', '--help'])
})

test('in-memory adapter: linkStack makes a stack of the PRs, grows the one that holds any of them, and stacks answers it', () => {
  const state = world()
  const github = githubInMemory(state)
  const url = n => `https://github.com/acme/Platform/pull/${n}`
  github.linkStack('acme', 'Platform', { base: 'feat/work', urls: [url(3), url(4)] })
  github.linkStack('acme', 'Platform', { base: 'feat/work', urls: [url(3), url(4), url(5)] })
  const [stack] = github.stacks('acme', 'Platform')
  assert.deepEqual({ ...stack, number: 0 }, { number: 0, open: true, base: 'feat/work', prs: [3, 4, 5], openPrs: [] })
  assert.equal(github.stacks('acme', 'Platform').length, 1)
})

test('in-memory adapter: stackTool answers what the state says gh stack is', () => {
  assert.equal(githubInMemory(world()).stackTool(), 'ok')
  assert.equal(githubInMemory({ ...world(), ghStack: 'missing' }).stackTool(), 'missing')
  assert.equal(githubInMemory({ ...world(), ghStack: 'old' }).stackTool(), 'old')
})
