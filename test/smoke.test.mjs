// Runs a temp copy of the tool as a subprocess against temp work and data roots.
// RIG_ROOT follows the file's location, so the roots need no test-only hook; GitHub
// is the one hook, below.
//
// The tests below share one temp installation and run in order (init before new,
// new before close). node:test runs a file's tests serially by default; running a
// single one with --test-name-pattern is not supported.
//
// GitHub is the in-memory adapter from bin/github.mjs, selected by RIG_FAKE_GITHUB
// naming a JSON state file the tool reads on start and writes back on exit. Tests seed
// it and read it back; the real `gh` is never spawned.
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
const rig = (args, input) => {
  const r = spawnSync(process.execPath, [path.join(tool, 'bin', 'rig.mjs'), ...args], { encoding: 'utf8', env, input })
  return { code: r.status, out: strip(r.stdout + r.stderr) }
}
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const setGithub = state => fs.writeFileSync(githubStateFile, JSON.stringify(state))
const github = () => readJson(githubStateFile)
const setTwg = state => fs.writeFileSync(twgStateFile, JSON.stringify(state))
const twg = () => readJson(twgStateFile)

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-smoke-'))
  tool = path.join(tmp, 'rig')
  for (const d of ['bin', 'prompts', 'templates']) fs.cpSync(path.join(SRC, d), path.join(tool, d), { recursive: true })
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
  assert.deepEqual(readJson(path.join(dataRoot, 'rig.json')), { orgs: ['acme'], tracker: { acme: { kind: 'none' } } })
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
  // "nothing is half-built" — `rig ticket <key>` can attach one later).
  assert.deepEqual(readJson(path.join(dataRoot, 'work', 't5-fail', 'work.json')).tickets, [])
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
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'seed']]) {
    const g = spawnSync('git', ['-C', billing, ...args], { encoding: 'utf8', env })
    assert.equal(g.status, 0, g.stderr)
  }
  let r = rig(['status', '--work', 'old'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /pr\s+#12 MERGED https:\/\/github\.com\/acme\/billing\/pull\/12/)
  r = rig(['list'])
  assert.match(r.out, /PR #12 merged/)
  assert.match(r.out, /safe to `rig close`/)
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
  assert.match(r.out, /uncommitted change/, 'records were written and not committed')
  assert.match(r.out, /no upstream — local only/)
})

test('the real global git config was never touched', () => {
  // core.longpaths lands in the temp global config, proving the redirect held.
  const r = spawnSync('git', ['config', '--global', 'core.longpaths'], { encoding: 'utf8', env })
  assert.equal(r.stdout.trim(), 'true')
})
