// `rig attach owner/repo` and `rig new --repos owner/repo` (hugoforte/rig#351). The owner names
// the org outright: it must be one of the data root's orgs, and no other org is asked, because
// same-named repos in different orgs are normal and `owner/repo` is how the user says which.
//
// Two orgs that both have a `billing`, acme first, so a bare name would land in acme's and the
// owner is the only thing that can say globex's. One temp installation, shared, and the tests
// run in order.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall, readJson } from './harness.mjs'

const { tmp, dataRoot, workRoot, remotesDir, githubStateFile, rig, gitMust, cleanup } = makeInstall({
  inProcess: true,
  prefix: 'rig-attach-owner-',
  author: 'rig attach',
  email: 'attach@example.invalid',
  remotes: true,
  github: {
    auth: 'ok',
    repos: {
      'acme/billing': { language: 'JavaScript' },
      'globex/billing': { language: 'Go' },
      'globex/ledger': { language: 'Rust' },
    },
  },
})

const record = id => readJson(path.join(dataRoot, 'work', id, 'work.json'))
const attached = (id, name) => record(id).repos.find(r => r.repo === name)

// A bare repo standing in for `https://github.com/<org>/<repo>.git`, with one commit.
const publish = (org, repo) => {
  const seed = path.join(tmp, 'seed', org, repo)
  fs.mkdirSync(seed, { recursive: true })
  gitMust(seed, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${org}/${repo}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', `${repo}: first`)
  const bare = path.join(remotesDir, org, `${repo}.git`)
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  gitMust(tmp, 'clone', '-q', '--bare', seed, bare)
}

publish('acme', 'billing')
publish('globex', 'billing')
publish('globex', 'ledger')
publish('globex', 'audit')

after(cleanup)

test('an installation with two orgs, the first of which catalogues a billing', () => {
  const r = rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme,globex', '--tracker', 'acme=none,globex=none'])
  assert.equal(r.code, 0, r.out)
  const entry = path.join(dataRoot, 'catalog', 'acme', 'billing.md')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, '---\nrepo: billing\norg: acme\nrole: acme\'s billing\nsetup:\n  - echo acme-setup\n---\n\nacme\'s billing.\n')
  assert.equal(rig(['new', 'w1', '--title', 'Owner repo', '--type', 'fix', '--no-ticket']).code, 0)
})

test('attach owner/repo takes the owner as the org, over a same-named repo the catalogue has in another', () => {
  const r = rig(['attach', 'globex/billing', '--work', 'w1'])
  assert.equal(r.code, 0, r.out)
  assert.equal(attached('w1', 'billing').org, 'globex')
  assert.equal(fs.readFileSync(path.join(workRoot, 'w1', 'billing', 'README.md'), 'utf8'), '# globex/billing\n')
})

test('and drafts that org\'s catalogue entry rather than borrowing the other org\'s', () => {
  assert.match(fs.readFileSync(path.join(dataRoot, 'catalog', 'globex', 'billing.md'), 'utf8'), /DRAFT: unreviewed/)
  assert.notEqual(attached('w1', 'billing').role, 'acme\'s billing')
})

test('attaching the same owner/repo again does nothing, whatever the owner\'s case', () => {
  for (const arg of ['globex/billing', 'Globex/billing']) {
    const r = rig(['attach', arg, '--work', 'w1'])
    assert.equal(r.code, 0, `${arg}: ${r.out}`)
    assert.match(r.out, /billing already attached/, arg)
  }
  assert.equal(record('w1').repos.length, 1)
})

test('rig setup reads the entry of the attached repo\'s org, not a same-named one in another', () => {
  const r = rig(['setup', 'globex/billing', '--work', 'w1'])
  assert.doesNotMatch(r.out, /acme-setup/)
  assert.match(r.out, /billing: no setup commands in the catalogue/)
})

test('attach owner/repo on a repo whose folder is gone puts it back with its own org\'s entry', () => {
  fs.rmSync(path.join(workRoot, 'w1', 'billing'), { recursive: true, force: true, maxRetries: 5 })
  const r = rig(['attach', 'globex/billing', '--work', 'w1'])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(workRoot, 'w1', 'billing', 'README.md')), r.out)
  assert.doesNotMatch(r.out, /acme-setup/)
})

