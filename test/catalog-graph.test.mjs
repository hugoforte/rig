// The catalogue's graph, and the questions asked of it. Pure: a catalogue in, a graph or an
// answer out — no data root, no mirror, no GitHub call. The freshness that `rig impact` prints
// beside an edge is gathered by the caller and joined on, for the same reason.
//
// `buildGraph`'s own tests moved here from `test/demo.test.mjs` unchanged when the function
// left `bin/demo.mjs`. What is new below the divider is direction, and `impact`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, impact, coAttached, unattached } from '../bin/catalog-graph.mjs'

const entry = (repo, talks_to = [], rest = {}) => ({
  repo, org: 'acme', role: `${repo} does things`, stack: 'Node',
  talks_to, setup: [], check: [], draft: false, body: '', file: `catalog/acme/${repo}.md`, ...rest,
})

// ------------------------------------------------------------------- the graph

test('buildGraph: a relationship both ends describe is one edge, not two', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'pushes invoices' }]),
    entry('orders', [{ repo: 'billing', how: 'emits OrderReturned' }]),
  ])
  assert.equal(graph.edges.length, 1)
})

test('buildGraph: that one edge keeps what each end said, with its direction', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'pushes invoices' }]),
    entry('orders', [{ repo: 'billing', how: 'emits OrderReturned' }]),
  ])
  assert.deepEqual(graph.edges[0].says.map(s => `${s.from}→${s.to}: ${s.how}`).sort(), [
    'billing→orders: pushes invoices',
    'orders→billing: emits OrderReturned',
  ])
})

test('buildGraph: a neighbour with no entry of its own is kept, and marked', () => {
  const graph = buildGraph([entry('billing', [{ repo: 'ancient-mainframe', how: 'nightly batch' }])])
  const found = graph.nodes.find(n => n.id === 'ancient-mainframe')
  assert.equal(found.catalogued, false, 'the catalogue being thin is a finding, not something to hide')
})

test('buildGraph: a repo naming itself gets no edge to itself', () => {
  const graph = buildGraph([entry('billing', [{ repo: 'billing', how: 'talks to itself' }])])
  assert.equal(graph.edges.length, 0)
})

test('buildGraph: degree counts relationships, not mentions of them', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'one way' }]),
    entry('orders', [{ repo: 'billing', how: 'the other way' }]),
  ])
  assert.equal(graph.nodes.find(n => n.id === 'billing').degree, 1)
})

test('buildGraph: a bare string in talks_to is an edge with nothing said about it', () => {
  const graph = buildGraph([entry('billing', ['orders']), entry('orders')])
  assert.deepEqual([graph.edges.length, graph.edges[0].says.length], [1, 0])
})

// --------------------------------------------------------------- direction

// The edge is keyed by its two repos sorted, so a direction has to be stored relative to one
// end and read back relative to whichever end is asking. Everything below fixes that: what a
// human wrote in one entry must mean the same thing read from the other.

const dir = (graph, from) => {
  const e = graph.edges[0]
  return e.a === from ? e.direction : flip(e.direction)
}
const flip = d => (d === 'downstream' ? 'upstream' : d === 'upstream' ? 'downstream' : d)

test('direction: a stated direction reaches the edge, relative to the end that stated it', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'pushes invoices', direction: 'downstream' }]),
    entry('orders'),
  ])
  assert.equal(dir(graph, 'billing'), 'downstream', 'a change in billing can break orders')
})

test('direction: the two ends state one relationship from opposite sides, and agree', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'pushes invoices', direction: 'downstream' }]),
    entry('orders', [{ repo: 'billing', how: 'reads the invoice shape', direction: 'upstream' }]),
  ])
  assert.deepEqual([dir(graph, 'billing'), graph.edges[0].disagreed], ['downstream', false])
})

test('direction: two ends that disagree are a contradiction, and rig picks no winner', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'pushes invoices', direction: 'downstream' }]),
    entry('orders', [{ repo: 'billing', how: 'emits OrderReturned', direction: 'downstream' }]),
  ])
  assert.deepEqual([graph.edges[0].direction, graph.edges[0].disagreed], [null, true])
})

test('direction: `both` at one end and `downstream` at the other is a disagreement', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'pushes invoices', direction: 'downstream' }]),
    entry('orders', [{ repo: 'billing', how: 'and back again', direction: 'both' }]),
  ])
  assert.equal(graph.edges[0].disagreed, true, 'two different claims about one relationship, not a superset to resolve')
})

test('direction: `both` at both ends is one claim, agreed', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'either way', direction: 'both' }]),
    entry('orders', [{ repo: 'billing', how: 'either way', direction: 'both' }]),
  ])
  assert.deepEqual([graph.edges[0].direction, graph.edges[0].disagreed], ['both', false])
})

test('direction: silence at one end is not a disagreement with the other', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'pushes invoices', direction: 'downstream' }]),
    entry('orders', [{ repo: 'billing', how: 'emits OrderReturned' }]),
  ])
  assert.deepEqual([dir(graph, 'billing'), graph.edges[0].disagreed], ['downstream', false])
})

