// The GitHub module is the seam between rig and `gh`. Two adapters satisfy the same
// interface: `githubViaGh` shells out (its `exec` is injected here so the output
// parsers run without gh), and `githubInMemory` holds canned repos, PRs and issues.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { githubViaGh, githubInMemory } from '../bin/github.mjs'

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

test('gh adapter: createIssue fails loudly when no issue URL is printed', () => {
  const { github } = canned(() => 'Creating issue in acme/platform\n')
  assert.throws(() => github.createIssue('acme/platform', 't', 'b'), /could not read the issue number/)
})

test('gh adapter: createIssue fails with gh\'s own error when gh fails', () => {
  const { github } = canned(() => ({ code: 1, err: 'GraphQL: Resource not accessible' }))
  assert.throws(() => github.createIssue('acme/platform', 't', 'b'), /Resource not accessible/)
})

test('gh adapter: prForBranch parses the newest PR from gh\'s JSON', () => {
  const { calls, github } = canned(() => '[{"number":12,"state":"MERGED","url":"https://github.com/acme/platform/pull/12"}]')
  assert.deepEqual(github.prForBranch('acme', 'platform', 'feat/x'),
    { number: 12, state: 'MERGED', url: 'https://github.com/acme/platform/pull/12' })
  assert.deepEqual(calls[0], ['pr', 'list', '--repo', 'acme/platform', '--head', 'feat/x',
    '--state', 'all', '--json', 'number,state,url', '--limit', '1'])
})

test('gh adapter: prForBranch is null when there is no PR', () => {
  const { github } = canned(() => '[]')
  assert.equal(github.prForBranch('acme', 'platform', 'feat/x'), null)
})

test('gh adapter: prForBranch is null when gh cannot answer', () => {
  const { github } = canned(() => ({ code: 1, err: 'HTTP 401: Bad credentials' }))
  assert.equal(github.prForBranch('acme', 'platform', 'feat/x'), null)
})

test('gh adapter: repo returns GitHub\'s canonical name and language', () => {
  const { github } = canned(() => '{"name":"Platform","language":"TypeScript"}')
  assert.deepEqual(github.repo('acme', 'platform'), { name: 'Platform', language: 'TypeScript' })
})

test('gh adapter: repo is null when GitHub has no such repo', () => {
  const { github } = canned(() => ({ code: 1, err: 'HTTP 404: Not Found' }))
  assert.equal(github.repo('acme', 'nope'), null)
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

test('gh adapter: commentIssue and closeIssue surface gh\'s first error line', () => {
  const { github } = canned(() => ({ code: 1, err: 'HTTP 403: Forbidden\nmore detail' }))
  assert.throws(() => github.commentIssue('acme/platform', 3, 'hi'), /gh issue comment: HTTP 403: Forbidden$/)
  assert.throws(() => github.closeIssue('acme/platform', 3), /HTTP 403: Forbidden/)
})

test('gh adapter: repoExists follows gh repo view\'s exit code', () => {
  assert.equal(canned(() => '{"name":"rig-data"}').github.repoExists('acme/rig-data'), true)
  assert.equal(canned(() => ({ code: 1, err: 'Could not resolve' })).github.repoExists('acme/rig-data'), false)
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
  assert.deepEqual(github.repo('acme', 'platform'), { name: 'Platform', language: 'TypeScript' })
  assert.equal(github.repo('acme', 'nope'), null)
})

test('in-memory adapter: prForBranch finds the PR by branch', () => {
  const github = githubInMemory(world())
  assert.equal(github.prForBranch('acme', 'platform', 'feat/x').number, 12)
  assert.equal(github.prForBranch('acme', 'platform', 'feat/other'), null)
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

test('in-memory adapter: with gh "missing", every call but auth fails as the real one would', () => {
  const github = githubInMemory({ ...world(), auth: 'missing' })
  assert.equal(github.auth(), 'missing')
  assert.throws(() => github.repo('acme', 'platform'), /gh not found on PATH/)
})

test('in-memory adapter: when "unauthenticated", lookups answer null and writes fail, as with the real gh', () => {
  const github = githubInMemory({ ...world(), auth: 'unauthenticated' })
  assert.equal(github.repo('acme', 'platform'), null)
  assert.equal(github.repoExists('acme/Platform'), false)
  assert.throws(() => github.createIssue('acme/Platform', 't', 'b'), /not authenticated/)
})

test('in-memory adapter: createRepo makes the repo exist; clone needs it to exist', () => {
  const state = world()
  const github = githubInMemory(state)
  assert.equal(github.repoExists('acme/rig-data'), false)
  github.createRepo('acme/rig-data', { source: '/tmp/x', description: 'd' })
  assert.equal(github.repoExists('acme/rig-data'), true)
  assert.throws(() => github.clone('acme/nope', '/tmp/y'), /acme\/nope/)
})
