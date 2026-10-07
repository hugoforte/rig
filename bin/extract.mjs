// One session as a digest a reader can afford (hugoforte/rig#322): what the user said and what
// the assistant had just said before it, the interrupts, denials and tool errors with the call
// each answered, the irreversible actions, the host's limits, and the gaps. A pilot over one
// machine's sessions shrank 461 MB of transcripts to 0.6 M characters this way, and six readers
// read all of it in about five minutes. A reader under `readers/` turns a host's files into the
// events; everything here is the same for every host. The whole digest is redacted last.
import path from 'node:path'

import { redact } from './redact.mjs'

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)
const flat = s => (s ?? '').replace(/\s+/g, ' ').trim()
const hhmm = at => (at ?? '').slice(0, 16).replace('T', ' ')

// What a host wraps around the user's text, which is no part of what they said.
const WRAPPERS = /<(t3_context|system-reminder|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g

// A call's text: the command a shell ran, or the tool and its input.
const commandOf = call => (typeof call?.input?.command === 'string' ? call.input.command : null)
const callText = call => (call ? clip(flat(commandOf(call) ?? `${call.name} ${JSON.stringify(call.input)}`), 300) : '?')

// Commands that cannot be taken back, or that reach someone else: what a reader most often went
// back to the raw session for.
const IRREVERSIBLE = [
  /\bgh\s+pr\s+(merge|close)\b/, /\bgh\s+stack\s+merge\b/, /\bgh\s+issue\s+(close|create|delete)\b/, /\bgh\s+repo\s+delete\b/,
  /\bgh\s+api\b.*-X\s*(DELETE|POST|PATCH|PUT)\b/i,
  /\bgit\s+push\b.*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s--delete\b|\s:\S)/, /\bgit\s+branch\s+-D\b/, /\bgit\s+reset\s+--hard\b/,
  /\brig\s+close\b/, /\brig\s+new\b.*--ticket\b/, /\btwg\b.*\b(create|transition)\b/,
  /\brm\s+-[a-z]*r[a-z]*f|\bRemove-Item\b.*-Recurse/i,
]
const irreversible = call => { const c = commandOf(call); return !!c && IRREVERSIBLE.some(p => p.test(c)) }

// A non-zero exit that says nothing went wrong: a search that found nothing, a comparison that
// differed, a check reporting what it found. The readers asked for these to go.
// Hosts write the exit as `Exit code 1` or `Exit code: 1`.
const benign = e => /^Exit code:? 1\s*$/.test(e.text.trim()) || (/\bExit code:? 1\b/.test(e.text) && /(^|[\s;&|(])(grep|rg|diff|test|\[)\s|rig doctor|node --test/.test(commandOf(e.call) ?? ''))

const IDLE_MINUTES = 30
const span = ms => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m` }

// The folders the session's tools wrote or read in, most used first.
function touched (events) {
  const counts = new Map()
  for (const e of events.filter(e => e.kind === 'call')) {
    const file = e.input?.file_path ?? e.input?.path ?? e.input?.notebook_path
    if (typeof file === 'string' && file) counts.set(path.dirname(file), (counts.get(path.dirname(file)) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([dir]) => dir)
}

export function digest ({ meta, events, reader }) {
  const lines = [
    `# session ${meta.session ?? '?'}${meta.subagent ? ' (a subagent)' : ''} — ${reader}`,
    `ran in: ${meta.cwds.join(', ') || '?'} · branches: ${meta.branches.join(', ') || '—'} · ${hhmm(meta.startedAt)} → ${hhmm(meta.endedAt)}`,
  ]
  const dirs = touched(events)
  if (dirs.length) lines.push(`touched: ${dirs.join(', ')}`)
  lines.push('')
  let last = null
  for (const e of events) {
    if (last && e.at && Date.parse(e.at) - Date.parse(last) > IDLE_MINUTES * 60000) lines.push(`— idle ${span(Date.parse(e.at) - Date.parse(last))} —`)
    if (e.at) last = e.at
    const ts = `[${hhmm(e.at)}]`
    if (e.kind === 'prompt') {
      const said = e.text.replace(WRAPPERS, '').trim()
      if (!said) continue
      if (/^continue from where you left off/i.test(said)) { lines.push(`${ts} RESUMED: ${clip(flat(said), 200)}`); continue }
      if (e.after) lines.push(`${ts} (assistant had said: ${clip(flat(e.after), 300)})`)
      lines.push(`${ts} USER: ${clip(said, 2500)}`)
    } else if (e.kind === 'command') lines.push(`${ts} COMMAND ${clip(flat(e.text), 400)}`)
    else if (e.kind === 'interrupt') lines.push(`${ts} INTERRUPTED after: ${clip(flat(e.after), 300)}`)
    else if (e.kind === 'denial') lines.push(`${ts} DENIED ${callText(e.call)}\n    ${clip(flat(e.text), 400)}`)
    else if (e.kind === 'error' && !benign(e)) lines.push(`${ts} TOOL ERROR ${callText(e.call)}\n    ${clip(flat(e.text), 300)}`)
    else if (e.kind === 'call' && irreversible(e)) lines.push(`${ts} ACTION ${callText(e)}`)
    else if (e.kind === 'limit') lines.push(`${ts} LIMIT ${clip(flat(e.text), 300)}`)
    else if (e.kind === 'compact') lines.push('— compacted —')
  }
  // A terminal's colours, which tools' output carries, are noise to a reader.
  return redact(`${lines.join('\n')}\n`.replace(/\x1b\[[0-9;]*m/g, ''))
}
