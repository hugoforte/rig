// Codex's sessions, read into rig's format (hugoforte/rig#322): placed in a work by what they
// record, though Codex files them by date, and given as the same events the Claude Code reader
// gives. The fixtures are synthetic, laid out and written the way Codex writes them.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { events, meta } from '../readers/codex.mjs'
import { readSessions, sessionsFor } from '../bin/sessions.mjs'
import { extractOf } from '../bin/extract.mjs'

const at = m => `2026-10-01T10:${String(m).padStart(2, '0')}:00.000Z`
const line = (m, type, payload) => JSON.stringify({ timestamp: at(m), type, payload })
const head = (cwd, branch = 'main', over = {}) => line(0, 'session_meta', { id: 'cx-1', timestamp: at(0), cwd, git: { commit_hash: 'abc', branch }, ...over })

const text = (cwd, branch) => [
  head(cwd, branch),
  line(1, 'turn_context', { cwd }),
  line(2, 'event_msg', { type: 'user_message', message: 'Fix the refund retry' }),
  line(3, 'event_msg', { type: 'agent_message', message: 'Looking.\n\nShall I push it?' }),
  line(4, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ cmd: 'git push --force origin feat/refunds' }), call_id: 'c1' }),
  line(5, 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'Exit code: 1\nWall time: 0.4 seconds\nOutput:\nrejected' }),
  line(6, 'event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
  line(7, 'response_item', { type: 'custom_tool_call', name: 'exec', input: 'await tools.exec_command({"cmd":"npm test"})', call_id: 'c2' }),
  line(8, 'response_item', { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'Script completed\nExit code: 0' }] }),
  line(9, 'compacted', { message: 'summary' }),
].join('\n')

test('the Codex reader says where a session ran, on which branch, and when', () => {
  const m = meta(text('/w/refunds', 'feat/refunds'))
  assert.deepEqual({ ...m, acted: undefined }, { session: 'cx-1', subagent: false, startedAt: at(0), endedAt: at(9), cwds: ['/w/refunds'], branches: ['feat/refunds'], acted: undefined })
})

test('what a Codex session did is what the user said and what its tools were given, never what they printed', () => {
  const m = meta(text('/w/refunds'))
  assert.match(m.acted, /Fix the refund retry/)
  assert.match(m.acted, /git push --force origin feat\/refunds/)
  assert.doesNotMatch(m.acted, /rejected/)
})

test('the Codex reader gives the same events as any reader: prompts, calls, failures, interrupts, compactions', () => {
  assert.deepEqual(events(text('/w/refunds')).map(e => e.kind), ['prompt', 'call', 'error', 'interrupt', 'call', 'compact'])
})

test('a Codex call carries the shell command it ran, so the extract can tell an irreversible one', () => {
  const t = text('/w/refunds')
  const d = extractOf({ meta: meta(t), events: events(t), reader: 'codex' })
  assert.match(d, /ACTION git push --force origin feat\/refunds/)
  assert.match(d, /INTERRUPTED after: Shall I push it\?/)
})

test('a command Codex refused to run is a denial, with the call it refused', () => {
  const t = [
    head('/w/refunds'),
    line(1, 'response_item', { type: 'custom_tool_call', name: 'exec', input: 'await tools.exec_command({"cmd":"git reset --hard"})', call_id: 'c1' }),
    line(2, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'Script failed\nScript error: exec_command failed: CreateProcess { message: "Rejected(\\"blocked by policy\\")" }' }),
  ].join('\n')
  const denial = events(t).find(e => e.kind === 'denial')
  assert.match(denial.call.input.command, /git reset --hard/)
})

test('a Codex session filed by date is placed in the work it ran in', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-codex-'))
  after(() => fs.rmSync(home, { recursive: true, force: true }))
  const work = path.join(home, 'w', 'refunds')
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '01')
  fs.mkdirSync(dir, { recursive: true })
  const mine = path.join(dir, 'rollout-a.jsonl')
  fs.writeFileSync(mine, text(path.join(work, 'billing')))
  fs.writeFileSync(path.join(dir, 'rollout-b.jsonl'), text(path.join(home, 'w', 'other')))
  const found = sessionsFor(readSessions({ sources: [{ glob: '~/.codex/sessions/*/*/*/*.jsonl', reader: 'codex' }], home }), { folder: work })
  assert.deepEqual(found.map(f => f.path), [mine])
})
