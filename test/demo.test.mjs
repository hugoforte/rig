// The demo page is pure: a catalogue and a set of records in, one HTML page out. That is why
// it is a module of its own — the page shown to other people is checkable without a browser,
// a data root or a GitHub call.
//
// The catalogue entries below are the shape `loadCatalog` produces, and the work records are
// the shape `rig new` and `rig attach` write. The last test in this file is what keeps those
// two claims honest: it drives the real command over a real data root on disk, so a change to
// either format fails here rather than in front of an audience.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { components, layout, nodeRadius, halfBox, repoBranch, pickExample, walkthrough, summarize, renderDemo } from '../bin/demo.mjs'
import { buildGraph } from '../bin/catalog-graph.mjs'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const entry = (repo, talks_to = [], rest = {}) => ({
  repo, org: 'acme', role: `${repo} does things`, stack: 'Node',
  talks_to, setup: [], check: [], draft: false, body: '', file: `catalog/acme/${repo}.md`, ...rest,
})

const work = (over = {}) => ({
  id: 'w1', title: 'A thing', tickets: ['ACME-1'], type: 'feat', branch: 'feat/a-thing',
  repos: [{ repo: 'billing', org: 'acme', base: 'main' }],
  createdAt: '2026-01-01T00:00:00Z', ...over,
})

// The same work in record format 3, where a repo carries `branches[]` — one entry per branch
// of this work it holds, each with its own base and, once merged, that PR's terminal facts.
//
// Both shapes exist in a live data root at the same time, because records migrate only when rig
// next writes one. Every fixture in this file was the legacy shape for exactly that reason: it
// is what the root on this machine happened to hold, and the whole suite passed while `rig demo`
// could not read a migrated record at all. A fixture is a claim about a format, and a claim
// nothing checks is the kind that is quietly wrong for a week.
const work3 = (over = {}) => {
  const { repos, ...rest } = work(over)
  return {
    ...rest,
    repos: repos.map(({ base, pr: merged, ...repo }) => ({
      ...repo,
      branches: [{ branch: rest.branch, base, ...(merged ? { pr: merged } : {}) }],
    })),
  }
}

const pr = (over = {}) => ({
  number: 7, url: 'https://example.invalid/7',
  openedAt: '2026-01-02T10:00:00Z', firstCommitAt: '2026-01-02T09:00:00Z',
  firstReviewAt: '2026-01-02T11:00:00Z', approvedAt: '2026-01-02T12:00:00Z',
  mergedAt: '2026-01-02T13:00:00Z', ...over,
})

// ------------------------------------------------------------------- the layout

const sampleCatalog = () => [
  entry('billing', [{ repo: 'orders', how: 'a' }, { repo: 'ledger', how: 'b' }]),
  entry('orders', [{ repo: 'web', how: 'c' }]),
  entry('ledger'),
  entry('web'),
  entry('warehouse', [{ repo: 'orders', how: 'd' }]),
]

test('layout: the same catalogue lays out identically every time', () => {
  const once = layout(buildGraph(sampleCatalog()))
  const again = layout(buildGraph(sampleCatalog()))
  assert.deepEqual(once.nodes.map(n => [n.id, n.x, n.y]), again.nodes.map(n => [n.id, n.x, n.y]),
    'a demo that rearranged itself between the rehearsal and the room would be a bad demo')
})

test('layout: every node lands inside the viewBox', () => {
  const placed = layout(buildGraph(sampleCatalog()))
  const stray = placed.nodes.filter(n => n.x < 0 || n.y < 0 || n.x > placed.width || n.y > placed.height)
  assert.deepEqual(stray, [])
})

