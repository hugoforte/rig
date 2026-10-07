// Finding a work's own agent sessions (hugoforte/rig#291, #322), so the lesson review can read
// the conversations that did the work and a close can name one still at work. Where a host keeps
// them is the machine's to say, as `sessions` in `rig.local.json`; a reader under `readers/`
// knows each host's files, and `bin/` knows none. The fixtures are synthetic: files laid out
// and written the way a host would, never anybody's real sessions.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { mentions, readSessions, sessionFiles, sessionsFor, sourcesProblem } from '../bin/sessions.mjs'
import { meta } from '../readers/claude-code.mjs'
import { billingInstall } from './billing-install.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-sessions-'))
after(() => fs.rmSync(home, { recursive: true, force: true }))

// A Claude Code session: one entry a line, each carrying the session's id, the folder it ran
// in, the branch checked out there and when it was written.
const entry = ({ id = 's', cwd, branch = 'main', at = '2026-10-01T10:00:00.000Z', text = 'synthetic', sidechain = false }) =>
  JSON.stringify({ type: 'user', isSidechain: sidechain, sessionId: id, cwd, gitBranch: branch, timestamp: at, message: { role: 'user', content: text } })

let n = 0
const session = (lines, folder = 'projects') => {
  const dir = path.join(home, '.host', folder, `p${n++}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, lines.map(entry).join('\n') + '\n')
  return file
}

const SOURCES = [{ glob: '~/.host/projects/*/*.jsonl', reader: 'claude-code' }]
const work = path.join(home, 'w', 'refunds')
const billing = path.join(work, 'billing')
const BRANCH = 'feat/refunds'
const WORK = { folder: work, branches: [BRANCH], repos: ['billing'] }
const placedIn = ({ since = null, ...over } = {}) => sessionsFor(readSessions({ sources: SOURCES, home, since }), { ...WORK, ...over })
const found = over => placedIn(over).map(s => s.path)

const inWork = session([{ cwd: work }])
const inBilling = session([{ cwd: path.join(billing, 'src') }])
const onBranch = session([{ cwd: path.join(home, 'source', 'billing'), branch: BRANCH }])
const naming = session([{ cwd: path.join(home, 'tool'), text: `cd ${billing} && npm test` }])
const elsewhere = session([{ cwd: path.join(home, 'w', 'refunds-old') }])
const namingOther = session([{ cwd: path.join(home, 'tool'), text: `ls ${path.join(home, 'w', 'refunds-old')}` }])
const branchElsewhere = session([{ cwd: path.join(home, 'source', 'payroll'), branch: BRANCH }])

// A session whose tools only printed the work's folder: a listing, or an extract of another session.
const printed = (() => {
  const dir = path.join(home, '.host', 'projects', `p${n++}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'assistant', sessionId: 'p', cwd: path.join(home, 'tool'), timestamp: '2026-10-01T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'rig list' } }] } }),
    JSON.stringify({ type: 'user', sessionId: 'p', cwd: path.join(home, 'tool'), timestamp: '2026-10-01T10:01:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: `ran in: ${billing}` }] } }),
  ].join('\n') + '\n')
  return file
})()

// ------------------------------------------------- the Claude Code reader

test('the Claude Code reader says where a session ran, on which branches, and when', () => {
  const text = [
    entry({ id: 'abc', cwd: 'C:\\w\\a', branch: 'main', at: '2026-10-01T10:00:00.000Z' }),
    entry({ id: 'abc', cwd: 'C:\\w\\a', branch: 'feat/x', at: '2026-10-01T11:00:00.000Z' }),
  ].join('\n')
  const where = { ...meta(text), acted: undefined }
  assert.deepEqual(where, { session: 'abc', subagent: false, startedAt: '2026-10-01T10:00:00.000Z', endedAt: '2026-10-01T11:00:00.000Z', cwds: ['C:\\w\\a'], branches: ['main', 'feat/x'], acted: undefined })
})

test('times written with an offset are the moments they are: started and ended are the earliest and latest instants', () => {
  const text = [entry({ cwd: '/w/a', at: '2026-10-01T11:00:00.000Z' }), entry({ cwd: '/w/a', at: '2026-10-01T12:00:00+02:00' })].join('\n')
  assert.deepEqual([meta(text).startedAt, meta(text).endedAt], ['2026-10-01T10:00:00.000Z', '2026-10-01T11:00:00.000Z'])
})

