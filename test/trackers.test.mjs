// Which tracker a ticket is told in. A key shaped `ABC-123` is held by Jira and by Linear
// alike, so its shape cannot say which; the org's tracker in rig.json does. The routing is
// tested as a function first, then end to end through `rig new` and `rig close`, with the
// in-memory twg missing from PATH throughout, so any ticket sent to Jira by mistake shows.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { trackerOfKey } from '../bin/trackers.mjs'
import { makeInstall, readJson } from './harness.mjs'

// ----------------------------------------------------------------- the routing

test('trackerOfKey: a key a Linear team claims goes to Linear, though it has the shape Jira keys have', () => {
  const trackers = { a: { kind: 'linear', team: 'ABC' }, b: { kind: 'jira', project: 'PROJ' } }
  assert.deepEqual(trackerOfKey(trackers, 'ABC-1', ['a', 'b']), { kind: 'linear', org: 'a', config: trackers.a })
  assert.deepEqual(trackerOfKey(trackers, 'PROJ-2', ['a', 'b']), { kind: 'jira', org: 'b', config: trackers.b })
})

test('trackerOfKey: a claim on the prefix holds whichever orgs the work has', () => {
  const trackers = { a: { kind: 'linear', team: 'ABC' }, b: { kind: 'jira', project: 'PROJ' } }
  assert.equal(trackerOfKey(trackers, 'PROJ-2', ['a']).kind, 'jira')
})

test('trackerOfKey: a key nothing claims goes to the kind of tracker its work\'s orgs keep', () => {
  assert.deepEqual(trackerOfKey({ k: { kind: 'linear' } }, 'XYZ-9', ['k']), { kind: 'linear', org: 'k', config: { kind: 'linear' } })
  assert.equal(trackerOfKey({ k: { kind: 'jira', project: 'MAIN' } }, 'OTHER-4', ['k']).kind, 'jira',
    'a second project on the same Jira site still reaches Jira')
})

test('trackerOfKey: an org whose tracker is none, or absent, holds no ticket, and the reason names it', () => {
  const none = trackerOfKey({ k: { kind: 'none' } }, 'ABC-1', ['k'])
  assert.equal(none.kind, 'none')
  assert.match(none.reason, /k: none/)
  assert.equal(trackerOfKey({}, 'ABC-1', ['k']).kind, 'none')
})

test('trackerOfKey: a GitHub tracker holds owner/repo#n keys, not ABC-123 ones', () => {
  assert.equal(trackerOfKey({ k: { kind: 'github', repo: 'k/tracker' } }, 'ABC-1', ['k']).kind, 'none')
})

test('trackerOfKey: an owner/repo#n key is GitHub\'s whatever the orgs keep, since it names its repo', () => {
  assert.deepEqual(trackerOfKey({ k: { kind: 'none' } }, 'acme/platform#3', ['k']), { kind: 'github' })
})

test('trackerOfKey: two kinds that could hold an unclaimed key are not guessed between', () => {
  const r = trackerOfKey({ a: { kind: 'jira', project: 'P' }, b: { kind: 'linear' } }, 'XYZ-1', ['a', 'b'])
  assert.equal(r.kind, 'ambiguous')
  assert.match(r.reason, /a \(jira\) and b \(linear\)/)
})

test('trackerOfKey: two orgs claiming one prefix in the same kind of tracker reach it; in two kinds, neither is guessed', () => {
  const same = { a: { kind: 'jira', project: 'PP' }, b: { kind: 'jira', project: 'PP' } }
  assert.equal(trackerOfKey(same, 'PP-1', []).kind, 'jira')
  const split = { a: { kind: 'jira', project: 'PP' }, b: { kind: 'linear', team: 'PP' } }
  assert.equal(trackerOfKey(split, 'PP-1', []).kind, 'ambiguous')
})

test('trackerOfKey: when the work\'s orgs keep no tracker for the key, the one kind the data root keeps holds it', () => {
  const trackers = { lin: { kind: 'linear' }, gh: { kind: 'github', repo: 'gh/tracker' } }
  assert.equal(trackerOfKey(trackers, 'XYZ-7', ['gh']).kind, 'linear', 'fetched at rig new from Linear, so told there at close')
  assert.equal(trackerOfKey({ ...trackers, j: { kind: 'jira', project: 'MAIN' } }, 'XYZ-7', ['gh']).kind, 'ambiguous')
})

test('trackerOfKey: the reason for none says what each org keeps, an org rig.json does not name included', () => {
  const { reason } = trackerOfKey({ gh: { kind: 'github', repo: 'gh/t' }, quiet: { kind: 'none' } }, 'ABC-1', ['gh', 'quiet', 'someoss'])
  assert.match(reason, /gh: github, quiet: none, someoss: no tracker/)
})

