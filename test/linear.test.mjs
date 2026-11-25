// The Linear module is the seam between rig and Linear's GraphQL API, the way bin/jira.mjs is
// twg's: one interface, two adapters. `linearViaApi`'s `post` is injected, so every query and
// every answer it reads runs here with no network; `linearInMemory` holds canned issues for the
// CLI tests. The answers below are shaped as Linear's API documents them; no test calls Linear.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linearViaApi, linearInMemory, linearApiKey, postViaNode, LINEAR_API } from '../bin/linear.mjs'
import { TrackerError } from '../bin/errors.mjs'

const KEY = 'lin_api_test_not_a_real_key'

// A GraphQL server in a function: `reply(payload)` answers each post with `data`, an
// `{ errors }` body, or a `{ status }` of its own.
const canned = (reply, { apiKey = KEY } = {}) => {
  const calls = []
  const post = (payload, key) => {
    calls.push({ payload, key })
    const r = reply(payload)
    if (r.error) return { error: r.error }
    return { status: r.status ?? 200, text: r.text ?? JSON.stringify(r.body ?? { data: r }) }
  }
  return { calls, linear: linearViaApi({ post, apiKey: () => apiKey }) }
}

test('linear adapter: present is whether there is an API key, and asks Linear nothing', () => {
  const { calls, linear } = canned(() => ({}))
  assert.equal(linear.present(), true)
  assert.equal(canned(() => ({}), { apiKey: null }).linear.present(), false)
  assert.equal(calls.length, 0)
})

test('linear adapter: getIssue reads the title and description of the issue its key names', () => {
  const { calls, linear } = canned(() => ({ issue: { identifier: 'ABC-12', title: 'A bug', description: 'Steps to reproduce' } }))
  assert.deepEqual(linear.getIssue('ABC-12'), { title: 'A bug', body: 'Steps to reproduce' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].payload.query, /issue\(id: \$id\)/)
  assert.deepEqual(calls[0].payload.variables, { id: 'ABC-12' })
  assert.equal(calls[0].key, KEY, 'the key goes to the transport, which puts it in the Authorization header')
})

test('linear adapter: getIssue reads an issue with no description as an empty body', () => {
  const { linear } = canned(() => ({ issue: { identifier: 'ABC-1', title: 'Only a title', description: null } }))
  assert.deepEqual(linear.getIssue('ABC-1'), { title: 'Only a title', body: '' })
})

test('linear adapter: commentIssue finds the issue, then comments on it by its id, as markdown', () => {
  const { calls, linear } = canned(p => /commentCreate/.test(p.query)
    ? { commentCreate: { success: true } }
    : { issue: { id: '7f1c0b9e-uuid', identifier: 'ABC-12' } })
  linear.commentIssue('ABC-12', '`rig close` ran.\n\n- rig: https://example.invalid/pull/1')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].payload.variables, { id: 'ABC-12' })
  assert.match(calls[1].payload.query, /commentCreate\(input: \$input\)/)
  assert.deepEqual(calls[1].payload.variables, { input: { issueId: '7f1c0b9e-uuid', body: '`rig close` ran.\n\n- rig: https://example.invalid/pull/1' } })
})

test('linear adapter: a comment Linear does not report a success for fails', () => {
  const { linear } = canned(p => /commentCreate/.test(p.query) ? { commentCreate: { success: false } } : { issue: { id: 'u1' } })
  assert.throws(() => linear.commentIssue('ABC-1', 'body'), /did not create the comment on ABC-1/)
})

test('linear adapter: createIssue finds the team by its key, creates the issue there and answers its key', () => {
  const { calls, linear } = canned(p => /issueCreate/.test(p.query)
    ? { issueCreate: { success: true, issue: { identifier: 'ABC-13', url: 'https://linear.app/x/issue/ABC-13' } } }
    : { teams: { nodes: [{ id: 'team-uuid', key: 'ABC' }] } })
  assert.equal(linear.createIssue({ team: 'ABC', title: 'A title', description: 'The brief' }), 'ABC-13')
  assert.deepEqual(calls[0].payload.variables, { key: 'ABC' })
  assert.deepEqual(calls[1].payload.variables, { input: { teamId: 'team-uuid', title: 'A title', description: 'The brief' } })
})

test('linear adapter: createIssue names the team key it could not find', () => {
  const { calls, linear } = canned(() => ({ teams: { nodes: [] } }))
  assert.throws(() => linear.createIssue({ team: 'NOPE', title: 't', description: 'd' }), /no Linear team has the key NOPE/)
  assert.equal(calls.length, 1, 'nothing is created')
})

test('linear adapter: createIssue says the issue may exist when Linear answers no key', () => {
  const { linear } = canned(p => /issueCreate/.test(p.query) ? { issueCreate: { success: true, issue: null } } : { teams: { nodes: [{ id: 't' }] } })
  assert.throws(() => linear.createIssue({ team: 'ABC', title: 'Lost', description: 'd' }), /may have been created.*"Lost"/s)
})

test('linear adapter: a GraphQL error is surfaced with Linear\'s own message', () => {
  const { linear } = canned(() => ({ body: { errors: [{ message: 'Entity not found: Issue' }] } }))
  assert.throws(() => linear.getIssue('ABC-404'), /Entity not found: Issue/)
})

test('linear adapter: every failure is a TrackerError, so a close degrades it to a warning', () => {
  const { linear } = canned(() => ({ body: { errors: [{ message: 'nope' }] } }))
  assert.throws(() => linear.getIssue('ABC-1'), TrackerError)
})