// The invariant is about *labels*, not circles. `texo-frontend-admin-portal-app` is nearly four
// times the width of the dot it sits under, so a layout that only keeps circles apart produces
// tidy dots with their names lying across each other — which is what the first one did.
const clashes = placed => {
  const out = []
  for (let i = 0; i < placed.nodes.length; i++) {
    for (let j = i + 1; j < placed.nodes.length; j++) {
      const [a, b] = [placed.nodes[i], placed.nodes[j]]
      const [ha, hb] = [halfBox(a), halfBox(b)]
      if (Math.abs(a.x - b.x) < ha.x + hb.x && Math.abs(a.y - b.y) < ha.y + hb.y) out.push(`${a.id}/${b.id}`)
    }
  }
  return out
}

test('layout: no two labels overlap', () => {
  assert.deepEqual(clashes(layout(buildGraph(sampleCatalog()))), [])
})

test('layout: a repo with a very long name does not land on top of its neighbours', () => {
  const long = 'texo-frontend-admin-portal-app-with-an-even-longer-name'
  assert.deepEqual(clashes(layout(buildGraph([
    entry('a', [{ repo: long, how: 'x' }, { repo: 'b', how: 'y' }]), entry(long), entry('b'),
  ]))), [])
})

// Big enough that the minimum-size floor is not what decides the answer.
const wideCatalog = () => [
  entry('billing', [{ repo: 'orders', how: 'a' }, { repo: 'ledger', how: 'b' }]),
  entry('orders', [{ repo: 'web', how: 'c' }, { repo: 'warehouse', how: 'd' }]),
  entry('ledger', [{ repo: 'reporting', how: 'e' }]),
  entry('web'), entry('warehouse'), entry('reporting'),
  entry('pricing', [{ repo: 'catalogue-service', how: 'f' }]), entry('catalogue-service'),
  entry('identity', [{ repo: 'gateway', how: 'g' }]), entry('gateway'),
]

test('layout: the box is measured from the drawing, not chosen in advance', () => {
  const placed = layout(buildGraph(wideCatalog()))
  const right = Math.max(...placed.nodes.map(n => n.x + halfBox(n).x))
  const bottom = Math.max(...placed.nodes.map(n => n.y + halfBox(n).y))
  // Within the padding on both axes: any more slack than that is empty page with nothing in it.
  assert.ok(placed.width - right < 80 && placed.height - bottom < 80,
    `drawing ends at ${right}x${bottom} in a ${placed.width}x${placed.height} box`)
})

test('layout: a drawing smaller than the floor is not blown up to fill the page', () => {
  const placed = layout(buildGraph([entry('a', [{ repo: 'b', how: 'x' }]), entry('b')]))
  assert.ok(placed.width >= 620, `a two-repo catalogue got a ${placed.width}-wide box`)
})

test('layout: the drawing keeps page-like proportions rather than becoming a strip', () => {
  const placed = layout(buildGraph(wideCatalog()))
  const aspect = placed.width / placed.height
  assert.ok(aspect > 0.7 && aspect < 3.5, `aspect was ${aspect.toFixed(2)}`)
})

test('components: repos with no path between them are separate components', () => {
  const { nodes, edges } = buildGraph([entry('a', [{ repo: 'b', how: 'x' }]), entry('b'), entry('lonely')])
  assert.equal(components(nodes, edges).length, 2)
})

test('components: the biggest comes first, so reading starts where the most is happening', () => {
  const { nodes, edges } = buildGraph([entry('lonely'), entry('a', [{ repo: 'b', how: 'x' }]), entry('b')])
  assert.equal(components(nodes, edges)[0].nodes.length, 2)
})

test('layout: an empty catalogue lays out nothing rather than dividing by zero', () => {
  assert.deepEqual(layout(buildGraph([])).nodes, [])
})

test('layout: a repo with no relationships is left out of the drawing', () => {
  assert.deepEqual(layout(buildGraph([entry('lonely')])).nodes, [],
    'every place to put it in a relationship graph is a claim, and none of them is true')
})

test('summarize: a repo with no relationships is listed instead', () => {
  const s = summarize({ catalog: [entry('a', [{ repo: 'b', how: 'x' }]), entry('b'), entry('lonely')] })
  assert.deepEqual(s.unlinked.map(n => n.id), ['lonely'])
})

