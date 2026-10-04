// Finding a work's own session transcripts (hugoforte/rig#291), so the lesson review can read
// the conversations that did the work. Where an agent host keeps them is the machine's to say,
// as patterns in `rig.local.json`; rig knows no host. The fixtures are synthetic: an empty
// folder laid out the way a host would lay one out, never anybody's real sessions.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { slugOf, transcriptsFor } from '../bin/transcripts.mjs'
import { billingInstall } from './billing-install.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-transcripts-'))
after(() => fs.rmSync(home, { recursive: true, force: true }))

const work = path.join(home, 'w', 'refunds')
const billing = path.join(work, 'billing')
const other = path.join(home, 'w', 'refunds-old')
const PATTERN = '~/.host/projects/{slug}/*.jsonl'

const session = (workspace, name) => {
  const dir = path.join(home, '.host', 'projects', slugOf(workspace))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, '{"type":"user","message":"synthetic"}\n')
  return file
}

const inWork = session(work, 'one.jsonl')
const inBilling = session(billing, 'two.jsonl')
const elsewhere = session(other, 'three.jsonl')
session(work, 'notes.txt')

test('a workspace\'s slug is its path with every character but a letter or digit made a dash', () => {
  assert.equal(slugOf('C:\\Users\\me\\w\\refunds'), 'C--Users-me-w-refunds')
})

test('a work\'s transcripts are the sessions whose workspace is its folder or one of its worktrees', () => {
  const { found } = transcriptsFor({ patterns: [PATTERN], workspaces: [work, billing], home })
  assert.deepEqual(found.map(f => f.path).sort(), [inWork, inBilling].sort())
})

test('a work whose folder name begins the same is another work, whose sessions are never among them', () => {
  const { found } = transcriptsFor({ patterns: [PATTERN], workspaces: [work, billing], home })
  assert.ok(!found.some(f => f.path === elsewhere))
})

test('only what the last part of the pattern matches is a transcript', () => {
  const { found } = transcriptsFor({ patterns: [PATTERN], workspaces: [work], home })
  assert.deepEqual(found.map(f => path.basename(f.path)), ['one.jsonl'])
})

test('each one carries when it was last written, which a live session is told by', () => {
  const { found } = transcriptsFor({ patterns: [PATTERN], workspaces: [work], home })
  assert.ok(!Number.isNaN(Date.parse(found[0].modifiedAt)))
})

test('nothing configured finds nothing, and says so', () => {
  assert.deepEqual(transcriptsFor({ patterns: [], workspaces: [work], home }), { found: [], refused: [] })
})

test('a pattern that does not name the workspace is refused: it would read every work\'s sessions', () => {
  const { found, refused } = transcriptsFor({ patterns: ['~/.host/projects/*/*.jsonl'], workspaces: [work], home })
  assert.deepEqual({ found, refused: refused.map(r => r.pattern) }, { found: [], refused: ['~/.host/projects/*/*.jsonl'] })
})

test('a pattern that climbs out of the workspace\'s folder is refused, though it names one', () => {
  const climbing = `~/.host/projects/{slug}/../${slugOf(other)}/*.jsonl`
  const { found, refused } = transcriptsFor({ patterns: [climbing], workspaces: [work], home })
  assert.deepEqual({ found, refused: refused.map(r => r.pattern) }, { found: [], refused: [climbing] })
})

test('a * before the workspace\'s folder is refused, since it matches other workspaces\' folders', () => {
  const { found, refused } = transcriptsFor({ patterns: ['~/.ho*/projects/{slug}/*.jsonl'], workspaces: [work], home })
  assert.deepEqual({ found, refused: refused.length }, { found: [], refused: 1 })
})

test('a relative pattern is refused: a pattern names one place on this machine', () => {
  assert.equal(transcriptsFor({ patterns: ['.host/projects/{slug}/*.jsonl'], workspaces: [work], home }).refused.length, 1)
})

