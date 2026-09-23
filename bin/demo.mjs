// The demo page, as pure functions: a catalogue and a set of work records in, one
// self-contained interactive HTML page out. Nothing here reads a record, spawns a process or
// touches the filesystem — `cmds.demo` in rig.mjs does that, and this module is testable
// without either.
//
// The page exists because rig cannot be explained in a README. What makes it click — one
// branch, several worktrees on different bases, and prose that outlives the branch — is
// motion, and prose cannot animate. So: a dependency graph the audience recognises, then one
// real work walked through command by command, with what changed in each root beside it.
//
// It is **generated, never written**, and that is the whole design:
//
//   - rig is public. A demo page naming a real org's repos could not live in this repo, so
//     the page has to be output rather than source. The generator is generic; the render is
//     private and belongs wherever its data root does.
//   - something has to read it back. A hand-written demo is a second copy of rig's command
//     surface and starts rotting the day it is written. This one is read out of live records
//     every time it is produced, so it cannot disagree with the records.
//   - the walkthrough is derived from a real work, not typed. Invented commands drift;
//     a record cannot. Only the one-line arguments between the steps are prose.
//
// Zero dependencies holds here as it does for the dashboard: no graph library, no CDN, no
// web font. The layout is computed here and shipped as coordinates; the script is inline and
// does highlighting and stepping, nothing else. The page has to open from a file:// URL on a
// machine with no network, because that is the machine it will be presented from.

// The graph itself is `bin/catalog-graph.mjs`, which `rig impact` reads too. What is left
// here is the drawing of it: where a node goes, and how big.
import { buildGraph } from './catalog-graph.mjs'

// ------------------------------------------------------------- laying it out

