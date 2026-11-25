// Linear, behind one interface, the way bin/jira.mjs is Jira's. rig speaks to Linear's GraphQL
// API directly, with a personal API key; nothing else is installed for it.
//
// The interface:
//   present()                               is there an API key? asks Linear nothing
//   getIssue(key)                           { title, body } of the issue `ABC-123` names
//   createIssue({ team, title, description })   the new issue's key, in the team whose key is `team`
//   commentIssue(key, body)                 a markdown comment on the issue
// Every call but present() throws LinearError when there is no key or the call fails.
//
// rig is synchronous throughout, and `fetch` is not, so a request is posted by a node child
// (`postViaNode`): the query goes down its stdin and the key in its environment, so neither
// reaches a command line that a process list would show.
import { TrackerError } from './errors.mjs'

export class LinearError extends TrackerError {}
const fail = msg => { throw new LinearError(msg) }
const firstLine = s => (s || '').trim().split('\n')[0]

export const LINEAR_API = 'https://api.linear.app/graphql'

const NO_KEY = 'no Linear API key: set LINEAR_API_KEY, or name a file holding it in rig.local.json\'s linear.keyFile'

// The key, from the run's environment or else the dotenv file the machine half names. A file
// still holding a placeholder, or no LINEAR_API_KEY line, is no key; a file named and missing
// is a mistake in the machine file, and said as one.
export function linearApiKey ({ env = {}, keyFile, readFile } = {}) {
  const fromEnv = (env.LINEAR_API_KEY || '').trim()
  if (fromEnv) return fromEnv
  if (!keyFile) return null
  let text
  try { text = readFile(keyFile) } catch (e) {
    if (e.code === 'ENOENT') fail(`rig.local.json's linear.keyFile names ${keyFile}, which does not exist`)
    throw e
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?LINEAR_API_KEY\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const value = m[1].replace(/^(['"])(.*)\1$/, '$2').trim()
    return value && value !== 'CHANGE_ME' ? value : null
  }
  return null
}

// The child that posts one request: it reads the payload from stdin, the key from its
// environment, and answers `{ status, text }` or `{ error }` as one line of JSON.
const POST_SCRIPT = `
const chunks = []
for await (const c of process.stdin) chunks.push(c)
let answer
try {
  const r = await fetch(${JSON.stringify(LINEAR_API)}, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: process.env.RIG_LINEAR_API_KEY },
    body: Buffer.concat(chunks).toString('utf8'),
    signal: AbortSignal.timeout(30000),
  })
  answer = { status: r.status, text: await r.text() }
} catch (e) { answer = { error: String(e?.cause?.message || e?.message || e) } }
process.stdout.write(JSON.stringify(answer))
`

// A `post(payload, key)` over `exec`, which is spawnSync-shaped and runs node.
export function postViaNode (exec) {
  return (payload, key) => {
    const r = exec(['--input-type=module', '-e', POST_SCRIPT], { input: JSON.stringify(payload), env: { RIG_LINEAR_API_KEY: key }, timeout: 45000 })
    if (r.error) return { error: r.error.message }
    try { return JSON.parse(r.stdout) } catch { return { error: firstLine(r.stderr) || `node exited ${r.status} with no answer` } }
  }
}

const ISSUE = 'query Issue($id: String!) { issue(id: $id) { id identifier title description } }'
const TEAM = 'query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }'
const CREATE = 'mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }'
const COMMENT = 'mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }'

// `post` answers one request; `apiKey` is asked at each call, so a key added mid-run is used and
// a run that never speaks to Linear never reads one.
export function linearViaApi ({ post, apiKey }) {
  const request = (query, variables) => {
    const key = apiKey()
    if (!key) fail(NO_KEY)
    const r = post({ query, variables }, key)
    if (r.error) fail(`could not reach Linear (${r.error})`)
    if (r.status === 401 || r.status === 403) fail(`Linear refused the API key (HTTP ${r.status}); make a new one and store it where linear.keyFile points`)
    let body
    try { body = JSON.parse(r.text) } catch { fail(`Linear answered HTTP ${r.status} with no JSON: ${firstLine(r.text)}`) }
    if (body.errors?.length) fail(`Linear: ${body.errors.map(e => e.message).join('; ')}`)
    if (r.status >= 400 || !body.data) fail(`Linear answered HTTP ${r.status} with no data`)
    return body.data
  }
  const issue = key => request(ISSUE, { id: key }).issue || fail(`${key}: Linear has no such issue`)

  return {
    present: () => !!apiKey(),
    getIssue (key) {
      const { title, description } = issue(key)
      return { title: title || '', body: description || '' }
    },
    createIssue ({ team, title, description }) {
      const teamId = request(TEAM, { key: team }).teams?.nodes?.[0]?.id || fail(`no Linear team has the key ${team}`)
      const created = request(CREATE, { input: { teamId, title, description } }).issueCreate
      // Linear said yes, so the issue may exist whether or not its key can be read, and a retry
      // makes a duplicate (as DESIGN.md decision 150 says for Jira).
      if (!created?.success || !created.issue?.identifier) {
        fail(`Linear did not answer the new issue's key, so it may have been created. Search team ${team} for "${title}" before retrying, ` +
          'then record it on this work with `rig ticket <KEY> --work <id>`.')
      }
      return created.issue.identifier
    },
    commentIssue (key, body) {
      const { id } = issue(key)
      if (!request(COMMENT, { input: { issueId: id, body } }).commentCreate?.success) fail(`Linear did not create the comment on ${key}`)
    },
  }
}

// Canned Linear for tests. `state` is mutated in place: { present, teams: ['ABC'],
// issues: { KEY: { title, body, comments } } }.
export function linearInMemory (state) {
  const guard = () => { if (state.present === false) fail(`${NO_KEY} (in-memory Linear)`) }
  const issue = key => state.issues?.[key] || fail(`${key}: no such issue (in-memory Linear)`)
  return {
    present: () => state.present !== false,
    getIssue (key) {
      guard()
      const { title, body } = issue(key)
      return { title, body }
    },
    createIssue ({ team, title, description }) {
      guard()
      if (!(state.teams || []).includes(team)) fail(`no Linear team has the key ${team} (in-memory Linear)`)
      state.issues ??= {}
      const numbers = Object.keys(state.issues).filter(k => k.startsWith(`${team}-`)).map(k => Number(k.slice(team.length + 1)))
      const key = `${team}-${Math.max(0, ...numbers) + 1}`
      state.issues[key] = { title, body: description, comments: [] }
      return key
    },
    commentIssue (key, body) {
      guard()
      issue(key).comments.push(body)
    },
  }
}