test('a * in a folder below the workspace\'s reaches what a host keeps there, such as its subagents\' sessions', () => {
  const dir = path.join(home, '.host', 'projects', slugOf(work), 'session-1', 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  const sub = path.join(dir, 'agent-a.jsonl')
  fs.writeFileSync(sub, '{"type":"user","message":"synthetic"}\n')
  const { found } = transcriptsFor({ patterns: ['~/.host/projects/{slug}/*/subagents/*.jsonl'], workspaces: [work, billing], home })
  assert.deepEqual(found.map(f => f.path), [sub])
})

test('they come oldest first', () => {
  const t = new Date(Date.now() - 3600 * 1000)
  fs.utimesSync(inBilling, t, t)
  const { found } = transcriptsFor({ patterns: [PATTERN], workspaces: [work, billing], home })
  assert.deepEqual(found.map(f => f.path), [inBilling, inWork])
})

test('a workspace with no folder of sessions finds nothing', () => {
  const { found } = transcriptsFor({ patterns: [PATTERN], workspaces: [path.join(home, 'w', 'never-opened')], home })
  assert.deepEqual(found, [])
})

// ------------------------------------------------- rig status --transcripts

const m = billingInstall('rig-transcripts-cli-')
after(m.cleanup)
const machineFile = path.join(m.install, 'rig.local.json')
const setPatterns = patterns => fs.writeFileSync(machineFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(machineFile, 'utf8')), transcripts: patterns }, null, 2))
const hostDir = path.join(m.tmp, 'host')
const hostPattern = path.join(hostDir, '{slug}', '*.jsonl')
const sessionOf = (workspace, name) => {
  const dir = path.join(hostDir, slugOf(workspace))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), '{"type":"user","message":"synthetic"}\n')
  return path.join(dir, name)
}

test('status --transcripts prints the work\'s own transcripts, one path a line', () => {
  assert.equal(m.rig(['new', 'talked', '--title', 'A work with sessions', '--no-ticket', '--repos', 'billing']).code, 0)
  const folder = path.join(m.workRoot, 'talked')
  const expected = [sessionOf(folder, 'a.jsonl'), sessionOf(m.worktree('talked', 'billing'), 'b.jsonl')]
  sessionOf(path.join(m.workRoot, 'someone-else'), 'c.jsonl')
  setPatterns([hostPattern])
  const r = m.rig(['status', '--transcripts', '--work', 'talked'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.stdout.trim().split(/\r?\n/).sort(), expected.sort())
})

test('with no transcript locations on this machine, it says where they would go', () => {
  setPatterns(undefined)
  const r = m.rig(['status', '--transcripts', '--work', 'talked'])
  assert.equal(r.code, 0, r.out)
  assert.equal(r.stdout.trim(), '')
  assert.match(r.out, /no transcript locations on this machine — `transcripts` in .*rig\.local\.json, such as "~\/\.claude\/projects\/\{slug\}\/\*\.jsonl"/)
})

test('a pattern that names no workspace is refused by name', () => {
  setPatterns([path.join(hostDir, '*', '*.jsonl')])
  const r = m.rig(['status', '--transcripts', '--work', 'talked'])
  assert.equal(r.stdout.trim(), '')
  assert.match(r.out, /finds nothing: it names no workspace — it would read every work's sessions; put \{slug\} as a folder where the workspace goes/)
})

test('a transcripts value that is not a list of patterns is named as the mistake it is', () => {
  for (const value of ['~/.host/{slug}/*.jsonl', [null], [7]]) {
    setPatterns(value)
    const r = m.rig(['status', '--transcripts', '--work', 'talked'])
    assert.equal(r.code, 1, `${JSON.stringify(value)}: ${r.out}`)
    assert.match(r.out, /`transcripts` in .*rig\.local\.json must be a list of patterns/)
  }
})

test('a misshapen transcripts value stops no listing or close: they say it and go on, and doctor names it', () => {
  setPatterns('~/.host/{slug}/*.jsonl')
  try {
    assert.equal(m.rig(['list']).code, 0)
    assert.equal(m.rig(['new', 'misshapen', '--title', 'Closed past a bad setting', '--no-ticket']).code, 0)
    const closed = m.rig(['close', '--work', 'misshapen'])
    assert.equal(closed.code, 0, closed.out)
    assert.match(closed.out, /must be a list of patterns, .* — sessions not checked/)
    assert.match(m.rig(['doctor']).out, /must be a list of patterns, .* — no session is found until it is/)
  } finally {
    setPatterns(undefined)
  }
})

test('patterns committed into the org file are not read: where sessions live is the machine\'s', () => {
  setPatterns(undefined)
  const orgFile = path.join(m.dataRoot, 'rig.json')
  const before = fs.readFileSync(orgFile, 'utf8')
  fs.writeFileSync(orgFile, JSON.stringify({ ...JSON.parse(before), transcripts: [hostPattern] }, null, 2))
  try {
    assert.equal(m.rig(['status', '--transcripts', '--work', 'talked']).stdout.trim(), '')
  } finally {
    fs.writeFileSync(orgFile, before)
  }
})

test('~ is the home of the run that asks', () => {
  setPatterns(['~/host/{slug}/*.jsonl'])
  const r = m.rig(['status', '--transcripts', '--work', 'talked'], { env: { ...m.env, USERPROFILE: m.tmp, HOME: m.tmp } })
  assert.equal(r.stdout.trim().split(/\r?\n/).length, 2, r.out)
})

// ------------------------------------------------- a session still at work (hugoforte/rig#292)

const setMachine = over => fs.writeFileSync(machineFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(machineFile, 'utf8')), ...over }, null, 2))
const aged = (file, hours) => { const t = new Date(Date.now() - hours * 3600 * 1000); fs.utimesSync(file, t, t) }

