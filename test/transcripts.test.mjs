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
