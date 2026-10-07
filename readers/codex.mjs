// Codex's sessions, read into rig's session format (hugoforte/rig#322). A reader is the one
// place that knows a host's files; `bin/` knows none (decision 19), and asks a reader by name.
//
// Codex files a session by the date it started (`sessions/YYYY/MM/DD/rollout-….jsonl`), so where
// a file is kept says nothing about which work it was. One entry a line, each `{ timestamp, type,
// payload }`: a `session_meta` first, with the session's id, the folder it started in and its git
// branch; a `turn_context` per turn with the folder it ran in; `event_msg` entries for what the
// user and the agent said, an interrupted turn and a compaction; and `response_item` entries for
// each tool call and its output, matched by `call_id`.

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

const distinct = list => [...new Set(list.filter(v => typeof v === 'string' && v))]

// What the finder needs to place a session: where it ran, on which branches, and when, from the
// session's own entries — `session_meta` and each `turn_context` — and never from a field nested
// in what a tool was given or gave back; and what the session did — the user's words and what
// its tools were given — as `acted`, the text a work's folder is looked for in.
export function meta (text) {
  const at = []
  const cwds = []
  const branches = []
  const acted = []
  let head = null
  for (const e of entries(text)) {
    const p = e.payload ?? {}
    if (typeof e.timestamp === 'string') at.push(e.timestamp)
    if (e.type === 'session_meta' && !head) {
      head = p
      branches.push(p.git?.branch)
    }
    if (e.type === 'session_meta' || e.type === 'turn_context') cwds.push(p.cwd)
    if (e.type === 'event_msg' && p.type === 'user_message') acted.push(p.message)
    if (e.type === 'response_item' && p.type === 'function_call') acted.push(p.arguments)
    if (e.type === 'response_item' && p.type === 'custom_tool_call') acted.push(p.input)
  }
  at.sort()
  return {
    session: head?.id ?? head?.session_id ?? null,
    // A session another agent spawned names its parent in the source it was started from.
    subagent: typeof head?.source === 'object' && head.source !== null && 'subagent' in head.source,
    startedAt: at[0] ?? null,
    endedAt: at.at(-1) ?? null,
    cwds: distinct(cwds),
    // A detached HEAD is no branch of anyone's.
    branches: distinct(branches).filter(b => b !== 'HEAD'),
    acted: acted.filter(a => typeof a === 'string').join('\n'),
  }
}

const textOf = output => typeof output === 'string'
  ? output
  : Array.isArray(output) ? output.map(o => o.text ?? '').join('\n') : ''

const lastParagraph = text => text.trim().split(/\n\s*\n/).at(-1) ?? ''

const parsed = json => { try { return JSON.parse(json) } catch { return {} } }

// A call's input, with the shell command it ran as `command` where there is one: Codex's shell
// tools take it as `cmd` or `command`, and its scripting tool as code that names it.
function inputOf (p) {
  if (p.type === 'custom_tool_call') return { command: String(p.input ?? '') }
  const args = parsed(p.arguments ?? '{}')
  const command = args.cmd ?? args.command
  return { ...args, ...(command ? { command: Array.isArray(command) ? command.join(' ') : String(command) } : {}) }
}

// A tool's output that says it failed: a non-zero exit, or a script that did not complete.
const failed = text => /\bExit code:? ?[1-9]\d*\b|^Script (failed|error)/m.test(text)

// A command Codex refused to run: its approval policy or its sandbox said no, and the output says
// so before anything ran.
const refused = text => /CreateProcess \{ message: "Rejected\(/.test(text)

// The session as rig's events, in the order they happened: the same kinds the Claude Code reader
// gives.
export function events (text) {
  const out = []
  const calls = new Map()
  let said = ''
  for (const e of entries(text)) {
    const at = e.timestamp ?? null
    const p = e.payload ?? {}
    if (e.type === 'compacted') { out.push({ at, kind: 'compact' }); continue }
    if (e.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string' && p.message.trim()) {
        out.push({ at, kind: 'prompt', text: p.message.trim(), after: lastParagraph(said) })
      } else if (p.type === 'agent_message' && typeof p.message === 'string') said = p.message
      else if (p.type === 'turn_aborted' && p.reason === 'interrupted') out.push({ at, kind: 'interrupt', after: lastParagraph(said) })
      else if (p.type === 'error' || p.type === 'stream_error') out.push({ at, kind: 'limit', text: String(p.message ?? '') })
      continue
    }
    if (e.type !== 'response_item') continue
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const call = { name: p.name, input: inputOf(p) }
      calls.set(p.call_id, call)
      out.push({ at, kind: 'call', ...call })
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const t = textOf(p.output)
      const call = calls.get(p.call_id) ?? null
      if (refused(t)) out.push({ at, kind: 'denial', call, text: t })
      else if (failed(t)) out.push({ at, kind: 'error', call, text: t })
    }
  }
  return out
}
