// Jira, behind one interface, the way bin/github.mjs is GitHub's. `twg` is the Jira
// client (docs/adr/0001-jira-via-twg.md supersedes DESIGN.md decisions 29 and 33): its
// site and auth come from twg's own config, and rig calls nothing else.
//
// ASSUMPTION, still standing for createIssue, fieldMetadata and activeSprintId: their JSON
// shapes are inferred from `twg --help` and the "Teamwork Graph" GraphQL shape hinted at by
// its `--agent-fields` example (`data.items.key`), not from a live response. Each parser
// fails loudly with the raw output when its guess is wrong, so a bad shape surfaces on first
// use rather than silently misreading a ticket.
//
// getIssue has had that first use, and the guess was wrong twice over (hugoforte/rig#22):
// `data` comes back as an array of workitems, and `description` as an ADF node tree rather
// than a string. It now reads either shape and flattens ADF; the rest await the same test.
//
// The interface:
//   present()                                    is `twg` on PATH? never throws
//   getIssue(key)                                { title, body }
//   createIssue({ project, type, summary, description, assignee, fields })   the new key
//   commentIssue(key, body)
//   fieldMetadata(project, type)                  [{ id, name }] for `--field` by name
//   projectComponents(project)                    [{ id, name }] the project's components
//   activeSprintId(boardId)                       the board's active sprint id, or null
// Every call but present() throws JiraError when twg is missing or the call fails.
import { spawnSync } from 'node:child_process'
import { TrackerError } from './errors.mjs'
import { jsonCliHelpers, cliRunner } from './cli.mjs'

export class JiraError extends TrackerError {}
const { fail, parseJson } = jsonCliHelpers(JiraError)

const spawnTwg = args => spawnSync('twg', args, { encoding: 'utf8' })

// Where a workitem's fields sit in twg's JSON. A real `jira workitem KEY -o json` returns
// `data` as an array of workitems carrying their fields directly; the `data.fields`/`fields`
// shapes this module originally guessed at are kept, since nothing has ruled them out. Null
// when no shape has either field — the one case worth failing on, because a workitem with a
// summary and no description is ordinary, not broken (hugoforte/rig#22).
function workitemFields (body) {
  const item = Array.isArray(body.data) ? body.data[0] : body.data
  for (const shape of [item?.fields, item, body.fields]) {
    if (shape && (shape.summary !== undefined || shape.description !== undefined)) return shape
  }
  return null
}

// Block nodes that end a line of prose. Everything else either carries text, carries a URL
// (the card nodes), or is a container to recurse through (`doc`, `bulletList`, `table`).
const ADF_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'rule', 'panel'])

// Atlassian Document Format flattened to plain text. A Jira description arrives as a node
// tree, not the string this module first assumed, and rig only ever shows it as prose — so
// flatten it rather than model it. A plain string passes through unchanged, which is what a
// summary is and what a site serving wiki-markup descriptions would give.
function adfToText (node) {
  if (node == null) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(adfToText).join('')
  switch (node.type) {
    case 'text': {
      const href = node.marks?.find(m => m.type === 'link')?.attrs?.href
      return href && href !== node.text ? `${node.text} (${href})` : (node.text || '')
    }
    case 'hardBreak': return '\n'
    case 'emoji': return node.attrs?.shortName || node.attrs?.text || ''
    case 'mention': return node.attrs?.text || ''
    // A card is the whole of its node: the URL is the only text there is to keep, and a
    // description that is nothing but one card is a real shape (KTLO-1455 was exactly that).
    case 'inlineCard': case 'blockCard': case 'embedCard': return node.attrs?.url || ''
  }
  const inner = adfToText(node.content)
  if (node.type === 'listItem') return `- ${inner.trim()}\n`
  return ADF_BLOCKS.has(node.type) ? `${inner}\n\n` : inner
}

// Blocks each end in a blank line, so nesting them leaves runs of them behind.
const tidy = text => text.replace(/\n{3,}/g, '\n\n').trim()

