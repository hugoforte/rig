// The earlier works end to end — hugoforte/rig#381.
//
// A closed work's decisions live in its context doc and notes, and the next work on the same
// repo saw none of them. The generated work AGENTS.md now lists, under each attached repo, the
// works that touched it and closed in the last 90 days, at most ten, with the totals on a lead
// line, as an index whose bodies the agent reads on demand.
//
// One data root, two repos in one org: billing has history, ledger has none. The earlier works
// are records written straight into the data root, closed relative to now. `RIG_FAKE_REMOTES`
// makes the worktrees real git, only local, and GitHub is the in-memory adapter. The tests run
// in order, each leaving the work where the next expects it.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall } from './harness.mjs'

const { tmp, dataRoot, workRoot, remotesDir, rig, gitMust, cleanup } = makeInstall({
  inProcess: true,
  prefix: 'rig-earlier-',
  remotes: true,
  github: {
    auth: 'ok',
    repos: {
      'acme/billing': { language: 'JavaScript' },
      'acme/ledger': { language: 'Go' },
    },
  },
})

after(cleanup)

const generatedAgents = () => fs.readFileSync(path.join(workRoot, 't1', 'AGENTS.md'), 'utf8')
const day = 86400000
const ago = days => new Date(Date.now() - days * day).toISOString()
const dateOf = iso => iso.slice(0, 10)
// Kept as written, so an assertion made after midnight still names the day the record says.
const newestClosedAt = ago(2)

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

const record = (id, fields) => {
  const dir = path.join(dataRoot, 'work', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'work.json'), typeof fields === 'string' ? fields : JSON.stringify({
    id,
    title: `${id} title`,
    tickets: [],
    stages: [],
    repos: [{ repo: 'billing', org: 'acme', branches: [] }],
    ...fields,
  }, null, 2))
}

publish('billing')
publish('ledger')

// The section's lines for one repo: its lead line and the works under it.
const earlierOf = repo => {
  const block = generatedAgents().match(new RegExp(`^### ${repo}\\n([\\s\\S]*?)\\n\\n`, 'm'))
  assert.ok(block, `the generated file has a block for ${repo}`)
  const lines = block[1].split('\n')
  const at = lines.findIndex(l => l.startsWith('- Earlier works:'))
  if (at === -1) return null
  const items = []
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('  - ')) break
    items.push(l.slice(4))
  }
  return { lead: lines[at], items }
}

test('a work on billing, with earlier works on it in the data root', () => {
  assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--tracker', 'acme=none', '--email', 'you@acme.example']).code, 0)
  record('newest', { closedAt: newestClosedAt, outcome: { text: 'Refunds never double-charge. The retry is idempotent now.', at: newestClosedAt } })
  record('stopped', { closedAt: ago(5), abandonedAt: ago(5) })
  record('oldest-in-window', { closedAt: ago(80) })
  record('long-ago', { closedAt: ago(200) })
  record('still-open', {})
  record('broken', '{ "id": "broken", ')
  gitMust(dataRoot, 'add', '-A')
  gitMust(dataRoot, 'commit', '-q', '-m', 'earlier works')
  assert.equal(rig(['new', 't1', '--title', 'Earlier works work', '--type', 'feat', '--no-ticket']).code, 0)
  const attached = rig(['attach', 'billing', '--work', 't1'])
  assert.equal(attached.code, 0, attached.out)
  assert.equal(rig(['attach', 'ledger', '--work', 't1']).code, 0)
  assert.equal(gitMust(dataRoot, 'status', '--porcelain'), '', 'an unreadable record costs the attach neither its regenerate nor its commit')
})

test('the generated file lists the works closed on the repo in the last 90 days, newest first', () => {
  const { items } = earlierOf('billing')
  assert.deepEqual(items.map(l => l.match(/`([^`]+)`/)[1]), ['newest', 'stopped', 'oldest-in-window'])
  assert.ok(items[0].startsWith(`${dateOf(newestClosedAt)} \`newest\` — newest title`), items[0])
})

test('the lead line gives the totals, the window\'s start and where the bodies are', () => {
  const { lead } = earlierOf('billing')
  // A date and no "last 90 days": the file is read days after it is written, and the phrase
  // would turn false while the date stays true.
  const since = lead.match(/the 3 closed on billing since (\d{4}-\d{2}-\d{2}), newest first; 1 closed before; 1 work record could not be read and may belong here \(`rig doctor` names it\)\./)
  assert.ok(since, lead)
  // The day the window opened, read at the regenerate: the day 90 days before this test, or the
  // one before it when the save ran on the far side of midnight.
  assert.ok([dateOf(ago(90)), dateOf(ago(91))].includes(since[1]), since[1])
  assert.ok(lead.includes(`\`${path.join(dataRoot, 'work')}${path.sep}<id>${path.sep}\``), lead)
  assert.match(lead, /`context\.md` and `notes\.tsv`/)
})

test('an outcome is cut to its first sentence, and an abandoned work is marked', () => {
  const { items } = earlierOf('billing')
  assert.match(items[0], /— newest title\. Outcome: Refunds never double-charge\.$/)
  assert.match(items[1], /— stopped title \(abandoned\)$/)
})

test('an open work, a work closed before the window and an unreadable record are not listed', () => {
  assert.doesNotMatch(generatedAgents(), /still-open|long-ago|broken/)
})

test('a repo nothing closed on has no Earlier works line', () => {
  assert.equal(earlierOf('ledger'), null)
})

test('a work that closes later reaches the file on this work\'s next mutating command', () => {
  record('just-closed', { closedAt: ago(0), repos: [{ repo: 'billing', org: 'acme', branches: [] }, { repo: 'ledger', org: 'acme', branches: [] }] })
  assert.equal(rig(['save', '-m', 'picks it up', '--work', 't1']).code, 0)
  assert.equal(earlierOf('billing').items[0].match(/`([^`]+)`/)[1], 'just-closed')
  assert.deepEqual(earlierOf('ledger').items.map(l => l.match(/`([^`]+)`/)[1]), ['just-closed'], 'a work on both repos is listed under each')
})

test('more than ten in the window lists the newest ten, and the lead line says how many there were', () => {
  for (let i = 0; i < 9; i++) record(`busy-${i}`, { closedAt: ago(10 + i) })
  assert.equal(rig(['save', '-m', 'a busy repo', '--work', 't1']).code, 0)
  const { lead, items } = earlierOf('billing')
  assert.equal(items.length, 10)
  assert.match(lead, /the 10 newest of the 13 closed on billing since \d{4}-\d{2}-\d{2}; 1 closed before; 1 work record could not be read/)
})

test('a repo whose works all closed before the window still says what there is', () => {
  for (const id of fs.readdirSync(path.join(dataRoot, 'work'))) {
    if (!['long-ago', 't1'].includes(id)) fs.rmSync(path.join(dataRoot, 'work', id), { recursive: true })
  }
  assert.equal(rig(['save', '-m', 'only history', '--work', 't1']).code, 0)
  const { lead, items } = earlierOf('billing')
  assert.deepEqual(items, [])
  assert.match(lead, /^- Earlier works: none closed on billing since \d{4}-\d{2}-\d{2}; 1 closed before\. /, 'no unreadable record is left, so none is named')
})
