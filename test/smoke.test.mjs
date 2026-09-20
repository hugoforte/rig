// Runs a temp copy of the tool as a subprocess against temp work and data roots.
//
// The copy is for git alone: it has no `.git`, which is what keeps `rig update` and every
// freshness path off the checkout these tests are running from (test/installation.test.mjs
// is where a real installation with a remote is built, and says so). The machine config no
// longer needs it — `RIG_LOCAL_CONFIG` puts rig.local.json in the temp dir, so nothing this
// suite writes lands beside the tool.
//
// The tests below share one temp installation and run in order (init before new,
// new before close). node:test runs a file's tests serially by default; running a
// single one with --test-name-pattern is not supported.
//
// GitHub and Jira are the in-memory adapters (test/harness.mjs says how). Tests seed them
// and read them back; the real `gh`/`twg` are never spawned. That state is shared too: a
// test that seeds a repo or issue is relied on by the later tests that assert on it, which
// is one more reason the order matters.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { MAJOR, MIGRATIONS, FORMAT_STAMP } from '../bin/version.mjs'
import { SRC, makeInstall, readJson, strip } from './harness.mjs'
import { DEFAULT_ROOT_NAME } from '../bin/roots.mjs'

// What this tool stamps a data root with: the record format, derived (ADR 0004). Not read
// from `package.json`, which no longer carries a version at all.
const VERSION = FORMAT_STAMP

const {
  tmp, install: tool, localConfig, dataRoot, workRoot, env,
  githubStateFile, twgStateFile, rig, git: gitIn, cleanup,
} = makeInstall({
  prefix: 'rig-smoke-',
  author: 'rig smoke',
  email: 'smoke@example.invalid',
  // The machine half, moved out of the tool copy. `init` creates it there; until it does,
  // there is no config at all, which is the state `doctor` is asked about first.
  localConfig: true,
  // No gh at all until a test needs GitHub; init's warning path runs first.
  github: { auth: 'missing' },
  twg: { present: true, issues: {}, fields: {}, boards: {} },
})

const setGithub = state => fs.writeFileSync(githubStateFile, JSON.stringify(state))
const github = () => readJson(githubStateFile)
const setTwg = state => fs.writeFileSync(twgStateFile, JSON.stringify(state))
const twg = () => readJson(twgStateFile)
const lastCommit = dir => gitIn(dir, 'log', '-1', '--format=%s').stdout.trim()
const dirty = dir => gitIn(dir, 'status', '--porcelain').stdout.trim()

after(cleanup)

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
    { orgs: ['acme'], tracker: { acme: { kind: 'none' } }, writtenBy: VERSION },
    'a data root rig just created is stamped with the format it writes, not one behind')
  const local = readJson(localConfig)
  // A data root is named, and the name is how every later command asks for it. An init that
  // was given none gets the one the single-root form always meant.
  assert.deepEqual(Object.keys(local.dataRoots), [DEFAULT_ROOT_NAME])
  assert.equal(path.resolve(local.dataRoots[DEFAULT_ROOT_NAME].path), path.resolve(dataRoot))
  assert.equal(local.current, DEFAULT_ROOT_NAME)
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
  const r = rig(['new', 't1', '--title', 'Smoke work', '--type', 'chore'], { input: 'the brief' })
  assert.equal(r.code, 1)
  assert.match(r.out, /--key.*--ticket.*--no-ticket/)
  assert.ok(!fs.existsSync(path.join(dataRoot, 'work', 't1')), 'nothing half-created on refusal')
})