test('direction: an edge nobody placed is unstated, which is not the same as both ways', () => {
  const graph = buildGraph([entry('billing', [{ repo: 'orders', how: 'pushes invoices' }]), entry('orders')])
  assert.deepEqual([graph.edges[0].direction, graph.edges[0].disagreed], [null, false])
})

test('direction: a word that is not a direction does not become one, and stays readable', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'pushes invoices', direction: 'sideways' }]),
    entry('orders'),
  ])
  assert.equal(graph.edges[0].direction, null, 'an unknown is not a fact')
  assert.equal(graph.edges[0].says[0].direction, 'sideways', 'and it is still shown, so it can be corrected')
})

// ------------------------------------------------------------------ impact

// `impact` is DESIGN.md §6's traversal — "for every selected repo, check its neighbours" —
// as a function instead of an instruction to the agent.

const sample = () => [
  entry('billing', [{ repo: 'orders', how: 'pushes invoices', direction: 'downstream' }]),
  entry('orders', [{ repo: 'warehouse', how: 'reserves stock', direction: 'downstream' }]),
  entry('warehouse'),
  entry('payroll'),
]

test('impact: one hop is what the subject names and what names the subject', () => {
  const answer = impact([
    entry('billing', [{ repo: 'orders', how: 'a' }]),
    entry('ledger', [{ repo: 'billing', how: 'b' }]),
    entry('orders'),
  ], 'billing')
  assert.deepEqual(answer.hop1.map(n => n.repo).sort(), ['ledger', 'orders'])
})

test('impact: two hops is reached through one, and repeats neither it nor the subject', () => {
  const answer = impact(sample(), 'billing')
  assert.deepEqual(answer.hop2.map(n => n.repo), ['warehouse'])
})

test('impact: a repo nothing connects to is in neither hop', () => {
  const answer = impact(sample(), 'billing')
  const named = [...answer.hop1, ...answer.hop2].map(n => n.repo)
  assert.equal(named.includes('payroll'), false)
})

test('impact: a one-hop direction is relative to the subject, not to whoever wrote it', () => {
  const answer = impact([
    entry('billing'),
    entry('orders', [{ repo: 'billing', how: 'reads the invoice shape', direction: 'upstream' }]),
  ], 'billing')
  assert.equal(answer.hop1[0].direction, 'downstream', 'orders said billing is upstream of it, which is the same fact')
})

test('impact: a two-hop neighbour names what it came through and claims no composed direction', () => {
  const answer = impact(sample(), 'billing')
  const [w] = answer.hop2
  assert.deepEqual(w.via.map(v => [v.through, v.direction]), [['orders', 'downstream']])
  assert.equal('direction' in w, false, 'two edges placed end to end are not a third edge')
})

test('impact: a repo with no entry of its own still answers, from the edges that name it', () => {
  const answer = impact([entry('billing', [{ repo: 'ancient-mainframe', how: 'nightly batch' }])], 'ancient-mainframe')
  assert.deepEqual([answer.catalogued, answer.hop1.map(n => n.repo)], [false, ['billing']])
})

test('impact: a repo nothing in the catalogue has heard of answers empty rather than throwing', () => {
  const answer = impact(sample(), 'nowhere')
  assert.deepEqual([answer.catalogued, answer.hop1, answer.hop2], [false, [], []])
})

test('impact: the subject is matched case-insensitively and answers in the catalogue spelling', () => {
  const answer = impact([entry('Eternity-II', [{ repo: 'orders', how: 'a' }]), entry('orders')], 'eternity-ii')
  assert.equal(answer.repo, 'Eternity-II')
})

test('impact: a neighbour with a draft entry says so, because a draft is a weaker claim', () => {
  const answer = impact([
    entry('billing', [{ repo: 'orders', how: 'a' }]),
    entry('orders', [], { draft: true }),
  ], 'billing')
  assert.deepEqual([answer.hop1[0].catalogued, answer.hop1[0].draft], [true, true])
})

test('impact: a contradiction survives the traversal instead of being resolved on the way', () => {
  const answer = impact([
    entry('billing', [{ repo: 'orders', how: 'pushes', direction: 'downstream' }]),
    entry('orders', [{ repo: 'billing', how: 'emits', direction: 'downstream' }]),
  ], 'billing')
  assert.deepEqual([answer.hop1[0].direction, answer.hop1[0].disagreed], [null, true])
})

// ------------------------------------------------- the observed graph

// The second graph over the same repos: which ones have been attached to the same work. It is
// read out of the records rather than derived, so unlike `talks_to` it cannot be wrong about
// what happened — and unlike `talks_to` it can only ever see repos already worked on together.
// Neither is sufficient, which is why `impact` prints both and marks where they disagree.

const work = (id, ...repos) => ({ id, repos: repos.map(repo => ({ repo, org: 'acme', base: 'main' })) })