test('a line cut off mid-write is skipped, and the rest of the session still reads', () => {
  const text = [entry({ id: 'abc', cwd: '/w/a' }), '{"type":"user","cwd":"/w/b","message":"cut', entry({ id: 'abc', cwd: '/w/a', at: '2026-10-01T12:00:00.000Z' })].join('\n')
  assert.deepEqual([meta(text).cwds, meta(text).endedAt], [['/w/a'], '2026-10-01T12:00:00.000Z'])
})

test('a folder a tool was given in a nested field is not where the session ran', () => {
  const text = [entry({ cwd: '/w/a' }), JSON.stringify({ type: 'assistant', cwd: '/w/a', message: { content: [{ type: 'tool_use', id: 't', name: 'mcp', input: { cwd: '/w/payroll', timestamp: '1999-01-01T00:00:00.000Z' } }] } })].join('\n')
  assert.deepEqual([meta(text).cwds, meta(text).startedAt], [['/w/a'], '2026-10-01T10:00:00.000Z'])
})

test('a subagent\'s session is marked as one, under the id of the session that spawned it', () => {
  const m = meta(entry({ id: 'parent', cwd: '/w/a', sidechain: true }))
  assert.deepEqual([m.session, m.subagent], ['parent', true])
})

test('a field named inside a tool\'s output is not where the session ran', () => {
  const text = entry({ cwd: '/w/a', text: '{"cwd":"/w/elsewhere"}' })
  assert.deepEqual(meta(text).cwds, ['/w/a'])
})

test('a detached HEAD is no branch', () => {
  assert.deepEqual(meta(entry({ cwd: '/w/a', branch: 'HEAD' })).branches, [])
})

// ------------------------------------------------- the finder

test('a session that ran in the work folder, or any folder under it, is the work\'s', () => {
  assert.deepEqual(found().filter(f => [inWork, inBilling].includes(f)).sort(), [inWork, inBilling].sort())
})

test('a session on one of the work\'s branches is the work\'s, in another checkout of one of its repos', () => {
  assert.ok(found().includes(onBranch))
})

test('a branch of the same name in a repo the work does not have places nothing', () => {
  assert.ok(!found().includes(branchElsewhere))
})

test('a session that ran elsewhere and names the work\'s folder is the work\'s', () => {
  assert.ok(found().includes(naming))
})

test('a session whose tools only printed the work\'s folder is not the work\'s', () => {
  assert.ok(!found().includes(printed))
})

test('a work whose folder name begins the same is another work, whose sessions are never among them', () => {
  const f = found()
  assert.ok(!f.includes(elsewhere) && !f.includes(namingOther))
})

test('each one says why it is the work\'s', () => {
  const why = Object.fromEntries(placedIn().map(s => [s.path, s.why]))
  assert.deepEqual([why[inWork], why[onBranch], why[naming]], ['ran there', 'on its branch', 'names its folder'])
})

test('a folder is named however a session writes it: escaped in JSON, with forward slashes, or as Git Bash writes a drive', () => {
  const folder = 'C:\\Users\\me\\w\\refunds'
  for (const text of ['"C:\\\\Users\\\\me\\\\w\\\\refunds\\\\billing"', 'C:/Users/me/w/refunds/billing', 'cd /c/Users/me/w/refunds', 'c:\\users\\me\\w\\REFUNDS']) {
    assert.ok(mentions(text, folder), text)
  }
  assert.ok(!mentions('C:\\Users\\me\\w\\refunds-old', folder))
  assert.ok(mentions('I am working in C:\\Users\\me\\w\\refunds.', folder), 'a full stop ends the sentence, not the name')
  assert.ok(!mentions('C:\\Users\\me\\w\\refunds.old', folder))
})

test('a session last written before the moment asked about is not read', () => {
  const t = new Date('2026-01-01T00:00:00Z')
  fs.utimesSync(inWork, t, t)
  try {
    assert.ok(!found({ since: '2026-06-01T00:00:00Z' }).includes(inWork))
  } finally {
    const now = new Date()
    fs.utimesSync(inWork, now, now)
  }
})

test('they come oldest first', () => {
  const t = new Date(Date.now() - 3600 * 1000)
  fs.utimesSync(inBilling, t, t)
  assert.equal(found()[0], inBilling)
})

test('nothing configured finds nothing', () => {
  assert.deepEqual(sessionsFor(readSessions({ sources: [], home }), WORK), [])
})

test('a glob reaches every folder its * matches, a level a segment, and a file named twice is one session', () => {
  const sub = session([{ cwd: work, sidechain: true }], path.join('projects', 'p-sub', 'subagents'))
  const files = sessionFiles({ sources: [...SOURCES, { glob: '~/.host/projects/*/*/*/*.jsonl', reader: 'claude-code' }, ...SOURCES], home }).map(f => f.path)
  assert.ok(files.includes(sub) && files.includes(inWork))
  assert.equal(files.length, new Set(files).size)
})