test('a work holding a repo of that name in another org refuses this one, and names it', () => {
  const r = rig(['attach', 'acme/billing', '--work', 'w1'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /w1 already holds globex\/billing, and a work holds one repo of a name/)
})

test('an owner that is not one of the data root\'s orgs is refused, naming the orgs', () => {
  const r = rig(['attach', 'initech/ledger', '--work', 'w1'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /"initech\/ledger": initech is not one of this data root's orgs \(acme, globex\)/)
  assert.equal(attached('w1', 'ledger'), undefined)
})

test('an owner that is an org but has no such repo is refused, and no other org is asked', () => {
  const r = rig(['attach', 'acme/ledger', '--work', 'w1'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /cannot resolve "acme\/ledger": acme has no repo ledger/)
  assert.equal(attached('w1', 'ledger'), undefined, 'globex has a ledger, and the owner said acme')
})

test('an owner GitHub would not answer for is refused naming the lookup, and no other org is asked', () => {
  const state = readJson(githubStateFile)
  const failing = structuredClone(state)
  failing.repos['globex/payroll'] = { language: 'Go', lookupFails: 'HTTP 502: Bad Gateway' }
  failing.repos['acme/payroll'] = { language: 'Go' }
  fs.writeFileSync(githubStateFile, JSON.stringify(failing))
  const r = rig(['attach', 'globex/payroll', '--work', 'w1'])
  fs.writeFileSync(githubStateFile, JSON.stringify(state))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /cannot resolve "globex\/payroll": could not ask GitHub whether globex\/payroll exists \(HTTP 502: Bad Gateway\)/)
})

test('an argument that is neither a name nor owner/repo is refused', () => {
  for (const arg of ['globex/', '/ledger', 'globex/ledger/x']) {
    const r = rig(['attach', arg, '--work', 'w1'])
    assert.equal(r.code, 1, `${arg}: ${r.out}`)
    assert.match(r.out, /is neither a repo name nor owner\/repo/, arg)
  }
})

test('new --repos takes owner/repo too, matching the owner whatever its case', () => {
  const r = rig(['new', 'w2', '--title', 'Owner repo again', '--type', 'fix', '--no-ticket', '--repos', 'Globex/ledger'])
  assert.equal(r.code, 0, r.out)
  assert.equal(attached('w2', 'ledger').org, 'globex', 'the configured spelling, not the typed one')
})

test('a catalogue entry that spells the org differently is recorded with the configured spelling', () => {
  const entry = path.join(dataRoot, 'catalog', 'globex', 'audit.md')
  fs.writeFileSync(entry, '---\nrepo: audit\norg: Globex\nrole: audit\n---\n\nglobex\'s audit.\n')
  const r = rig(['attach', 'globex/audit', '--work', 'w2'])
  assert.equal(r.code, 0, r.out)
  assert.equal(attached('w2', 'audit').org, 'globex')
})

test('new --repos refuses an owner outside the orgs before the work exists', () => {
  const r = rig(['new', 'w3', '--title', 'Not made', '--type', 'fix', '--no-ticket', '--repos', 'globex/ledger,initech/x'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /initech is not one of this data root's orgs/)
  assert.equal(fs.existsSync(path.join(dataRoot, 'work', 'w3')), false)
})

test('a reviewed entry in one org is not reported as a draft because another org\'s of the name is', () => {
  assert.equal(rig(['new', 'w4', '--title', 'Acme billing', '--type', 'fix', '--no-ticket', '--repos', 'acme/billing']).code, 0)
  assert.doesNotMatch(rig(['next', '--work', 'w4']).out, /catalogue entry for billing is still a draft/)
})

test('detach takes owner/repo, and an owner the work does not hold is not attached', () => {
  const wrong = rig(['detach', 'acme/billing', '--work', 'w1'])
  assert.equal(wrong.code, 1, wrong.out)
  assert.match(wrong.out, /acme\/billing is not attached to w1/)
  const r = rig(['detach', 'globex/billing', '--work', 'w1'])
  assert.equal(r.code, 0, r.out)
  assert.equal(attached('w1', 'billing'), undefined)
})
