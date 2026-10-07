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
import { fileURLToPath } from 'node:url'
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

// The section's paragraph, whitespace folded, so a rewrap of the source is no change.
const replyRule = () => {
  const m = generatedAgents().match(/^## Replying to the user\n\n([\s\S]*?)\n\n## /m)
  assert.ok(m, 'the generated work file has a Replying to the user section')
  return m[1].replace(/\s+/g, ' ')
}

test('the generated work file opens every reply with what happened, then the user\'s action items, the rest below (#325)', () => {
  const rule = replyRule()
  assert.match(rule, /^Open every reply with a \*\*TL;DR\*\*: .*what happened or the answer, then the action items the user must take, if any — or "Nothing for you to do\." Everything else follows below it/)
})

test('a skill or prompt that sets its own reply shape keeps it, its opening naming the user\'s action items (#325)', () => {
  assert.match(replyRule(), /A skill or prompt that sets its reply's shape keeps it: its opening lines are the TL;DR, and they name the user's action items\./)
})

test('the tool\'s AGENTS.md quotes the generated reply rule word for word (#325)', () => {
  const toolAgents = fs.readFileSync(fileURLToPath(new URL('../AGENTS.md', import.meta.url)), 'utf8')
  assert.ok(toolAgents.replace(/\s+/g, ' ').includes(replyRule()), 'AGENTS.md rule 6 and the generated section say the same')
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
  fs.appendFileSync(orgDoc, '\n## What we believe\n\n```bash\n# deploy on Tuesdays only\n```\n')
  assert.equal(rig(['save', '-m', 'org doc grown', '--work', 't1']).code, 0)
  assert.match(generatedAgents(), /^# deploy on Tuesdays only$/m)
})

test('an org with no doc adds nothing beside one that has it', () => {
  assert.doesNotMatch(generatedAgents(), /globex/)
})

// The doc is hand-editable, so what follows is what a hand might write.
const regenerateWith = text => {
  fs.writeFileSync(orgDoc, text)
  assert.equal(rig(['save', '-m', 'org doc edited', '--work', 't1']).code, 0)
  return generatedAgents()
}

test('a doc that opens with a title still nests every heading under the org', () => {
  const out = regenerateWith('---\norg: acme\n---\n\n# Acme\n\n## What we believe\n\n###### Deepest\n')
  assert.match(out, /^### Acme\n\n#### What we believe\n\n###### Deepest$/m)
})

test('a fence closes only on its own kind, so a fence inside it hides no heading', () => {
  const out = regenerateWith('## What we believe\n\n````md\n```\n# not a heading\n```\n````\n\n## Whose call it is\n')
  assert.match(out, /^# not a heading\n```\n````\n\n### Whose call it is$/m)
})

test('a fence the doc leaves open is closed before the rest of the file', () => {
  assert.match(regenerateWith('## What we believe\n\n~~~\nunclosed\n'), /^unclosed\n~~~\n\n## Replying to the user$/m)
})

test('a doc saved with a byte-order mark keeps its frontmatter out of the file', () => {
  assert.doesNotMatch(regenerateWith('﻿---\norg: acme\n---\n\n## What hurts now\n\nRetries.\n'), /org: acme/)
})

test('a doc with nothing under its frontmatter adds nothing to the file', () => {
  assert.doesNotMatch(regenerateWith('---\norg: acme\n---\n'), /^## acme$/m)
})

test('and status says it has no org doc, so the lesson review still asks', () => {
  assert.match(strip(rig(['status', '--work', 't1']).out), /org acme no org doc/)
})

test('status names the doc of each org the work touches, or says there is none and where it would go', () => {
  regenerateWith('---\norg: acme\n---\n\n## What hurts now\n\nRetries.\n')
  const r = rig(['status', '--work', 't1'])
  assert.equal(r.code, 0, r.out)
  const out = strip(r.out)
  assert.ok(out.includes(`org acme ${orgDoc}`), 'acme\'s doc, by path')
  assert.ok(out.includes(`org globex no org doc — ${path.join(dataRoot, 'orgs', 'globex.md')}`), 'where globex\'s would be written')
})

test('status still names the doc once the work is closed and its folder is gone', () => {
  assert.equal(rig(['close', '--abandoned', '--work', 't1']).code, 0)
  assert.ok(strip(rig(['status', '--work', 't1']).out).includes(`org acme ${orgDoc}`))
})
