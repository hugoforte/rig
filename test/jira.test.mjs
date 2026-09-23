// The Jira module is the seam between rig and `twg`, mirroring bin/github.mjs: one
// interface, two adapters. `twgViaCli`'s `exec` is injected so its parsers run without
// twg; `twgInMemory` holds canned issues for tests. See docs/adr/0001-jira-via-twg.md
// for why twg, and for the caveat that the JSON shapes below are inferred from
// `twg --help`, not a live call, and may need adjustment on first real use.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { twgViaCli, twgInMemory } from '../bin/jira.mjs'
import { resolveJiraFields } from '../bin/rig.mjs'
import { makeInstall, readJson } from './harness.mjs'

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
    '--summary', 'New work', '--description', 'The brief', '--description-format', 'markdown',
    '--assignee', 'me', '--field', 'customfield_10020=7', '-o', 'json', '-y'])
})

// twg's --description-format defaults to html, so a multi-paragraph markdown brief sent
// without this flag arrives as one run-on paragraph (hugoforte/rig#54).
test('twg adapter: createIssue sends the description as markdown, never twg\'s default html', () => {
  const { calls, twg } = canned(() => JSON.stringify({ data: { key: 'KTLO-44' } }))
  twg.createIssue({ project: 'KTLO', type: 'Task', summary: 'S', description: 'First.\n\nSecond.', fields: {} })
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--description')),
    ['--description', 'First.\n\nSecond.', '--description-format', 'markdown', '-o', 'json', '-y'])
})

test('twg adapter: createIssue omits --assignee and --field when there are none', () => {
  const { calls, twg } = canned(() => JSON.stringify({ data: { key: 'KTLO-44' } }))
  twg.createIssue({ project: 'KTLO', type: 'Task', summary: 'S', description: 'D', fields: {} })
  assert.deepEqual(calls[0], ['jira', 'workitem', 'create', '--space', 'KTLO', '--type', 'Task',
    '--summary', 'S', '--description', 'D', '--description-format', 'markdown', '-o', 'json', '-y'])
})