// A deterministic PRNG, so the same catalogue always lays out the same way. A demo that
// rearranged itself between the rehearsal and the room would be a bad demo, and a layout
// nobody can reproduce is untestable besides.
function seeded (seed) {
  let a = seed | 0
  return () => {
    a = a + 0x6d2b79f5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// How big a node is drawn. A busy repo gets a bigger dot, which is the one piece of the
// catalogue's shape you can read without clicking anything.
export const nodeRadius = node => 9 + Math.min(9, node.degree * 2)

// What a node actually occupies once it is drawn, as half-extents. The circle is the small
// part: `texo-frontend-admin-portal-app` is thirty characters of label and nearly four times
// the width of the dot it sits under. A layout that separates circles produces exactly the
// picture this one did on the first attempt — tidy dots, labels lying across each other.
//
// The width is estimated from the character count rather than measured, because measuring
// means a browser and this module renders without one. A mean advance slightly over-estimates
// the common case, which is the direction to be wrong in: it costs a little air between nodes
// and never costs a collision.
const LABEL_SIZE = 11
const LABEL_ADVANCE = 0.55 * LABEL_SIZE
export const halfBox = node => ({
  x: Math.max(nodeRadius(node), (node.id.length * LABEL_ADVANCE) / 2),
  y: nodeRadius(node) + LABEL_SIZE,
})

// Which nodes can reach each other. Everything below treats a component as the unit, because
// the force pass has nothing to say about two nodes with no path between them: repulsion pushes
// them apart and no edge ever pulls them back, so one sim over a disconnected catalogue flings
// its pieces into the corners and leaves the middle empty. That is not a layout, it is an
// artifact of running the wrong algorithm over the wrong thing.
export function components (nodes, edges) {
  const near = new Map(nodes.map(n => [n.id.toLowerCase(), []]))
  for (const e of edges) {
    near.get(e.a.toLowerCase())?.push(e.b.toLowerCase())
    near.get(e.b.toLowerCase())?.push(e.a.toLowerCase())
  }
  const seen = new Set()
  const out = []
  for (const start of nodes) {
    const key = start.id.toLowerCase()
    if (seen.has(key)) continue
    const members = []
    const queue = [key]
    seen.add(key)
    while (queue.length) {
      const at = queue.shift()
      members.push(at)
      for (const next of near.get(at) || []) if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
    const inside = new Set(members)
    out.push({
      nodes: nodes.filter(n => inside.has(n.id.toLowerCase())),
      edges: edges.filter(e => inside.has(e.a.toLowerCase())),
    })
  }
  // Biggest first: the cluster someone is meant to look at should be the one in the top-left,
  // where reading starts, rather than wherever the catalogue happened to list it.
  return out.sort((x, y) => y.nodes.length - x.nodes.length)
}

// One component, laid out around the origin. Fruchterman-Reingold with a fixed seed and a
// fixed iteration count, so the same catalogue always lays out the same way — a demo that
// rearranged itself between the rehearsal and the room would be a bad demo, and a layout
// nobody can reproduce is untestable besides.
//
// `SPACING` is shared by every component rather than derived from each one's size, which is
// what keeps two repos in a pair as far apart as two repos inside the big cluster. Scaled
// per component, a pair of nodes would sprawl to the same area as a cluster of seven and read
// as the more important of the two.
const SPACING = 132

function layoutComponent ({ nodes, edges }, seed) {
  const n = nodes.length
  if (n === 1) return [{ x: 0, y: 0 }]

  const rand = seeded(seed)
  const pos = nodes.map((_, i) => {
    // A ring to start from, with a little jitter. Starting every node at the centre makes the
    // first repulsion step explode; starting at random makes the result depend on the seed far
    // more than on the edges.
    const angle = (i / n) * Math.PI * 2
    const r = SPACING * Math.max(1, n / 6)
    return { x: Math.cos(angle) * r + (rand() - 0.5) * 20, y: Math.sin(angle) * r + (rand() - 0.5) * 20 }
  })
  const index = new Map(nodes.map((node, i) => [node.id.toLowerCase(), i]))
  const links = edges
    .map(e => [index.get(e.a.toLowerCase()), index.get(e.b.toLowerCase())])
    .filter(([a, b]) => a !== undefined && b !== undefined)

  const k = SPACING
  const iterations = 400
  for (let step = 0; step < iterations; step++) {
    // Cooling: big moves early to untangle, small moves late to settle. Without it the layout
    // never stops shivering and the last iteration is as arbitrary as the first.
    const temp = k * 0.12 * (1 - step / iterations)
    const disp = pos.map(() => ({ x: 0, y: 0 }))

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x
        let dy = pos[i].y - pos[j].y
        let d = Math.hypot(dx, dy)
        if (d < 0.01) { dx = (rand() - 0.5) * 0.1; dy = (rand() - 0.5) * 0.1; d = 0.01 }
        const force = (k * k) / d
        const ux = (dx / d) * force
        const uy = (dy / d) * force
        disp[i].x += ux; disp[i].y += uy
        disp[j].x -= ux; disp[j].y -= uy
      }
    }

    for (const [a, b] of links) {
      const dx = pos[a].x - pos[b].x
      const dy = pos[a].y - pos[b].y
      const d = Math.max(0.01, Math.hypot(dx, dy))
      const force = (d * d) / k
      const ux = (dx / d) * force
      const uy = (dy / d) * force
      disp[a].x -= ux; disp[a].y -= uy
      disp[b].x += ux; disp[b].y += uy
    }

    for (let i = 0; i < n; i++) {
      const d = Math.max(0.01, Math.hypot(disp[i].x, disp[i].y))
      pos[i].x += (disp[i].x / d) * Math.min(d, temp)
      pos[i].y += (disp[i].y / d) * Math.min(d, temp)
      // A pull to the middle, so a chain curls up instead of stretching off into a diagonal
      // nothing else can be packed beside. Most of this catalogue is chains and trees, which is
      // the shape force-directed layout sprawls on worst, and the first value here was far too
      // weak: components came out as long thin diagonals and two of them packed to a square
      // page that had to be scrolled. Stronger is not simply better — past about 0.03 the
      // components collapse until the drawing hits its minimum size and reads as cramped — so
      // this sits at the compact end of the range that still leaves the clusters distinct.
      pos[i].x -= pos[i].x * 0.008
      pos[i].y -= pos[i].y * 0.008
    }
  }
  return pos
}

// Shelf packing: each component as a block, laid left to right and wrapped onto a new row when
// the row is full, tallest first so the rows stay tight. It is the simplest packing that fills
// a rectangle, and with a handful of components there is nothing to gain from a better one.
function shelve (blocks, rowWidth, gap) {
  let x = 0
  let y = 0
  let shelf = 0
  let row = []
  const rows = []
  const closeRow = () => { if (row.length) rows.push({ y, height: shelf, blocks: row }); row = []; }
  for (const block of blocks) {
    if (x > 0 && x + block.w > rowWidth) { closeRow(); x = 0; y += shelf + gap; shelf = 0 }
    row.push({ ...block, at: { x, y } })
    x += block.w + gap
    shelf = Math.max(shelf, block.h)
  }
  closeRow()
  // Blocks are centred in their row rather than hung from its top edge. A short block beside a
  // tall one otherwise sits against the ceiling with its own height of dead space underneath,
  // which is most of what made the first packing look like a page with a hole in it.
  return rows.flatMap(r => r.blocks.map(block =>
    ({ ...block, at: { x: block.at.x, y: block.at.y + (r.height - block.h) / 2 } })))
}

// Which shelf width to pack at. Estimating one from the total area is the textbook answer and
// it was wrong here by a whole row: shelf waste depends on the shapes, and two tall thin
// components plus a wide short one waste nothing like the average. With a handful of blocks
// there is no reason to estimate — pack at every width that could change the answer, and keep
// whichever result comes out closest to the proportions asked for. The candidate widths are
// the cumulative ones, because a shelf only breaks differently when it crosses a block edge.
function packed (blocks, shape, gap = 46) {
  const widest = Math.max(...blocks.map(b => b.w))
  const candidates = blocks.map((_, i) =>
    Math.max(widest, blocks.slice(0, i + 1).reduce((sum, b) => sum + b.w, 0) + gap * i))

  let best = null
  for (const rowWidth of candidates) {
    const laid = shelve(blocks, rowWidth, gap)
    const w = Math.max(...laid.map(b => b.at.x + b.w))
    const h = Math.max(...laid.map(b => b.at.y + b.h))
    // Scored on the log ratio so that twice too wide and half as wide cost the same. Judging
    // it on the difference would quietly prefer tall layouts, which are the ones that make the
    // page scroll.
    const off = Math.abs(Math.log((w / Math.max(1, h)) / shape))
    if (!best || off < best.off) best = { off, laid }
  }
  return best.laid
}

// The pass that looks at the drawing rather than the topology: any two nodes whose *boxes*
// overlap — circle and label together — are pushed apart along whichever axis needs the least
// movement, repeatedly, until none do. It moves nodes by a few pixels and never reorders them,
// so the clusters the forces found survive it.
function separate (placed, { rounds = 160, gap = 12 }) {
  for (let round = 0; round < rounds; round++) {
    let moved = false
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]
        const b = placed[j]
        const ha = halfBox(a)
        const hb = halfBox(b)
        let dx = b.x - a.x
        let dy = b.y - a.y
        const overlapX = ha.x + hb.x + gap - Math.abs(dx)
        const overlapY = ha.y + hb.y + gap - Math.abs(dy)
        if (overlapX <= 0 || overlapY <= 0) continue
        // Exactly coincident has no direction to push along; a fixed one keeps it reproducible.
        if (dx === 0 && dy === 0) dx = 1
        if (overlapX < overlapY) {
          const shift = (Math.sign(dx) || 1) * overlapX / 2
          a.x -= shift; b.x += shift
        } else {
          const shift = (Math.sign(dy) || 1) * overlapY / 2
          a.y -= shift; b.y += shift
        }
        moved = true
      }
    }
    if (!moved) break
  }
  return placed
}

