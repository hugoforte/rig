// `rig run`, `rig verify` and `rig deploy` end to end — hugoforte/rig#175.
//
// The catalogue knew how a repo is set up and how it is checked, and nothing about how it is
// brought up on this machine, verified in a browser once it is, or deployed. The three sit
// beside `check` on its rule (DESIGN.md decision 106): printed, never run, until `--run`; a
// command held and never a result; the file to write it in named when it is missing.
//
// The site the two polling commands wait for is an http server this file starts, told how
// many requests to refuse before answering 200 — so what is asserted is the poll and its
// timeout, with no real site and nothing on the network. The commands themselves are `echo`
// and `node -e`, so no npm is spawned; what is asserted is where they ran, what they were
// handed, and that nothing about the outcome was written down.
//
// `RIG_FAKE_REMOTES` points bin/worktrees.mjs at a directory of bare repos, so the mirror
// and the worktrees are real git, only local. One temp installation, shared, and the tests
// run in order — each leaves the work where the next one expects it. test/harness.mjs
// builds it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { makeInstall } from './harness.mjs'

const { tmp, dataRoot, workRoot, remotesDir, rig, gitMust, cleanup } = makeInstall({
  inProcess: true,
  prefix: 'rig-run-verify-deploy-',
  author: 'rig run',
  email: 'run@example.invalid',
  remotes: true,
  github: {
    auth: 'ok',
    repos: {
      'acme/billing': { language: 'JavaScript' },
      'acme/orders': { language: 'Go' },
      'acme/web': { language: 'TypeScript' },
    },
  },
})

// A catalogue command inherits rig's stdio, so what `verify --run` prints only reaches an
// assertion when rig is a child with a pipe on the other end of it. The two commands that
// poll the site cannot be run that way: the site is this process, and a subprocess blocks
// this process's event loop for as long as it runs — so `run --run` and `deploy --run` are
// awaited in-process, and what their start commands did is read off disk.
const SUBPROCESS = { inProcess: false }

const catalogEntry = repo => path.join(dataRoot, 'catalog', 'acme', `${repo}.md`)
const recordFile = path.join(dataRoot, 'work', 't1', 'work.json')
const runLog = repo => path.join(workRoot, 't1', '.rig', `${repo}.run.log`)

// The site: refuses the first `refuse` requests with 503 and answers 200 after that.
let hits = 0
let refuse = 0
const server = http.createServer((_req, res) => {
  hits += 1
  res.statusCode = hits > refuse ? 200 : 503
  res.end()
})
const site = () => `http://127.0.0.1:${server.address().port}/`
const answeringAfter = n => { hits = 0; refuse = n }
// A second URL on the same server, standing in for a deployed environment.
const deployed = () => `${site()}develop`

// A bare repo standing in for `https://github.com/acme/<repo>.git`, with one commit.
const publish = repo => {
  const seed = path.join(tmp, 'seed', repo)
  fs.mkdirSync(seed, { recursive: true })
  gitMust(seed, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', `${repo}: first`)
  const bare = path.join(remotesDir, 'acme', `${repo}.git`)
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  gitMust(tmp, 'clone', '-q', '--bare', seed, bare)
}

// The correction rule 4 asks for, made by hand: the abilities, put where `rig attach` left
// commented examples.
const correct = (repo, abilities) => fs.writeFileSync(catalogEntry(repo), `---
repo: ${repo}
org: acme
stack: JavaScript
role: a repo with a site to bring up
talks_to: []
setup: []
check: []
${abilities}
---

Prose.
`)

const START = 'echo started-by-rig'
const SAYS_BASE_URL = 'node -e "console.log(\'base=\' + process.env.RIG_BASE_URL)"'
// A deploy that leaves its mark where it ran, so an in-process run can be asked what it did.
const DEPLOY = 'node -e "require(\'fs\').writeFileSync(\'deployed.marker\', \'\')"'
const deployMarker = repo => path.join(workRoot, 't1', repo, 'deployed.marker')

publish('billing')
publish('orders')
publish('web')

after(() => {
  server.closeAllConnections()
  server.close()
  cleanup()
})

test('a work with three repos attached, each drafted into the catalogue, and a site to poll', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--tracker', 'acme=none', '--email', 'you@acme.example']).code, 0)
  assert.equal(rig(['new', 't1', '--title', 'Run work', '--type', 'feat', '--no-ticket']).code, 0)
  for (const repo of ['billing', 'orders', 'web']) {
    assert.equal(rig(['attach', repo, '--work', 't1']).code, 0)
  }
})

test('the drafted entry shows the three abilities as commented examples, beside the check', () => {
  const drafted = fs.readFileSync(catalogEntry('billing'), 'utf8')
  assert.match(drafted, /^check: \[\]$/m)
  for (const key of ['run', 'verify', 'deploy']) assert.match(drafted, new RegExp(`^# ${key}:$`, 'm'))
})

