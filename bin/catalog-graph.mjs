// The catalogue as a graph, and the questions worth asking of it.
//
// `talks_to` was the catalogue's load-bearing field and the only thing that ever read it back
// was `rig demo`, which drew it. DESIGN.md §6 makes the traversal a rule *for the agent* — "for
// every selected repo, check its neighbours and say why each is or isn't in scope" — which is
// discipline standing in for a command. `impact` is that traversal, and having it means a
// corrected entry changes an outcome, which is the only thing that makes rule 4's correction
// worth making.
//
// Pure by construction: a catalogue in, a graph or an answer out. No data root, no mirror, no
// `gh`. The entry freshness `rig impact` prints beside an edge is gathered by the caller and
// joined on there, so this module stays answerable from a literal.
//
// **Direction is stored relative to one end and read relative to the other.** An edge is keyed
// by its two repos sorted, because a relationship is one thing however many entries describe
// it; so `edge.direction` is expressed from `edge.a`'s side and `toward()` flips it for anyone
// asking from the far end. `downstream` means "a change here can break that one" — the value
// names the answer rather than the arrow, because `in`/`out` is ambiguous on an event bus,
// where the calls and the data travel in opposite directions.

const DIRECTIONS = new Set(['downstream', 'upstream', 'both'])

const flip = d => (d === 'downstream' ? 'upstream' : d === 'upstream' ? 'downstream' : d)

// What `d` means to whoever is at `from`, given it was recorded from `edge.a`'s side.
const toward = (edge, from, d = edge.direction) =>
  (d === null || lower(from) === lower(edge.a) ? d : flip(d))

const lower = s => String(s).toLowerCase()