test('new --no-ticket, ticket, list, status, close on a work with no repos', () => {
  let r = rig(['new', 't1', '--title', 'Smoke work', '--type', 'chore', '--no-ticket'], { input: 'the brief' })
  assert.equal(r.code, 0, r.out)
  // Every mutating command ends by committing the whole data root, and says so.
  assert.match(r.out, /data root: committed [0-9a-f]{7,} \(no upstream/)
  assert.equal(lastCommit(dataRoot), 'rig new t1')
  assert.equal(dirty(dataRoot), '', 'nothing left uncommitted')
  const record = path.join(dataRoot, 'work', 't1', 'work.json')
  assert.equal(readJson(record).branch, 'chore/smoke-work')
  assert.equal(readJson(record).ticketsDeclined, true)
  assert.equal(readJson(record).status, undefined, 'the phase is derived; nothing about it is stored')
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
  assert.match(r.out, /phase Planning/)
  assert.match(r.out, /tickets PROJ-9/)

  r = rig(['close', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.equal(lastCommit(dataRoot), 'rig close t1')
  assert.ok(readJson(record).closedAt)
  assert.equal(readJson(record).abandonedAt, undefined, 'a close that landed is not an abandonment')
  assert.match(doc(), /^Tickets: PROJ-9 · Status: Closed$/m)
  assert.ok(!fs.existsSync(path.join(workRoot, 't1')), 'work folder removed')
})

test('a GitHub --key is recorded but never reaches the branch name', () => {
  const r = rig(['new', 't2', '--key', 'acme/platform#3', '--title', 'Keyed work'])
  assert.equal(r.code, 0, r.out)
  const record = readJson(path.join(dataRoot, 'work', 't2', 'work.json'))
  assert.equal(record.branch, 'feat/keyed-work')
  assert.deepEqual(record.tickets, ['acme/platform#3'])
})

test('a Jira --key is recorded and does reach the branch name', () => {
  const r = rig(['new', 't3', '--key', 'PROJ-42', '--title', 'Jira keyed'])
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

  r = rig(['new', 't4', '--title', 'Ticketed work', '--ticket', '--org', 'acme'],
    { input: 'first paragraph of the brief\n\nsecond paragraph' })
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
    { input: 'the jira brief\n\nmore detail' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /would create a Task in PROJ/)
  assert.match(r.out, /customfield_10058\s+3/)
  assert.match(r.out, /customfield_10020\s+7/, 'sprint "active" resolved through the board')
  assert.match(r.out, /customfield_10755\s+\["10755"\]/, 'component name resolved to its id')
  assert.match(r.out, /more detail/, 'the whole brief is previewed, not its first paragraph')
  assert.ok(!fs.existsSync(path.join(dataRoot, 'work', 't5')), 'dry-run creates nothing')
  assert.deepEqual(twg().issues, {}, 'dry-run never calls createIssue')
})

test('rig new --ticket on a Jira org creates via twg with resolved fields', () => {
  const r = rig(['new', 't5', '--title', 'Jira ticketed work', '--ticket', '--org', 'acme-labs'],
    { input: 'the jira brief\n\nmore detail' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /ticket PROJ-1/)
  const record = readJson(path.join(dataRoot, 'work', 't5', 'work.json'))
  assert.deepEqual(record.tickets, ['PROJ-1'])
  const issue = twg().issues['PROJ-1']
  assert.equal(issue.title, 'Jira ticketed work')
  // The whole brief and a link back to the design (test/jira.test.mjs has the detail).
  assert.equal(issue.body.split('\n\nThe design lives')[0], 'the jira brief\n\nmore detail')
  assert.equal(issue.assignee, 'me')
  assert.deepEqual(issue.fields, { customfield_10755: ['10755'], customfield_10058: 3, customfield_10020: 7 })
  assert.match(fs.readFileSync(path.join(dataRoot, 'work', 't5', 'context.md'), 'utf8'), /^Tickets: PROJ-1 · Status: Planning$/m)
})

test('a Jira ticket-creation failure surfaces as a clean error, not a stack trace', () => {
  const state = twg()
  setTwg({ ...state, present: false })
  const r = rig(['new', 't5-fail', '--title', 'Should not crash', '--ticket', '--org', 'acme-labs'], { input: 'brief' })
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

  const r = rig(['new', 't5-badcomponent', '--title', 'Bad component', '--ticket', '--org', 'acme-labs'], { input: 'brief' })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /"Not A Real Component" is not a value for "Components"/)
  assert.deepEqual(readJson(path.join(dataRoot, 'work', 't5-badcomponent', 'work.json')).tickets, [])

  rigJson.tracker['acme-labs'].fields.components = original
  fs.writeFileSync(path.join(dataRoot, 'rig.json'), JSON.stringify(rigJson, null, 2))
})

test('--dry-run warns instead of misleadingly previewing when the work already has a ticket', () => {
  const r = rig(['new', 't5', '--title', 'Jira ticketed work', '--ticket', '--org', 'acme-labs', '--dry-run'],
    { input: 'a different brief' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /t5 already has a ticket \(PROJ-1\)/)
  assert.doesNotMatch(r.out, /would create/, 'no misleading preview once a ticket already exists')
})

test('--field is ignored for a GitHub tracker, and says so', () => {
  const r = rig(['new', 't6b', '--title', 'Field on GitHub', '--ticket', '--org', 'acme', '--field', 'story_points=5'],
    { input: 'brief' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /--field is ignored for a GitHub tracker/)
})

test('--field name=value,... overrides the org\'s configured default', () => {
  const r = rig(['new', 't6', '--title', 'Overridden points', '--ticket', '--org', 'acme-labs', '--field', 'story_points=5'],
    { input: 'brief' })
  assert.equal(r.code, 0, r.out)
  const record = readJson(path.join(dataRoot, 'work', 't6', 'work.json'))
  const issue = twg().issues[record.tickets[0]]
  assert.equal(issue.fields.customfield_10058, '5')
})

test('rig new --key <a Jira key> fetches title and description from Jira, no piped brief needed', () => {
  const state = twg()
  state.issues['PROJ-2'] = { title: 'Fetched summary', body: 'Fetched description', comments: [] }
  setTwg(state)
  const r = rig(['new', 't7', '--key', 'PROJ-2'])
  assert.equal(r.code, 0, r.out)
  const record = readJson(path.join(dataRoot, 'work', 't7', 'work.json'))
  assert.equal(record.title, 'Fetched summary')
  assert.deepEqual(record.tickets, ['PROJ-2'])
  assert.match(fs.readFileSync(path.join(dataRoot, 'work', 't7', 'context.md'), 'utf8'), /Fetched description/)
})

test('rig save --designed records the design-agreed gate and commits with the message', () => {
  const r = rig(['save', '--work', 't7', '-m', 'design agreed', '--designed'])
  assert.equal(r.code, 0, r.out)
  const record = readJson(path.join(dataRoot, 'work', 't7', 'work.json'))
  assert.ok(record.designedAt, 'the gate is stored with its date, and nothing else is')
  assert.equal(record.status, undefined)
  assert.match(fs.readFileSync(path.join(dataRoot, 'work', 't7', 'context.md'), 'utf8'), /^Tickets: PROJ-2 · Status: Building \(design agreed \d{4}-\d{2}-\d{2}\)$/m)
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
  let r = rig(['save', '--work', 't7', '-m', 'who am i'], { env: anonymous })
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

test('a mutating command fast-forwards a data root another machine moved', () => {
  // The correctness half of this feature: rig pushed the data root but never pulled it, so a
  // second machine read stale records and wrote on top of them. Nothing else reaches the
  // plain behind-and-clean path — the tests either side of this one are behind *and* dirty,
  // or behind *and* ahead, which take different branches.
  const other = path.join(tmp, 'other-machine')
  assert.equal(gitIn(other, 'pull', '-q', '--rebase').status, 0)
  fs.writeFileSync(path.join(other, 'FROM-THE-OTHER-MACHINE.md'), 'written elsewhere')
  assert.equal(gitIn(other, 'add', '-A').status, 0)
  assert.equal(gitIn(other, 'commit', '-q', '-m', 'the other machine moved ahead').status, 0)
  assert.equal(gitIn(other, 'push', '-q').status, 0)

  const landed = path.join(dataRoot, 'FROM-THE-OTHER-MACHINE.md')
  assert.equal(fs.existsSync(landed), false, 'not here yet')

  const r = rig(['save', '--work', 't7', '-m', 'after the other machine moved'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /data root: fast-forwarded 1 commit\(s\) from origin/)
  assert.ok(fs.existsSync(landed), 'and the command ran against the updated tree, not the stale one')
})

test('doctor reports a data root that is behind origin, as of the last fetch', () => {
  const other = path.join(tmp, 'other-machine')
  assert.equal(gitIn(other, 'pull', '-q', '--rebase').status, 0)
  fs.writeFileSync(path.join(other, 'AGAIN.md'), 'moved again')
  assert.equal(gitIn(other, 'add', '-A').status, 0)
  assert.equal(gitIn(other, 'commit', '-q', '-m', 'the other machine moved again').status, 0)
  assert.equal(gitIn(other, 'push', '-q').status, 0)
  // doctor does not fetch the data root — a mutating command does — so it reports the
  // distance as of the last fetch, which this stands in for.
  assert.equal(gitIn(dataRoot, 'fetch', '-q').status, 0)
  const r = rig(['doctor'])
  assert.match(r.out, /data root is 1 commit\(s\) behind origin — `rig update` fast-forwards it/)
  assert.ok(!fs.existsSync(path.join(dataRoot, 'AGAIN.md')), 'reported, not fast-forwarded: doctor does not mutate')
  // Left level with origin, which is what the tests that follow start from.
  assert.equal(gitIn(dataRoot, 'merge', '-q', '--ff-only', '@{u}').status, 0)
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
    prs: [{
      branch: 'feat/old', number: 12, state: 'MERGED', url: 'https://github.com/acme/billing/pull/12',
      openedAt: '2026-01-02T00:00:00Z', mergedAt: '2026-01-03T00:00:00Z',
      commits: ['2026-01-01T09:00:00Z', '2026-01-02T10:00:00Z'],
    }],
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

test('list --json carries the record plus the timestamps a consumer cannot derive', () => {
  const r = rig(['list', '--json'])
  assert.equal(r.code, 0, r.out)
  const doc = JSON.parse(r.stdout)   // stdout is JSON and nothing else
  assert.equal(doc.live, true)
  const old = doc.works.find(w => w.id === 'old')
  assert.deepEqual(old.tickets, ['acme/platform#3', 'PROJ-1'])
  assert.equal(old.branch, 'feat/old')
  assert.equal(old.createdAt, '2026-01-01T00:00:00.000Z')
  const [billing] = old.repos
  assert.equal(billing.pr.number, 12)
  assert.equal(billing.pr.openedAt, '2026-01-02T00:00:00Z')
  assert.equal(billing.pr.mergedAt, '2026-01-03T00:00:00Z')
  // The start of the work: the PR's earliest commit, which outlives the merged branch.
  assert.equal(billing.firstCommitAt, '2026-01-01T09:00:00Z')
})

test('list --json orders works by last activity, oldest first', () => {
  const works = JSON.parse(rig(['list', '--json', '--quick']).stdout).works
  const stamps = works.map(w => w.activityAt)
  assert.deepEqual(stamps, [...stamps].sort(), 'activityAt ascending')
  assert.ok(works.length > 1, 'more than one work to order')
  // The sort key is the newest of the record's own timestamps, never a stored field.
  const old = works.find(w => w.id === 'old')
  assert.equal(old.activityAt, old.createdAt, 'no attach or close on this work')
})

test('list --json --quick omits the live fields rather than nulling them', () => {
  const doc = JSON.parse(rig(['list', '--json', '--quick']).stdout)
  assert.equal(doc.live, false)
  const [billing] = doc.works.find(w => w.id === 'old').repos
  assert.equal(billing.repo, 'billing')
  assert.ok(!('pr' in billing), 'no PR key at all — "not looked up" is not "no PR"')
  assert.ok(!('firstCommitAt' in billing))
  assert.ok(!('dirty' in billing))
})

test('list --json says so when gh could not answer for a repo', () => {
  const state = github()
  setGithub({ ...state, auth: 'missing' })
  const [billing] = JSON.parse(rig(['list', '--json']).stdout).works.find(w => w.id === 'old').repos
  assert.ok(!('pr' in billing), 'unknown is not reported as no PR')
  assert.match(billing.prUnknown, /gh not found on PATH/)
  // No PR to read commits from, and the branch's base ref is not in this checkout: the
  // start of the work is unknown too, and `prUnknown` is what says why.
  assert.equal(billing.firstCommitAt, null)
  setGithub(state)
})

test('dash renders the captured payload, and writes nothing into the data root', () => {
  const captured = path.join(tmp, 'payload.json')
  fs.writeFileSync(captured, rig(['list', '--json']).stdout)
  const before = gitIn(dataRoot, 'status', '--porcelain').stdout

  const r = rig(['dash', '--from', captured, '--no-open'])
  assert.equal(r.code, 0, r.out)
  const out = /dashboard at (.+)$/m.exec(strip(r.out))?.[1].trim()
  assert.ok(out && fs.existsSync(out), `a file at ${out}`)
  const html = fs.readFileSync(out, 'utf8')
  assert.match(html, /<h2>acme<\/h2>/, 'the org that owns the works')
  assert.match(html, /Generated <strong>/, 'when it was true')
  assert.doesNotMatch(html, /<script/i)

  assert.equal(gitIn(dataRoot, 'status', '--porcelain').stdout, before, 'the data root is untouched')
  assert.ok(!fs.existsSync(path.join(dataRoot, 'dash.html')), 'and nothing was written into it')
})

test('dash reads the works itself when given no payload', () => {
  const r = rig(['dash', '--no-open'])
  assert.equal(r.code, 0, r.out)
  // A directory of rig's own under the temp root, so the filename can stay stable.
  assert.match(r.out, /dashboard at .+rig-dash.dash\.html/)
})

test('dash --quick looks nothing up, and still renders what is recorded', () => {
  // The flag was parsed and then never read, so the only symptom was a page that took as
  // long as the live one. With gh gone, a dash that reaches for it cannot quietly succeed.
  const state = github()
  setGithub({ ...state, auth: 'missing' })
  const r = rig(['dash', '--quick', '--no-open'])
  assert.equal(r.code, 0, r.out)
  const html = fs.readFileSync(/dashboard at (.+)$/m.exec(strip(r.out))[1].trim(), 'utf8')
  assert.match(html, /no PR state was looked up|read from the records/, 'the page says nothing was looked up')
  setGithub(state)
})

test('dash dies on a window it cannot parse rather than showing everything', () => {
  const captured = path.join(tmp, 'window-payload.json')
  fs.writeFileSync(captured, rig(['list', '--json', '--quick']).stdout)
  const r = rig(['dash', '--from', captured, '--no-open', '--since', 'last tuesday'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /--since wants a number of days like 14d/)
})

test('dash says which payload file it could not find', () => {
  const r = rig(['dash', '--from', path.join(tmp, 'nope.json'), '--no-open'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no such payload file/)
})

test('list shows each work\'s phase and how long since it was touched', () => {
  const r = rig(['list', '--quick'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /old feat\/old\n {2}Designing · \d+[mhd] ago/)
  // "just now" on a fast runner: the work was closed seconds ago, in an earlier test.
  assert.match(r.out, /\n {2}Closed · (just now|\d+[mhd] ago)/, 'a closed work says so here, not next to the branch')
  assert.ok(r.out.indexOf('old feat/old') < r.out.indexOf('t1 chore/'), 'least recently touched first')
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

test('close refuses on an open PR even when the repo\'s worktree folder is already gone', () => {
  const state = github()
  state.repos['acme/billing'].prs[0].state = 'OPEN'
  setGithub(state)
  const billing = path.join(workRoot, 'old', 'billing')
  fs.rmSync(billing, { recursive: true, force: true })

  const r = rig(['close', '--work', 'old'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /billing: PR #12 still open/)
  assert.equal(readJson(path.join(dataRoot, 'work', 'old', 'work.json')).closedAt, undefined, 'not closed')

  // Recreate the worktree so the later close-and-teardown test still exercises that path.
  fs.mkdirSync(billing, { recursive: true })
  const g = gitIn(billing, 'init', '-q', '-b', 'main')
  assert.equal(g.status, 0, g.stderr)
  state.repos['acme/billing'].prs[0].state = 'MERGED'
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

test('close recorded the merged PR\'s terminal facts before saving, and a record needs no lookup to read back', () => {
  const saved = readJson(path.join(dataRoot, 'work', 'old', 'work.json'))
  const stored = saved.repos[0].branches[0].pr
  assert.equal(stored.number, 12)
  assert.equal(stored.url, 'https://github.com/acme/billing/pull/12')
  assert.equal(stored.openedAt, '2026-01-02T00:00:00Z')
  assert.equal(stored.mergedAt, '2026-01-03T00:00:00Z')
  assert.equal(stored.firstCommitAt, '2026-01-01T09:00:00Z')
  assert.deepEqual(Object.keys(stored).sort(),
    ['approvedAt', 'firstCommitAt', 'firstReviewAt', 'mergedAt', 'number', 'openedAt', 'url'].sort(),
    'only terminal facts — never state, dirty, or ahead/behind')

  // gh unreachable: a stored record needs no lookup, live or `--quick` alike.
  const state = github()
  setGithub({ ...state, auth: 'missing' })
  for (const args of [['list', '--json', '--quick'], ['list', '--json']]) {
    const billing = JSON.parse(rig(args).stdout).works.find(w => w.id === 'old').repos[0]
    assert.equal(billing.pr.recorded, true)
    assert.equal(billing.pr.mergedAt, '2026-01-03T00:00:00Z')
    assert.equal(billing.firstCommitAt, '2026-01-01T09:00:00Z')
    assert.ok(!('prUnknown' in billing), 'a stored record has nothing left to refuse')
  }
  setGithub(state)
})

test('doctor after setup reports the data root state, and says so in its exit code', () => {
  const r = rig(['doctor'])
  assert.match(r.out, /data root is a git checkout/)
  assert.doesNotMatch(r.out, /uncommitted change/, 'every mutating command committed as it went')
  assert.match(r.out, /no upstream — local only/)
  // The one test watching the whole wire: a snapshot gathered off a real installation, turned
  // into findings, rendered, counted, and the count becoming the exit code. A snapshot built
  // wrong leaves every fixture in test/doctor.test.mjs passing and doctor wrong on every real
  // machine, and everything above a check has already printed by the time that check dies —
  // `doctor` used to die on the free-space probe and nothing noticed.
  //
  // The verdict line is asked what it counted rather than the output being grepped for a
  // complaint this host might legitimately have: free space is the host's business and not
  // this run's, and what must hold is that the two agree.
  const counted = Number(/(\d+) thing\(s\) to look at/.exec(r.out)?.[1] ?? 0)
  assert.equal(r.code, counted ? 1 : 0, r.out)
})

test('doctor names a key of the org half left behind in the machine file', () => {
  // `orgs` and `tracker` were both written there by older versions of `init`, where a stale
  // copy silently shadowed the committed answer. Now they are dropped from the merge and said
  // out loud, so the file can be cleaned up.
  const before = fs.readFileSync(localConfig, 'utf8')
  fs.writeFileSync(localConfig, JSON.stringify({ ...readJson(localConfig), orgs: ['stale'], tracker: {} }, null, 2))
  try {
    const out = rig(['doctor']).out
    assert.match(out, /has "orgs" — ignored; it lives in rig\.json/)
    assert.match(out, /has "tracker" — ignored; it lives in rig\.json/)
  } finally { fs.writeFileSync(localConfig, before) }
})

test('the real global git config was never touched', () => {
  // core.longpaths lands in the temp global config, proving the redirect held.
  const r = spawnSync('git', ['config', '--global', 'core.longpaths'], { encoding: 'utf8', env })
  assert.equal(r.stdout.trim(), 'true')
})

test('doctor reports a pending migration, and never runs it', () => {
  const file = path.join(dataRoot, 'rig.json')
  const stamped = fs.readFileSync(file, 'utf8')
  const { writtenBy, ...unstamped } = readJson(file)
  assert.equal(writtenBy, VERSION)
  fs.writeFileSync(file, JSON.stringify(unstamped, null, 2) + '\n')
  try {
    const r = rig(['doctor'])
    assert.match(r.out, new RegExp(`${MIGRATIONS.length} pending migration\\(s\\) — run \`rig update\`: stamp the data root`))
    assert.equal(readJson(file).writtenBy, undefined, 'reported, not run')
  } finally {
    fs.writeFileSync(file, stamped)
  }
})

test('a data root from before stamping is warned about, then migrated by update', () => {
  const file = path.join(dataRoot, 'rig.json')
  const { writtenBy, ...unstamped } = readJson(file)   // as a rig from before this check left it
  assert.equal(writtenBy, VERSION)
  fs.writeFileSync(file, JSON.stringify(unstamped, null, 2) + '\n')

  const warned = rig(['save', '--work', 't7', '-m', 'a note'])
  assert.equal(warned.code, 0, warned.out)
  assert.match(warned.out, new RegExp(`record format 0, this rig writes ${MAJOR}`))

  const updated = rig(['update'])
  assert.match(updated.out, /migrated: stamp the data root/)
  assert.equal(readJson(file).writtenBy, VERSION)
  assert.equal(dirty(dataRoot), '', 'the migration is committed, not left in the tree')
  assert.match(updated.out, new RegExp(`record format ${MAJOR}`), 'the doctor checks run inline')
})

test('update does not migrate over a dirty data root that has no upstream', () => {
  // The guard used to key on `updateCheckout` not reporting failure, and a data root with no
  // upstream reports 'current' before cleanliness is ever asked about — so the migration
  // commit staged the user's half-written notes under a "record format" message.
  const file = path.join(dataRoot, 'rig.json')
  const cfg = readJson(file)
  delete cfg.writtenBy
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + String.fromCharCode(10))
  assert.equal(gitIn(dataRoot, 'commit', '-q', '-am', 'back to an unstamped data root').status, 0)
  fs.writeFileSync(path.join(dataRoot, 'HALF-WRITTEN.md'), 'not ready to share')

  const r = rig(['update'])
  assert.match(r.out, /migration\(s\) pending, not run/)
  assert.doesNotMatch(r.out, /migrated:/, 'nothing ran')
  assert.equal(readJson(file).writtenBy, undefined, 'and the stamp did not move')
  assert.match(dirty(dataRoot), /HALF-WRITTEN/, 'the unfinished file is still the users own to deal with')
  assert.doesNotMatch(lastCommit(dataRoot), /record format/)

  fs.rmSync(path.join(dataRoot, 'HALF-WRITTEN.md'))
  assert.match(rig(['update']).out, /migrated: stamp the data root/, 'it migrates once the tree is clean')
  assert.ok(readJson(file).writtenBy, 'and the stamp moves')
})

test('a second update migrates nothing', () => {
  const r = rig(['update'])
  assert.doesNotMatch(r.out, /migrated:/)
  assert.match(r.out, new RegExp(`record format ${MAJOR}`))
})

test('a rig older than the data root refuses to write, and still reads', () => {
  const file = path.join(dataRoot, 'rig.json')
  const saved = readJson(file)
  fs.writeFileSync(file, JSON.stringify({ ...saved, writtenBy: '99.0.0' }, null, 2) + '\n')

  const blocked = rig(['save', '--work', 't7', '-m', 'from an older rig'])
  assert.equal(blocked.code, 1, blocked.out)
  assert.match(blocked.out, new RegExp(`writes record format ${MAJOR}`))
  assert.match(blocked.out, /is at 99/)

  const listed = rig(['list', '--quick'])
  assert.equal(listed.code, 0, listed.out)
  assert.match(listed.out, /t7/, 'reading a newer data root is harmless')

  fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n')
  assert.equal(rig(['save', '--work', 't7', '-m', 'restored']).code, 0)
})

// `rig backfill` reads every work.json directly, so a work for it needs no work-root
// folder at all — planted the same way the "old-shaped record" test above plants one.
const plantWork = (id, record) => {
  const dir = path.join(dataRoot, 'work', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'work.json'), JSON.stringify(record, null, 2))
}

test('rig backfill fills a merged PR\'s terminal facts, and leaves an unmerged one alone', () => {
  const state = github()
  state.repos['acme/checkout'] = {
    prs: [{
      branch: 'feat/t8', number: 20, state: 'MERGED', url: 'https://github.com/acme/checkout/pull/20',
      openedAt: '2026-02-01T00:00:00Z', mergedAt: '2026-02-05T00:00:00Z',
      commits: ['2026-01-30T09:00:00Z'],
      reviews: [{ state: 'APPROVED', submittedAt: '2026-02-04T00:00:00Z' }],
    }],
  }
  state.repos['acme/ledger'] = {
    prs: [{
      branch: 'feat/t8', number: 21, state: 'OPEN', url: 'https://github.com/acme/ledger/pull/21',
      openedAt: '2026-02-01T00:00:00Z', mergedAt: null, commits: ['2026-02-01T09:00:00Z'],
    }],
  }
  setGithub(state)

  plantWork('t8', {
    id: 't8', title: 'Backfill work', tickets: [], ticketsDeclined: true, type: 'feat',
    branch: 'feat/t8', status: 'closed',
    repos: [
      { repo: 'checkout', org: 'acme', base: 'main', attachedAt: '2026-02-01T00:00:00.000Z' },
      { repo: 'ledger', org: 'acme', base: 'main', attachedAt: '2026-02-01T00:00:00.000Z' },
    ],
    createdAt: '2026-02-01T00:00:00.000Z', closedAt: '2026-02-05T01:00:00.000Z',
  })

  const record = path.join(dataRoot, 'work', 't8', 'work.json')
  const r = rig(['backfill', '--work', 't8'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /recorded PR #20/)
  assert.match(r.out, /backfilled 1 PR record\(s\) across 1 work\(s\)/)

  const saved = readJson(record)
  assert.deepEqual(Object.keys(saved.repos[0].branches[0].pr).sort(),
    ['approvedAt', 'firstCommitAt', 'firstReviewAt', 'mergedAt', 'number', 'openedAt', 'url'].sort(),
    'only terminal facts stored, never state or dirty/ahead/behind')
  assert.equal(saved.repos[0].branches[0].pr.number, 20)
  assert.equal(saved.repos[0].branches[0].pr.firstCommitAt, '2026-01-30T09:00:00Z')
  assert.equal(saved.repos[0].branches[0].pr.approvedAt, '2026-02-04T00:00:00Z')
  assert.equal(saved.repos[1].pr, undefined, 'the open PR on ledger is not terminal yet — nothing to store')
  assert.equal(lastCommit(dataRoot), 'rig backfill t8: 1 PR record(s) across 1 work(s)')
})

test('a second backfill run stores nothing, and says so', () => {
  const before = lastCommit(dataRoot)
  const r = rig(['backfill', '--work', 't8'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /nothing to backfill — every merged PR already has a stored record/)
  assert.equal(lastCommit(dataRoot), before, 'nothing new to commit')
  assert.equal(dirty(dataRoot), '')
})

test('--force refreshes an entry that is already stored; without it, a stored entry is left alone', () => {
  const state = github()
  // An earlier approval than the one already stored — proof that a refresh actually asked
  // GitHub again, rather than recomputing from what was already on disk.
  state.repos['acme/checkout'].prs[0].reviews.unshift({ state: 'APPROVED', submittedAt: '2026-02-03T00:00:00Z' })
  setGithub(state)

  const plain = rig(['backfill', '--work', 't8'])
  assert.match(plain.out, /nothing to backfill/)
  assert.equal(readJson(path.join(dataRoot, 'work', 't8', 'work.json')).repos[0].branches[0].pr.approvedAt, '2026-02-04T00:00:00Z')

  const forced = rig(['backfill', '--work', 't8', '--force'])
  assert.equal(forced.code, 0, forced.out)
  assert.match(forced.out, /refreshed PR #20/)
  assert.match(forced.out, /backfilled 1 PR record\(s\)/)
  assert.equal(readJson(path.join(dataRoot, 'work', 't8', 'work.json')).repos[0].branches[0].pr.approvedAt, '2026-02-03T00:00:00Z')
})

test('backfill: a lookup GitHub refuses is reported and left unstored, never cached as unknown', () => {
  const state = github()
  state.repos['acme/warehouse'] = {
    prs: [{
      branch: 'feat/t9', number: 30, state: 'MERGED', url: 'https://github.com/acme/warehouse/pull/30',
      openedAt: '2026-02-10T00:00:00Z', mergedAt: '2026-02-12T00:00:00Z', commits: ['2026-02-09T00:00:00Z'],
    }],
  }
  setGithub(state)
  plantWork('t9', {
    id: 't9', title: 'Unresolvable at first', tickets: [], ticketsDeclined: true, type: 'feat',
    branch: 'feat/t9', status: 'closed',
    repos: [{ repo: 'warehouse', org: 'acme', base: 'main', attachedAt: '2026-02-10T00:00:00.000Z' }],
    createdAt: '2026-02-10T00:00:00.000Z', closedAt: '2026-02-12T01:00:00.000Z',
  })

  setGithub({ ...state, auth: 'missing' })
  let r = rig(['backfill', '--work', 't9'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /nothing to backfill/)
  assert.match(r.out, /GitHub would not answer for 1, left unstored/)
  assert.match(r.out, /t9\/warehouse feat\/t9: gh not found on PATH/,
    "the branch is named too: a repo carries several branches of one work once it has stages")
  assert.equal(readJson(path.join(dataRoot, 'work', 't9', 'work.json')).repos[0].branches?.[0]?.pr, undefined,
    'a refused lookup is not "no PR" — the next run gets a real try, not a cached guess')

  setGithub(state)   // gh is back
  r = rig(['backfill', '--work', 't9'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /backfilled 1 PR record\(s\)/)
  assert.equal(readJson(path.join(dataRoot, 'work', 't9', 'work.json')).repos[0].branches[0].pr.number, 30)
})

test('rig backfill with no --work scans every work in the data root', () => {
  const state = github()
  state.repos['acme/reporting'] = {
    prs: [{
      branch: 'feat/t10', number: 40, state: 'MERGED', url: 'https://github.com/acme/reporting/pull/40',
      openedAt: '2026-02-15T00:00:00Z', mergedAt: '2026-02-16T00:00:00Z', commits: ['2026-02-14T00:00:00Z'],
    }],
  }
  setGithub(state)
  plantWork('t10', {
    id: 't10', title: 'Scanned without --work', tickets: [], ticketsDeclined: true, type: 'feat',
    branch: 'feat/t10', status: 'closed',
    repos: [{ repo: 'reporting', org: 'acme', base: 'main', attachedAt: '2026-02-15T00:00:00.000Z' }],
    createdAt: '2026-02-15T00:00:00.000Z', closedAt: '2026-02-16T01:00:00.000Z',
  })

  // Every other work in the data root already has whatever it will ever have stored, so the
  // one new entry here is the only thing left to find without being told where to look.
  const r = rig(['backfill'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /backfilled 1 PR record\(s\) across 1 work\(s\)/)
  assert.equal(readJson(path.join(dataRoot, 'work', 't10', 'work.json')).repos[0].branches[0].pr.number, 40)
})

test('acceptance: with gh unavailable, rig list --json still emits complete PR timestamps for backfilled work', () => {
  const state = github()
  setGithub({ ...state, auth: 'missing' })
  for (const args of [['list', '--json', '--quick'], ['list', '--json']]) {
    const r = rig(args)
    assert.equal(r.code, 0, r.out)
    const checkout = JSON.parse(r.stdout).works.find(w => w.id === 't8').repos.find(x => x.repo === 'checkout')
    assert.equal(checkout.pr.recorded, true)
    assert.equal(checkout.pr.number, 20)
    assert.equal(checkout.pr.mergedAt, '2026-02-05T00:00:00Z')
    assert.equal(checkout.pr.approvedAt, '2026-02-03T00:00:00Z')
    assert.equal(checkout.firstCommitAt, '2026-01-30T09:00:00Z')
    assert.equal(checkout.pr.state, 'MERGED', 'a record exists only for a merged PR, and says so')
    assert.ok(!('prUnknown' in checkout), 'a stored record needs no GitHub call, so there is nothing to refuse')
  }
  // The point of the payload is the page. Rendering it is what proves the work did not
  // quietly drop out of every figure on the way.
  const page = rig(['dash', '--no-open'])
  assert.equal(page.code, 0, page.out)
  const html = fs.readFileSync(/dashboard at (.+)$/m.exec(strip(page.out))[1].trim(), 'utf8')
  // t10 is backfilled, single-repo and merged. Before the reader put `state` back, a recorded
  // PR reduced to "not merged" and every closed work left the figures as in flight instead.
  assert.match(html, /<th>t10<\/th>/, 'a backfilled work appears among the merged')
  assert.match(html, /count">3<\/span> merged · 0 in flight/, 'and none of them read as in flight')
  setGithub(state)
})
