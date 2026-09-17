// Runs a temp copy of the tool as a subprocess against temp work and data roots.
// RIG_ROOT follows the file's location, so the roots need no test-only hook; GitHub
// is the one hook, below.
//
// The tests below share one temp installation and run in order (init before new,
// new before close). node:test runs a file's tests serially by default; running a
// single one with --test-name-pattern is not supported.
//
// GitHub is the in-memory adapter from bin/github.mjs, selected by RIG_FAKE_GITHUB
// naming a JSON state file the tool reads on start and writes back on exit (Jira the
// same, via RIG_FAKE_TWG). Tests seed it and read it back; the real `gh`/`twg` are never
// spawned. That file is shared state too: a test that seeds a repo or issue is relied on
// by the later tests that assert on it, which is one more reason the order matters.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let tmp, tool, dataRoot, workRoot, env, githubStateFile, twgStateFile

const strip = s => s.replace(/\x1b\[\d+m/g, '')
const rig = (args, input, envOverride = env) => {
  const r = spawnSync(process.execPath, [path.join(tool, 'bin', 'rig.mjs'), ...args], { encoding: 'utf8', env: envOverride, input })
  return { code: r.status, out: strip(r.stdout + r.stderr) }
}
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const setGithub = state => fs.writeFileSync(githubStateFile, JSON.stringify(state))
const github = () => readJson(githubStateFile)
const setTwg = state => fs.writeFileSync(twgStateFile, JSON.stringify(state))
const twg = () => readJson(twgStateFile)
const gitIn = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env })
const lastCommit = dir => gitIn(dir, 'log', '-1', '--format=%s').stdout.trim()
const dirty = dir => gitIn(dir, 'status', '--porcelain').stdout.trim()

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-smoke-'))
  tool = path.join(tmp, 'rig')
  for (const d of ['bin', 'prompts', 'templates']) fs.cpSync(path.join(SRC, d), path.join(tool, d), { recursive: true })
  fs.cpSync(path.join(SRC, 'package.json'), path.join(tool, 'package.json'))
  dataRoot = path.join(tmp, 'rig-data')
  workRoot = path.join(tmp, 'w')

  env = { ...process.env }
  githubStateFile = path.join(tmp, 'github.json')
  env.RIG_FAKE_GITHUB = githubStateFile
  // No gh at all until a test needs GitHub; init's warning path runs first.
  setGithub({ auth: 'missing' })
  twgStateFile = path.join(tmp, 'twg.json')
  env.RIG_FAKE_TWG = twgStateFile
  setTwg({ present: true, issues: {}, fields: {}, boards: {} })
  // The tool writes `git config --global core.longpaths`; keep that, and every
  // inherited setting, out of the real global config.
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '')
  env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'rig smoke'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'smoke@example.invalid'
})

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) })

