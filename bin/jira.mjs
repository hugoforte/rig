// Jira, behind one interface, the way bin/github.mjs is GitHub's. `twg` is the Jira
// client (docs/adr/0001-jira-via-twg.md supersedes DESIGN.md decisions 29 and 33): its
// site and auth come from twg's own config, and rig calls nothing else.
//
// Every answer parsed here has been checked against a real twg 1.3.3 answer (apiVersion v2),
// and each has a test of that shape (hugoforte/rig#260). A parser that meets a shape it
// cannot read fails with the raw output rather than guessing. For a write that is not
// enough on its own, since the write has happened by then; createIssue says so.
//
// The interface:
//   present()                                    is `twg` on PATH? never throws
//   getIssue(key)                                { title, body }
//   createIssue({ project, type, summary, description, assignee, parent, fields })   the new key
//   commentIssue(key, body)
// Both descriptions and comments are sent as **markdown**: twg's own default is HTML
// (`--description-format`/`--body-format`, `twg --version` 1.1.0), and everything rig
// writes — briefs, PR-link lists, the context-doc line — is markdown.
//   fieldMetadata(project, type)                  [{ id, name }] for `--field` by name
//   projectComponents(project)                    [{ id, name }] the project's components
//   activeSprintId(boardId)                       the board's active sprint id, or null
// Every call but present() throws JiraError when twg is missing or the call fails.
import { spawnSync } from 'node:child_process'
import { TrackerError } from './errors.mjs'
import { jsonCliHelpers, cliRunner } from './cli.mjs'

export class JiraError extends TrackerError {}
const { fail, parseJson } = jsonCliHelpers(JiraError)

// A field value as `--field id=<value>` carries it, and as `rig new --dry-run` previews it:
// one renderer, so the preview is what twg is sent. twg reads a value as JSON when it
// parses, so a list goes as JSON to arrive as a list — as `components=10001` it would arrive
// as one bare number — and a string goes as it is (DESIGN.md decision 147).
export const fieldValue = value => typeof value === 'string' ? value : JSON.stringify(value)

const spawnTwg = args => spawnSync('twg', args, { encoding: 'utf8' })

// Plain JSON on stdout, whoever runs rig. With an agent's variables in the environment
// (CLAUDECODE, AI_AGENT, …) twg 1.3 answers some `-o json` commands, `workitem get` among
// them, with a YAML summary and writes the JSON to a temp file (DESIGN.md decision 149).
const JSON_OUT = ['-o', 'json', '--output-summary', 'none']

// Where a workitem's fields sit in twg's JSON. `jira workitem get` returns `data` as an array
// of workitems carrying their fields directly, in twg 1.3 as in 1.1; the `data.fields`/`fields`
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
      // `get`: twg 1.3 dropped the bare `jira workitem <KEY>` (DESIGN.md decision 148).
      const out = must(['jira', 'workitem', 'get', key, ...JSON_OUT, '--fields', 'summary,description'])
      const fields = workitemFields(parseJson(out, 'twg jira workitem'))
      if (!fields) fail(`could not read summary/description from twg's JSON:\n${out}`)
      return { title: tidy(adfToText(fields.summary)), body: tidy(adfToText(fields.description)) }
    },
    // `--description-format markdown` because twg's default is HTML: without it a brief's
    // blank lines collapse into one run-on paragraph and anything angle-bracketed is eaten
    // as a tag (hugoforte/rig#54). It is fixed, not a parameter — rig writes markdown and
    // nothing else.
    // `parent` goes by twg's own `--parent`, which sends `fields.parent = { key }`; as a
    // `--field` it would reach Jira as a bare string (hugoforte/rig#220).
    createIssue ({ project, type, summary, description, assignee, parent, fields = {} }) {
      const args = ['jira', 'workitem', 'create', '--space', project, '--type', type,
        '--summary', summary, '--description', description, '--description-format', 'markdown']
      if (assignee) args.push('--assignee', assignee)
      if (parent) args.push('--parent', parent)
      for (const [id, value] of Object.entries(fields)) args.push('--field', `${id}=${fieldValue(value)}`)
      args.push(...JSON_OUT, '-y')
      const out = must(args)
      // twg exited 0, so the ticket exists whether or not its answer can be read, and a retry
      // makes a duplicate (DESIGN.md decision 150). twg 1.3 answers
      // `{ apiVersion: 'v2', data: { issue: { key } } }`; earlier ones `{ data: { key } }`.
      let body = null
      try { body = JSON.parse(out) } catch {}
      const key = body?.data?.issue?.key || body?.data?.key || body?.key
      if (!key) {
        fail(`twg reports the create succeeded, but rig could not read the new key from its answer. ` +
          `The ticket may have been created: search ${project} for "${summary}" before retrying, ` +
          `and record it on this work with \`rig ticket <KEY>\`.\ntwg's answer:\n${out}`)
      }
      return key
    },
    commentIssue (key, body) {
      must(['jira', 'workitem', 'comment', 'create', '--issue-id', key, '--body', body, '--body-format', 'markdown'])
    },
    fieldMetadata (project, type) {
      const out = must(['jira', 'workitem', 'field', 'create-metadata', '--space', project, '--type', type, ...JSON_OUT])
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
    // twg 1.3 answers one `data.sprint`: twg's pick when several are active, whose id is also
    // `activeSprints.selectedId`. No `sprint`, or a total of 0, is a board with none active.
    // Anything else is a shape rig does not know, and "no active sprint" would be a guess
    // about it (DESIGN.md decision 148).
    activeSprintId (boardId) {
      const out = must(['jira', 'sprint', 'snapshot', '--board-id', String(boardId), ...JSON_OUT])
      const data = parseJson(out, 'twg jira sprint snapshot').data
      if (data?.sprint?.state === 'active' && data.sprint.id != null) return data.sprint.id
      if (data && (!data.sprint || data.activeSprints?.total === 0)) return null
      fail(`could not read the active sprint from twg's JSON:\n${out}`)
    },
  }
}

// Canned Jira for tests. `state` is mutated in place: { present, issues: { KEY: {
// title, body, comments, assignee, parent, fields } }, fields: { project: { type: [{ id, name,
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
    createIssue ({ project, type, summary, description, assignee, parent, fields = {} }) {
      guard()
      const numbers = Object.keys(state.issues)
        .filter(k => k.startsWith(`${project}-`))
        .map(k => Number(k.slice(project.length + 1)))
      const key = `${project}-${Math.max(0, ...numbers) + 1}`
      state.issues[key] = { title: summary, body: description, ...(assignee ? { assignee } : {}), ...(parent ? { parent } : {}), fields, comments: [] }
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
