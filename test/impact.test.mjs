// `rig impact` end to end — hugoforte/rig#130, stages 1 and 2.
//
// The traversal itself is `bin/catalog-graph.mjs` and is tested against literals in
// test/catalog-graph.test.mjs. What this file asserts is the half that only exists once the
// command is driven for real: that a hand-written entry's `direction` survives the frontmatter
// reader, that the two ends are read as one relationship, and that a disagreement between them
// reaches the person reading the output.
//
// No remotes and no worktrees — `impact` reads the catalogue and nothing else. The entry
// freshness it joins on needs a mirror, and that is asserted in test/attach.test.mjs, on the
// installation that already has one.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall, strip } from './harness.mjs'

const { dataRoot, workRoot, rig, cleanup } = makeInstall({
  prefix: 'rig-impact-',
  author: 'rig impact',
  email: 'impact@example.invalid',
  github: { auth: 'ok', repos: {} },
})

after(cleanup)

// Written by hand, the way an entry corrected under rule 4 is written — this is the format the
// reader has to accept, so the test states it in full rather than building it through `attach`.
const entry = (repo, { role = `${repo} does things`, talks_to = '[]' } = {}) =>
  fs.writeFileSync(path.join(dataRoot, 'catalog', 'acme', `${repo}.md`), `---
repo: ${repo}
org: acme
stack: JavaScript
role: ${role}
talks_to: ${talks_to}
setup: []
check: []
---

Prose.
`)

const out = (...args) => {
  const r = rig(['impact', ...args])
  assert.equal(r.code, 0, r.out)
  return strip(r.out)
}

test('a data root with a catalogue written by hand', () => {
  assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--tracker', 'acme=none', '--email', 'you@acme.example']).code, 0)
  fs.mkdirSync(path.join(dataRoot, 'catalog', 'acme'), { recursive: true })

  entry('billing', {
    role: 'invoices and refunds',
    talks_to: `
  - repo: orders
    how: pushes invoices as they settle
    direction: downstream
  - repo: ledger
    how: nightly batch
  - repo: shipping
    how: posts labels
    direction: downstream`,
  })
  entry('orders', {
    talks_to: `
  - repo: billing
    how: reads the invoice shape
    direction: upstream
  - repo: warehouse
    how: reserves stock
    direction: downstream`,
  })
  entry('shipping', {
    talks_to: `
  - repo: billing
    how: bills for postage
    direction: downstream`,
  })
  entry('warehouse')
  entry('payroll')
})

test('a direction written in one entry survives the frontmatter reader', () => {
  assert.match(out('billing'), /orders\s+downstream/)
})

test('the two ends of one relationship are read as one claim, not two edges', () => {
  const o = out('billing')
  assert.equal(o.match(/^ {2}orders\b/gm).length, 1, 'orders appears once, whichever end described it')
  assert.match(o, /billing → orders: pushes invoices as they settle/)
  assert.match(o, /orders → billing: reads the invoice shape/)
})

test('an edge nobody placed reads as unstated, not as a guess', () => {
  assert.match(out('billing'), /ledger\s+unstated/)
})

test('two entries that disagree about direction say so, and rig picks no winner', () => {
  const o = out('billing')
  assert.match(o, /shipping\s+disagreed/)
  assert.match(o, /billing → shipping: posts labels/, 'both claims are shown, which is what makes it readable')
  assert.match(o, /shipping → billing: bills for postage/)
})

test('two hops names the route and claims no direction of its own', () => {
  const o = out('billing')
  assert.match(o, /two hops[\s\S]*warehouse\s+via orders \(downstream of it\)/)
})

test('a repo nothing connects to is in no hop at all', () => {
  assert.doesNotMatch(out('billing'), /payroll/)
})

test('a neighbour with no entry of its own is named as the gap it is', () => {
  entry('billing', {
    role: 'invoices and refunds',
    talks_to: `
  - repo: ancient-mainframe
    how: nightly batch`,
  })
  const o = out('billing')
  assert.match(o, /ancient-mainframe\s+unstated\s+\(no catalogue entry\)/)
  assert.match(o, /ancient-mainframe has no catalogue entry — one is drafted the first time it is attached/)
  assert.doesNotMatch(o, /rig catalog ancient-mainframe|rig catalog <repo>/,
    'rig catalog dies on a repo with no entry, so it is not what to point at')
})