test('twg adapter: createIssue fails loudly when it cannot read the new key', () => {
  const { twg } = canned(() => '{"data":{}}')
  assert.throws(() => twg.createIssue({ project: 'KTLO', type: 'Task', summary: 'S', description: 'D', fields: {} }),
    /could not read the new issue's key/)
})

// --body-format for the same reason as the description's: the close comment is a markdown
// list of PR links, and twg would otherwise read it as html.
test('twg adapter: commentIssue posts the body as markdown and surfaces twg\'s error', () => {
  const { calls, twg } = canned(() => '')
  twg.commentIssue('KTLO-42', 'Closed by rig close.')
  assert.deepEqual(calls[0], ['jira', 'workitem', 'comment', 'create', '--issue-id', 'KTLO-42',
    '--body', 'Closed by rig close.', '--body-format', 'markdown'])
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

test('twg adapter: projectComponents reads the REST passthrough\'s array of components', () => {
  const { calls, twg } = canned(() => JSON.stringify([{ id: 11023, name: 'InfoManagerWeb' }, { id: 11024, name: 'Payments' }]))
  assert.deepEqual(twg.projectComponents('KTLO'), [{ id: '11023', name: 'InfoManagerWeb' }, { id: '11024', name: 'Payments' }])
  assert.deepEqual(calls[0], ['api', 'jira:/rest/api/3/project/KTLO/components'])
})

test('twg adapter: projectComponents also reads the paginated { values } shape', () => {
  const { twg } = canned(() => JSON.stringify({ values: [{ id: '11023', name: 'InfoManagerWeb' }] }))
  assert.deepEqual(twg.projectComponents('KTLO'), [{ id: '11023', name: 'InfoManagerWeb' }])
})

test('twg adapter: projectComponents fails loudly on a JSON shape it cannot read', () => {
  const { twg } = canned(() => '{"errorMessages":["No project could be found with key KTLO"]}')
  assert.throws(() => twg.projectComponents('KTLO'), /could not read components/)
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
  components: { KTLO: [{ id: '11023', name: 'InfoManagerWeb' }] },
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

test('in-memory adapter: fieldMetadata, projectComponents and activeSprintId read the canned tables', () => {
  const twg = twgInMemory(world())
  assert.equal(twg.fieldMetadata('KTLO', 'Task')[0].name, 'Story Points')
  assert.deepEqual(twg.projectComponents('KTLO'), [{ id: '11023', name: 'InfoManagerWeb' }])
  assert.deepEqual(twg.projectComponents('OTHER'), [])
  assert.equal(twg.activeSprintId(123), 7)
  assert.equal(twg.activeSprintId(999), null)
})

test('in-memory adapter: present false makes every call fail like a missing twg', () => {
  const twg = twgInMemory({ ...world(), present: false })
  assert.equal(twg.present(), false)
  assert.throws(() => twg.getIssue('KTLO-1'), /twg not found on PATH/)
})

// ------------------------------------------------- rig.json fields -> what twg is given
//
// `resolveJiraFields` is bin/rig.mjs's, but everything it asks about is this module's
// interface, so it is exercised here against the in-memory adapter. The create-metadata
// table below is the shape a real Jira answers with: custom fields only. No system field
// is ever in it (hugoforte/rig#45 — 31 entries for KTLO/Story, every one a
// `customfield_*`), which is why rig has to know them by heart.
const customFieldsOnly = () => ({
  present: true,
  issues: {},
  fields: { KTLO: { Story: [{ id: 'customfield_10058', name: 'Story Points', allowedValues: [] }] } },
  components: { KTLO: [{ id: '11023', name: 'InfoManagerWeb' }, { id: '11024', name: 'Payments' }] },
  boards: {},
})
const ktlo = (fields, type = 'Story') => ({ org: 'linenmaster', project: 'KTLO', type, fields })

test('resolveJiraFields: a system field resolves although create-metadata omits it', () => {
  const resolved = resolveJiraFields(twgInMemory(customFieldsOnly()),
    ktlo({ assignee: 'me', story_points: 3, components: ['InfoManagerWeb'] }), [])
  // `components` keeps Jira's own name as its id — there is no customfield_* to become —
  // and this is also the payload `--dry-run` prints, line for line.
  assert.deepEqual(resolved, { assignee: 'me', fields: { customfield_10058: 3, components: ['11023'] } })
})

test('resolveJiraFields: a component name resolves to its id from the project components', () => {
  const resolved = resolveJiraFields(twgInMemory(customFieldsOnly()), ktlo({ components: 'Payments' }), [])
  assert.deepEqual(resolved.fields, { components: ['11024'] }, 'a bare name resolves like a list of one')
})

test('resolveJiraFields: a component the project does not have dies, listing the ones it does', () => {
  assert.throws(() => resolveJiraFields(twgInMemory(customFieldsOnly()), ktlo({ components: ['Payment'] }), []),
    /"Payment" is not a value for "Components" \(KTLO\) — known: InfoManagerWeb, Payments/)
})

test('resolveJiraFields: system fields other than components pass through under their Jira name', () => {
  const resolved = resolveJiraFields(twgInMemory(customFieldsOnly()),
    ktlo({ labels: ['ktlo'], priority: 'High', fix_versions: ['2026.9'] }), [])
  assert.deepEqual(resolved.fields, { labels: ['ktlo'], priority: 'High', fixVersions: ['2026.9'] },
    'rig.json may spell it fix_versions; Jira calls it fixVersions')
})

test('resolveJiraFields: a name in neither create-metadata nor the system set still dies', () => {
  assert.throws(() => resolveJiraFields(twgInMemory(customFieldsOnly()), ktlo({ compnoents: ['InfoManagerWeb'] }), []),
    /no field named "compnoents" for KTLO\/Story/)
})

test('resolveJiraFields: create-metadata wins over the system set when both know the name', () => {
  // world()'s KTLO/Task does carry a Components field, with allowed values of its own that
  // the project's component list (InfoManagerWeb) knows nothing about.
  const resolved = resolveJiraFields(twgInMemory(world()), ktlo({ components: ['Payments'] }, 'Task'), [])
  assert.deepEqual(resolved.fields, { customfield_10755: ['10755'] })
})

// ------------------------------------------------- what a created Jira ticket says
//
// End to end through the CLI, because the description is built from the work record and
// the data root's remote (`contextDocRef`) — neither of which a direct call could supply
// honestly. One temp installation (test/harness.mjs) with the in-memory twg adapter behind
// RIG_FAKE_TWG; the real `twg` is never spawned. The two tests below share it and run in
// order: the dry-run's preview is compared against what the create then sends.
const install = makeInstall({ prefix: 'rig-jira-', twg: { present: true, issues: {}, fields: {}, boards: {} }, inProcess: true })
after(install.cleanup)

const brief = [
  'Refunds are charged twice when the gateway retries.',
  '',
  '## What happens',
  '',
  'The second paragraph — everything the old create dropped on the floor.',
].join('\n')

// The four spaces `--dry-run` indents the description block by, stripped back off. The
// block is the last thing printed, and its blank lines are printed bare so that nothing
// rig prints carries trailing whitespace.
const previewedDescription = stdout => {
  const lines = stdout.split(/\r?\n/)
  const start = lines.findIndex(l => l.startsWith('  description'))
  assert.notEqual(start, -1, `no description block in:\n${stdout}`)
  const block = lines.slice(start + 1).map(l => l.startsWith('    ') ? l.slice(4) : l)
  while (block.length && block.at(-1) === '') block.pop()
  return block.join('\n')
}

test('rig new --ticket --dry-run previews the Jira description in full', () => {
  let r = install.rig(['init', '--data-root', install.dataRoot, '--work-root', install.workRoot,
    '--orgs', 'acme', '--tracker', 'acme=jira:PROJ', '--email', 'you@acme.example'])
  assert.equal(r.code, 0, r.out)
  // `type` has no CLI setter — org facts go straight into the data root's rig.json.
  const rigJson = path.join(install.dataRoot, 'rig.json')
  const cfg = readJson(rigJson)
  cfg.tracker.acme = { kind: 'jira', project: 'PROJ', type: 'Task' }
  fs.writeFileSync(rigJson, JSON.stringify(cfg, null, 2))

  r = install.rig(['new', 'refunds', '--title', 'Refunds double-charge', '--ticket', '--org', 'acme', '--dry-run'],
    { input: brief })
  assert.equal(r.code, 0, r.out)
  assert.match(previewedDescription(r.stdout), /dropped on the floor/, 'the whole brief, not its first paragraph')
})

test('a Jira ticket created by rig new --ticket carries the whole brief and the context-doc link', () => {
  const preview = previewedDescription(
    install.rig(['new', 'refunds', '--title', 'Refunds double-charge', '--ticket', '--org', 'acme', '--dry-run'],
      { input: brief }).stdout)

  const r = install.rig(['new', 'refunds', '--title', 'Refunds double-charge', '--ticket', '--org', 'acme'],
    { input: brief })
  assert.equal(r.code, 0, r.out)
  const issue = readJson(install.twgStateFile).issues['PROJ-1']
  assert.equal(issue.title, 'Refunds double-charge')
  assert.ok(issue.body.startsWith(brief), 'the brief goes in whole, verbatim, first')
  assert.match(issue.body, /The design lives in the work record: \S*refunds\S*context\.md/)
  assert.equal(preview, issue.body, '--dry-run previews exactly what the create sends')
})