// Every node, placed. Components are laid out one at a time, packed into rows, separated so no
// label crosses anything, and only then scaled into the viewBox — in that order, because
// scaling first would undo the separation and separating first would undo the packing.
// `shape` is the proportion the packing aims for, not the size of anything: a graph packed
// towards the page's own proportions needs the least scaling to sit on it. The box that comes
// out is measured from the result.
export function layout (graph, { shape = 1000 / 560, seed = 20260921 } = {}) {
  const { nodes, edges } = graph
  if (!nodes.length) return { width: 620, height: 260, nodes: [], edges: [] }

  // **A repo with no relationships is not part of a relationship graph.** Placed in the
  // drawing it has to go *somewhere*, and every somewhere is a claim: floating beside a cluster
  // reads as "nearly connected to that", and a corner reads as "banished". It is neither — it
  // is a repo the catalogue has not been filled in for. So it leaves the drawing altogether and
  // is listed under it, where saying that plainly costs nothing and reads as the finding it is.
  // The drawing gets the two components it actually has, and packs far better for losing them.
  const linked = components(nodes, edges).filter(c => c.nodes.length > 1)
  if (!linked.length) return { width: 620, height: 200, nodes: [], edges: [] }

  const blocks = linked.map((comp, i) => {
    const pos = layoutComponent(comp, seed + i * 977)
    const members = comp.nodes.map((node, j) => ({ ...node, x: pos[j].x, y: pos[j].y }))
    // The block is the component's *drawn* extent, labels included, so packing leaves room for
    // the widest name rather than for the dot under it.
    const left = Math.min(...members.map(m => m.x - halfBox(m).x))
    const right = Math.max(...members.map(m => m.x + halfBox(m).x))
    const top = Math.min(...members.map(m => m.y - halfBox(m).y))
    const bottom = Math.max(...members.map(m => m.y + halfBox(m).y))
    return { members, left, top, w: right - left, h: bottom - top }
  })

  const pad = 34
  const laid = packed(blocks, shape)
  const loose = separate(laid.flatMap(block => block.members.map(m => ({
    ...m,
    x: m.x - block.left + block.at.x,
    y: m.y - block.top + block.at.y,
  }))), {})

  // **The viewBox is fitted to the drawing, not the drawing to the viewBox.** Packing a graph
  // into a rectangle chosen in advance leaves whatever the shapes did not happen to fill, and
  // for three components of very different proportions that is a quarter of the page with
  // nothing in it. Measuring the content instead means there is no empty space to explain: the
  // svg is `width: 100%`, so the page scales it to fit and the height simply follows.
  //
  // `MIN_BOX` is the one thing a fitted box still needs. A catalogue of three repos measures
  // small, and a small viewBox stretched across the page magnifies everything in it — three
  // enormous dots, reading as a diagram of something important rather than as a short list.
  // Below that width the box stops shrinking and the drawing sits inside it at its own size.
  const MIN_BOX = 620
  const left = Math.min(...loose.map(n => n.x - halfBox(n).x))
  const right = Math.max(...loose.map(n => n.x + halfBox(n).x))
  const top = Math.min(...loose.map(n => n.y - halfBox(n).y))
  const bottom = Math.max(...loose.map(n => n.y + halfBox(n).y))
  const box = {
    width: Math.max(MIN_BOX, right - left + pad * 2),
    height: Math.max(MIN_BOX / 2.4, bottom - top + pad * 2),
  }
  const offX = (box.width - (right - left)) / 2 - left
  const offY = (box.height - (bottom - top)) / 2 - top

  const placed = loose.map(node => ({
    ...node,
    x: Math.round((node.x + offX) * 10) / 10,
    y: Math.round((node.y + offY) * 10) / 10,
  }))
  const at = new Map(placed.map(p => [p.id.toLowerCase(), p]))

  return {
    width: Math.round(box.width),
    height: Math.round(box.height),
    nodes: placed,
    edges: edges.map(e => ({ ...e, from: at.get(e.a.toLowerCase()), to: at.get(e.b.toLowerCase()) })).filter(e => e.from && e.to),
  }
}

// ---------------------------------------------------------------- the example work

// Which work to walk through. The leading term is **repos that actually merged**, which is
// breadth and completeness in one number — the page argues that rig earns its keep on
// cross-repo work, and a walkthrough that stops before the merge makes half that case.
// Ranking on repo count alone picks the widest unfinished work every time, which is how the
// closing panel ends up empty on the most interesting-looking example in the root.
// Total repos breaks the tie, then recency, so the example keeps up with what the team is
// actually doing.
export function pickExample (works, wanted = null) {
  const usable = works.filter(w => (w.repos || []).length > 0)
  if (!usable.length) return null
  if (wanted) {
    const named = usable.find(w => w.id === wanted)
    if (!named) throw new Error(`no work "${wanted}" with repos attached in this data root`)
    return named
  }
  const score = w => {
    const repos = w.repos || []
    return [
      repos.filter(r => repoBranch(r, w.branch).pr?.mergedAt).length,
      repos.length,
      w.closedAt ? 1 : 0,
      Date.parse(w.createdAt || 0) || 0,
    ]
  }
  return usable.slice().sort((a, b) => {
    const [x, y] = [score(a), score(b)]
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]
    return 0
  })[0]
}

const shortBranch = b => String(b || '')

// What a repo contributes to this work: where its branch lands, and that branch's pull request
// once it merged.
//
// Record format 3 moved both into `repos[].branches[]` — one entry per branch of this work the
// repo holds, because a repo carries several once a work has stages, and a base belongs to the
// branch it was cut for rather than to the repo. Before that they sat directly on the repo.
//
// Both shapes are live at once and will be for a while: records migrate when rig next writes
// one, so a root holds a mix, and reading only the new shape would be exactly the bug this
// replaces with the sides swapped. The failure was quiet, which is what made it expensive — a
// work whose record had been rewritten read as a work with no pull requests, so it lost the
// example ranking, its `rig pr` step vanished, its PR table came out empty and every base
// printed `undefined`, and nothing anywhere failed.
export function repoBranch (repo, workBranch = null) {
  const entries = repo?.branches
  if (Array.isArray(entries) && entries.length) {
    return entries.find(b => b.branch === workBranch) || entries[0]
  }
  // The legacy shape, read as the one branch it could describe.
  return { branch: workBranch, base: repo?.base, pr: repo?.pr }
}

