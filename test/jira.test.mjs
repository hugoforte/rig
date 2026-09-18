// The Jira module is the seam between rig and `twg`, mirroring bin/github.mjs: one
// interface, two adapters. `twgViaCli`'s `exec` is injected so its parsers run without
// twg; `twgInMemory` holds canned issues for tests. See docs/adr/0001-jira-via-twg.md
// for why twg, and for the caveat that the JSON shapes below are inferred from
// `twg --help`, not a live call, and may need adjustment on first real use.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { twgViaCli, twgInMemory } from '../bin/jira.mjs'

const canned = reply => {
  const calls = []
  const exec = args => {
    calls.push(args)
    const r = reply(args)
    return typeof r === 'string' ? { status: 0, stdout: r, stderr: '' } : { status: r.code, stdout: r.out || '', stderr: r.err || '' }
  }
  return { calls, twg: twgViaCli({ exec }) }
}

test('twg adapter: present is false when twg cannot be spawned, true otherwise', () => {
  assert.equal(twgViaCli({ exec: () => ({ error: new Error('ENOENT') }) }).present(), false)
  assert.equal(canned(() => '1.1.0').twg.present(), true)
})

test('twg adapter: getIssue reads summary and description from the issue fields', () => {
  const { calls, twg } = canned(() => JSON.stringify({ data: { key: 'KTLO-42', fields: { summary: 'A bug', description: 'Steps to reproduce' } } }))
  assert.deepEqual(twg.getIssue('KTLO-42'), { title: 'A bug', body: 'Steps to reproduce' })
  assert.deepEqual(calls[0], ['jira', 'workitem', 'KTLO-42', '-o', 'json', '--fields', 'summary,description'])
})

test('twg adapter: getIssue fails with twg\'s own error when twg fails', () => {
  const { twg } = canned(() => ({ code: 1, err: 'HTTP 404: Issue does not exist' }))
  assert.throws(() => twg.getIssue('KTLO-999'), /Issue does not exist/)
})

test('twg adapter: getIssue fails loudly on a JSON shape it cannot read', () => {
  const { twg } = canned(() => '{"data":{"key":"KTLO-1"}}')
  assert.throws(() => twg.getIssue('KTLO-1'), /could not read summary\/description/)
})

// The shape a real `twg jira workitem KEY -o json` returns, which the guessed shapes above
// did not cover: `data` is an array of workitems, and `description` is ADF, not a string.
// See hugoforte/rig#22 — the fetch failed outright on the first ticket that had one.
test('twg adapter: getIssue reads a workitem returned as an array under data', () => {
  const { twg } = canned(() => JSON.stringify({ data: [{ key: 'KTLO-1455', summary: 'Import Payabli tokens', description: 'Plain enough' }] }))
  assert.deepEqual(twg.getIssue('KTLO-1455'), { title: 'Import Payabli tokens', body: 'Plain enough' })
})

test('twg adapter: getIssue flattens an ADF description to plain text', () => {
  const { twg } = canned(() => JSON.stringify({
    data: [{
      summary: 'A bug',
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Steps to reproduce' }] }] },
    }],
  }))
  assert.equal(twg.getIssue('KTLO-42').body, 'Steps to reproduce')
})

test('twg adapter: getIssue keeps the summary when the description is an empty ADF doc', () => {
  const { twg } = canned(() => JSON.stringify({ data: [{ summary: 'A bug', description: { type: 'doc', version: 1, content: [] } }] }))
  assert.deepEqual(twg.getIssue('KTLO-42'), { title: 'A bug', body: '' })
})

test('twg adapter: getIssue keeps the summary when there is no description at all', () => {
  const { twg } = canned(() => JSON.stringify({ data: [{ summary: 'A bug' }] }))
  assert.deepEqual(twg.getIssue('KTLO-42'), { title: 'A bug', body: '' })
})

test('twg adapter: getIssue reads the description when there is no summary', () => {
  const { twg } = canned(() => JSON.stringify({ data: [{ description: 'Just a body' }] }))
  assert.deepEqual(twg.getIssue('KTLO-42'), { title: '', body: 'Just a body' })
})

// KTLO-1455's description was exactly this: one embedCard and nothing else. A card carries
// its URL in attrs and has no text child, so dropping it would leave an empty brief.
test('twg adapter: getIssue reads a card-only ADF description as its URL', () => {
  const { twg } = canned(() => JSON.stringify({
    data: [{ summary: 'Import Payabli tokens', description: { type: 'doc', version: 1, content: [{ type: 'embedCard', attrs: { url: 'https://example.atlassian.net/wiki/spaces/X/pages/1' } }] } }],
  }))
  assert.equal(twg.getIssue('KTLO-1455').body, 'https://example.atlassian.net/wiki/spaces/X/pages/1')
})

test('twg adapter: getIssue keeps a link\'s target alongside its text', () => {
  const { twg } = canned(() => JSON.stringify({
    data: [{ summary: 'S', description: { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'see ' },
      { type: 'text', text: 'the design', marks: [{ type: 'link', attrs: { href: 'https://example.com/d' } }] },
    ] }] } }],
  }))
  assert.equal(twg.getIssue('KTLO-42').body, 'see the design (https://example.com/d)')
})

test('twg adapter: getIssue separates ADF paragraphs with a blank line', () => {
  const { twg } = canned(() => JSON.stringify({
    data: [{ summary: 'S', description: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'First.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second.' }] },
    ] } }],
  }))
  assert.equal(twg.getIssue('KTLO-42').body, 'First.\n\nSecond.')
})