test('a source is refused unless it is a glob from ~ or a drive and a reader rig ships', () => {
  const file = 'rig.local.json'
  assert.equal(sourcesProblem(undefined, file), null)
  assert.equal(sourcesProblem(SOURCES, file), null)
  assert.match(sourcesProblem('~/.host/*.jsonl', file), /must be a list of \{ "glob", "reader" \}/)
  assert.match(sourcesProblem([{ glob: '~/.host/*.jsonl' }], file), /names the reader "undefined", and rig ships claude-code/)
  assert.match(sourcesProblem([{ glob: '.host/*.jsonl', reader: 'claude-code' }], file), /is relative/)
})

// ------------------------------------------------- rig status --transcripts

const m = billingInstall('rig-sessions-cli-')
after(m.cleanup)
const machineFile = path.join(m.install, 'rig.local.json')
const setMachine = over => fs.writeFileSync(machineFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(machineFile, 'utf8')), ...over }, null, 2))
const hostDir = path.join(m.tmp, 'host')
const hostSources = [{ glob: path.join(hostDir, '*', '*.jsonl'), reader: 'claude-code' }]
let k = 0
const sessionIn = (cwd, name = `s${k++}`, over = {}) => {
  const dir = path.join(hostDir, `p${k++}`)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.jsonl`)
  fs.writeFileSync(file, entry({ id: name, cwd, ...over }) + '\n')
  return file
}
const aged = (file, hours) => { const t = new Date(Date.now() - hours * 3600 * 1000); fs.utimesSync(file, t, t) }

test('status --transcripts prints the work\'s own sessions, one path a line', () => {
  assert.equal(m.rig(['new', 'talked', '--title', 'A work with sessions', '--no-ticket', '--repos', 'billing']).code, 0)
  const expected = [sessionIn(path.join(m.workRoot, 'talked')), sessionIn(m.worktree('talked', 'billing'))]
  sessionIn(path.join(m.workRoot, 'someone-else'))
  setMachine({ sessions: hostSources })
  const r = m.rig(['status', '--transcripts', '--work', 'talked'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.stdout.trim().split(/\r?\n/).sort(), expected.sort())
})

test('a session on the work\'s branch is among them, though it ran in another checkout', () => {
  const branch = JSON.parse(fs.readFileSync(path.join(m.dataRoot, 'work', 'talked', 'work.json'), 'utf8')).branch
  const file = sessionIn(path.join(m.tmp, 'source', 'billing'), undefined, { branch })
  assert.ok(m.rig(['status', '--transcripts', '--work', 'talked']).stdout.includes(file))
})

test('with no session locations on this machine, it says where they would go', () => {
  setMachine({ sessions: undefined })
  const r = m.rig(['status', '--transcripts', '--work', 'talked'])
  assert.equal(r.code, 0, r.out)
  assert.equal(r.stdout.trim(), '')
  assert.match(r.out, /no session locations on this machine — `sessions` in .*rig\.local\.json, such as \[\{ "glob": "~\/\.claude\/projects\/\*\/\*\.jsonl", "reader": "claude-code" \}\]/)
})

test('a sessions value that is not a list of sources is named as the mistake it is', () => {
  for (const value of ['~/.host/*.jsonl', [null], [{ glob: '~/x/*.jsonl', reader: 'nobody' }]]) {
    setMachine({ sessions: value })
    const r = m.rig(['status', '--transcripts', '--work', 'talked'])
    assert.equal(r.code, 1, `${JSON.stringify(value)}: ${r.out}`)
    assert.match(r.out, /`sessions` in .*rig\.local\.json/)
  }
  setMachine({ sessions: undefined })
})

test('the transcripts patterns sessions replaced are named, with what to write instead', () => {
  setMachine({ transcripts: ['~/.claude/projects/{slug}/*.jsonl'] })
  try {
    const r = m.rig(['status', '--transcripts', '--work', 'talked'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /`transcripts` in .*rig\.local\.json gave way to `sessions` — write "sessions": \[\{ "glob": "~\/\.claude\/projects\/\*\/\*\.jsonl", "reader": "claude-code" \}\]/)
  } finally {
    setMachine({ transcripts: undefined })
  }
})

test('a misshapen sessions value stops no listing or close: they say it and go on, and doctor names it', () => {
  setMachine({ sessions: '~/.host/*.jsonl' })
  try {
    assert.equal(m.rig(['list']).code, 0)
    assert.equal(m.rig(['new', 'misshapen', '--title', 'Closed past a bad setting', '--no-ticket']).code, 0)
    const closed = m.rig(['close', '--work', 'misshapen'])
    assert.equal(closed.code, 0, closed.out)
    assert.match(closed.out, /must be a list of \{ "glob", "reader" \}, .* — sessions not checked/)
    assert.match(m.rig(['doctor']).out, /must be a list of \{ "glob", "reader" \}, .* — no session is found until it is/)
  } finally {
    setMachine({ sessions: undefined })
  }
})

test('sessions committed into the org file are not read: where sessions live is the machine\'s', () => {
  const orgFile = path.join(m.dataRoot, 'rig.json')
  const before = fs.readFileSync(orgFile, 'utf8')
  fs.writeFileSync(orgFile, JSON.stringify({ ...JSON.parse(before), sessions: hostSources }, null, 2))
  try {
    assert.equal(m.rig(['status', '--transcripts', '--work', 'talked']).stdout.trim(), '')
  } finally {
    fs.writeFileSync(orgFile, before)
  }
})

test('~ is the home of the run that asks', () => {
  setMachine({ sessions: [{ glob: '~/host/*/*.jsonl', reader: 'claude-code' }] })
  const r = m.rig(['status', '--transcripts', '--work', 'talked'], { env: { ...m.env, USERPROFILE: m.tmp, HOME: m.tmp } })
  assert.ok(r.stdout.trim().split(/\r?\n/).length >= 2, r.out)
})

// ------------------------------------------------- a session still at work (hugoforte/rig#292)

test('close names a session that wrote in a worktree lately, and closes all the same', () => {
  setMachine({ sessions: hostSources, transcriptSession: undefined })
  assert.equal(m.rig(['new', 'busy', '--title', 'A work someone is in', '--no-ticket', '--repos', 'billing']).code, 0)
  sessionIn(m.worktree('busy', 'billing'), 'live')
  const r = m.rig(['close', '--work', 'busy'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: a session wrote live\.jsonl (just now|\d+m ago) — it may still be working there/)
  assert.ok(!fs.existsSync(m.worktree('busy', 'billing')), 'it closed anyway')
})

test('a session with a line cut off mid-write stops no close, and is still named', () => {
  assert.equal(m.rig(['new', 'cutoff', '--title', 'A work with a torn session', '--no-ticket', '--repos', 'billing']).code, 0)
  const file = sessionIn(m.worktree('cutoff', 'billing'), 'torn')
  fs.appendFileSync(file, '{"type":"user","cwd":"C:\\\\w\\\\x","message":"cut\n')
  const r = m.rig(['close', '--work', 'cutoff'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: a session wrote torn\.jsonl/)
})

test('a session that last wrote longer ago than the window is not named', () => {
  assert.equal(m.rig(['new', 'quiet', '--title', 'A work nobody is in', '--no-ticket', '--repos', 'billing']).code, 0)
  aged(sessionIn(m.worktree('quiet', 'billing'), 'old'), 3)
  const r = m.rig(['close', '--work', 'quiet'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /may still be working/)
})

test('a session that started elsewhere and works in the worktree is named too', () => {
  assert.equal(m.rig(['new', 'reached', '--title', 'A work worked on from outside', '--no-ticket', '--repos', 'billing']).code, 0)
  sessionIn(path.join(m.tmp, 'tool'), 'outside', { text: `git -C ${m.worktree('reached', 'billing')} status` })
  const r = m.rig(['close', '--work', 'reached'])
  assert.match(r.out, /billing: a session wrote outside\.jsonl .* — it may still be working there/)
})

test('the session running the command is not named, where the machine says how to tell it', () => {
  setMachine({ transcriptSession: 'RIG_TEST_SESSION_ID' })
  assert.equal(m.rig(['new', 'mine', '--title', 'The work this session is in', '--no-ticket', '--repos', 'billing']).code, 0)
  sessionIn(path.join(m.workRoot, 'mine'), 'abc-123')
  sessionIn(path.join(m.workRoot, 'mine'), 'abc-1234')
  const r = m.rig(['close', '--work', 'mine'], { env: { ...m.env, RIG_TEST_SESSION_ID: 'abc-123' } })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /abc-123\.jsonl/)
  assert.match(r.out, /the work folder: a session wrote abc-1234\.jsonl .* — it may still be working there/, 'by its id, whole, and the work folder is looked in')
})

test('without a way to tell this session, a close that names one says it may be this one', () => {
  setMachine({ transcriptSession: undefined })
  assert.equal(m.rig(['new', 'unsure', '--title', 'Which session', '--no-ticket', '--repos', 'billing']).code, 0)
  sessionIn(path.join(m.workRoot, 'unsure'), 'any')
  const r = m.rig(['close', '--work', 'unsure'])
  assert.match(r.out, /one of them may be this session — `transcriptSession` in .*rig\.local\.json/)
})

test('a close of a work already closed on another machine names a session here, as tidy does', () => {
  for (const [id, cmd] of [['elsewhere', ['close', '--work', 'elsewhere']], ['tidied', ['tidy']]]) {
    assert.equal(m.rig(['new', id, '--title', 'Closed on the other machine', '--no-ticket', '--repos', 'billing']).code, 0)
    sessionIn(m.worktree(id, 'billing'), id)
    const file = path.join(m.dataRoot, 'work', id, 'work.json')
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), closedAt: new Date().toISOString() }, null, 2))
    const r = m.rig(cmd)
    assert.match(r.out, new RegExp(`billing: a session wrote ${id}\\.jsonl`), `${cmd.join(' ')}: ${r.out}`)
  }
})

test('detach names a session that wrote in that worktree lately, and detaches all the same', () => {
  assert.equal(m.rig(['new', 'shared', '--title', 'A worktree in use', '--no-ticket', '--repos', 'billing']).code, 0)
  sessionIn(m.worktree('shared', 'billing'), 'other')
  const r = m.rig(['detach', 'billing', '--work', 'shared'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: a session wrote other\.jsonl (just now|\d+m ago) — it may still be working there/)
})

test('list says it did not look for sessions before calling a work safe to close', () => {
  assert.equal(m.rig(['new', 'listed', '--title', 'Closable', '--no-ticket', '--repos', 'billing']).code, 0)
  const r = m.rig(['list'])
  assert.match(r.out, /listed[\s\S]*?`rig close` would not refuse \(sessions not checked\)/)
})

test('list says both when it looked at neither the stages nor the sessions', () => {
  assert.equal(m.rig(['stage', 'feat/listed-one', '--delivers', 'a slice', '--work', 'listed']).code, 0)
  assert.match(m.rig(['list']).out, /listed[\s\S]*?`rig close` would not refuse \(stages and sessions not checked\)/)
})

// ------------------------------------------------- rig sessions: a period, for a retro (decision 210)

const listed = r => r.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => line.split('\t'))
const PERIOD = ['--since', '2026-09-01', '--until', '2026-11-01']

test('sessions lists every session on the machine in a period, each with the works it belongs to', () => {
  setMachine({ sessions: hostSources })
  const file = sessionIn(m.worktree('talked', 'billing'), 'period-in-work')
  const r = m.rig(['sessions', ...PERIOD])
  assert.equal(r.code, 0, r.out)
  const row = listed(r).find(cells => cells[5] === file)
  assert.deepEqual(row.slice(1, 5), ['claude-code', 'period-in-work', 'main', 'talked'])
})

test('a session that belongs to no work is listed too, as in none', () => {
  const file = sessionIn(path.join(m.tmp, 'scratch'), 'period-no-work')
  const row = listed(m.rig(['sessions', ...PERIOD])).find(cells => cells[5] === file)
  assert.equal(row[4], '-')
})

test('a session that only names a work\'s folder is placed in that work', () => {
  const file = sessionIn(path.join(m.tmp, 'tool'), 'period-naming', { text: `rig status in ${path.join(m.workRoot, 'talked')}` })
  const row = listed(m.rig(['sessions', ...PERIOD])).find(cells => cells[5] === file)
  assert.equal(row[4], 'talked')
})

test('a session outside the period is not listed', () => {
  const file = sessionIn(path.join(m.tmp, 'scratch'), 'period-old', { at: '2026-06-01T10:00:00.000Z' })
  assert.ok(!m.rig(['sessions', ...PERIOD]).stdout.includes(file))
})

test('sessions --extract prints one session as a redacted extract', () => {
  const file = sessionIn(path.join(m.tmp, 'scratch'), 'extracted', { text: 'my token is sk-abcdefghijklmnopqrstuvwx' })
  const r = m.rig(['sessions', '--extract', file])
  assert.equal(r.code, 0, r.out)
  assert.match(r.stdout, /USER: my token is \[redacted\]/)
})

test('sessions --extract refuses a file that is not one of this machine\'s sessions', () => {
  const r = m.rig(['sessions', '--extract', machineFile])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is not one of this machine's sessions/)
})