test('trackerOfKey: a prefix two kinds both claim goes to the claim the work\'s own org makes', () => {
  const trackers = { a: { kind: 'jira', project: 'ABC' }, b: { kind: 'linear', team: 'ABC' } }
  assert.deepEqual(trackerOfKey(trackers, 'ABC-1', ['b']), { kind: 'linear', org: 'b', config: trackers.b })
  const r = trackerOfKey(trackers, 'ABC-1', ['c'])
  assert.equal(r.kind, 'ambiguous')
  assert.match(r.reason, /a \(jira\) and b \(linear\) both claim ABC/)
})

test('trackerOfKey: a key of neither shape is said to be so', () => {
  const r = trackerOfKey({ k: { kind: 'jira', project: 'P' } }, 'not a key', ['k'])
  assert.equal(r.kind, 'unknown')
  assert.match(r.reason, /neither PROJ-123 nor owner\/repo#n/)
})

// ------------------------------------------------------------- end to end
//
// One installation, its tests in order. twg is missing throughout; Linear is the in-memory
// adapter behind RIG_FAKE_LINEAR. GitHub is faked only because `rig init` asks it about auth.
const install = makeInstall({
  prefix: 'rig-trackers-',
  inProcess: true,
  github: { auth: 'ok', repos: {} },
  twg: { present: false, issues: {} },
  linear: {
    teams: ['ABC'],
    issues: {
      'ABC-1': { title: 'Quiet one', body: '', comments: [] },
      'XYZ-7': { title: 'Linear work', body: '', comments: [] },
      'ABC-5': { title: 'Fetched from Linear', body: 'The Linear brief.', comments: [] },
    },
  },
})
after(install.cleanup)

const linear = () => readJson(install.linearStateFile)
const setLinear = state => fs.writeFileSync(install.linearStateFile, JSON.stringify(state))
const setTracker = tracker => {
  const file = path.join(install.dataRoot, 'rig.json')
  fs.writeFileSync(file, JSON.stringify({ ...readJson(file), tracker: { acme: tracker } }, null, 2))
}
const record = id => readJson(path.join(install.dataRoot, 'work', id, 'work.json'))

test('an org whose tracker is none closes a work with an ABC-123 ticket in one quiet line, never reaching twg', () => {
  let r = install.rig(['init', '--data-root', install.dataRoot, '--work-root', install.workRoot,
    '--orgs', 'acme', '--tracker', 'acme=none', '--email', 'you@acme.example'])
  assert.equal(r.code, 0, r.out)
  r = install.rig(['new', 'quiet', '--key', 'ABC-1', '--title', 'Quiet'])
  assert.equal(r.code, 0, r.out)

  r = install.rig(['close', '--work', 'quiet'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /twg/)
  const lines = r.out.split('\n').filter(l => l.includes('ABC-1'))
  assert.equal(lines.length, 1, r.out)
  assert.match(lines[0], /ABC-1: not told, no tracker in rig\.json holds it \(acme: none\)/)
  assert.doesNotMatch(lines[0], /^!/, 'a note, not a warning')
  assert.deepEqual(linear().issues['ABC-1'].comments, [])
})

test('an org tracking in Linear is told on close, through Linear, whatever the key looks like', () => {
  setTracker({ kind: 'linear' })
  let r = install.rig(['new', 'lin', '--key', 'XYZ-7', '--title', 'Linear work'])
  assert.equal(r.code, 0, r.out)
  r = install.rig(['close', '--work', 'lin'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /twg/)
  assert.match(r.out, /commented on XYZ-7/)
  const [comment, ...more] = linear().issues['XYZ-7'].comments
  assert.equal(more.length, 0)
  assert.match(comment, /`rig close` ran\./)
  assert.match(comment, /rig does not move Linear issues: move this one yourself\./)
})

test('rig new --key fetches the brief from the org\'s Linear team', () => {
  setTracker({ kind: 'linear', team: 'ABC' })
  const r = install.rig(['new', 'fetched', '--key', 'ABC-5'])
  assert.equal(r.code, 0, r.out)
  assert.equal(record('fetched').title, 'Fetched from Linear')
  assert.match(fs.readFileSync(path.join(install.dataRoot, 'work', 'fetched', 'context.md'), 'utf8'), /The Linear brief\./)
})

test('rig new --ticket --dry-run previews the Linear issue and creates nothing', () => {
  const r = install.rig(['new', 'made', '--title', 'Made in Linear', '--ticket', '--dry-run'], { input: 'The brief.\n\nMore of it.' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /would create a Linear issue in team ABC/)
  assert.match(r.out, /More of it\./, 'the whole brief, as Jira gets it')
  assert.equal(Object.keys(linear().issues).length, 3)
  assert.ok(!fs.existsSync(path.join(install.dataRoot, 'work', 'made')))
})

test('rig new --ticket opens the issue in the org\'s Linear team and records its key', () => {
  const r = install.rig(['new', 'made', '--title', 'Made in Linear', '--ticket'], { input: 'The brief.\n\nMore of it.' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /ticket ABC-6/)
  assert.deepEqual(record('made').tickets, ['ABC-6'])
  const issue = linear().issues['ABC-6']
  assert.equal(issue.title, 'Made in Linear')
  assert.match(issue.body, /^The brief\.\n\nMore of it\.\n\nThe design lives in the work record/)
})

test('a Linear tracker with no API key says where one goes, and the work is still made', () => {
  const state = linear()
  setLinear({ ...state, present: false })
  const r = install.rig(['new', 'keyless', '--title', 'No key', '--ticket'], { input: 'brief' })
  setLinear(state)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no Linear API key/)
  assert.deepEqual(record('keyless').tickets, [])
})

test('doctor names a missing Linear API key when an org tracks in Linear', () => {
  const state = linear()
  setLinear({ ...state, present: false })
  const r = install.rig(['doctor'])
  setLinear(state)
  assert.match(r.out, /Linear API key — Linear ticket creation, fetch and write-back will not work/)
  assert.doesNotMatch(r.out, /twg present/, 'no org tracks in Jira, so twg is not asked about')
})

// The real Linear adapter, for what is asked of the key before any request: no test sends one.
const realLinear = (extra = {}) => {
  const env = { ...install.env, LINEAR_API_KEY: '', ...extra }
  delete env.RIG_FAKE_LINEAR
  return env
}

test('rig new --key on a prefix two kinds of tracker claim says why it fetched nothing', () => {
  const file = path.join(install.dataRoot, 'rig.json')
  const was = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(was), orgs: ['acme', 'beta'],
    tracker: { acme: { kind: 'jira', project: 'ABC' }, beta: { kind: 'linear', team: 'ABC' } } }, null, 2))
  try {
    const r = install.rig(['new', 'amb', '--key', 'ABC-5'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /ABC-5: not fetched, acme \(jira\) and beta \(linear\) both claim ABC/)
  } finally {
    fs.writeFileSync(file, was)
  }
})

test('a Linear tracker with no team refuses --ticket before the work is made', () => {
  setTracker({ kind: 'linear' })
  const r = install.rig(['new', 'teamless', '--title', 'No team', '--ticket'], { input: 'brief' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /tracker for acme is Linear but has no "team"/)
  assert.ok(!fs.existsSync(path.join(install.dataRoot, 'work', 'teamless')), 'no record left behind')
})

test('doctor names the key file that is missing, rather than asking for one', () => {
  setTracker({ kind: 'linear', team: 'ABC' })
  const missing = path.join(install.tmp, 'no-such', '.secrets.env')
  const machineFile = path.join(install.install, 'rig.local.json')
  const local = readJson(machineFile)
  fs.writeFileSync(machineFile, JSON.stringify({ ...local, linear: { keyFile: missing } }, null, 2))
  try {
    const r = install.rig(['doctor'], { env: realLinear() })
    assert.ok(r.out.includes(`Linear API key — rig.local.json's linear.keyFile names ${missing}, which does not exist`), r.out)
  } finally {
    fs.writeFileSync(machineFile, JSON.stringify(local, null, 2))
  }
})

test('doctor still reports on a machine with two data roots and none current, one of them tracking in Linear', () => {
  const other = path.join(install.tmp, 'other-root')
  fs.mkdirSync(other, { recursive: true })
  fs.writeFileSync(path.join(other, 'rig.json'), JSON.stringify({ orgs: ['beta'], tracker: { beta: { kind: 'none' } } }))
  const machine = path.join(install.tmp, 'two-roots.local.json')
  fs.writeFileSync(machine, JSON.stringify({ workRoot: install.workRoot, dataRoots: { a: { path: install.dataRoot }, b: { path: other } } }))
  const r = install.rig(['doctor'], { env: realLinear({ RIG_LOCAL_CONFIG: machine }) })
  assert.match(r.out, /none is current/)
  assert.match(r.out, /Linear API key/, 'the report goes on past the selection it cannot make')
})

test('an org tracking in Jira, with twg missing, says plainly that twg is what is missing', () => {
  setTracker({ kind: 'jira', project: 'ABC' })
  let r = install.rig(['new', 'jw', '--key', 'ABC-8', '--title', 'Jira work'])
  assert.equal(r.code, 0, r.out)
  r = install.rig(['close', '--work', 'jw'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /ABC-8: could not comment \(Jira is reached through twg, and twg is not on PATH: install it, or set acme's tracker in rig\.json to the one that holds ABC-8\)/)
})