export function twgViaCli ({ exec = spawnTwg } = {}) {
  const { must } = cliRunner('twg', exec, fail)

  return {
    present () {
      return !exec(['--version']).error
    },
    getIssue (key) {
      const out = must(['jira', 'workitem', key, '-o', 'json', '--fields', 'summary,description'])
      const fields = workitemFields(parseJson(out, 'twg jira workitem'))
      if (!fields) fail(`could not read summary/description from twg's JSON:\n${out}`)
      return { title: tidy(adfToText(fields.summary)), body: tidy(adfToText(fields.description)) }
    },
    createIssue ({ project, type, summary, description, assignee, fields = {} }) {
      const args = ['jira', 'workitem', 'create', '--space', project, '--type', type,
        '--summary', summary, '--description', description]
      if (assignee) args.push('--assignee', assignee)
      for (const [id, value] of Object.entries(fields)) args.push('--field', `${id}=${value}`)
      args.push('-o', 'json', '-y')
      const out = must(args)
      const body = parseJson(out, 'twg jira workitem create')
      const key = body.data?.key || body.key
      if (!key) fail(`could not read the new issue's key from twg's JSON:\n${out}`)
      return key
    },
    commentIssue (key, body) {
      must(['jira', 'workitem', 'comment', 'create', '--issue-id', key, '--body', body])
    },
    fieldMetadata (project, type) {
      const out = must(['jira', 'workitem', 'field', 'create-metadata', '--space', project, '--type', type, '-o', 'json'])
      const body = parseJson(out, 'twg jira workitem field create-metadata')
      const fields = body.data?.fields || body.fields
      if (!Array.isArray(fields)) fail(`could not read fields from twg's JSON:\n${out}`)
      return fields.map(f => ({ id: f.id, name: f.name, allowedValues: f.allowedValues || [] }))
    },
    // Components come from the REST passthrough because `field create-metadata` returns
    // custom fields only, so Components — a system field — is never in it, allowed values
    // and all (hugoforte/rig#45). The paginated `/component` variant answers `{ values }`;
    // this unpaginated one answers a bare array. Both shapes are read.
    projectComponents (project) {
      const out = must(['api', `jira:/rest/api/3/project/${project}/components`])
      const body = parseJson(out, 'twg api project components')
      const items = Array.isArray(body) ? body : body.values || body.components || body.data
      if (!Array.isArray(items)) fail(`could not read components from twg's JSON:\n${out}`)
      return items.map(c => ({ id: String(c.id), name: c.name }))
    },
    activeSprintId (boardId) {
      const out = must(['jira', 'sprint', 'snapshot', '--board-id', String(boardId), '-o', 'json'])
      const body = parseJson(out, 'twg jira sprint snapshot')
      const sprints = body.data?.sprints || body.sprints || []
      return sprints.find(s => s.state === 'active')?.id ?? null
    },
  }
}

// Canned Jira for tests. `state` is mutated in place: { present, issues: { KEY: {
// title, body, comments, assignee, fields } }, fields: { project: { type: [{ id, name,
// allowedValues }] } }, components: { project: [{ id, name }] },
// boards: { boardId: activeSprintId | null } }.
export function twgInMemory (state) {
  const guard = () => { if (state.present === false) fail('twg not found on PATH (in-memory Jira)') }
  const issue = key => state.issues[key] || fail(`${key}: no such issue (in-memory Jira)`)

  return {
    present: () => state.present !== false,
    getIssue (key) {
      guard()
      const { title, body } = issue(key)
      return { title, body }
    },
    createIssue ({ project, type, summary, description, assignee, fields = {} }) {
      guard()
      const numbers = Object.keys(state.issues)
        .filter(k => k.startsWith(`${project}-`))
        .map(k => Number(k.slice(project.length + 1)))
      const key = `${project}-${Math.max(0, ...numbers) + 1}`
      state.issues[key] = { title: summary, body: description, ...(assignee ? { assignee } : {}), fields, comments: [] }
      return key
    },
    commentIssue (key, body) {
      guard()
      issue(key).comments.push(body)
    },
    fieldMetadata (project, type) {
      guard()
      return state.fields?.[project]?.[type] || []
    },
    projectComponents (project) {
      guard()
      return state.components?.[project] || []
    },
    activeSprintId (boardId) {
      guard()
      return state.boards?.[boardId] ?? null
    },
  }
}
