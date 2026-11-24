// A work branch its repo runs workflows on at every push, end to end: said where the branch is
// cut, by `rig status` while the work is open, and by `rig doctor` (hugoforte/rig#386). One temp
// installation, shared, and the tests run in order.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall, strip } from './harness.mjs'

const { tmp, dataRoot, workRoot, remotesDir, rig, gitMust, cleanup } = makeInstall({
  inProcess: true,
  prefix: 'rig-push-triggers-',
  author: 'rig push triggers',
  email: 'push-triggers@example.invalid',
  remotes: true,
  github: { auth: 'ok', repos: { 'acme/web': { language: 'TypeScript' } } },
})

// A bare repo standing in for `https://github.com/acme/web.git`, whose deploy runs on every push
// to `main` and to the hotfix family, and whose tests run on pull requests only.
const seed = path.join(tmp, 'seed', 'web')
fs.mkdirSync(path.join(seed, '.github', 'workflows'), { recursive: true })
gitMust(seed, 'init', '-q', '-b', 'main')
fs.writeFileSync(path.join(seed, '.github', 'workflows', 'deploy.yml'), 'on:\n  push:\n    branches:\n      - main\n      - "fix/**"\n')
fs.writeFileSync(path.join(seed, '.github', 'workflows', 'tests.yml'), 'on:\n  pull_request:\n    branches: [main]\n')
gitMust(seed, 'add', '-A')
gitMust(seed, 'commit', '-q', '-m', 'web: first')
const bare = path.join(remotesDir, 'acme', 'web.git')
fs.mkdirSync(path.dirname(bare), { recursive: true })
gitMust(tmp, 'clone', '-q', '--bare', seed, bare)

after(cleanup)

const run = args => { const r = rig(args); return { ...r, out: strip(r.out) } }

test('a set-up installation', () => {
  const r = run(['init', '--data-root', dataRoot, '--work-root', workRoot, '--orgs', 'acme', '--tracker', 'acme=none'])
  assert.equal(r.code, 0, r.out)
})

test('a branch cut where every push deploys is named at the cut, with the type that would not', () => {
  const r = run(['new', 'hot', '--title', 'Hot fix', '--type', 'fix', '--no-ticket', '--repos', 'web'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /web: fix\/hot-fix: a push runs deploy\.yml \(fix\/\*\*\) — `--type feat` or `chore` would not — rig never renames a branch, so push it only when a deploy is meant/)
})

test('rig status says it on the repo while the work is open', () => {
  const r = run(['status', '--work', 'hot'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /\n {2}pushes {2}fix\/hot-fix: a push runs deploy\.yml \(fix\/\*\*\)/)
})

test('rig doctor names it, without counting it', () => {
  const out = run(['doctor']).out
  assert.match(out, /hot: web on fix\/hot-fix: a push runs deploy\.yml \(fix\/\*\*\)/)
})

test('a branch no workflow runs on is cut without a word about pushes', () => {
  const r = run(['new', 'calm', '--title', 'Calm', '--type', 'feat', '--no-ticket', '--repos', 'web'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /a push runs/)
  assert.doesNotMatch(run(['status', '--work', 'calm']).out, /pushes/)
})