// The walkthrough, derived. Every command, path, branch, base and PR number below comes out
// of the record; only `note` is prose, and it is prose about the shape of the step rather
// than about this particular work, so it stays true for whichever work gets picked.
export function walkthrough (work, { workRoot = 'w', dataRoot = 'rig-data' } = {}) {
  // Each repo flattened to the branch this work has in it, so nothing below has to know which
  // record format the work was written in.
  const repos = (work.repos || []).map(r => ({ ...r, ...repoBranch(r, work.branch) }))
  const tickets = work.tickets || []
  const branch = shortBranch(work.branch)
  const steps = []

  const ticketArg = tickets.length ? `--key ${tickets[0]}` : '--no-ticket'
  steps.push({
    command: `rig new ${work.id} ${ticketArg}`,
    says: [
      ...(tickets.length ? [`· fetching ${tickets[0]}`, `✓ ticket ${tickets[0]}`] : ['· no ticket — decision recorded']),
      `✓ created work ${work.id}`,
      `  folder   ${workRoot}\\${work.id}`,
      `  branch   ${branch}`,
    ],
    work: [`${work.id}/`, '  AGENTS.md    generated — regenerated on every change'],
    data: [`work/${work.id}/work.json`, `work/${work.id}/context.md`, '✓ committed and pushed'],
    note: tickets.length
      ? 'The ticket decision is never implicit. `rig new` refuses without `--key`, `--ticket` or `--no-ticket`, so a work always knows whether it has one.'
      : 'No ticket, recorded as a decision rather than left as an empty list nobody chose.',
  })

  repos.forEach((repo, i) => {
    steps.push({
      command: `rig attach ${repo.repo}`,
      says: [
        `· fetching ${repo.org}/${repo.repo}`,
        `· worktree ${repo.repo} → ${branch} (base ${repo.base})`,
        `✓ attached ${repo.repo}`,
      ],
      work: [
        `${work.id}/`,
        ...repos.slice(0, i + 1).map(r => `  ${r.repo}/    ${branch} on ${r.base}`),
        '  AGENTS.md    regenerated',
      ],
      data: [`work/${work.id}/work.json    + ${repo.repo} (base ${repo.base})`, '✓ committed and pushed'],
      note: i === 0
        ? 'One branch name, decided once. Every repo in this work gets the same one — that is what makes the work findable from any of them.'
        : repo.base !== repos[0].base
          ? `Same branch, different base: \`${repo.base}\`, not \`${repos[0].base}\`. The base belongs to the branch, not to the repo — and getting this wrong by hand is the mistake that costs an afternoon.`
          : 'A second worktree, not a second clone. Same objects on disk, one fetch, and both trees on the same branch.',
    })
  })

  steps.push({
    command: 'rig save -m "design agreed" --designed',
    says: [`✓ ${work.id}: design agreed`, '✓ data root: committed and pushed'],
    work: [`${work.id}/`, '  (unchanged — no prose lives here)'],
    data: [`work/${work.id}/context.md    the Direction section`, `work/${work.id}/work.json    + designedAt`, '✓ committed and pushed'],
    note: 'The gate, not a status field. `designedAt` is a decision on a date that nothing can observe afterwards — which is exactly what is worth storing, and why branch and PR state never are.',
  })

  const withPr = repos.filter(r => r.pr?.number)
  if (withPr.length) {
    steps.push({
      command: 'rig pr',
      says: withPr.map(r => `✓ ${r.repo} #${r.pr.number} → ${r.base}`),
      work: [`${work.id}/`, ...repos.map(r => `  ${r.repo}/`)],
      data: ['(nothing yet — a PR is not a terminal fact until it merges)'],
      note: 'The body is assembled from the record: the title, the tickets, and the Direction section of the context doc lifted verbatim. Nothing is retyped, so nothing can disagree.',
    })
  }

  steps.push({
    command: 'rig close',
    says: [
      ...withPr.map(r => `✓ ${r.repo} #${r.pr.number} merged`),
      ...(tickets.length ? [`✓ commented on ${tickets.join(', ')} with the PR links`] : []),
      '✓ worktrees removed',
    ],
    work: ['(gone — the work root is disposable)'],
    data: [`work/${work.id}/context.md    kept`, `work/${work.id}/work.json    + closedAt, + each PR's merge facts`, '✓ committed and pushed'],
    note: 'The trees were scaffolding; the knowledge was the point. What survives is the prose and the merge facts — the two things nothing can re-derive once the branch is gone.',
  })

  return steps.map((s, i) => ({ ...s, n: i + 1 }))
}

// ---------------------------------------------------------------- the model

export function summarize ({ catalog = [], works = [], generatedAt = null, root = null, example = null } = {}) {
  const whole = buildGraph(catalog)
  const graph = layout(whole)
  // Listed rather than drawn, in reading order. `graph.nodes` is only what the drawing holds.
  const unlinked = whole.nodes.filter(n => n.degree === 0).sort((a, b) => a.id.localeCompare(b.id))
  const chosen = pickExample(works, example)
  const orgs = [...new Set(catalog.map(e => e.org).filter(Boolean))]
  const spread = works.reduce((acc, w) => {
    const n = (w.repos || []).length
    acc[n] = (acc[n] || 0) + 1
    return acc
  }, {})

  return {
    generatedAt,
    root,
    orgs,
    graph,
    whole,
    unlinked,
    example: chosen,
    steps: chosen ? walkthrough(chosen) : [],
    counts: {
      repos: catalog.length,
      uncatalogued: whole.nodes.filter(n => !n.catalogued).length,
      edges: whole.edges.length,
      works: works.length,
      crossRepo: works.filter(w => (w.repos || []).length > 1).length,
    },
    outcome: outcome(works),
    spread: Object.entries(spread).map(([repos, n]) => ({ repos: Number(repos), n })).sort((a, b) => a.repos - b.repos),
  }
}

