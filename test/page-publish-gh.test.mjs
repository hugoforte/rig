// `rig page --publish` through the real spawn: the CLI in a process of its own, starting a program
// called `gh` that it found on PATH. Every other test of a publish runs over the in-memory GitHub,
// which takes a JavaScript call, so it cannot see what is lost on the way to a process.
//
// The stand-in is a copy of this `node` named `gh`, because a spawn on Windows finds only `.exe` and
// `.com`, so no script could stand in there. `NODE_OPTIONS` has it load GH_STANDIN first, which
// answers and exits before node looks for a script to run. One mechanism on every platform, so a
// run on one machine proves what the others run. It never reaches GitHub: it answers what it knows
// and refuses everything else.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { billingInstall } from './billing-install.mjs'

const GH_STANDIN = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const here = path.dirname(process.execPath)
if (path.basename(process.execPath, '.exe') === 'gh') {
  // Node resolved its first argument to a path, taking it for the script to run.
  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)]
  const finish = (code, out = '', err = '') => {
    if (out) fs.writeSync(1, out)
    if (err) fs.writeSync(2, err)
    process.exit(code)
  }
  const answers = JSON.parse(fs.readFileSync(path.join(here, 'answers.json'), 'utf8'))
  const stdin = args.includes('--input') ? fs.readFileSync(0, 'utf8') : null
  fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ args, stdin }) + '\n')
  const asked = args.join(' ')
  if (args[0] === 'pr' && args[1] === 'view') finish(0, JSON.stringify(answers.pr))
  if (args[0] === 'api' && args[1] === '-X') {
    // What GitHub answers for an empty request body, in the words gh prints.
    let body = null
    try { body = JSON.parse(stdin) } catch {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) finish(1, '', 'gh: Body should be a JSON object (HTTP 400)\n')
    finish(0, 'c0ffee\n')
  }
  if (args[0] === 'api' && /\/contents\//.test(args[1])) {
    if (answers.existingSha) finish(0, answers.existingSha + '\n')
    finish(1, '', 'gh: Not Found (HTTP 404)\n')
  }
  if (args[0] === 'api' && answers.api[args[1]] !== undefined) finish(0, answers.api[args[1]] + '\n')
  if (args[0] === 'api' && /\/commits\/[0-9a-f]{40}$/.test(args[1])) finish(0, 'found\n')
  finish(1, '', 'stand-in gh does not know: ' + asked + '\n')
}
`

const m = billingInstall('rig-page-gh-')
const { tmp, dataRoot, rig, gitMust, env: installEnv, cleanup } = m

const HEAD = 'a'.repeat(40)
const PR_URL = 'https://github.com/acme/billing/pull/7'
const SITE = { url: 'https://wandering-otter-1a2b3c.pages.github.io/', public: false, branch: 'gh-pages', path: '/', build: 'legacy' }
const PAGE = `<!doctype html><head><meta name="rig:pr" content="${PR_URL}"><meta name="rig:head" content="${HEAD}"></head><p>a page, é and all</p>`
const PAGE_PATH = 'rig-pr-pages/acme/billing/7/index.html'

const standin = path.join(tmp, 'standin')
const callsFile = path.join(standin, 'calls.jsonl')
const answersFile = path.join(standin, 'answers.json')
const preload = path.join(standin, 'preload.cjs')
const built = path.join(tmp, 'dist.html')

// An environment with the stand-in first on PATH and no in-memory GitHub, so rig spawns `gh`.
const realSpawnEnv = () => {
  const out = { ...installEnv }
  delete out.RIG_FAKE_GITHUB
  // Windows spells it Path, and a copy of the environment keeps that spelling case-sensitively.
  let found = ''
  for (const key of Object.keys(out)) {
    if (key.toUpperCase() === 'PATH') {
      found = out[key]
      delete out[key]
    }
  }
  out.PATH = `${standin}${path.delimiter}${found}`
  // A backslash is an escape inside NODE_OPTIONS' quotes.
  out.NODE_OPTIONS = `--require "${preload.replaceAll('\\', '/')}"`
  return out
}

const answersWith = over => ({
  pr: { number: 7, state: 'OPEN', baseRefName: 'main', headRefName: 'feat/x', headRefOid: HEAD, url: PR_URL, title: 'X', body: '', additions: 1, deletions: 1, changedFiles: 1, isCrossRepository: false, headRepositoryOwner: { login: 'acme' } },
  api: {
    'repos/acme/billing': JSON.stringify({ name: 'billing', language: 'JavaScript', visibility: 'private' }),
    'repos/acme/rig-data': JSON.stringify({ name: 'rig-data', language: '', visibility: 'private' }),
    'repos/acme/rig-data/pages': JSON.stringify(SITE),
  },
  ...over,
})

function publish (over = {}) {
  fs.rmSync(callsFile, { force: true })
  fs.writeFileSync(answersFile, JSON.stringify(answersWith(over)))
  const r = rig(['page', PR_URL, '--publish', built], { inProcess: false, env: realSpawnEnv() })
  const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { r, calls, put: calls.find(c => c.args.includes('PUT')) }
}

// The body rig handed gh for the write, checked as GitHub reads it.
function assertBody (put, sha) {
  assert.ok(put, 'rig asked gh to write the page')
  assert.ok(put.args.includes(`repos/acme/rig-data/contents/${PAGE_PATH}`), put.args.join(' '))
  assert.deepEqual(put.args.slice(put.args.indexOf('--input'), put.args.indexOf('--input') + 2), ['--input', '-'])
  assert.ok(put.stdin, 'the request body reached gh on its stdin')
  const body = JSON.parse(put.stdin)
  assert.equal(body.branch, 'gh-pages')
  assert.equal(body.message, `Reading page for acme/billing#7 at ${HEAD.slice(0, 7)}`)
  assert.equal(Buffer.from(body.content, 'base64').toString('utf8'), PAGE, 'the content is the page, byte for byte')
  assert.equal(body.sha, sha)
}

before(() => {
  gitMust(dataRoot, 'remote', 'add', 'origin', 'https://github.com/acme/rig-data.git')
  gitMust(dataRoot, 'config', 'remote.origin.pushurl', path.join(tmp, 'no-such-remote'))
  fs.mkdirSync(standin)
  fs.copyFileSync(process.execPath, path.join(standin, process.platform === 'win32' ? 'gh.exe' : 'gh'))
  fs.writeFileSync(preload, GH_STANDIN)
  fs.writeFileSync(built, PAGE)
})
after(cleanup)

test('a new page reaches gh as a JSON body holding its path, branch, message and content', () => {
  const { r, put } = publish()
  assertBody(put)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Reading page, at `aaaaaaa`: https:\/\/wandering-otter-1a2b3c\.pages\.github\.io\/rig-pr-pages\/acme\/billing\/7\//)
})

test('a page already there is replaced, with the sha GitHub asks for in the same body', () => {
  const { r, put } = publish({ existingSha: 'b'.repeat(40) })
  assertBody(put, 'b'.repeat(40))
  assert.equal(r.code, 0, r.out)
})

test('the stand-in refuses what it does not know, so a publish that wandered would fail here', () => {
  const answers = answersWith()
  delete answers.api['repos/acme/rig-data/pages']
  const { r, calls } = publish({ api: answers.api })
  assert.notEqual(r.code, 0, r.out)
  assert.ok(!calls.some(c => c.args.includes('PUT')), 'no site, no write')
})