// `talks_to` is written from both ends: Payments says how it hears from the integration hub,
// and the hub says how it pushes. Those are one relationship described twice, so the graph
// draws one line and hangs both descriptions off it. Drawing two would say the systems are
// more tangled than they are, which is the opposite of what the catalogue is for.
export function buildGraph (catalog) {
  const known = new Map(catalog.map(e => [lower(e.repo), e]))
  const nodes = new Map()
  const edges = new Map()

  const node = (repo, entry) => {
    const key = lower(repo)
    if (!nodes.has(key)) {
      nodes.set(key, {
        id: repo,
        org: entry?.org || '',
        role: entry?.role || '',
        stack: entry?.stack || '',
        // A neighbour named by someone else's `talks_to` with no entry of its own is a real
        // finding, not a rendering problem: it is the catalogue telling you where it is thin.
        // Dropping it would hide exactly the gap worth seeing.
        catalogued: Boolean(entry),
        draft: Boolean(entry?.draft),
        degree: 0,
      })
    }
    return nodes.get(key)
  }

  for (const entry of catalog) node(entry.repo, entry)

  for (const entry of catalog) {
    for (const link of entry.talks_to || []) {
      const other = typeof link === 'string' ? link : link.repo
      if (!other) continue
      const how = typeof link === 'string' ? '' : (link.how || '')
      // Kept verbatim rather than validated away: a value outside the vocabulary is not a
      // direction, and it is also not nothing — it is an entry to correct, and the only way
      // anyone finds out is by seeing the word they actually wrote.
      const direction = typeof link === 'string' ? '' : (link.direction || '')
      const a = node(entry.repo, entry)
      const b = node(other, known.get(lower(other)))
      if (a.id === b.id) continue
      const key = [lower(a.id), lower(b.id)].sort().join('\u0000')
      if (!edges.has(key)) edges.set(key, { a: a.id, b: b.id, says: [] })
      if (how || direction) edges.get(key).says.push({ from: a.id, to: b.id, how, direction })
    }
  }

  for (const e of edges.values()) {
    nodes.get(lower(e.a)).degree++
    nodes.get(lower(e.b)).degree++
    Object.assign(e, resolve(e))
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

// Every stated direction, normalised to `edge.a`'s side. One distinct claim is the direction;
// two are a contradiction and rig picks no winner, because a rule that chose one would hide
// the disagreement that is the whole reason to notice. Silence is not a claim, so an end that
// said nothing never disagrees with one that did — an unknown is not a fact.
//
// `both` against `downstream` counts as a disagreement rather than a superset to absorb. Two
// different claims about one relationship want a human's eye, and inventing a precedence rule
// would resolve them quietly in whichever direction the rule happened to favour.
function resolve (edge) {
  const claims = new Set(
    edge.says
      .filter(s => DIRECTIONS.has(s.direction))
      .map(s => (lower(s.from) === lower(edge.a) ? s.direction : flip(s.direction))),
  )
  return claims.size === 1 ? { direction: [...claims][0], disagreed: false } : { direction: null, disagreed: claims.size > 1 }
}

// The **observed** graph: which repos have been attached to the same work, read straight out
// of the records. `repos[]` is stored and not derived, so unlike `talks_to` this cannot be
// wrong about what happened — and unlike `talks_to` it can only ever see repos somebody has
// already worked on together, so it can never catch the fourth repo the first time.
//
// Every work is read, not only the closed ones. A work's repo set is as true the day it is
// attached as it is the day it lands, and excluding the open ones would hide the pairing
// happening right now, which is the one a reader can still act on.
//
// Pairs, never triples: a work holding three repos is evidence about each of the three
// relationships and not about some three-way thing the catalogue has no way to record.
export function coAttached (works) {
  const pairs = new Map()
  for (const w of works || []) {
    const repos = [...new Map((w.repos || []).map(r => [lower(r.repo), r.repo])).values()]
    for (let i = 0; i < repos.length; i++) {
      for (let j = i + 1; j < repos.length; j++) {
        const [a, b] = [repos[i], repos[j]].sort((x, y) => lower(x).localeCompare(lower(y)))
        const key = `${lower(a)}\u0000${lower(b)}`
        if (!pairs.has(key)) pairs.set(key, { a, b, works: [] })
        if (!pairs.get(key).works.includes(w.id)) pairs.get(key).works.push(w.id)
      }
    }
  }
  return [...pairs.values()]
}

// What else a change in `repo` reaches: the repos one hop away, and the repos those reach.
//
// **Two hops, fixed.** §6's rule is about neighbours; three hops across a well-connected
// catalogue reaches most of an org and stops being an answer. A depth flag would be a knob
// with no value anyone could choose.
//
// **No composed direction at two hops.** That a change in A can break B, and one in B can
// break C, does not say that a change in A reaches C — B may well absorb it. So a two-hop
// neighbour carries the hops it was reached through and the direction of *that* edge, and rig
// draws no conclusion the catalogue did not state.
export function impact (catalog, repo, { works = [] } = {}) {
  const graph = buildGraph(catalog)
  const node = graph.nodes.find(n => lower(n.id) === lower(repo))
  const name = node ? node.id : repo

  const around = of => graph.edges
    .filter(e => lower(e.a) === lower(of) || lower(e.b) === lower(of))
    .map(e => ({ edge: e, other: lower(e.a) === lower(of) ? e.b : e.a }))

  const describe = other => {
    const n = graph.nodes.find(x => lower(x.id) === lower(other))
    return { repo: n?.id ?? other, catalogued: Boolean(n?.catalogued), draft: Boolean(n?.draft), role: n?.role || '' }
  }

  const hop1 = around(name).map(({ edge, other }) => ({
    ...describe(other),
    direction: toward(edge, name),
    disagreed: edge.disagreed,
    says: edge.says,
  })).sort((x, y) => x.repo.localeCompare(y.repo))

  const seen = new Set([lower(name), ...hop1.map(n => lower(n.repo))])
  const second = new Map()
  for (const near of hop1) {
    for (const { edge, other } of around(near.repo)) {
      if (seen.has(lower(other))) continue
      if (!second.has(lower(other))) second.set(lower(other), { ...describe(other), via: [] })
      second.get(lower(other)).via.push({ through: near.repo, direction: toward(edge, near.repo), disagreed: edge.disagreed })
    }
  }

  // The observed graph, beside the declared one rather than merged into it. `declared` is the
  // whole point of printing them together: a pair the records keep making with no `talks_to`
  // line between them is evidence that an entry is missing an edge, and it names which entry.
  // Merging the two lists would lose exactly that, and would also put a claim nobody wrote
  // into the same column as claims people did.
  const declared = new Set(graph.edges.map(e => [lower(e.a), lower(e.b)].sort().join('\u0000')))
  const observed = coAttached(works)
    .filter(p => lower(p.a) === lower(name) || lower(p.b) === lower(name))
    .map(p => ({
      ...describe(lower(p.a) === lower(name) ? p.b : p.a),
      works: p.works,
      declared: declared.has([lower(p.a), lower(p.b)].sort().join('\u0000')),
    }))
    // Ordered by how often the two travelled together: the count is the strength of the
    // evidence, and it is the only ranking the records can honestly support.
    .sort((x, y) => y.works.length - x.works.length || x.repo.localeCompare(y.repo))

  return {
    repo: name,
    catalogued: Boolean(node?.catalogued),
    role: node?.role || '',
    org: node?.org || '',
    hop1,
    hop2: [...second.values()].sort((x, y) => x.repo.localeCompare(y.repo)),
    observed,
  }
}

// The repos the declared graph says talk to one of `attached`, and which are not attached
// themselves — §6's traversal, asked once per attached repo, for `rig next` to offer. One entry
// per repo however many attached repos reach it: the offer names where it came from, and naming
// three of them makes the line longer without making it truer. A disagreed direction arrives
// as none, because offering either claim would be picking the side `impact` refuses to pick.
export function unattached (catalog, attached) {
  const have = new Set(attached.map(lower))
  const found = new Map()
  for (const repo of attached) {
    for (const n of impact(catalog, repo).hop1) {
      if (have.has(lower(n.repo)) || found.has(lower(n.repo))) continue
      found.set(lower(n.repo), { repo: n.repo, via: repo, direction: n.disagreed ? null : n.direction })
    }
  }
  return [...found.values()].sort((a, b) => a.repo.localeCompare(b.repo))
}