// What the works cost, as opposed to how many there were. The header counted inventory and
// said nothing about what any of it produced, which is the half that makes the case.
//
// Read out of the **terminal PR facts** `rig close` stores and `rig backfill` fills in behind
// it (decision 60): a merge cannot un-merge, so unlike the dashboard's live PR state these
// cannot be wrong by tomorrow — which is the property decision 91 required of anything this
// page commits into a data root. No `gh` call, so `--quick` and live agree by construction.
//
// **A work landed when a pull request of its own merged.** Not `closedAt`, which is when the
// teardown ran: `rig close --abandoned` sets it too, and a work can be closed with nothing
// shipped. **The cycle is the first commit in any repo to the last merge in any repo**, because
// a cross-repo work is not finished until its last repo is — taking the first merge would make
// the widest works look like the fastest.
//
// **Median, never mean**, and every figure carries the n it was taken over: one migration that
// sat for a month drags a mean far enough to be a lie, and a figure with no n behind it is the
// claim `rig dash` already refuses to make.
const median = xs => {
  if (!xs.length) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const DAY = 86400000

function outcome (works) {
  const landed = []
  for (const w of works) {
    // Landed is every repo's pull request merged — the rule `rig dash` counts by, in
    // `reduceWork` — and never an abandoned work, whatever merged before it was stopped. Counting
    // a work on its first merge stops its clock early and makes the widest works look fastest.
    if (w.abandonedAt) continue
    const repos = w.repos || []
    const prs = repos.map(r => repoBranch(r, w.branch)?.pr)
    if (!repos.length || !prs.every(pr => pr?.mergedAt)) continue
    const first = prs.map(pr => Date.parse(pr.firstCommitAt)).filter(Number.isFinite)
    const last = prs.map(pr => Date.parse(pr.mergedAt)).filter(Number.isFinite)
    landed.push({
      repos: repos.length,
      days: first.length && last.length ? (Math.max(...last) - Math.min(...first)) / DAY : null,
    })
  }
  const days = landed.map(l => l.days).filter(d => d !== null)
  const round = (n, dp) => (n === null ? null : Math.round(n * 10 ** dp) / 10 ** dp)
  return {
    landed: landed.length,
    // Kept to four places rather than one: a root of single-repo works merges in hours, and
    // rounding to a tenth of a day here would flatten every one of them to zero before the
    // page ever got to choose a unit.
    cycleDays: round(median(days), 4),
    cycleN: days.length,
    reposPerWork: round(median(landed.map(l => l.repos)), 1),
  }
}

// ---------------------------------------------------------------- rendering

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Backtick-delimited spans become <code>, because the notes are written the way every other
// piece of rig prose is written and retyping them as markup would be worse.
const ticks = s => esc(s).replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)

const HOUR = 3600000
const duration = (from, to) => {
  const a = Date.parse(from)
  const b = Date.parse(to)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '—'
  const h = (b - a) / HOUR
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`
  return `${(h / 24).toFixed(1)}d`
}



// Days is the model's unit because it is the one a cycle time is usually quoted in, but a
// data root of single-repo works merges in hours and "0 days" reads as a broken page rather
// than as a fast one. So the page picks the unit from the number, the way `duration` already
// does for the pull-request table.
//
// Each unit is chosen after rounding, not before, so 59.9 minutes is "1 hour" rather than
// "60 minutes" and a cycle one breath short of a day is "1 day" rather than "24 hours".
const span = days => {
  if (days === null) return ''
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  const minutes = Math.round(days * 24 * 60)
  if (minutes < 60) return unit(Math.max(1, minutes), 'minute')
  const hours = Math.round(days * 24 * 10) / 10
  if (hours < 24) return unit(hours, 'hour')
  return unit(Math.round(days * 10) / 10, 'day')
}

// Where a line from `from` towards `to` meets `to`'s circle, one unit outside it. The heads put
// their tip exactly on the line's end (`refX` at the tip), so this is where the tip lands.
const toEdge = (from, to) => {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
  const back = (nodeRadius(to) + 1) / length
  return {
    x: Math.round((to.x - (to.x - from.x) * back) * 10) / 10,
    y: Math.round((to.y - (to.y - from.y) * back) * 10) / 10,
  }
}

function renderGraph (graph) {
  if (!graph.nodes.length) return '<p class="empty">No repos catalogued in this data root yet.</p>'

  // `from` is the edge's `a` and `to` its `b`, and `direction` is recorded from `a`'s side, so
  // `downstream` — a change in `a` can break `b` — points at the `to` end. An edge nobody placed
  // and an edge the two entries disagree about are both drawn plain: an unknown is not a fact,
  // and neither is a contradiction. That makes the drawing a map of where the catalogue is thin,
  // which is the same argument as listing the repos with no entry underneath it.
  //
  // A marked end stops at the edge of the dot it points at. The nodes are drawn after the edges
  // with an opaque fill, so a head left at a node's centre is painted over and the page shows a
  // plain line — the picture this is meant to tell apart from an unstated edge.
  const edges = graph.edges.map((e, i) => {
    const end = !e.disagreed && (e.direction === 'downstream' || e.direction === 'both')
    const start = !e.disagreed && (e.direction === 'upstream' || e.direction === 'both')
    const from = start ? toEdge(e.to, e.from) : e.from
    const to = end ? toEdge(e.from, e.to) : e.to
    const heads = (start ? ' marker-start="url(#arrowback)"' : '') + (end ? ' marker-end="url(#arrow)"' : '')
    return `<line class="edge" id="e${i}" data-a="${esc(e.a)}" data-b="${esc(e.b)}" ` +
      `x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"${heads}></line>`
  }).join('\n    ')

  const nodes = graph.nodes.map(n => {
    const r = nodeRadius(n)
    return `<g class="node${n.catalogued ? '' : ' unknown'}" data-repo="${esc(n.id)}" tabindex="0" role="button" ` +
      `aria-label="${esc(n.id)}" transform="translate(${n.x},${n.y})">` +
      `<circle r="${r}"></circle>` +
      `<text y="${r + 15}">${esc(n.id)}</text></g>`
  }).join('\n    ')

  return `<svg viewBox="0 0 ${graph.width} ${graph.height}" class="graph" role="img" aria-label="Repository dependency graph">
    <defs>
      <marker id="arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z"></path></marker>
      <marker id="arrowback" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z"></path></marker>
    </defs>
    ${edges}
    ${nodes}
  </svg>`
}

