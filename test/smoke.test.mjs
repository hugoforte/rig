// Runs a temp copy of the tool as a subprocess against temp work and data roots.
// RIG_ROOT follows the file's location, so the tool needs no test-only hooks.
//
// The tests below share one temp installation and run in order (init before new,
// new before close). node:test runs a file's tests serially by default; running a
// single one with --test-name-pattern is not supported.
//
// `gh` is kept away: on Linux/macOS a stub script on PATH prints `[]`; on Windows
// Node will not spawn a `.cmd` without a shell, so the real gh is removed from PATH
// instead and the tool takes its "gh not found" path. Nothing here needs gh output.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let tmp, tool, dataRoot, workRoot, env

const strip = s => s.replace(/\x1b\[\d+m/g, '')
const rig = (args, input) => {
  const r = spawnSync(process.execPath, [path.join(tool, 'bin', 'rig.mjs'), ...args], { encoding: 'utf8', env, input })
  return { code: r.status, out: strip(r.stdout + r.stderr) }
}
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'))

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-smoke-'))
  tool = path.join(tmp, 'rig')
  for (const d of ['bin', 'prompts', 'templates']) fs.cpSync(path.join(SRC, d), path.join(tool, d), { recursive: true })
  dataRoot = path.join(tmp, 'rig-data')
  workRoot = path.join(tmp, 'w')

  env = { ...process.env }
  if (process.platform === 'win32') {
    env.PATH = process.env.PATH.split(path.delimiter)
      .filter(p => !fs.existsSync(path.join(p, 'gh.exe'))).join(path.delimiter)
  } else {
    const stubs = path.join(tmp, 'stubs')
    fs.mkdirSync(stubs)
    // `auth status` fails so the tool's "not authenticated" warning is exercised.
    fs.writeFileSync(path.join(stubs, 'gh'), "#!/bin/sh\ncase \"$1\" in auth) exit 1 ;; esac\necho '[]'\n", { mode: 0o755 })
    env.PATH = stubs + path.delimiter + process.env.PATH
  }
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
  // Windows: gh is off PATH ("not found"). Elsewhere: the stub fails auth ("not authenticated").
  const r = rig(['init'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /gh not found on PATH|gh is not authenticated/)
})

test('init --orgs adds, never replaces', () => {
  rig(['init', '--orgs', 'acme-labs', '--tracker', 'acme-labs=jira:PROJ'])
  assert.deepEqual(readJson(path.join(dataRoot, 'rig.json')).orgs, ['acme', 'acme-labs'])
})

test('new, ticket, list, status, close on a work with no repos', () => {
  let r = rig(['new', 't1', '--title', 'Smoke work', '--type', 'chore'], 'the brief')
  assert.equal(r.code, 0, r.out)
  const record = path.join(dataRoot, 'work', 't1', 'work.json')
  assert.equal(readJson(record).branch, 'chore/smoke-work')
  assert.ok(fs.existsSync(path.join(workRoot, 't1', 'AGENTS.md')), 'generated file in the work folder')
  assert.match(fs.readFileSync(path.join(dataRoot, 'work', 't1', 'context.md'), 'utf8'), /the brief/)

  r = rig(['ticket', 'PROJ-9', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(readJson(record).tickets, ['PROJ-9'])
  assert.match(fs.readFileSync(path.join(dataRoot, 'work', 't1', 'context.md'), 'utf8'), /^Tickets: PROJ-9/m)

  r = rig(['list'])
  assert.match(r.out, /t1/)
  r = rig(['status', '--work', 't1'])
  assert.match(r.out, /branch chore\/smoke-work/)

  r = rig(['close', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.ok(readJson(record).closedAt)
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
