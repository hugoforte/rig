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
const other = path.join(home, 'w', 'unrelated')
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

test('another work\'s sessions are never among them', () => {
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
  assert.deepEqual(transcriptsFor({ patterns: [], workspaces: [work], home }), { found: [], unscoped: [] })
})

test('a pattern that does not name the workspace is refused: it would read every work\'s sessions', () => {
  const { found, unscoped } = transcriptsFor({ patterns: ['~/.host/projects/*/*.jsonl'], workspaces: [work], home })
  assert.deepEqual({ found, unscoped }, { found: [], unscoped: ['~/.host/projects/*/*.jsonl'] })
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
  assert.match(r.out, /names no workspace — it would read every work's sessions; put \{slug\} where the workspace goes/)
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
  const r = m.rig(['close', '--work', 'mine'], { env: { ...m.env, RIG_TEST_SESSION_ID: 'abc-123' } })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /may still be working/)
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
