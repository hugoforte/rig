// The catalogue's graph, and the questions asked of it. Pure: a catalogue in, a graph or an
// answer out — no data root, no mirror, no GitHub call. The freshness that `rig impact` prints
// beside an edge is gathered by the caller and joined on, for the same reason.
//
// `buildGraph`'s own tests moved here from `test/demo.test.mjs` unchanged when the function
// left `bin/demo.mjs`. What is new below the divider is direction, and `impact`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, impact } from '../bin/catalog-graph.mjs'

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
  assert.deepEqual([dir(graph, 'billing'), graph.edges[0].conflict], ['downstream', false])
})

test('direction: two ends that disagree are a contradiction, and rig picks no winner', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'pushes invoices', direction: 'downstream' }]),
    entry('orders', [{ repo: 'billing', how: 'emits OrderReturned', direction: 'downstream' }]),
  ])
  assert.deepEqual([graph.edges[0].direction, graph.edges[0].conflict], [null, true])
})

test('direction: `both` at one end and `downstream` at the other is a disagreement', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'pushes invoices', direction: 'downstream' }]),
    entry('orders', [{ repo: 'billing', how: 'and back again', direction: 'both' }]),
  ])
  assert.equal(graph.edges[0].conflict, true, 'two different claims about one relationship, not a superset to resolve')
})

test('direction: `both` at both ends is one claim, agreed', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'either way', direction: 'both' }]),
    entry('orders', [{ repo: 'billing', how: 'either way', direction: 'both' }]),
  ])
  assert.deepEqual([graph.edges[0].direction, graph.edges[0].conflict], ['both', false])
})

test('direction: silence at one end is not a disagreement with the other', () => {
  const graph = buildGraph([
    entry('billing', [{ repo: 'orders', how: 'pushes invoices', direction: 'downstream' }]),
    entry('orders', [{ repo: 'billing', how: 'emits OrderReturned' }]),
  ])
  assert.deepEqual([dir(graph, 'billing'), graph.edges[0].conflict], ['downstream', false])
})

test('direction: an edge nobody placed is unstated, which is not the same as both ways', () => {
  const graph = buildGraph([entry('billing', [{ repo: 'orders', how: 'pushes invoices' }]), entry('orders')])
  assert.deepEqual([graph.edges[0].direction, graph.edges[0].conflict], [null, false])
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
  assert.deepEqual([answer.hop1[0].direction, answer.hop1[0].conflict], [null, true])
})