test('renderDemo: an unconnected repo is named on the page, and stays clickable', () => {
  const html = page({ catalog: [entry('a', [{ repo: 'b', how: 'x' }]), entry('b'), entry('lonely')] })
  assert.match(html, /class="chip"[^>]*data-repo="lonely"/)
})

test('renderDemo: an unconnected repo still has a card to open', () => {
  const html = page({ catalog: [entry('a', [{ repo: 'b', how: 'x' }]), entry('b'), entry('lonely')] })
  assert.match(html, /data-for="lonely"/)
})

test('renderDemo: a catalogue where nothing is connected still renders the repos', () => {
  const html = page({ catalog: [entry('a'), entry('b')], works: [] })
  assert.match(html, /no relationships recorded yet/)
})

test('summarize: the counts are the whole catalogue, not just what got drawn', () => {
  const s = summarize({ catalog: [entry('a', [{ repo: 'b', how: 'x' }]), entry('b'), entry('lonely')] })
  assert.equal(s.counts.repos, 3)
})

// ------------------------------------------------------------------- the example

test('pickExample: prefers the work with the most repos that actually merged', () => {
  const wide = work({ id: 'wide', repos: [1, 2, 3, 4].map(n => ({ repo: `r${n}`, base: 'main' })) })
  const landed = work({ id: 'landed', repos: [{ repo: 'a', base: 'main', pr: pr() }, { repo: 'b', base: 'uat', pr: pr() }] })
  assert.equal(pickExample([wide, landed]).id, 'landed',
    'the widest unfinished work leaves the closing panel empty')
})

test('pickExample: with nothing merged anywhere, the widest work wins', () => {
  const narrow = work({ id: 'narrow', repos: [{ repo: 'a', base: 'main' }] })
  const wide = work({ id: 'wide', repos: [{ repo: 'a', base: 'main' }, { repo: 'b', base: 'main' }] })
  assert.equal(pickExample([narrow, wide]).id, 'wide')
})

test('pickExample: a named work is used even when it would not have been chosen', () => {
  const landed = work({ id: 'landed', repos: [{ repo: 'a', base: 'main', pr: pr() }] })
  const plain = work({ id: 'plain', repos: [{ repo: 'b', base: 'main' }] })
  assert.equal(pickExample([landed, plain], 'plain').id, 'plain')
})

test('pickExample: a named work that is not there is an error, not a silent substitution', () => {
  assert.throws(() => pickExample([work()], 'nope'), /no work "nope"/)
})

test('pickExample: a root whose works have no repos yet has no example', () => {
  assert.equal(pickExample([work({ repos: [] })]), null)
})

// ------------------------------------------------------------------- the walkthrough

test('walkthrough: one attach step per repo', () => {
  const steps = walkthrough(work({ repos: [{ repo: 'a', org: 'acme', base: 'main' }, { repo: 'b', org: 'acme', base: 'uat' }] }))
  assert.equal(steps.filter(s => s.command.startsWith('rig attach')).length, 2)
})

test('walkthrough: a repo landing on a different base says which, and why that matters', () => {
  const steps = walkthrough(work({ repos: [{ repo: 'a', org: 'acme', base: 'develop' }, { repo: 'b', org: 'acme', base: 'uat' }] }))
  assert.match(steps.find(s => s.command === 'rig attach b').note, /`uat`, not `develop`/)
})

test('walkthrough: repos sharing a base do not claim they differ', () => {
  const steps = walkthrough(work({ repos: [{ repo: 'a', org: 'acme', base: 'main' }, { repo: 'b', org: 'acme', base: 'main' }] }))
  assert.doesNotMatch(steps.find(s => s.command === 'rig attach b').note, /different base/)
})

test('walkthrough: a work with no ticket shows the decision being recorded', () => {
  const steps = walkthrough(work({ tickets: [] }))
  assert.match(steps[0].command, /--no-ticket/)
})

test('walkthrough: a work whose PRs never opened skips the `rig pr` step', () => {
  const steps = walkthrough(work())
  assert.equal(steps.filter(s => s.command === 'rig pr').length, 0)
})

