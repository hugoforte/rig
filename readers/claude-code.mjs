// Claude Code's sessions, read into rig's session format (hugoforte/rig#322). A reader is the one
// place that knows a host's files; `bin/` knows none (decision 19), and asks a reader by name.
//
// A session is a JSONL file, one entry a line. Every entry about a turn carries the session's
// id (`sessionId`), when it was written (`timestamp`), the folder the session ran in (`cwd`)
// and the branch checked out there (`gitBranch`). A subagent's session is a file of its own
// whose entries are marked `isSidechain` and carry the id of the session that spawned it.

// Each entry that reads, one a line. A line cut off — the host killed mid-write — is skipped,
// never the session.
function * entries (text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e && typeof e === 'object') yield e
  }
}

const textOf = content => typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : ''

const lastParagraph = text => text.trim().split(/\n\s*\n/).at(-1) ?? ''
const distinct = list => [...new Set(list.filter(v => typeof v === 'string' && v))]

// What the finder needs to place a session: where it ran, on which branches, and when, from each
// entry's own fields and never from a field nested in what a tool was given or gave back; and what
// the session did — the user's words and what its tools were given — as `acted`, the text a work's
// folder is looked for in. What tools printed is left out: a session that only listed or read
// other works' paths did none of their work.
export function meta (text) {
  const at = []
  const cwds = []
  const branches = []
  const acted = []
  let session = null
  let subagent = false
  for (const e of entries(text)) {
    if (typeof e.timestamp === 'string') at.push(e.timestamp)
    if (typeof e.cwd === 'string') cwds.push(e.cwd)
    // A detached HEAD is no branch of anyone's.
    if (typeof e.gitBranch === 'string' && e.gitBranch !== 'HEAD') branches.push(e.gitBranch)
    if (session === null && typeof e.sessionId === 'string') session = e.sessionId
    if (e.isSidechain === true) subagent = true
    const content = e.message?.content
    if (e.type === 'user' && !(Array.isArray(content) && content.some(c => c?.type === 'tool_result'))) acted.push(textOf(content))
    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c?.type === 'tool_use') acted.push(JSON.stringify(c.input ?? {}))
    }
  }
  at.sort()
  return { session, subagent, startedAt: at[0] ?? null, endedAt: at.at(-1) ?? null, cwds: distinct(cwds), branches: distinct(branches), acted: acted.join('\n') }
}

// The session as rig's events, in the order they happened. Each carries `at` and a `kind`:
// `prompt` (the user's text, `after` the last paragraph of the assistant's message before it),
// `command` (a slash command), `interrupt`, `call` (a tool's `name` and `input`), `denial` and
// `error` (with the `call` they answered and the host's `text`), `limit` (the host could not
// answer: an API error or a usage limit) and `compact` (the conversation was summarised).
export function events (text) {
  const out = []
  const calls = new Map()
  let said = ''
  for (const e of entries(text)) {
    const at = e.timestamp ?? null
    if (e.isCompactSummary || e.subtype === 'compact_boundary') { out.push({ at, kind: 'compact' }); continue }
    if (e.isMeta) continue
    const content = e.message?.content
    if (e.type === 'assistant') {
      if (e.isApiErrorMessage) { out.push({ at, kind: 'limit', text: textOf(content) }); continue }
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) said = c.text
        if (c?.type === 'tool_use') {
          const call = { name: c.name, input: c.input ?? {} }
          calls.set(c.id, call)
          out.push({ at, kind: 'call', ...call })
        }
      }
      continue
    }
    if (e.type !== 'user') continue
    const results = Array.isArray(content) ? content.filter(c => c?.type === 'tool_result') : []
    if (results.length) {
      for (const r of results) {
        const call = calls.get(r.tool_use_id) ?? null
        if (e.toolDenialKind) out.push({ at, kind: 'denial', call, text: textOf(r.content) })
        else if (r.is_error) out.push({ at, kind: 'error', call, text: textOf(r.content) })
      }
      continue
    }
    const t = textOf(content).trim()
    if (!t) continue
    if (t.startsWith('[Request interrupted')) out.push({ at, kind: 'interrupt', after: lastParagraph(said) })
    else if (t.startsWith('<command-name>')) out.push({ at, kind: 'command', text: t })
    else out.push({ at, kind: 'prompt', text: t, after: lastParagraph(said) })
  }
  return out
}