test('a repo with none of the three is told which file to write each in', () => {
  for (const [args, key] of [
    [['run', 'web'], 'run'],
    [['verify', 'web'], 'verify'],
    [['deploy', 'web', '--env', 'develop'], 'deploy'],
  ]) {
    const r = rig([...args, '--work', 't1'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, new RegExp(`web: no ${key}`), `${key}: the missing ability, named`)
    assert.ok(r.out.includes(catalogEntry('web')), `${key}: the file to correct, named`)
  }
})

test('run prints start and ready, and starts nothing', () => {
  correct('billing', `run:
  start: ${START}
  ready: ${site()}
verify:
  - ${SAYS_BASE_URL}
deploy:
  develop:
    start: ${DEPLOY}
    ready: ${deployed()}`)
  const r = rig(['run', 'billing', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing[\s\S]*not run — `rig run billing --run`/)
  assert.match(r.out, new RegExp(`start\\s+${START}`))
  assert.match(r.out, new RegExp(`ready\\s+${site()}`))
  assert.ok(!fs.existsSync(runLog('billing')), 'no log, because nothing was started')
})

test('verify prints the commands and the URL they would get, run.ready by default', () => {
  const r = rig(['verify', 'billing', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing[\s\S]*not run — `rig verify billing --run`/)
  assert.ok(r.out.includes(`RIG_BASE_URL=${site()}`), r.out)
  assert.ok(r.out.includes(SAYS_BASE_URL), r.out)
  assert.doesNotMatch(r.out, /^base=/m, 'the command was printed, not run')
})

test('verify --env points the same commands at the environment\'s ready URL', () => {
  const r = rig(['verify', 'billing', '--work', 't1', '--env', 'develop'])
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes(`RIG_BASE_URL=${deployed()}`), r.out)
  assert.match(r.out, /rig verify billing --run --env develop/)
})

test('an --env the entry does not name is refused, naming the ones it does', () => {
  for (const args of [['verify', 'billing', '--env', 'prod'], ['deploy', 'billing', '--env', 'prod']]) {
    const r = rig([...args, '--work', 't1'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /billing: no deploy env "prod" in the catalogue — it names develop/)
  }
})

test('deploy wants both the repo and the environment named', () => {
  assert.match(rig(['deploy', '--work', 't1']).out, /rig deploy wants a repo/)
  assert.match(rig(['deploy', 'billing', '--work', 't1']).out, /rig deploy wants an environment/)
})

test('deploy prints the environment\'s start and ready, and runs nothing', () => {
  const r = rig(['deploy', 'billing', '--env', 'develop', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing → develop[\s\S]*not run — `rig deploy billing --env develop --run`/)
  assert.ok(r.out.includes(`start  ${DEPLOY}`), r.out)
  assert.ok(r.out.includes(`ready  ${deployed()}`), r.out)
  assert.ok(!fs.existsSync(deployMarker('billing')), 'the command was printed, not run')
})

test('verify --run hands the command the site as RIG_BASE_URL, in the repo\'s worktree', () => {
  const r = rig(['verify', 'billing', '--work', 't1', '--run'], SUBPROCESS)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes(`base=${site()}`), r.out)
  assert.match(r.out, /\(in billing\)/)
})

test('verify --run --env hands it the environment instead', () => {
  const r = rig(['verify', 'billing', '--work', 't1', '--run', '--env', 'develop'], SUBPROCESS)
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes(`base=${deployed()}`), r.out)
})

test('a failed verify is reported, and the exit code carries the verdict', () => {
  correct('orders', `run:
  start: ${START}
  ready: ${site()}
verify:
  - node -e "process.exit(1)"
deploy:
  develop:
    start: node -e "process.exit(1)"
    ready: ${deployed()}`)
  const r = rig(['verify', 'orders', '--work', 't1', '--run'], SUBPROCESS)
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /verify command failed: node -e "process\.exit\(1\)"/)
})

test('run --run starts the site detached with a log, and waits for ready to answer', async () => {
  answeringAfter(2)
  const r = await rig(['run', 'billing', '--work', 't1', '--run'])
  assert.equal(r.code, 0, r.out)
  assert.ok(r.out.includes(`billing is up at ${site()}`), r.out)
  assert.match(r.out, /pid \d+/, 'the process is yours from here, so its pid is said')
  assert.ok(r.out.includes(runLog('billing')), 'and where its output goes')
  assert.equal(hits, 3, 'polled until the site answered, and not after')
  assert.match(fs.readFileSync(runLog('billing'), 'utf8'), /started-by-rig/, 'the command ran, into the log')
  assert.ok(!fs.existsSync(path.join(workRoot, 't1', 'billing', '.rig-run.log')),
    'the log is outside the worktree, where it cannot read as an uncommitted change')
})

test('a run records nothing — not in the catalogue, not in the work record', async () => {
  answeringAfter(0)
  const before = [fs.readFileSync(catalogEntry('billing')), fs.readFileSync(recordFile)]
  assert.equal((await rig(['run', 'billing', '--work', 't1', '--run'])).code, 0)
  assert.deepEqual([fs.readFileSync(catalogEntry('billing')), fs.readFileSync(recordFile)], before,
    'the catalogue holds the command; a result is nobody\'s durable fact')
})

test('a site that never answers is the exit code, and the log is named', async () => {
  answeringAfter(Infinity)
  const r = await rig(['run', 'billing', '--work', 't1', '--run', '--timeout', '1'])
  assert.equal(r.code, 1, r.out)
  assert.ok(r.out.includes(`billing did not answer at ${site()} within 1s`), r.out)
  assert.ok(r.out.includes(runLog('billing')), 'where to look, when it did not come up')
  assert.ok(hits >= 2, 'it kept asking until the deadline')
})

test('deploy --run runs start in the worktree, then waits for the environment to answer', async () => {
  answeringAfter(2)
  const r = await rig(['deploy', 'billing', '--env', 'develop', '--work', 't1', '--run'])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(deployMarker('billing')), 'the start command ran, in billing\'s worktree')
  assert.ok(r.out.includes(`billing is up at ${deployed()}`), r.out)
  assert.equal(hits, 3, 'polled until the environment answered, and not after')
})

test('a deploy whose start fails never polls', async () => {
  answeringAfter(0)
  const r = await rig(['deploy', 'orders', '--env', 'develop', '--work', 't1', '--run'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /deploy command failed/)
  assert.doesNotMatch(r.out, /is up at/)
  assert.equal(hits, 0)
})
