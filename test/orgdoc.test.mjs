// The org doc end to end — hugoforte/rig#184.
//
// rig knew where an org's knowledge lives and nothing about what the org is for, so every work
// started with the human explaining it again. `<data root>/orgs/<org>.md` says it once, and
// every work reads it: the generated work AGENTS.md inlines the doc of each org the work's
// repos belong to. An absent doc means no constraints, so an org without one adds nothing.
//
// Two orgs in one data root, one repo each, attached to one work: acme gets a doc, globex
// never does. `RIG_FAKE_REMOTES` makes the worktrees real git, only local, and GitHub is the
// in-memory adapter. The tests run in order, each leaving the work where the next expects it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall, strip } from './harness.mjs'

const { tmp, dataRoot, workRoot, remotesDir, rig, gitMust, cleanup } = makeInstall({
  inProcess: true,
  prefix: 'rig-orgdoc-',
  remotes: true,
  github: {
    auth: 'ok',
    repos: {
      'acme/billing': { language: 'JavaScript' },
      'globex/ledger': { language: 'Go' },
    },
  },
})

const orgDoc = path.join(dataRoot, 'orgs', 'acme.md')
const generatedAgents = () => fs.readFileSync(path.join(workRoot, 't1', 'AGENTS.md'), 'utf8')

const publish = (org, repo) => {
  const seed = path.join(tmp, 'seed', repo)
  fs.mkdirSync(seed, { recursive: true })
  gitMust(seed, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', `${repo}: first`)
  const bare = path.join(remotesDir, org, `${repo}.git`)
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  gitMust(tmp, 'clone', '-q', '--bare', seed, bare)
}

publish('acme', 'billing')
publish('globex', 'ledger')

after(cleanup)

test('a work touching two orgs, neither with a doc', () => {
  assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme,globex', '--tracker', 'acme=none,globex=none', '--email', 'you@acme.example']).code, 0)
  assert.equal(rig(['new', 't1', '--title', 'Org doc work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 't1']).code, 0)
  assert.equal(rig(['attach', 'ledger', '--work', 't1']).code, 0)
})

test('with no org doc, the generated work file has no org section', () => {
  assert.doesNotMatch(generatedAgents(), /^## (acme|globex)$/m)
})

test('an org\'s doc is inlined in the generated work file, its headings nested under the org', () => {
  fs.mkdirSync(path.dirname(orgDoc), { recursive: true })
  fs.writeFileSync(orgDoc, `---
org: acme
---

## What we're trying to accomplish

Refunds that never double-charge.
`)
  assert.equal(rig(['save', '-m', 'org doc written', '--work', 't1']).code, 0)
  assert.match(generatedAgents(),
    /^## acme\n\n.*acme\.md.*\n\n### What we're trying to accomplish\n\nRefunds that never double-charge\.$/m)
})

test('a comment in the doc\'s code block is not taken for a heading', () => {
  fs.appendFileSync(orgDoc, '\n## How we like work done\n\n```bash\n# deploy on Tuesdays only\n```\n')
  assert.equal(rig(['save', '-m', 'org doc grown', '--work', 't1']).code, 0)
  assert.match(generatedAgents(), /^### How we like work done$/m)
  assert.match(generatedAgents(), /^# deploy on Tuesdays only$/m)
})

test('an org with no doc adds nothing beside one that has it', () => {
  assert.doesNotMatch(generatedAgents(), /globex/)
})

test('status names the doc of each org the work touches, or says there is none and where it would go', () => {
  const r = rig(['status', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  const out = strip(r.out)
  assert.ok(out.includes(`org acme ${orgDoc}`), 'acme\'s doc, by path')
  assert.ok(out.includes(`org globex no org doc — ${path.join(dataRoot, 'orgs', 'globex.md')}`), 'where globex\'s would be written')
})