function repoCards (graph) {
  return graph.nodes.map(n => {
    const mine = graph.edges.filter(e => e.a === n.id || e.b === n.id)
    const says = mine.flatMap(e => e.says.map(s =>
      `<li><span class="dir">${esc(s.from)} → ${esc(s.to)}</span>${ticks(s.how)}</li>`))
    return `<article class="card" data-for="${esc(n.id)}" hidden>
      <h3>${esc(n.id)}${n.catalogued ? '' : ' <span class="flag">not catalogued</span>'}${n.draft ? ' <span class="flag">draft entry</span>' : ''}</h3>
      ${n.role ? `<p class="role">${ticks(n.role)}</p>` : ''}
      ${n.stack ? `<p class="stack">${ticks(n.stack)}</p>` : ''}
      ${says.length ? `<ul class="edges">${says.join('')}</ul>` : '<p class="empty">Named by another repo’s <code>talks_to</code>, with no entry of its own yet.</p>'}
    </article>`
  }).join('\n')
}

// The repos the drawing has nothing to say about. A quiet strip rather than a warning: a
// catalogue is filled in as work touches each repo, so a thin entry is the normal state of one
// nobody has needed yet — not a fault to flag. They stay clickable, because their entry is
// still worth reading.
function renderUnlinked (unlinked) {
  if (!unlinked?.length) return ''
  return `<div class="loose">
    <h4>no relationships recorded yet <span>${unlinked.length} of them</span></h4>
    <div class="chips">${unlinked.map(n =>
      `<button type="button" class="chip${n.catalogued ? '' : ' unknown'}" data-repo="${esc(n.id)}">${esc(n.id)}</button>`).join('')}</div>
  </div>`
}

function renderSteps (steps) {
  return steps.map(s => `<section class="step" data-step="${s.n}" hidden>
    <div class="cmd"><span class="prompt">$</span> ${esc(s.command)}</div>
    <pre class="says">${s.says.map(esc).join('\n')}</pre>
    <div class="panes">
      <div class="pane"><h4>the work root <span>disposable</span></h4><pre>${s.work.map(esc).join('\n')}</pre></div>
      <div class="pane"><h4>the data root <span>committed</span></h4><pre>${s.data.map(esc).join('\n')}</pre></div>
    </div>
    <p class="why">${ticks(s.note)}</p>
  </section>`).join('\n')
}

function renderPrs (work) {
  const rows = (work.repos || [])
    .map(r => ({ ...r, ...repoBranch(r, work.branch) }))
    .filter(r => r.pr?.mergedAt).map(r => `<tr>
    <th>${esc(r.repo)}</th>
    <td><code>${esc(r.base)}</code></td>
    <td>#${esc(r.pr.number)}</td>
    <td>${duration(r.pr.firstCommitAt, r.pr.openedAt)}</td>
    <td>${duration(r.pr.openedAt, r.pr.firstReviewAt)}</td>
    <td>${duration(r.pr.firstReviewAt, r.pr.approvedAt)}</td>
    <td>${duration(r.pr.approvedAt, r.pr.mergedAt)}</td>
  </tr>`)
  if (!rows.length) return ''
  return `<section class="panel">
  <h2>What survived the branch</h2>
  <p class="note">Recorded by <code>rig close</code> once each pull request merged. These are
  terminal facts — a merge cannot un-merge — which is what makes storing them a different act
  from storing branch or PR state, and why everything else on this page is derived live.</p>
  <table>
    <thead><tr><th>Repo</th><th>Base</th><th>PR</th><th>Commit → open</th><th>Open → first look</th><th>Look → approve</th><th>Approve → merge</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
</section>`
}