test('walkthrough: the close step says the prose is what survives', () => {
  const steps = walkthrough(work())
  assert.match(steps.at(-1).data.join('\n'), /context\.md\s+kept/)
})

test('walkthrough: every step is numbered from one, in order', () => {
  const steps = walkthrough(work())
  assert.deepEqual(steps.map(s => s.n), steps.map((_, i) => i + 1))
})

// ------------------------------------------------------------------- the page

const page = (over = {}) => renderDemo(summarize({
  catalog: sampleCatalog(), works: [work()], generatedAt: '2026-01-01 00:00Z', root: 'acme', ...over,
}))

test('renderDemo: is self-contained — nothing is fetched when it opens', () => {
  const html = page()
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|@import/)
})

test('renderDemo: a repo name with markup in it is escaped, not rendered', () => {
  const html = page({ catalog: [entry('<img src=x onerror=alert(1)>')] })
  assert.doesNotMatch(html, /<img src=x/)
})

test('renderDemo: a `how` with markup in it is escaped too', () => {
  const html = page({ catalog: [entry('billing', [{ repo: 'orders', how: '<script>alert(1)</script>' }]), entry('orders')] })
  assert.doesNotMatch(html, /<script>alert/)
})

test('renderDemo: backticks in a role become code, because that is how rig prose is written', () => {
  const html = page({ catalog: [entry('billing', [], { role: 'reads `rig.json`' })] })
  assert.match(html, /<code>rig\.json<\/code>/)
})

test('renderDemo: a data root with no works renders a page rather than failing', () => {
  assert.match(page({ works: [] }), /nothing to walk through/)
})

test('renderDemo: an empty catalogue renders a page rather than failing', () => {
  assert.match(page({ catalog: [], works: [] }), /No repos catalogued/)
})

test('renderDemo: says when it was generated, because a stale page is worse than none', () => {
  assert.match(page(), /2026-01-01 00:00Z/)
})

test('renderDemo: counts only the works that spanned more than one repo as cross-repo', () => {
  const one = work({ id: 'one', repos: [{ repo: 'a', base: 'main' }] })
  const two = work({ id: 'two', repos: [{ repo: 'a', base: 'main' }, { repo: 'b', base: 'main' }] })
  assert.equal(summarize({ catalog: sampleCatalog(), works: [one, two] }).counts.crossRepo, 1)
})

test('renderDemo: a merged PR is reported with the stretches it spent, not a duration invented for it', () => {
  const landed = work({ repos: [{ repo: 'a', org: 'acme', base: 'main', pr: pr() }] })
  const html = page({ works: [landed] })
  assert.match(html, /What survived the branch/)
})

// --------------------------------------------------------- both record formats

test('repoBranch: reads the branch entry when the record has been migrated', () => {
  const repo = { repo: 'a', branches: [{ branch: 'feat/x', base: 'uat', pr: pr() }] }
  assert.equal(repoBranch(repo, 'feat/x').base, 'uat')
})

test('repoBranch: falls back to the legacy fields when it has not', () => {
  assert.equal(repoBranch({ repo: 'a', base: 'develop', pr: pr() }, 'feat/x').base, 'develop')
})

test('repoBranch: picks the entry for this work’s branch, not merely the first', () => {
  const repo = { repo: 'a', branches: [
    { branch: 'feat/stage-one', base: 'main' },
    { branch: 'feat/x', base: 'develop' },
  ] }
  assert.equal(repoBranch(repo, 'feat/x').base, 'develop')
})

test('repoBranch: a repo with no branch entry for this work still answers', () => {
  const repo = { repo: 'a', branches: [{ branch: 'feat/other', base: 'main' }] }
  assert.equal(repoBranch(repo, 'feat/x').base, 'main')
})