test('importing the tool runs nothing', () => {
  const url = pathToFileURL(path.join(tool, 'bin', 'rig.mjs')).href
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(url)}).then(m => console.log(Object.keys(m).length))`], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout.trim(), /^\d+$/, 'only the export count is printed, no help text')
})

test('the CLI still runs as an entry point through a link', () => {
  const linkDir = path.join(tmp, 'linked-bin')
  // A directory junction needs no privilege on Windows; a file symlink elsewhere.
  if (process.platform === 'win32') fs.symlinkSync(path.join(tool, 'bin'), linkDir, 'junction')
  else { fs.mkdirSync(linkDir); fs.symlinkSync(path.join(tool, 'bin', 'rig.mjs'), path.join(linkDir, 'rig.mjs')) }
  const r = spawnSync(process.execPath, [path.join(linkDir, 'rig.mjs'), 'help'], { encoding: 'utf8', env })
  assert.equal(r.status, 0)
  assert.match(strip(r.stdout), /cross-repo work harness/)
})

test('doctor before init says not set up', () => {
  const r = rig(['doctor'])
  assert.equal(r.code, 1)
  assert.match(r.out, /not set up/)
})

test('init --data-root makes a git checkout with a first commit and writes both configs', () => {
  const r = rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--tracker', 'acme=none', '--email', 'you@acme.example'])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(dataRoot, '.git')))
  // Every mutating command will `git add -A` here and push; the hard guards come first.
  assert.match(fs.readFileSync(path.join(dataRoot, '.gitignore'), 'utf8'), /^\*\.env$/m)
  assert.equal(lastCommit(dataRoot), 'rig init: rig.json', 'the org-level half is committed by init itself')
  assert.deepEqual(readJson(path.join(dataRoot, 'rig.json')),
    { orgs: ['acme'], tracker: { acme: { kind: 'none' } }, writtenBy: '1.0.0' },
    'a data root rig just created is stamped with the format it writes, not one behind')
  const local = readJson(path.join(tool, 'rig.local.json'))
  assert.equal(path.resolve(local.dataRoot), path.resolve(dataRoot))
  assert.deepEqual(local.identities, { acme: 'you@acme.example' })
  assert.ok(!('orgs' in local), 'orgs never go in the local file')
})

test('init warns rather than crashes without a usable gh', () => {
  const r = rig(['init'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /gh not found on PATH/)
})

test('init --orgs adds, never replaces', () => {
  rig(['init', '--orgs', 'acme-labs', '--tracker', 'acme-labs=jira:PROJ'])
  assert.deepEqual(readJson(path.join(dataRoot, 'rig.json')).orgs, ['acme', 'acme-labs'])
})

test('new refuses without a ticket decision once a tracker is configured', () => {
  // acme-labs got a live Jira tracker two tests ago; the gate now applies data-root-wide.
  const r = rig(['new', 't1', '--title', 'Smoke work', '--type', 'chore'], 'the brief')
  assert.equal(r.code, 1)
  assert.match(r.out, /--key.*--ticket.*--no-ticket/)
  assert.ok(!fs.existsSync(path.join(dataRoot, 'work', 't1')), 'nothing half-created on refusal')
})

test('new --no-ticket, ticket, list, status, close on a work with no repos', () => {
  let r = rig(['new', 't1', '--title', 'Smoke work', '--type', 'chore', '--no-ticket'], 'the brief')
  assert.equal(r.code, 0, r.out)
  // Every mutating command ends by committing the whole data root, and says so.
  assert.match(r.out, /data root: committed [0-9a-f]{7,} \(no upstream/)
  assert.equal(lastCommit(dataRoot), 'rig new t1')
  assert.equal(dirty(dataRoot), '', 'nothing left uncommitted')
  const record = path.join(dataRoot, 'work', 't1', 'work.json')
  assert.equal(readJson(record).branch, 'chore/smoke-work')
  assert.equal(readJson(record).ticketsDeclined, true)
  assert.equal(readJson(record).status, 'planning')
  assert.ok(fs.existsSync(path.join(workRoot, 't1', 'AGENTS.md')), 'generated file in the work folder')
  const doc = () => fs.readFileSync(path.join(dataRoot, 'work', 't1', 'context.md'), 'utf8')
  assert.match(doc(), /the brief/)
  assert.match(doc(), /^Tickets: none \(declined\) · Status: Planning$/m)

  r = rig(['ticket', 'PROJ-9', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.equal(lastCommit(dataRoot), 'rig ticket t1: PROJ-9')
  assert.deepEqual(readJson(record).tickets, ['PROJ-9'])
  assert.equal(readJson(record).ticketsDeclined, undefined, 'a real ticket supersedes the decline')
  assert.match(doc(), /^Tickets: PROJ-9 · Status: Planning$/m)

  r = rig(['list'])
  assert.match(r.out, /t1/)
  r = rig(['status', '--work', 't1'])
  assert.match(r.out, /branch chore\/smoke-work/)
  assert.match(r.out, /status Planning/)
  assert.match(r.out, /tickets PROJ-9/)

  r = rig(['close', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.equal(lastCommit(dataRoot), 'rig close t1')
  assert.ok(readJson(record).closedAt)
  assert.equal(readJson(record).status, 'closed')
  assert.match(doc(), /^Tickets: PROJ-9 · Status: Closed$/m)
  assert.ok(!fs.existsSync(path.join(workRoot, 't1')), 'work folder removed')
})

test('a GitHub --key is recorded but never reaches the branch name', () => {
  const r = rig(['new', 't2', '--key', 'acme/platform#3', '--title', 'Keyed work'], '')
  assert.equal(r.code, 0, r.out)
  const record = readJson(path.join(dataRoot, 'work', 't2', 'work.json'))
  assert.equal(record.branch, 'feat/keyed-work')
  assert.deepEqual(record.tickets, ['acme/platform#3'])
})

test('a Jira --key is recorded and does reach the branch name', () => {
  const r = rig(['new', 't3', '--key', 'PROJ-42', '--title', 'Jira keyed'], '')
  assert.equal(r.code, 0, r.out)
  assert.equal(readJson(path.join(dataRoot, 'work', 't3', 'work.json')).branch, 'feat/PROJ-42-jira-keyed')
})

test('init warns when gh is present but not authenticated', () => {
  setGithub({ auth: 'unauthenticated' })
  const r = rig(['init'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /gh is not authenticated/)
})

test('new --ticket opens a ticket in the org\'s GitHub tracker and records its key', () => {
  setGithub({
    auth: 'ok',
    repos: {
      'acme/platform': {
        language: 'TypeScript',
        issues: [{ number: 3, title: 'Existing', body: '', state: 'OPEN', comments: [] }],
      },
    },
  })
  let r = rig(['init', '--tracker', 'acme=github:acme/platform'])
  assert.equal(r.code, 0, r.out)
  assert.equal(lastCommit(dataRoot), 'rig init: rig.json')

  r = rig(['new', 't4', '--title', 'Ticketed work', '--ticket', '--org', 'acme'], 'first paragraph of the brief\n\nsecond paragraph')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /ticket acme\/platform#4/)
  assert.deepEqual(readJson(path.join(dataRoot, 'work', 't4', 'work.json')).tickets, ['acme/platform#4'])
  assert.match(fs.readFileSync(path.join(dataRoot, 'work', 't4', 'context.md'), 'utf8'), /^Tickets: acme\/platform#4/m)
  const issue = github().repos['acme/platform'].issues[1]
  assert.equal(issue.title, 'Ticketed work')
  assert.match(issue.body, /^first paragraph of the brief\n/, 'thin body: the brief\'s first paragraph')
  assert.match(issue.body, /work\/t4\/context\.md/, 'links to the context doc')
})

test('close on a work with no repos comments on the GitHub ticket and leaves it open', () => {
  const r = rig(['close', '--work', 't4'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /commented on acme\/platform#4 \(left open/)
  const issue = github().repos['acme/platform'].issues[1]
  assert.equal(issue.state, 'OPEN')
  assert.equal(issue.comments.length, 1)
  assert.match(issue.comments[0], /No repos were attached/)
})

test('rig.json can carry full per-org Jira ticket config; --dry-run previews without creating', () => {
  // type/fields/board have no CLI setter (Direction: "org facts... never in code") —
  // an agent or `rig save` (PR3) writes them straight into the data root's rig.json.
  const rigJson = readJson(path.join(dataRoot, 'rig.json'))
  rigJson.tracker['acme-labs'] = {
    kind: 'jira', project: 'PROJ', type: 'Task',
    fields: { components: ['Payments'], assignee: 'me', story_points: 3, sprint: 'active' },
    board: 123,
  }
  fs.writeFileSync(path.join(dataRoot, 'rig.json'), JSON.stringify(rigJson, null, 2))
  setTwg({
    present: true,
    issues: {},
    fields: { PROJ: { Task: [
      { id: 'customfield_10058', name: 'Story Points', allowedValues: [] },
      { id: 'customfield_10020', name: 'Sprint', allowedValues: [] },
      { id: 'customfield_10755', name: 'Components', allowedValues: [{ id: '10755', name: 'Payments' }] },
    ] } },
    boards: { 123: 7 },
  })

  const r = rig(['new', 't5', '--title', 'Jira ticketed work', '--ticket', '--org', 'acme-labs', '--dry-run'],
    'the jira brief\n\nmore detail')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /would create a Task in PROJ/)
  assert.match(r.out, /customfield_10058\s+3/)
  assert.match(r.out, /customfield_10020\s+7/, 'sprint "active" resolved through the board')
  assert.match(r.out, /customfield_10755\s+\["10755"\]/, 'component name resolved to its id')
  assert.ok(!fs.existsSync(path.join(dataRoot, 'work', 't5')), 'dry-run creates nothing')
  assert.deepEqual(twg().issues, {}, 'dry-run never calls createIssue')
})

test('rig new --ticket on a Jira org creates via twg with resolved fields', () => {
  const r = rig(['new', 't5', '--title', 'Jira ticketed work', '--ticket', '--org', 'acme-labs'],
    'the jira brief\n\nmore detail')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /ticket PROJ-1/)
  const record = readJson(path.join(dataRoot, 'work', 't5', 'work.json'))
  assert.deepEqual(record.tickets, ['PROJ-1'])
  const issue = twg().issues['PROJ-1']
  assert.equal(issue.title, 'Jira ticketed work')
  assert.equal(issue.body, 'the jira brief')
  assert.equal(issue.assignee, 'me')
  assert.deepEqual(issue.fields, { customfield_10755: ['10755'], customfield_10058: 3, customfield_10020: 7 })
  assert.match(fs.readFileSync(path.join(dataRoot, 'work', 't5', 'context.md'), 'utf8'), /^Tickets: PROJ-1 · Status: Planning$/m)
})

test('a Jira ticket-creation failure surfaces as a clean error, not a stack trace', () => {
  const state = twg()
  setTwg({ ...state, present: false })
  const r = rig(['new', 't5-fail', '--title', 'Should not crash', '--ticket', '--org', 'acme-labs'], 'brief')
  setTwg(state)   // restore before any later test needs twg present again
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /twg not found on PATH/)
  assert.doesNotMatch(r.out, /at Object\.|at file:|\bnode:internal\b/, 'no raw stack trace reaches the user')
  // The record still gets created even though the ticket did not (existing invariant:
  // "nothing is half-built" — `rig ticket <key>` can attach one later) — and it is
  // committed under this command's own message, not swept up by the next one.
  assert.deepEqual(readJson(path.join(dataRoot, 'work', 't5-fail', 'work.json')).tickets, [])
  assert.equal(lastCommit(dataRoot), 'rig new t5-fail')
  assert.equal(dirty(dataRoot), '')
})

test('an unresolvable Jira component name dies loudly instead of reaching twg unresolved', () => {
  const rigJson = readJson(path.join(dataRoot, 'rig.json'))
  const original = rigJson.tracker['acme-labs'].fields.components
  rigJson.tracker['acme-labs'].fields.components = ['Not A Real Component']
  fs.writeFileSync(path.join(dataRoot, 'rig.json'), JSON.stringify(rigJson, null, 2))

  const r = rig(['new', 't5-badcomponent', '--title', 'Bad component', '--ticket', '--org', 'acme-labs'], 'brief')
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /"Not A Real Component" is not a value for "Components"/)
  assert.deepEqual(readJson(path.join(dataRoot, 'work', 't5-badcomponent', 'work.json')).tickets, [])

  rigJson.tracker['acme-labs'].fields.components = original
  fs.writeFileSync(path.join(dataRoot, 'rig.json'), JSON.stringify(rigJson, null, 2))
})

test('--dry-run warns instead of misleadingly previewing when the work already has a ticket', () => {
  const r = rig(['new', 't5', '--title', 'Jira ticketed work', '--ticket', '--org', 'acme-labs', '--dry-run'],
    'a different brief')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /t5 already has a ticket \(PROJ-1\)/)
  assert.doesNotMatch(r.out, /would create/, 'no misleading preview once a ticket already exists')
})

test('--field is ignored for a GitHub tracker, and says so', () => {
  const r = rig(['new', 't6b', '--title', 'Field on GitHub', '--ticket', '--org', 'acme', '--field', 'story_points=5'],
    'brief')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /--field is ignored for a GitHub tracker/)
})

test('--field name=value,... overrides the org\'s configured default', () => {
  const r = rig(['new', 't6', '--title', 'Overridden points', '--ticket', '--org', 'acme-labs', '--field', 'story_points=5'],
    'brief')
  assert.equal(r.code, 0, r.out)
  const record = readJson(path.join(dataRoot, 'work', 't6', 'work.json'))
  const issue = twg().issues[record.tickets[0]]
  assert.equal(issue.fields.customfield_10058, '5')
})

test('rig new --key <a Jira key> fetches title and description from Jira, no piped brief needed', () => {
  const state = twg()
  state.issues['PROJ-2'] = { title: 'Fetched summary', body: 'Fetched description', comments: [] }
  setTwg(state)
  const r = rig(['new', 't7', '--key', 'PROJ-2'], '')
  assert.equal(r.code, 0, r.out)
  const record = readJson(path.join(dataRoot, 'work', 't7', 'work.json'))
  assert.equal(record.title, 'Fetched summary')
  assert.deepEqual(record.tickets, ['PROJ-2'])
  assert.match(fs.readFileSync(path.join(dataRoot, 'work', 't7', 'context.md'), 'utf8'), /Fetched description/)
})

test('rig save --designed records the design-agreed gate and commits with the message', () => {
  const r = rig(['save', '--work', 't7', '-m', 'design agreed', '--designed'])
  assert.equal(r.code, 0, r.out)
  assert.equal(readJson(path.join(dataRoot, 'work', 't7', 'work.json')).status, 'designed')
  assert.match(fs.readFileSync(path.join(dataRoot, 'work', 't7', 'context.md'), 'utf8'), /^Tickets: PROJ-2 · Status: Designed$/m)
  assert.equal(lastCommit(dataRoot), 'rig save t7: design agreed')
})

test('rig save with nothing changed says so and makes no commit', () => {
  const before = lastCommit(dataRoot)
  const r = rig(['save', '--work', 't7'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /nothing to commit/)
  assert.equal(lastCommit(dataRoot), before)
})

test('doctor flags an edit made outside rig as uncommitted; rig save sweeps it up', () => {
  const doc = path.join(dataRoot, 'work', 't7', 'context.md')
  fs.appendFileSync(doc, '\n## Direction\n\nDecided by hand.\n')
  let r = rig(['doctor'])
  assert.match(r.out, /data root has 1 uncommitted change/)
  r = rig(['save', '--work', 't7'])
  assert.equal(r.code, 0, r.out)
  assert.equal(lastCommit(dataRoot), 'rig save t7')
  assert.equal(dirty(dataRoot), '')
})

test('a commit that fails (no git identity) warns and leaves the edit for next time, never dies', () => {
  fs.appendFileSync(path.join(dataRoot, 'work', 't7', 'context.md'), '\nAnonymous edit.\n')
  const anonymous = { ...env }
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete anonymous[k]
  let r = rig(['save', '--work', 't7', '-m', 'who am i'], undefined, anonymous)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /could not commit/)
  assert.notEqual(dirty(dataRoot), '', 'the change is still there for the next command')
  r = rig(['save', '--work', 't7', '-m', 'now with an identity'])
  assert.equal(r.code, 0, r.out)
  assert.equal(lastCommit(dataRoot), 'rig save t7: now with an identity')
  assert.equal(dirty(dataRoot), '')
})

test('with an upstream, a mutating command pushes, rebasing over what others pushed first', () => {
  const remote = path.join(tmp, 'rig-data-remote.git')
  assert.equal(gitIn(tmp, 'init', '-q', '--bare', '-b', 'main', remote).status, 0)
  assert.equal(gitIn(dataRoot, 'remote', 'add', 'origin', remote).status, 0)
  assert.equal(gitIn(dataRoot, 'push', '-q', '-u', 'origin', 'main').status, 0)

  fs.appendFileSync(path.join(dataRoot, 'work', 't7', 'context.md'), '\nAn edit to push.\n')
  let r = rig(['save', '--work', 't7', '-m', 'pushed'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /data root: committed [0-9a-f]{7,} and pushed/)
  assert.equal(lastCommit(remote), 'rig save t7: pushed')

  // Another machine pushes first, touching a different file.
  const other = path.join(tmp, 'other-machine')
  assert.equal(gitIn(tmp, 'clone', '-q', remote, other).status, 0)
  fs.writeFileSync(path.join(other, 'NOTES.md'), 'from the other machine\n')
  assert.equal(gitIn(other, 'add', '-A').status, 0)
  assert.equal(gitIn(other, 'commit', '-q', '-m', 'other machine').status, 0)
  assert.equal(gitIn(other, 'push', '-q').status, 0)

  fs.appendFileSync(path.join(dataRoot, 'work', 't7', 'context.md'), '\nMore, locally.\n')
  r = rig(['save', '--work', 't7', '-m', 'after divergence'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /and pushed/)
  assert.equal(lastCommit(remote), 'rig save t7: after divergence')
  assert.ok(fs.existsSync(path.join(dataRoot, 'NOTES.md')), 'the other machine\'s commit was rebased under ours')
})

test('a rebase conflict is warned about, aborted, and leaves the data root clean', () => {
  const remote = path.join(tmp, 'rig-data-remote.git')
  const other = path.join(tmp, 'other-machine')
  // The other machine rewrites the same header line `rig ticket` is about to rewrite.
  assert.equal(gitIn(other, 'pull', '-q', '--rebase').status, 0)
  const otherDoc = path.join(other, 'work', 't7', 'context.md')
  fs.writeFileSync(otherDoc, fs.readFileSync(otherDoc, 'utf8').replace(/^Tickets: .*$/m, 'Tickets: EDITED-1 · Status: Designed'))
  assert.equal(gitIn(other, 'commit', '-q', '-am', 'conflicting edit').status, 0)
  assert.equal(gitIn(other, 'push', '-q').status, 0)

  // A local commit as well, so the data root is behind *and* ahead: the fast-forward before
  // a mutating command cannot straighten that out, and the rebase at the end meets the
  // conflict. Behind alone no longer reaches this path — it is fast-forwarded first.
  const localDoc = path.join(dataRoot, 'work', 't7', 'context.md')
  fs.writeFileSync(localDoc, fs.readFileSync(localDoc, 'utf8').replace(/^Tickets: .*$/m, 'Tickets: LOCAL-9 · Status: In progress'))
  assert.equal(gitIn(dataRoot, 'commit', '-q', '-am', 'local edit').status, 0)

  const r = rig(['ticket', 'PROJ-3', '--work', 't7'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /1 behind and 1 ahead of origin/)
  assert.match(r.out, /conflict/)
  assert.match(r.out, /rebase aborted/)
  assert.equal(lastCommit(dataRoot), 'rig ticket t7: PROJ-3', 'the local commit is kept')
  assert.equal(dirty(dataRoot), '', 'tree left clean')
  assert.ok(!fs.existsSync(path.join(dataRoot, '.git', 'rebase-merge')), 'never left mid-rebase')
  assert.equal(lastCommit(remote), 'conflicting edit', 'nothing pushed')
})

test('a fetch that fails (remote unreachable) says so, rather than calling it a conflict', () => {
  try {
    assert.equal(gitIn(dataRoot, 'remote', 'set-url', 'origin', path.join(tmp, 'no-such-remote.git')).status, 0)
    fs.appendFileSync(path.join(dataRoot, 'work', 't7', 'context.md'), '\nOffline edit.\n')
    const r = rig(['save', '--work', 't7', '-m', 'offline'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /could not fetch from origin/)
    assert.doesNotMatch(r.out, /conflict/)
    assert.equal(lastCommit(dataRoot), 'rig save t7: offline')
    assert.equal(dirty(dataRoot), '')
  } finally {
    // Back to a local-only data root for the tests that follow, whatever happened above.
    gitIn(dataRoot, 'remote', 'remove', 'origin')
  }
})

test('close comments on a Jira ticket and never transitions it', () => {
  const r = rig(['close', '--work', 't5'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /commented on PROJ-1/)
  const issue = twg().issues['PROJ-1']
  assert.equal(issue.comments.length, 1)
  assert.match(issue.comments[0], /No repos were attached/)
  assert.match(issue.comments[0], /rig does not transition Jira tickets/)
})

test('an old-shaped record (jiraKeys, stored path) is read and migrated on save', () => {
  const dir = path.join(dataRoot, 'work', 'old')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'work.json'), JSON.stringify({
    id: 'old', title: 'Old shape', branch: 'feat/old', type: 'feat',
    jiraKeys: ['acme/platform#3'],
    repos: [{ repo: 'billing', org: 'acme', path: 'X:\\somewhere\\else\\billing', base: 'main' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  }))
  fs.writeFileSync(path.join(dir, 'context.md'), '# old\n\nTickets: acme/platform#3 · Status: Planning\n')
  fs.mkdirSync(path.join(workRoot, 'old', '.rig'), { recursive: true })
  fs.writeFileSync(path.join(workRoot, 'old', '.rig', 'id'), 'old\n')

  let r = rig(['list', '--quick'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /acme\/platform#3/, 'jiraKeys read as tickets')
  r = rig(['status', '--work', 'old'])
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes(path.join(workRoot, 'old', 'billing')), 'path derived from this work root')
  assert.doesNotMatch(r.out, /somewhere/, 'stored path ignored')

  r = rig(['ticket', 'PROJ-1', '--work', 'old'])
  assert.equal(r.code, 0, r.out)
  const saved = readJson(path.join(dir, 'work.json'))
  assert.deepEqual(saved.tickets, ['acme/platform#3', 'PROJ-1'])
  assert.equal(saved.jiraKeys, undefined)
  assert.equal(saved.repos[0].path, undefined, 'path never stored')
})

test('status and list read the PR for the work branch from GitHub', () => {
  const state = github()
  state.repos['acme/billing'] = {
    prs: [{ branch: 'feat/old', number: 12, state: 'MERGED', url: 'https://github.com/acme/billing/pull/12' }],
  }
  setGithub(state)
  // A checkout where the worktree would be; rig only needs it to exist and be clean.
  const billing = path.join(workRoot, 'old', 'billing')
  fs.mkdirSync(billing, { recursive: true })
  const g = gitIn(billing, 'init', '-q', '-b', 'main')
  assert.equal(g.status, 0, g.stderr)
  let r = rig(['status', '--work', 'old'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /pr\s+#12 MERGED https:\/\/github\.com\/acme\/billing\/pull\/12/)
  r = rig(['list'])
  assert.match(r.out, /PR #12 merged/)
  assert.match(r.out, /safe to `rig close`/)
})

test('when gh cannot answer, status and list say the PR state is unknown, and close refuses', () => {
  const state = github()
  setGithub({ ...state, auth: 'missing' })
  let r = rig(['status', '--work', 'old'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /pr\s+unknown — gh not found on PATH/)
  r = rig(['list'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /PR state unknown/)
  assert.doesNotMatch(r.out, /safe to `rig close`/)
  r = rig(['close', '--work', 'old'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing: PR state unknown \(gh not found on PATH/)
  assert.ok(fs.existsSync(path.join(workRoot, 'old', 'billing')), 'nothing torn down')
  setGithub(state)
})

test('close with every PR merged comments on the GitHub ticket and closes it', () => {
  const r = rig(['close', '--work', 'old'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /closed acme\/platform#3/)
  const issue = github().repos['acme/platform'].issues[0]
  assert.equal(issue.state, 'CLOSED')
  assert.match(issue.comments[0], /^Closed by `rig close`\.\n\n- billing: https:\/\/github\.com\/acme\/billing\/pull\/12\n/)
})

test('doctor after setup reports the data root state', () => {
  const r = rig(['doctor'])
  assert.match(r.out, /data root is a git checkout/)
  assert.doesNotMatch(r.out, /uncommitted change/, 'every mutating command committed as it went')
  assert.match(r.out, /no upstream — local only/)
})

test('the real global git config was never touched', () => {
  // core.longpaths lands in the temp global config, proving the redirect held.
  const r = spawnSync('git', ['config', '--global', 'core.longpaths'], { encoding: 'utf8', env })
  assert.equal(r.stdout.trim(), 'true')
})

test('a data root from before stamping is warned about, then migrated by update', () => {
  const file = path.join(dataRoot, 'rig.json')
  const { writtenBy, ...unstamped } = readJson(file)   // as a rig from before this check left it
  assert.equal(writtenBy, '1.0.0')
  fs.writeFileSync(file, JSON.stringify(unstamped, null, 2) + '\n')

  const warned = rig(['save', '--work', 't7', '-m', 'a note'])
  assert.equal(warned.code, 0, warned.out)
  assert.match(warned.out, /record format 0, this rig writes 1/)

  const updated = rig(['update'])
  assert.match(updated.out, /migrated: stamp the data root/)
  assert.equal(readJson(file).writtenBy, '1.0.0')
  assert.equal(dirty(dataRoot), '', 'the migration is committed, not left in the tree')
  assert.match(updated.out, /record format 1, last written by rig 1\.0\.0/, 'the doctor checks run inline')
})

test('a second update migrates nothing', () => {
  const r = rig(['update'])
  assert.doesNotMatch(r.out, /migrated:/)
  assert.match(r.out, /record format 1/)
})

test('a rig older than the data root refuses to write, and still reads', () => {
  const file = path.join(dataRoot, 'rig.json')
  const saved = readJson(file)
  fs.writeFileSync(file, JSON.stringify({ ...saved, writtenBy: '99.0.0' }, null, 2) + '\n')

  const blocked = rig(['save', '--work', 't7', '-m', 'from an older rig'])
  assert.equal(blocked.code, 1, blocked.out)
  assert.match(blocked.out, /writes record format 1/)
  assert.match(blocked.out, /is at 99/)

  const listed = rig(['list', '--quick'])
  assert.equal(listed.code, 0, listed.out)
  assert.match(listed.out, /t7/, 'reading a newer data root is harmless')

  fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n')
  assert.equal(rig(['save', '--work', 't7', '-m', 'restored']).code, 0)
})
