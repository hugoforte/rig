// Jira, behind one interface, the way bin/github.mjs is GitHub's. `twg` is the Jira
// client (docs/adr/0001-jira-via-twg.md supersedes DESIGN.md decisions 29 and 33): its
// site and auth come from twg's own config, and rig calls nothing else.
//
// ASSUMPTION, flagged for whoever runs this first against a real site: the JSON shapes
// parsed below (getIssue, createIssue, fieldMetadata, activeSprintId) are inferred from
// `twg --help` and the "Teamwork Graph" GraphQL shape hinted at by its `--agent-fields`
// example (`data.items.key`), not from a live response — twg was deliberately not
// exercised against real Jira data while building this. Each parser fails loudly with
// the raw output when its guess is wrong, so a bad shape surfaces on first use rather
// than silently misreading a ticket.
//
// The interface:
//   present()                                    is `twg` on PATH? never throws
//   getIssue(key)                                { title, body }
//   createIssue({ project, type, summary, description, assignee, fields })   the new key
//   commentIssue(key, body)
//   fieldMetadata(project, type)                  [{ id, name }] for `--field` by name
//   activeSprintId(boardId)                       the board's active sprint id, or null
// Every call but present() throws JiraError when twg is missing or the call fails.
import { spawnSync } from 'node:child_process'
import { jsonCliHelpers } from './cli-json.mjs'

export class JiraError extends Error {}
const { fail, firstLine, parseJson } = jsonCliHelpers(JiraError)

const spawnTwg = args => spawnSync('twg', args, { encoding: 'utf8' })

export function twgViaCli ({ exec = spawnTwg } = {}) {
  const twg = args => {
    const r = exec(args)
    if (r.error) fail(`twg not found on PATH (${r.error.message})`)
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
  }
  const must = args => {
    const r = twg(args)
    if (r.code !== 0) fail(`twg ${args.slice(0, 2).join(' ')}: ${firstLine(r.err || r.out)}`)
    return r.out
  }

  return {
    present () {
      return !exec(['--version']).error
    },
    getIssue (key) {
      const out = must(['jira', 'workitem', key, '-o', 'json', '--fields', 'summary,description'])
      const body = parseJson(out, 'twg jira workitem')
      const fields = body.data?.fields || body.fields
      if (!fields || (fields.summary === undefined && fields.description === undefined)) {
        fail(`could not read summary/description from twg's JSON:\n${out}`)
      }
      return { title: fields.summary || '', body: fields.description || '' }
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
// allowedValues }] } }, boards: { boardId: activeSprintId | null } }.
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
    activeSprintId (boardId) {
      guard()
      return state.boards?.[boardId] ?? null
    },
  }
}
