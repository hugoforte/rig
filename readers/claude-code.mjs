// Claude Code's sessions, read into rig's session format (hugoforte/rig#322). A reader is the one
// place that knows a host's files; `bin/` knows none (decision 19), and asks a reader by name.
//
// A session is a JSONL file, one entry a line. Every entry about a turn carries the session's
// id (`sessionId`), when it was written (`timestamp`), the folder the session ran in (`cwd`)
// and the branch checked out there (`gitBranch`). A subagent's session is a file of its own
// whose entries are marked `isSidechain` and carry the id of the session that spawned it.

// Every value of a top-level string field, in the order written. Read from the text rather than
// line by line through JSON.parse: a session runs to megabytes, and the finder reads every one
// on the machine. A field inside a string, such as a tool's output, is escaped there and never
// matches.
const values = (text, key) => [...text.matchAll(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g'))].map(m => JSON.parse(`"${m[1]}"`))
const distinct = list => [...new Set(list.filter(Boolean))]

const textOf = content => typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : ''

const lastParagraph = text => text.trim().split(/\n\s*\n/).at(-1) ?? ''

// The session as rig's events, in the order they happened. Each carries `at` and a `kind`:
// `prompt` (the user's text, `after` the last paragraph of the assistant's message before it),
// `command` (a slash command), `interrupt`, `call` (a tool's `name` and `input`), `denial` and
// `error` (with the `call` they answered and the host's `text`), `limit` (the host could not
// answer: an API error or a usage limit) and `compact` (the conversation was summarised).
export function events (text) {
  const out = []
  const calls = new Map()
  let said = ''
  for (const line of text.split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    const at = e.timestamp ?? null
    if (e.isCompactSummary || e.subtype === 'compact_boundary') { out.push({ at, kind: 'compact' }); continue }
    if (e.isMeta) continue
    const content = e.message?.content
    if (e.type === 'assistant') {
      if (e.isApiErrorMessage) { out.push({ at, kind: 'limit', text: textOf(content) }); continue }
      for (const c of Array.isArray(content) ? content : []) {
        if (c.type === 'text' && c.text.trim()) said = c.text
        if (c.type === 'tool_use') {
          const call = { name: c.name, input: c.input ?? {} }
          calls.set(c.id, call)
          out.push({ at, kind: 'call', ...call })
        }
      }
      continue
    }
    if (e.type !== 'user') continue
    const results = Array.isArray(content) ? content.filter(c => c.type === 'tool_result') : []
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

// What the finder needs to place a session: where it ran, on which branches, and when.
export function meta (text) {
  const at = values(text, 'timestamp').sort()
  return {
    session: values(text, 'sessionId')[0] ?? null,
    subagent: /"isSidechain":true/.test(text),
    startedAt: at[0] ?? null,
    endedAt: at.at(-1) ?? null,
    cwds: distinct(values(text, 'cwd')),
    // A detached HEAD is no branch of anyone's.
    branches: distinct(values(text, 'gitBranch')).filter(b => b !== 'HEAD'),
  }
}
