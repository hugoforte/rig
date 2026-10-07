// One session as a digest a reader can afford, with its secrets taken out (hugoforte/rig#322).
// A reader turns a host's file into events; the digest and the redaction are the same for every
// host. The fixtures are synthetic, and so is every secret in them: none was ever real.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { events, meta } from '../readers/claude-code.mjs'
import { digest } from '../bin/extract.mjs'
import { redact } from '../bin/redact.mjs'

// Claude Code's entries, one a line, as the host writes them.
const at = m => `2026-10-01T10:${String(m).padStart(2, '0')}:00.000Z`
const user = (m, content, over = {}) => ({ type: 'user', sessionId: 's1', cwd: '/w/refunds', gitBranch: 'feat/refunds', timestamp: at(m), message: { role: 'user', content }, ...over })
const assistant = (m, content) => ({ type: 'assistant', sessionId: 's1', cwd: '/w/refunds', gitBranch: 'feat/refunds', timestamp: at(m), message: { role: 'assistant', content } })
const said = text => ({ type: 'text', text })
const call = (id, name, input) => ({ type: 'tool_use', id, name, input })
const result = (id, content, isError = false) => [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }]
const session = entries => entries.map(e => JSON.stringify(e)).join('\n')

const text = session([
  user(0, 'Fix the refund retry'),
  assistant(1, [said('First paragraph.\n\nShall I merge it?'), call('t1', 'Bash', { command: 'gh pr merge 7 --squash' })]),
  user(2, result('t1', 'The user doesn\'t want to proceed with this tool use.', true), { toolDenialKind: 'user-rejected' }),
  user(3, [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
  user(4, 'no, not like that <t3_context>a long block the host adds</t3_context>'),
  assistant(5, [call('t2', 'Bash', { command: 'npm test' })]),
  user(6, result('t2', 'Exit code 2\nTypeError: x is undefined', true)),
  assistant(7, [call('t3', 'Bash', { command: 'grep -c TODO notes.md' })]),
  user(8, result('t3', 'Exit code 1', true)),
  assistant(9, [call('t4', 'Edit', { file_path: '/w/refunds/billing/src/refund.js' })]),
  user(50, '<command-name>/rig</command-name>'),
  { type: 'assistant', isApiErrorMessage: true, timestamp: at(51), message: { content: [said('API Error: 529 overloaded')] } },
  user(52, 'Continue from where you left off.'),
  user(53, 'here is the key sk-abcdefghijklmnopqrstuvwx and AKIAABCDEFGHIJKLMNOP'),
])

test('the Claude Code reader gives the session as events, in the order they happened', () => {
  assert.deepEqual(events(text).map(e => e.kind), ['prompt', 'call', 'denial', 'interrupt', 'prompt', 'call', 'error', 'call', 'error', 'call', 'command', 'limit', 'prompt', 'prompt'])
})

test('a prompt carries the last paragraph of what the assistant had said before it', () => {
  assert.equal(events(text).find(e => e.kind === 'interrupt').after, 'Shall I merge it?')
})

test('a denial is told by the host\'s own marker, with the call it refused', () => {
  const denial = events(text).find(e => e.kind === 'denial')
  assert.equal(denial.call.input.command, 'gh pr merge 7 --squash')
})

const d = digest({ meta: meta(text), events: events(text), reader: 'claude-code' })

test('the digest says where and when the session ran, and the folders its tools touched', () => {
  assert.match(d, /ran in: \/w\/refunds · branches: feat\/refunds · 2026-10-01 10:00 → 2026-10-01 10:53/)
  assert.match(d, /touched: \/w\/refunds\/billing\/src/)
})

test('the digest keeps what the user said, the interrupts, denials, errors and limits', () => {
  for (const line of [/USER: Fix the refund retry/, /\(assistant had said: Shall I merge it\?\)/, /DENIED gh pr merge 7 --squash/, /INTERRUPTED after: Shall I merge it\?/, /TOOL ERROR npm test\n {4}Exit code 2 TypeError/, /COMMAND <command-name>\/rig/, /LIMIT API Error: 529/, /RESUMED: Continue from where you left off/]) {
    assert.match(d, line)
  }
})

test('an irreversible command gets a line of its own', () => {
  assert.match(d, /ACTION gh pr merge 7 --squash/)
})

test('a non-zero exit that says nothing went wrong is left out, and so is what the host wraps round a prompt', () => {
  assert.doesNotMatch(d, /grep -c TODO/)
  assert.doesNotMatch(d, /a long block the host adds/)
})

test('a long gap between turns is marked', () => {
  assert.match(d, /— idle 41m —/)
})

test('the digest is redacted, what the user pasted included', () => {
  assert.doesNotMatch(d, /sk-abcdefghijklmnopqrstuvwx|AKIAABCDEFGHIJKLMNOP/)
  assert.match(d, /here is the key \[redacted\] and \[redacted\]/)
})

test('a terminal\'s colours in a tool\'s output are left out', () => {
  const coloured = session([assistant(0, [call('c', 'Bash', { command: 'rig status' })]), user(1, result('c', 'Exit code 2\n\u001b[31m✗\u001b[0m not inside a work', true))])
  assert.match(digest({ meta: meta(coloured), events: events(coloured), reader: 'claude-code' }), /Exit code 2 ✗ not inside a work/)
})

test('redaction takes out each kind of secret a session was found to hold, and keeps the name it was given', () => {
  const cases = [
    ['Server=db;User Id=sa;Password=Hunter2!;', 'Server=db;User Id=sa;Password=[redacted];'],
    ['https://me:hunter22@git.example.com/repo', 'https://[redacted]@git.example.com/repo'],
    ['GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123', 'GITHUB_TOKEN=[redacted]'],
    ['"password": "correct-horse"', '"password": "[redacted]"'],
    ['api_key: 0123456789abcdef', 'api_key: [redacted]'],
    ['Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijkl', 'Bearer [redacted]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', '[redacted]'],
    ['xoxb-1234567890-abcdefghij', '[redacted]'],
  ]
  for (const [secret, expected] of cases) assert.equal(redact(secret), expected)
})

test('redaction leaves ordinary text alone', () => {
  const ordinary = 'max_tokens=4096; the password reset page; git push origin feat/x'
  assert.equal(redact(ordinary), ordinary)
})