test('close names a session that wrote in a worktree lately, and closes all the same', () => {
  setMachine({ transcripts: [hostPattern], transcriptSession: undefined })
  assert.equal(m.rig(['new', 'busy', '--title', 'A work someone is in', '--no-ticket', '--repos', 'billing']).code, 0)
  sessionOf(m.worktree('busy', 'billing'), 'live.jsonl')
  const r = m.rig(['close', '--work', 'busy'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: a session wrote live\.jsonl (just now|\d+m ago) — it may still be working there/)
  assert.ok(!fs.existsSync(m.worktree('busy', 'billing')), 'it closed anyway')
})

test('a session that last wrote longer ago than the window is not named', () => {
  assert.equal(m.rig(['new', 'quiet', '--title', 'A work nobody is in', '--no-ticket', '--repos', 'billing']).code, 0)
  aged(sessionOf(m.worktree('quiet', 'billing'), 'old.jsonl'), 3)
  const r = m.rig(['close', '--work', 'quiet'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /may still be working/)
})

test('the session running the command is not named, where the machine says how to tell it', () => {
  setMachine({ transcriptSession: 'RIG_TEST_SESSION_ID' })
  assert.equal(m.rig(['new', 'mine', '--title', 'The work this session is in', '--no-ticket', '--repos', 'billing']).code, 0)
  sessionOf(path.join(m.workRoot, 'mine'), 'abc-123.jsonl')
  sessionOf(path.join(m.workRoot, 'mine'), 'abc-1234.jsonl')
  const r = m.rig(['close', '--work', 'mine'], { env: { ...m.env, RIG_TEST_SESSION_ID: 'abc-123' } })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /abc-123\.jsonl/)
  assert.match(r.out, /the work folder: a session wrote abc-1234\.jsonl .* — it may still be working there/, 'by its id, whole, and the work folder is looked in')
})

test('without a way to tell this session, a close that names one says it may be this one', () => {
  setMachine({ transcriptSession: undefined })
  assert.equal(m.rig(['new', 'unsure', '--title', 'Which session', '--no-ticket', '--repos', 'billing']).code, 0)
  sessionOf(path.join(m.workRoot, 'unsure'), 'any.jsonl')
  const r = m.rig(['close', '--work', 'unsure'])
  assert.match(r.out, /one of them may be this session — `transcriptSession` in .*rig\.local\.json/)
})

test('a close says a pattern that cannot look finds nothing, so its silence is not read as no session', () => {
  setMachine({ transcripts: [hostPattern, path.join(hostDir, '*', '*.jsonl')] })
  assert.equal(m.rig(['new', 'misset', '--title', 'A pattern refused', '--no-ticket', '--repos', 'billing']).code, 0)
  const r = m.rig(['close', '--work', 'misset'])
  assert.match(r.out, /transcripts: ".*" finds nothing: it names no workspace/)
  setMachine({ transcripts: [hostPattern] })
})

test('a close of a work already closed on another machine names a session here, as tidy does', () => {
  for (const [id, cmd] of [['elsewhere', ['close', '--work', 'elsewhere']], ['tidied', ['tidy']]]) {
    assert.equal(m.rig(['new', id, '--title', 'Closed on the other machine', '--no-ticket', '--repos', 'billing']).code, 0)
    sessionOf(m.worktree(id, 'billing'), `${id}.jsonl`)
    const file = path.join(m.dataRoot, 'work', id, 'work.json')
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), closedAt: new Date().toISOString() }, null, 2))
    const r = m.rig(cmd)
    assert.match(r.out, new RegExp(`billing: a session wrote ${id}\\.jsonl`), `${cmd.join(' ')}: ${r.out}`)
  }
})

test('detach names a session that wrote in that worktree lately, and detaches all the same', () => {
  assert.equal(m.rig(['new', 'shared', '--title', 'A worktree in use', '--no-ticket', '--repos', 'billing']).code, 0)
  sessionOf(m.worktree('shared', 'billing'), 'other.jsonl')
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