test('linear adapter: a refused key says so, and never repeats the key', () => {
  const { linear } = canned(() => ({ status: 401, text: '{"errors":[{"message":"Authentication required, not authenticated"}]}' }))
  assert.throws(() => linear.getIssue('ABC-1'), e => {
    assert.match(e.message, /Linear refused the API key \(HTTP 401\)/)
    assert.ok(!e.message.includes(KEY))
    return true
  })
})

test('linear adapter: an answer that is not JSON fails with its first line', () => {
  const { linear } = canned(() => ({ status: 502, text: '<html>Bad gateway</html>' }))
  assert.throws(() => linear.getIssue('ABC-1'), /HTTP 502.*Bad gateway/)
})

test('linear adapter: Linear out of reach is said as that', () => {
  const { linear } = canned(() => ({ error: 'getaddrinfo ENOTFOUND api.linear.app' }))
  assert.throws(() => linear.getIssue('ABC-1'), /could not reach Linear \(getaddrinfo ENOTFOUND api\.linear\.app\)/)
})

test('linear adapter: with no API key every call fails before anything is sent, naming where a key goes', () => {
  const { calls, linear } = canned(() => ({}), { apiKey: null })
  assert.throws(() => linear.commentIssue('ABC-1', 'b'), /no Linear API key.*LINEAR_API_KEY.*linear\.keyFile/s)
  assert.equal(calls.length, 0)
})

// The transport: a node child posts the query, so rig stays synchronous. The key travels in the
// child's environment and the query on its stdin, never on a command line a process list shows.
test('postViaNode: the key goes in the child\'s environment and the payload on its stdin, never in its arguments', () => {
  const seen = []
  const exec = (args, opts) => {
    seen.push({ args, opts })
    return { status: 0, stdout: JSON.stringify({ status: 200, text: '{"data":{}}' }), stderr: '' }
  }
  const answer = postViaNode(exec)({ query: 'q', variables: { id: 'ABC-1' } }, KEY)
  assert.deepEqual(answer, { status: 200, text: '{"data":{}}' })
  assert.equal(seen.length, 1)
  assert.ok(!seen[0].args.join(' ').includes(KEY), 'no key in the arguments')
  assert.ok(seen[0].args.join(' ').includes(LINEAR_API), 'the child posts to Linear\'s GraphQL endpoint')
  assert.equal(seen[0].opts.env.RIG_LINEAR_API_KEY, KEY)
  assert.deepEqual(JSON.parse(seen[0].opts.input), { query: 'q', variables: { id: 'ABC-1' } })
})

test('postViaNode: a child that cannot start, or answers nothing readable, is a transport error', () => {
  assert.match(postViaNode(() => ({ error: new Error('spawn ENOENT') }))({}, KEY).error, /ENOENT/)
  assert.match(postViaNode(() => ({ status: 1, stdout: '', stderr: 'boom' }))({}, KEY).error, /boom/)
})

test('linearApiKey: the environment\'s LINEAR_API_KEY wins over the key file', () => {
  assert.equal(linearApiKey({ env: { LINEAR_API_KEY: ' lin_env ' }, keyFile: '/no/such/file', readFile: () => { throw new Error('not read') } }), 'lin_env')
})

test('linearApiKey: the key file is a dotenv file holding LINEAR_API_KEY', () => {
  const read = text => () => text
  assert.equal(linearApiKey({ env: {}, keyFile: 'f', readFile: read('# a comment\nOTHER=x\nLINEAR_API_KEY=lin_file\n') }), 'lin_file')
  assert.equal(linearApiKey({ env: {}, keyFile: 'f', readFile: read('export LINEAR_API_KEY="lin_quoted"\r\n') }), 'lin_quoted')
  assert.equal(linearApiKey({ env: {}, keyFile: 'f', readFile: read("LINEAR_API_KEY='lin_single'") }), 'lin_single')
})

test('linearApiKey: no key anywhere, or a placeholder still in the file, is no key', () => {
  assert.equal(linearApiKey({ env: {} }), null)
  assert.equal(linearApiKey({ env: {}, keyFile: 'f', readFile: () => 'LINEAR_API_KEY=CHANGE_ME\n' }), null)
  assert.equal(linearApiKey({ env: {}, keyFile: 'f', readFile: () => 'OTHER=1\n' }), null)
})

test('linearApiKey: a key file that is named and missing fails, naming the file', () => {
  const missing = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e }
  assert.throws(() => linearApiKey({ env: {}, keyFile: '/somewhere/.secrets.env', readFile: missing }), /linear\.keyFile names \/somewhere\/\.secrets\.env, which does not exist/)
})

test('in-memory adapter: getIssue, commentIssue and createIssue read and mutate canned issues', () => {
  const state = { issues: { 'ABC-1': { title: 'One', body: 'Brief', comments: [] } }, teams: ['ABC'] }
  const linear = linearInMemory(state)
  assert.equal(linear.present(), true)
  assert.deepEqual(linear.getIssue('ABC-1'), { title: 'One', body: 'Brief' })
  linear.commentIssue('ABC-1', 'hello')
  assert.deepEqual(state.issues['ABC-1'].comments, ['hello'])
  assert.equal(linear.createIssue({ team: 'ABC', title: 'Two', description: 'd' }), 'ABC-2')
  assert.equal(state.issues['ABC-2'].title, 'Two')
  assert.throws(() => linear.getIssue('ABC-9'), /ABC-9: no such issue/)
  assert.throws(() => linear.createIssue({ team: 'XYZ', title: 't', description: 'd' }), /no Linear team has the key XYZ/)
})

test('in-memory adapter: present false makes every call fail like a missing key', () => {
  const linear = linearInMemory({ present: false, issues: { 'ABC-1': { title: 't', body: '', comments: [] } } })
  assert.equal(linear.present(), false)
  assert.throws(() => linear.commentIssue('ABC-1', 'b'), /no Linear API key/)
})