test('pickExample: a migrated record is ranked on its merged PRs like any other', () => {
  const migrated = work3({ id: 'migrated', repos: [
    { repo: 'a', org: 'acme', base: 'main', pr: pr() },
    { repo: 'b', org: 'acme', base: 'uat', pr: pr() },
  ] })
  const legacy = work({ id: 'legacy', repos: [{ repo: 'c', org: 'acme', base: 'main', pr: pr() }] })
  assert.equal(pickExample([legacy, migrated]).id, 'migrated',
    'a migrated work used to score zero and lose to an unmigrated one')
})

test('walkthrough: a migrated record still knows where each repo lands', () => {
  const steps = walkthrough(work3({ repos: [
    { repo: 'a', org: 'acme', base: 'develop' },
    { repo: 'b', org: 'acme', base: 'uat' },
  ] }))
  assert.match(steps.find(s => s.command === 'rig attach b').note, /`uat`, not `develop`/)
})

test('walkthrough: a migrated record never prints an undefined base', () => {
  const steps = walkthrough(work3({ repos: [{ repo: 'a', org: 'acme', base: 'develop', pr: pr() }] }))
  assert.doesNotMatch(JSON.stringify(steps), /undefined/)
})

test('walkthrough: a migrated record keeps its `rig pr` step', () => {
  const steps = walkthrough(work3({ repos: [{ repo: 'a', org: 'acme', base: 'main', pr: pr() }] }))
  assert.equal(steps.filter(s => s.command === 'rig pr').length, 1)
})

test('renderDemo: a migrated record still reports what survived the branch', () => {
  const html = page({ works: [work3({ repos: [{ repo: 'a', org: 'acme', base: 'main', pr: pr() }] })] })
  assert.match(html, /What survived the branch/)
})

test('both record formats describe the same work the same way', () => {
  const repos = [{ repo: 'a', org: 'acme', base: 'develop', pr: pr() }, { repo: 'b', org: 'acme', base: 'uat', pr: pr() }]
  assert.deepEqual(walkthrough(work3({ repos })), walkthrough(work({ repos })))
})

// ------------------------------------------------------------- the real command

// The one test that touches disk. Everything above trusts a fixture to be the shape rig
// writes; this drives the real command over a real data root, so the day `loadCatalog` or the
// record format moves, it fails here.
const temps = []
after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

test('rig demo: renders a page from a data root on disk, naming its repos', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-demo-'))
  temps.push(tmp)
  const root = path.join(tmp, 'data')
  fs.mkdirSync(path.join(root, 'catalog', 'acme'), { recursive: true })
  fs.mkdirSync(path.join(root, 'work', 'w1'), { recursive: true })
  fs.writeFileSync(path.join(root, 'catalog', 'acme', 'billing.md'),
    '---\nrepo: billing\norg: acme\nrole: Owns invoices\nstack: C#\ntalks_to:\n  - repo: orders\n    how: posts invoices\n---\nProse.\n')
  fs.writeFileSync(path.join(root, 'catalog', 'acme', 'orders.md'),
    '---\nrepo: orders\norg: acme\nrole: Owns orders\nstack: Node\ntalks_to: []\n---\nProse.\n')
  // Written in the current record format, so this fails the day the demo stops reading it.
  fs.writeFileSync(path.join(root, 'work', 'w1', 'work.json'), JSON.stringify(work3()))

  const localFile = path.join(tmp, 'rig.local.json')
  fs.writeFileSync(localFile, JSON.stringify({
    workRoot: path.join(tmp, 'w'),
    dataRoots: { t: { path: root } },
    current: 't',
  }))

  const out = path.join(tmp, 'demo.html')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('RIG_')) delete env[key]
  env.RIG_LOCAL_CONFIG = localFile
  const r = spawnSync(process.execPath, [path.join(SRC, 'bin', 'rig.mjs'), 'demo', '--out', out, '--no-open'],
    { encoding: 'utf8', env, cwd: tmp })

  assert.equal(r.status, 0, r.stderr || r.stdout)
  const html = fs.readFileSync(out, 'utf8')
  assert.match(html, /data-repo="billing"/)
  assert.match(html, /posts invoices/)
  assert.match(html, /rig attach billing/)
})