const STYLE = `
:root {
  color-scheme: dark;
  --bg: #12201a; --panel: #18291f; --raise: #1e3a2b; --edge: #2b4634;
  --text: #e6efe8; --dim: #8ba795;
  --accent: #e0559a; --good: #3ec98a; --amber: #e8b93a; --link: #6aa9e0;
  --line: #4e7a61;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #fbfdfb; --panel: #f2f6f3; --raise: #e7efe9; --edge: #d3e0d7;
    --text: #16241c; --dim: #5d7767;
    --accent: #b5246c; --good: #1d7d55; --amber: #9a6f00; --link: #2a6aa8;
    --line: #9dbaa8;
  }
}
* { box-sizing: border-box; }
body {
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg); color: var(--text);
  margin: 0 auto; max-width: 68rem; padding: 2.5rem 1.5rem 5rem;
  -webkit-font-smoothing: antialiased;
}
h1 { margin: 0; font-size: 1.6rem; font-weight: 600; letter-spacing: -.01em; }
h1 .tag {
  display: inline-block; margin-right: .5rem; padding: .12rem .45rem; vertical-align: .14em;
  border-radius: 5px; background: var(--accent); color: #fff;
  font: 600 .72rem/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .04em;
}
h2 { margin: 0 0 .1rem; font-size: 1.15rem; font-weight: 600; letter-spacing: -.01em; display: flex; align-items: center; gap: .5rem; }
h2::before { content: ""; width: .55rem; height: .55rem; border-radius: 50%; background: var(--accent); flex: none; }
h3 { margin: 0 0 .3rem; font-size: .95rem; font-weight: 600; }
h4 { margin: 0; font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .09em; color: var(--dim); display: flex; justify-content: space-between; }
h4 span { font-weight: 500; text-transform: none; letter-spacing: 0; }
.panel, header.meta { background: var(--panel); border: 1px solid var(--edge); border-radius: 12px; padding: 1.25rem 1.4rem 1.5rem; margin-top: 1.25rem; }
header.meta { padding: 1rem 1.25rem; }
header.meta p { margin: .35rem 0; font-size: .85rem; color: var(--dim); }
header.meta strong { color: var(--text); font-weight: 600; }
.lede { color: var(--dim); font-size: .92rem; margin: .5rem 0 0; }
.lede strong { color: var(--text); }
.note, .empty { color: var(--dim); font-size: .84rem; }
.note { margin: .3rem 0 .9rem; }
code { background: var(--raise); border: 1px solid var(--edge); border-radius: 5px; padding: .05rem .3rem; font: .85em ui-monospace, SFMono-Regular, Consolas, monospace; }
table { border-collapse: collapse; width: 100%; margin-top: .4rem; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: .38rem .55rem; border-bottom: 1px solid var(--edge); font-size: .88rem; }
thead th { font-size: .66rem; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: var(--dim); }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
tbody th { font-weight: 500; }

/* ---- graph */
.graph { width: 100%; height: auto; display: block; touch-action: manipulation; margin: .3rem 0 .1rem; }
.edge { stroke: var(--line); stroke-width: 2; transition: stroke .12s, stroke-width .12s; }
#arrow path, #arrowback path { fill: var(--line); }
.edge.lit { stroke: var(--accent); stroke-width: 2.6; }
.graph.picking .edge:not(.lit) { stroke: var(--line); opacity: .3; }
.node circle { fill: var(--raise); stroke: var(--good); stroke-width: 2; transition: fill .12s, stroke .12s; }
/* The halo. Labels are wider than the dots they belong to, so one will eventually cross an
   edge or a neighbour however well the layout separates them; a stroke in the page colour,
   painted under the glyphs, means that crossing is never the thing that makes a name
   unreadable. */
.node text {
  fill: var(--text); font: 500 11.5px ui-sans-serif, system-ui, sans-serif; text-anchor: middle;
  paint-order: stroke fill; stroke: var(--bg); stroke-width: 3.5px; stroke-linejoin: round;
}
.node { cursor: pointer; }
.node:hover circle, .node:focus circle { fill: var(--good); }
.node:focus { outline: none; }
.node:focus text { fill: var(--good); }
.node.unknown circle { stroke: var(--dim); stroke-dasharray: 3 3; }
.node.lit circle { fill: var(--accent); stroke: var(--accent); }
.node.lit text { fill: var(--text); font-weight: 600; }
.graph.picking .node:not(.lit):not(.near) circle { opacity: .45; }
.graph.picking .node:not(.lit):not(.near) text { opacity: .5; }
.card { border-top: 1px solid var(--edge); margin-top: 1rem; padding-top: .9rem; }
.card .role { margin: .1rem 0 .3rem; font-size: .9rem; }
.card .stack { margin: 0 0 .5rem; font-size: .8rem; color: var(--dim); }
.card .flag { font-size: .62rem; text-transform: uppercase; letter-spacing: .08em; color: var(--amber); border: 1px solid var(--amber); border-radius: 4px; padding: .08rem .3rem; vertical-align: .12em; }
.edges { margin: 0; padding-left: 0; list-style: none; }
.edges li { font-size: .85rem; color: var(--dim); margin: .45rem 0; padding-left: .8rem; border-left: 2px solid var(--edge); }
.dir { display: block; color: var(--good); font: 600 .72rem ui-monospace, SFMono-Regular, Consolas, monospace; margin-bottom: .1rem; }
.hint { color: var(--dim); font-size: .8rem; margin: .6rem 0 0; text-align: center; }
.loose { border-top: 1px solid var(--edge); margin-top: 1.1rem; padding-top: .85rem; }
.loose h4 { margin-bottom: .5rem; }
.loose h4 span { color: var(--dim); }
.chips { display: flex; flex-wrap: wrap; gap: .4rem; }
.chip {
  font: 500 .82rem ui-sans-serif, system-ui, sans-serif; color: var(--text);
  background: var(--raise); border: 1px solid var(--edge); border-radius: 999px;
  padding: .22rem .7rem; cursor: pointer;
}
.chip:hover, .chip:focus { border-color: var(--good); outline: none; }
.chip.lit { background: var(--accent); border-color: var(--accent); color: #fff; }
.chip.unknown { border-style: dashed; color: var(--dim); }

/* ---- walkthrough */
.stepper { display: flex; align-items: center; gap: .5rem; margin: .8rem 0 .2rem; flex-wrap: wrap; }
.stepper button { font: inherit; font-size: .82rem; color: var(--text); background: var(--raise); border: 1px solid var(--edge); border-radius: 7px; padding: .3rem .7rem; cursor: pointer; }
.stepper button:hover:not(:disabled) { border-color: var(--good); }
.stepper button:disabled { opacity: .4; cursor: default; }
.dots { display: flex; gap: .3rem; margin-left: auto; }
.dots i { width: .5rem; height: .5rem; border-radius: 50%; background: var(--edge); cursor: pointer; display: block; }
.dots i.on { background: var(--accent); }
.cmd { font: .92rem ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--raise); border: 1px solid var(--edge); border-radius: 8px; padding: .55rem .8rem; overflow-x: auto; }
.prompt { color: var(--accent); margin-right: .5rem; }
pre { margin: 0; font: .82rem/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
.says { color: var(--good); padding: .6rem .3rem .2rem; }
.panes { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; margin-top: .5rem; }
.pane { background: var(--raise); border: 1px solid var(--edge); border-radius: 8px; padding: .6rem .75rem; }
.pane pre { margin-top: .35rem; color: var(--dim); }
.why { font-size: .88rem; color: var(--text); margin: .9rem 0 0; padding-left: .8rem; border-left: 2px solid var(--accent); }
@media (max-width: 42rem) { .panes { grid-template-columns: 1fr; } }
.roots { display: grid; grid-template-columns: repeat(3, 1fr); gap: .8rem; margin-top: .6rem; }
.root { background: var(--raise); border: 1px solid var(--edge); border-radius: 8px; padding: .7rem .8rem; }
.root b { display: block; font-size: .9rem; }
.root span { font-size: .8rem; color: var(--dim); }
@media (max-width: 42rem) { .roots { grid-template-columns: 1fr; } }
`