test('a neighbour whose entry is still a draft is pointed at the file, which exists', () => {
  fs.writeFileSync(path.join(dataRoot, 'catalog', 'acme', 'ancient-mainframe.md'), `---
repo: ancient-mainframe
org: acme
talks_to: []
---

<!-- DRAFT: unreviewed -->
`)
  try {
    assert.match(out('billing'), /ancient-mainframe is still a draft — `rig catalog ancient-mainframe` names the file/)
  } finally {
    fs.rmSync(path.join(dataRoot, 'catalog', 'acme', 'ancient-mainframe.md'))
  }
})

test('a repo the catalogue has never heard of answers, rather than refusing', () => {
  assert.match(out('nowhere'), /nothing in the catalogue talks to it, and it talks to nothing/)
})

test('impact with no repo refuses and says where the names are', () => {
  const r = rig(['impact'])
  assert.equal(r.code, 1)
  assert.match(strip(r.out), /rig impact wants a repo — `rig catalog` lists them/)
})

// -------------------------------------------------- the observed graph

// Work records written by hand, in the shape `rig new` and `rig attach` write — the same claim
// test/demo.test.mjs makes about its fixtures, and kept honest the same way: the suites that
// drive the real commands fail here if the shape moves.

const record = (id, ...repos) => {
  fs.mkdirSync(path.join(dataRoot, 'work', id), { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'work', id, 'work.json'), JSON.stringify({
    id, title: id, type: 'feat', branch: `feat/${id}`, tickets: [],
    repos: repos.map(repo => ({ repo, org: 'acme', base: 'main' })),
    createdAt: '2026-01-01T00:00:00Z',
  }))
}

test('records that keep putting two repos in one work', () => {
  entry('billing', {
    role: 'invoices and refunds',
    talks_to: `
  - repo: orders
    how: pushes invoices as they settle
    direction: downstream`,
  })
  entry('orders')
  entry('ledger')
  record('w1', 'billing', 'ledger')
  record('w2', 'billing', 'ledger')
  record('w3', 'billing', 'orders')
})

test('a pair the records keep making is reported, with the works that made it', () => {
  const o = out('billing')
  assert.match(o, /worked on together[\s\S]*ledger\s+2 works/)
  assert.match(o, /w1, w2/)
})

test('a pair with no talks_to line between them is the finding, and names the file to correct', () => {
  const o = out('billing')
  assert.match(o, /ledger\s+2 works — and nothing in talks_to says why/)
  assert.match(o, /`rig catalog billing` names the file to correct/)
})

test('a pair the catalogue already explains is shown, and not reported as a gap', () => {
  assert.match(out('billing'), /orders\s+1 work — and talks_to says why/)
})

test('the pairs are ordered by how often the two travelled together', () => {
  const section = out('billing').slice(out('billing').indexOf('worked on together'))
  assert.ok(section.indexOf('ledger') < section.indexOf('orders'), 'two works outrank one')
})

test('a repo with no talks_to line still shows the pairs the records keep making', () => {
  // The case the observed graph exists for: every freshly drafted entry has `talks_to: []`, so
  // an early return on an empty declared graph hid the evidence exactly where it was needed.
  const o = out('ledger')
  assert.match(o, /nothing in the catalogue talks to it, and it talks to nothing/)
  assert.match(o, /worked on together[\s\S]*billing\s+2 works — and nothing in talks_to says why/)
})

test('the correction for a subject with no entry names what drafts one, not a command that fails', () => {
  record('w4', 'unwritten', 'billing')
  try {
    const o = out('unwritten')
    assert.match(o, /unwritten has no catalogue entry — one is drafted the first time it is attached/)
    assert.doesNotMatch(o, /rig catalog unwritten/)
  } finally {
    fs.rmSync(path.join(dataRoot, 'work', 'w4'), { recursive: true })
  }
})