test('twg adapter: createIssue passes summary, description and fields, and reads the new key', () => {
  const { calls, twg } = canned(() => JSON.stringify({ data: { key: 'KTLO-43' } }))
  const key = twg.createIssue({
    project: 'KTLO', type: 'Task', summary: 'New work', description: 'The brief',
    assignee: 'me', fields: { customfield_10020: 7 },
  })
  assert.equal(key, 'KTLO-43')
  assert.deepEqual(calls[0], ['jira', 'workitem', 'create', '--space', 'KTLO', '--type', 'Task',
    '--summary', 'New work', '--description', 'The brief', '--assignee', 'me',
    '--field', 'customfield_10020=7', '-o', 'json', '-y'])
})

test('twg adapter: createIssue omits --assignee and --field when there are none', () => {
  const { calls, twg } = canned(() => JSON.stringify({ data: { key: 'KTLO-44' } }))
  twg.createIssue({ project: 'KTLO', type: 'Task', summary: 'S', description: 'D', fields: {} })
  assert.deepEqual(calls[0], ['jira', 'workitem', 'create', '--space', 'KTLO', '--type', 'Task',
    '--summary', 'S', '--description', 'D', '-o', 'json', '-y'])
})

test('twg adapter: createIssue fails loudly when it cannot read the new key', () => {
  const { twg } = canned(() => '{"data":{}}')
  assert.throws(() => twg.createIssue({ project: 'KTLO', type: 'Task', summary: 'S', description: 'D', fields: {} }),
    /could not read the new issue's key/)
})

test('twg adapter: commentIssue posts the body and surfaces twg\'s error', () => {
  const { calls, twg } = canned(() => '')
  twg.commentIssue('KTLO-42', 'Closed by rig close.')
  assert.deepEqual(calls[0], ['jira', 'workitem', 'comment', 'create', '--issue-id', 'KTLO-42', '--body', 'Closed by rig close.'])
  const failing = canned(() => ({ code: 1, err: 'HTTP 403: Forbidden' })).twg
  assert.throws(() => failing.commentIssue('KTLO-42', 'x'), /HTTP 403: Forbidden/)
})

test('twg adapter: fieldMetadata lists each field\'s id, name and allowed values', () => {
  const { calls, twg } = canned(() => JSON.stringify({
    data: {
      fields: [
        { id: 'customfield_10058', name: 'Story Points' },
        { id: 'customfield_10755', name: 'Components', allowedValues: [{ id: '10755', name: 'Payments' }] },
      ],
    },
  }))
  assert.deepEqual(twg.fieldMetadata('KTLO', 'Task'), [
    { id: 'customfield_10058', name: 'Story Points', allowedValues: [] },
    { id: 'customfield_10755', name: 'Components', allowedValues: [{ id: '10755', name: 'Payments' }] },
  ])
  assert.deepEqual(calls[0], ['jira', 'workitem', 'field', 'create-metadata', '--space', 'KTLO', '--type', 'Task', '-o', 'json'])
})

test('twg adapter: fieldMetadata fails loudly on a JSON shape it cannot read', () => {
  const { twg } = canned(() => '{"data":{}}')
  assert.throws(() => twg.fieldMetadata('KTLO', 'Task'), /could not read fields/)
})

test('twg adapter: activeSprintId finds the sprint in state "active"', () => {
  const { calls, twg } = canned(() => JSON.stringify({ data: { sprints: [{ id: 5, state: 'closed' }, { id: 7, state: 'active' }] } }))
  assert.equal(twg.activeSprintId(123), 7)
  assert.deepEqual(calls[0], ['jira', 'sprint', 'snapshot', '--board-id', '123', '-o', 'json'])
})

test('twg adapter: activeSprintId is null when no sprint is active', () => {
  const { twg } = canned(() => JSON.stringify({ data: { sprints: [{ id: 5, state: 'closed' }] } }))
  assert.equal(twg.activeSprintId(123), null)
})

const world = () => ({
  present: true,
  issues: { 'KTLO-1': { title: 'Existing', body: 'desc', comments: [] } },
  fields: { KTLO: { Task: [
    { id: 'customfield_10058', name: 'Story Points', allowedValues: [] },
    { id: 'customfield_10755', name: 'Components', allowedValues: [{ id: '10755', name: 'Payments' }] },
  ] } },
  boards: { 123: 7 },   // board id -> active sprint id
})

test('in-memory adapter: getIssue and commentIssue read and mutate canned issues', () => {
  const state = world()
  const twg = twgInMemory(state)
  assert.deepEqual(twg.getIssue('KTLO-1'), { title: 'Existing', body: 'desc' })
  twg.commentIssue('KTLO-1', 'done')
  assert.deepEqual(state.issues['KTLO-1'].comments, ['done'])
  assert.throws(() => twg.getIssue('KTLO-999'), /KTLO-999/)
})

test('in-memory adapter: createIssue numbers a new key under the project and records the fields', () => {
  const state = world()
  const twg = twgInMemory(state)
  const key = twg.createIssue({ project: 'KTLO', type: 'Task', summary: 'New', description: 'D', assignee: 'me', fields: { customfield_10058: 3 } })
  assert.equal(key, 'KTLO-2')
  assert.deepEqual(state.issues['KTLO-2'], { title: 'New', body: 'D', assignee: 'me', fields: { customfield_10058: 3 }, comments: [] })
})

test('in-memory adapter: fieldMetadata and activeSprintId read the canned tables', () => {
  const twg = twgInMemory(world())
  assert.equal(twg.fieldMetadata('KTLO', 'Task')[0].name, 'Story Points')
  assert.equal(twg.activeSprintId(123), 7)
  assert.equal(twg.activeSprintId(999), null)
})

test('in-memory adapter: present false makes every call fail like a missing twg', () => {
  const twg = twgInMemory({ ...world(), present: false })
  assert.equal(twg.present(), false)
  assert.throws(() => twg.getIssue('KTLO-1'), /twg not found on PATH/)
})