// Highlighting and stepping. Everything it needs is already in the DOM — the script chooses
// what is visible and never computes a fact. A page whose numbers came out of a script would
// be a second implementation of rig in JavaScript, which is the thing this whole design is
// avoiding.
const SCRIPT = `
(function () {
  var svg = document.querySelector('.graph');
  var cards = document.querySelectorAll('.card');
  var chips = document.querySelectorAll('.chip');
  if (svg || chips.length) {
    var picked = null;
    function pick (repo) {
      picked = picked === repo ? null : repo;
      var near = {};
      if (svg) {
        svg.classList.toggle('picking', Boolean(picked));
        svg.querySelectorAll('.edge').forEach(function (e) {
          var on = Boolean(picked) && (e.dataset.a === picked || e.dataset.b === picked);
          e.classList.toggle('lit', on);
          if (on) { near[e.dataset.a] = 1; near[e.dataset.b] = 1; }
        });
        svg.querySelectorAll('.node').forEach(function (n) {
          n.classList.toggle('lit', n.dataset.repo === picked);
          n.classList.toggle('near', Boolean(near[n.dataset.repo]));
        });
      }
      chips.forEach(function (c) { c.classList.toggle('lit', c.dataset.repo === picked); });
      cards.forEach(function (c) { c.hidden = c.dataset.for !== picked; });
    }
    // A node in the drawing and a chip under it are two ways of naming the same repo, so both
    // go through one selection and a second click on either closes the card again.
    // (No backticks anywhere in here: this whole script is a template literal.)
    if (svg) {
      svg.querySelectorAll('.node').forEach(function (n) {
        n.addEventListener('click', function () { pick(n.dataset.repo); });
        n.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(n.dataset.repo); }
        });
      });
    }
    chips.forEach(function (c) {
      c.addEventListener('click', function () { pick(c.dataset.repo); });
    });
  }

  var steps = Array.prototype.slice.call(document.querySelectorAll('.step'));
  if (!steps.length) return;
  var prev = document.getElementById('prev');
  var next = document.getElementById('next');
  var dots = Array.prototype.slice.call(document.querySelectorAll('.dots i'));
  var at = 0;
  function show (i) {
    at = Math.max(0, Math.min(steps.length - 1, i));
    steps.forEach(function (s, j) { s.hidden = j !== at; });
    dots.forEach(function (d, j) { d.classList.toggle('on', j === at); });
    prev.disabled = at === 0;
    next.disabled = at === steps.length - 1;
  }
  prev.addEventListener('click', function () { show(at - 1); });
  next.addEventListener('click', function () { show(at + 1); });
  dots.forEach(function (d, j) { d.addEventListener('click', function () { show(j); }); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowLeft') show(at - 1);
    if (ev.key === 'ArrowRight') show(at + 1);
  });
  show(0);
})();
`

export function renderDemo (model) {
  const s = model
  const c = s.counts
  const ex = s.example
  const org = s.orgs.length === 1 ? s.orgs[0] : s.orgs.join(', ')

  const walk = ex
    ? `<section class="panel">
  <h2>One work, end to end</h2>
  <p class="note">Every command, path, branch, base and pull-request number below is read out of
  <code>work/${esc(ex.id)}/work.json</code> — a work that really happened. Nothing here is a
  mock-up, which is the only reason it can be trusted not to drift from the tool.</p>
  <p class="lede"><strong>${esc(ex.title || ex.id)}</strong><br>
  ${(ex.tickets || []).map(esc).join(', ')}${(ex.tickets || []).length ? ' · ' : ''}${(ex.repos || []).length} repos · one branch <code>${esc(ex.branch)}</code></p>
  <div class="stepper">
    <button id="prev" type="button">← back</button>
    <button id="next" type="button">next →</button>
    <span class="dots">${s.steps.map((_, i) => `<i data-to="${i}"></i>`).join('')}</span>
  </div>
  ${renderSteps(s.steps)}
</section>
${renderPrs(ex)}`
    : '<section class="panel"><h2>One work, end to end</h2><p class="empty">No work in this data root has repos attached yet, so there is nothing to walk through.</p></section>'

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rig — what it is, on your repos</title>
<style>${STYLE}</style>
<h1><span class="tag">rig</span>One branch, several repos, and the part that outlives it</h1>
<header class="meta">
  <p>Generated <strong>${esc(s.generatedAt)}</strong> from ${s.root ? `the <strong>${esc(s.root)}</strong> data root` : 'a data root'}${org ? ` · ${esc(org)}` : ''}</p>
  <p>Everything on this page was read out of that root just now: <strong>${c.repos}</strong> catalogued
  repos, <strong>${c.edges}</strong> relationships between them, <strong>${c.works}</strong> recorded
  works, <strong>${c.crossRepo}</strong> of which spanned more than one repo${c.uncatalogued ? `, and <strong>${c.uncatalogued}</strong> repo${c.uncatalogued === 1 ? '' : 's'} named by a neighbour with no catalogue entry yet` : ''}.</p>
${s.outcome.landed ? `  <p class="outcome"><strong>${s.outcome.landed}</strong> of those works landed: a median of
  <strong>${span(s.outcome.cycleDays)}</strong> from the first commit to the last merge (n=${s.outcome.cycleN}),
  over a median of <strong>${s.outcome.reposPerWork}</strong> repo${s.outcome.reposPerWork === 1 ? '' : 's'} each.
  Read out of the pull requests those works actually merged — rig has no record of what you would
  have spent without it, so this page does not claim one.</p>` : ''}
</header>

<section class="panel">
  <h2>Three roots, and only one of them matters in a year</h2>
  <div class="roots">
    <div class="root"><b>the tool</b><span>A CLI. Generic, public, knows nothing about your systems.</span></div>
    <div class="root"><b>the data root</b><span>A private repo: this catalogue, the work records, the prose. Committed at every agreement point.</span></div>
    <div class="root"><b>the work root</b><span>Worktrees and mirrors. Disposable — deleting it loses nothing.</span></div>
  </div>
  <p class="note">The split is the whole idea. Branches get merged and worktrees get deleted;
  what you worked out about why the invoice push is shaped the way it is has to live somewhere
  that survives both.</p>
</section>

<section class="panel">
  <h2>What the catalogue already knows</h2>
  <p class="note">One file per repo, in the data root. Durable facts only — no branches, no
  paths, no status, because anything <code>git</code> or <code>gh</code> can answer is derived
  live rather than stored and left to rot. The load-bearing field is <code>talks_to</code>:
  choosing which repos a piece of work touches is graph traversal over these edges, and the
  repo you forget is almost always one hop from a repo you remembered.</p>
  ${renderGraph(s.graph)}
  <p class="hint">Click a repo to see what it talks to, and how.</p>
  ${renderUnlinked(s.unlinked)}
  ${repoCards(s.whole)}
</section>

${walk}

<section class="panel">
  <h2>How to read this page</h2>
  <p class="note">It is generated, not written — <code>rig demo</code> renders it from the data
  root every time, which is the only version of this that stays true. A hand-written demo is a
  second copy of the tool's command surface and starts disagreeing with it the same week.
  If something here looks wrong, the record is what is wrong, and the record is the thing worth
  fixing.</p>
</section>
<script>${SCRIPT}</script>
`
}