test('coAttached: two repos in one work are a pair, named by the work that paired them', () => {
  assert.deepEqual(coAttached([work('w1', 'billing', 'orders')]),
    [{ a: 'billing', b: 'orders', works: ['w1'] }])
})

test('coAttached: a work with one repo pairs it with nothing', () => {
  assert.deepEqual(coAttached([work('w1', 'billing')]), [])
})

test('coAttached: three repos in one work are three pairs, not one triple', () => {
  assert.equal(coAttached([work('w1', 'billing', 'orders', 'ledger')]).length, 3)
})

test('coAttached: a pair two works made counts both, so the evidence accumulates', () => {
  const [pair] = coAttached([work('w1', 'billing', 'orders'), work('w2', 'orders', 'billing')])
  assert.deepEqual(pair.works, ['w1', 'w2'])
})

test('coAttached: a repo named twice in one work does not pair with itself', () => {
  assert.deepEqual(coAttached([work('w1', 'billing', 'billing')]), [])
})

test('impact: a repo the records put beside the subject is reported, with the works that did it', () => {
  const answer = impact([entry('billing'), entry('ledger')], 'billing',
    { works: [work('w1', 'billing', 'ledger'), work('w2', 'billing', 'ledger')] })
  assert.deepEqual(answer.observed.map(o => [o.repo, o.works]), [['ledger', ['w1', 'w2']]])
})

test('impact: an observed pair the catalogue already explains is marked as declared', () => {
  const answer = impact([entry('billing', [{ repo: 'orders', how: 'pushes invoices' }]), entry('orders')],
    'billing', { works: [work('w1', 'billing', 'orders')] })
  assert.equal(answer.observed[0].declared, true)
})

test('impact: an observed pair with no talks_to line between them is the finding', () => {
  const answer = impact([entry('billing'), entry('ledger')], 'billing',
    { works: [work('w1', 'billing', 'ledger')] })
  assert.equal(answer.observed[0].declared, false,
    'they travel together and nothing in the catalogue says why — that names the entry to correct')
})

test('impact: observed is ordered by how often the two travelled together', () => {
  const answer = impact([entry('billing')], 'billing', {
    works: [work('w1', 'billing', 'ledger'), work('w2', 'billing', 'orders'), work('w3', 'billing', 'orders')],
  })
  assert.deepEqual(answer.observed.map(o => o.repo), ['orders', 'ledger'])
})

test('impact: the subject is matched against the records case-insensitively', () => {
  const answer = impact([entry('Eternity-II')], 'eternity-ii',
    { works: [work('w1', 'Eternity-II', 'ledger')] })
  assert.deepEqual(answer.observed.map(o => o.repo), ['ledger'])
})

test('impact: a work that never held the subject says nothing about it', () => {
  const answer = impact([entry('billing')], 'billing', { works: [work('w1', 'orders', 'ledger')] })
  assert.deepEqual(answer.observed, [])
})

test('impact: with no records at all, observed is empty and the declared graph is untouched', () => {
  const answer = impact([entry('billing', [{ repo: 'orders', how: 'a' }]), entry('orders')], 'billing')
  assert.deepEqual([answer.observed, answer.hop1.map(n => n.repo)], [[], ['orders']])
})

// ------------------------------------------- the neighbours nobody attached

// What `rig next` offers: repos the declared graph says talk to one this work has attached, and
// which are not attached themselves. Pure, so every rule it applies is one literal away.

test('unattached: a neighbour of an attached repo is offered, with the repo it was reached from', () => {
  const found = unattached([entry('billing', [{ repo: 'orders', how: 'a', direction: 'downstream' }]), entry('orders')], ['billing'])
  assert.deepEqual(found, [{ repo: 'orders', via: 'billing', direction: 'downstream' }])
})

test('unattached: a neighbour already attached is not offered back, whatever its case', () => {
  const found = unattached([entry('billing', [{ repo: 'Orders', how: 'a' }]), entry('Orders')], ['billing', 'orders'])
  assert.deepEqual(found, [])
})

test('unattached: a neighbour two attached repos both reach is offered once', () => {
  const found = unattached([
    entry('billing', [{ repo: 'ledger', how: 'a' }]),
    entry('orders', [{ repo: 'ledger', how: 'b' }]),
    entry('ledger'),
  ], ['billing', 'orders'])
  assert.deepEqual(found.map(n => n.repo), ['ledger'])
})

test('unattached: a disagreed direction is offered as no direction, not as either claim', () => {
  const found = unattached([
    entry('billing', [{ repo: 'orders', how: 'a', direction: 'downstream' }]),
    entry('orders', [{ repo: 'billing', how: 'b', direction: 'downstream' }]),
  ], ['billing'])
  assert.equal(found[0].direction, null)
})

test('unattached: the offer is ordered by name, so it reads the same every time', () => {
  const found = unattached([entry('billing', [{ repo: 'zeta', how: 'a' }, { repo: 'alpha', how: 'b' }])], ['billing'])
  assert.deepEqual(found.map(n => n.repo), ['alpha', 'zeta'])
})
