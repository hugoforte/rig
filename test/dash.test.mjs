// The dashboard is pure: a payload in, statistics and HTML out. That is the whole reason it
// is a module of its own — the numbers shown to other people are checkable without a browser,
// a data root or a GitHub call.
//
// The payload it is fed is the one machine-readable surface (DESIGN.md decision 55), and it
// comes out of `listPayload` itself rather than from a copy of it written out here. A copy
// drifts in silence — this file's had, through two record formats and two majors, and nothing
// failed — so what the fixtures below describe is the producer's *input*: the records `rig
// new`, `rig attach` and `rig close` write, and the pull requests GitHub has. Every payload
// in this file is produced from those.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { percentile, median, isoWeek, reduceWork, summarize, renderDash, duration } from '../bin/dash.mjs'
import { MAJOR, toolVersion } from '../bin/version.mjs'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRODUCER = pathToFileURL(path.join(SRC, 'bin', 'rig.mjs')).href

// ------------------------------------------------------- driving the producer

const temps = []
after(() => { for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

let scenario = 0

// One scenario's records on disk, read back through the real producer. Nothing is spawned
// and nothing is cloned: the worktrees are never made, so every repo reads as `missing` and
// no git command runs, and GitHub is the in-memory adapter the rest of the suite uses.
//
// A fresh module instance per call, because rig resolves its config and its GitHub adapter
// once per process and then holds them: a new instance is what keeps one scenario's data
// root and canned pull requests out of the next, and is what lets `github: 'missing'` be a
// run in which every lookup is refused.
async function produce (works, { live = true, github = 'ok' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-dash-'))
  temps.push(tmp)
  const dataRoot = path.join(tmp, 'data')
  const repos = {}
  // GitHub numbers a repo's pull requests, not the fixture: two works sharing a repo must not
  // share a number, or a timeline lookup on one answers with the other's.
  const numbers = {}
  for (const w of works) {
    const branch = `${w.type}/${w.id}`
    const attached = w.repos.map(r => ({ ...r, number: nextNumber(repos, numbers, `${r.org}/${r.repo}`) }))
    const dir = path.join(dataRoot, 'work', folderName(w.id))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'work.json'), JSON.stringify(record(w, attached, branch), null, 2))
    // A PR nobody recorded is one the producer has to look up, which is what the canned
    // GitHub answers. The first commit is read off that PR's commits, exactly as `gh` gives
    // it — the branch it would otherwise fall back to is in a worktree that does not exist.
    for (const r of attached.filter(r => r.pr && !r.recorded)) {
      const canned = { ...r.pr, number: r.number, branch, base: 'main', commits: [r.firstCommitAt].filter(Boolean) }
      repos[`${r.org}/${r.repo}`].prs.push(canned)
    }
  }
  const localConfig = path.join(tmp, 'rig.local.json')
  const githubState = path.join(tmp, 'github.json')
  fs.writeFileSync(githubState, JSON.stringify({ auth: github, repos }))
  fs.writeFileSync(localConfig, JSON.stringify({ dataRoot, workRoot: path.join(tmp, 'w') }))
  process.env.RIG_LOCAL_CONFIG = localConfig
  process.env.RIG_FAKE_GITHUB = githubState
  const { config, listPayload } = await import(`${PRODUCER}?scenario=${++scenario}`)
  return listPayload(config(), live)
}

// A record's folder is named for the filesystem; the `id` inside it is what every surface
// renders. They are the same string for every work rig makes — the escaping test below is
// the one place they part, because Windows will not take `<` in a directory name.
const folderName = id => id.replace(/[^a-zA-Z0-9._-]+/g, '_')

// The next number GitHub would give this repo's pull requests, and the canned repo to hang
// them on.
function nextNumber (repos, numbers, key) {
  repos[key] ||= { prs: [] }
  return (numbers[key] = (numbers[key] || 0) + 1)
}

const record = (w, attached, branch) => ({
  id: w.id,
  title: w.title,
  tickets: [],
  type: w.type,
  branch,
  createdAt: w.createdAt,
  ...(w.closedAt ? { closedAt: w.closedAt } : {}),
  repos: attached.map(r => ({
    repo: r.repo,
    org: r.org,
    role: '',
    attachedAt: r.attachedAt,
    branches: [{ branch, base: 'main', ...(r.recorded ? { pr: terminalFacts(r) } : {}) }],
  })),
})

// What `rig close` and `rig backfill` store once a PR is merged (decision 60) — the terminal
// facts, in the record, which the producer reads back with no lookup at all.
const terminalFacts = r => ({
  number: r.number,
  url: r.pr.url,
  openedAt: r.pr.openedAt,
  firstCommitAt: r.firstCommitAt,
  firstReviewAt: reviewedAt(r.pr),
  approvedAt: reviewedAt(r.pr, 'APPROVED'),
  mergedAt: r.pr.mergedAt,
})

const reviewedAt = (pull, state) => (pull.reviews || [])
  .filter(review => !state || review.state === state)
  .map(review => review.submittedAt).filter(Boolean).sort()[0] ?? null

// ------------------------------------------------------------------ fixtures

// A pull request as GitHub has it. `reviews` is what the review clocks are read from: the
// earliest submitted one is the first look, the earliest approval the approval.
const pr = (over = {}) => ({
  state: 'MERGED', url: 'u',
  openedAt: '2026-03-02T09:00:00Z', mergedAt: '2026-03-03T09:00:00Z', reviews: [], ...over,
})

// One repo of the work, as `rig attach` records it, plus the pull request its branch carries.
// `recorded: true` is the backfilled kind — the merged PR's facts stored in the record rather
// than looked up, which is the other route into the same payload.
const repo = (over = {}) => ({
  repo: 'billing', org: 'acme', attachedAt: '2026-03-01T08:00:00Z',
  firstCommitAt: '2026-03-01T09:00:00Z', pr: pr(), recorded: false, ...over,
})

const work = (over = {}) => ({
  id: 'w', title: 'A work', type: 'feat',
  createdAt: '2026-03-01T00:00:00Z', repos: [repo()], ...over,
})

const soleWork = payload => payload.works[0]
const workById = (payload, id) => payload.works.find(w => w.id === id)

// --------------------------------------------------------------------- tests

test('the payload names the tool that wrote it, and the record format it wrote', async () => {
  // The drift this file was rewritten for: a hand-written payload said `recordFormat: 1` and
  // `rig: '1.3.0'` for two majors, and nothing could notice.
  const p = await produce([work()])
  assert.equal(p.recordFormat, MAJOR, 'the record format is the major version (ADR 0002)')
  assert.equal(p.rig, toolVersion(JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'))))
})

test('percentile: nearest-rank, so every figure printed is one that happened', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(percentile(xs, 90), 9)
  assert.equal(median(xs), 5, 'the lower of the two middles, never their average')
  assert.equal(percentile([4], 90), 4, 'a single value is its own p90')
  assert.equal(percentile([], 50), null, 'nothing measured is not zero')
})

test('isoWeek: Monday-based, and the year comes from the Thursday', () => {
  assert.equal(isoWeek('2026-09-18T12:00:00Z'), '2026-W38')
  assert.equal(isoWeek('2026-09-14T00:00:00Z'), '2026-W38', 'the Monday of the same week')
  assert.equal(isoWeek('2026-09-13T23:00:00Z'), '2026-W37', 'the Sunday before it')
  assert.equal(isoWeek(null), null)
})

test('reduceWork: a work is merged only when every one of its repos is', async () => {
  const p = await produce([work({
    repos: [repo(), repo({ repo: 'orders', pr: pr({ state: 'OPEN', mergedAt: null }) })],
  })])
  const half = reduceWork(soleWork(p))
  assert.equal(half.merged, false, 'one PR still open is a work in flight')
  assert.equal(half.mergedAt, null)
  assert.equal(half.cycleHours, null, 'and it contributes to no cycle-time figure')
})

test('reduceWork: across repos the clock runs from the earliest commit to the last merge', async () => {
  const p = await produce([work({
    repos: [
      repo({ firstCommitAt: '2026-03-01T09:00:00Z', pr: pr({ mergedAt: '2026-03-02T09:00:00Z' }) }),
      repo({ repo: 'orders', firstCommitAt: '2026-03-01T12:00:00Z', pr: pr({ mergedAt: '2026-03-03T09:00:00Z' }) }),
    ],
  })])
  const w = reduceWork(soleWork(p))
  assert.equal(w.merged, true)
  assert.equal(w.firstCommitAt, '2026-03-01T09:00:00Z')
  assert.equal(w.mergedAt, '2026-03-03T09:00:00Z')
  assert.equal(w.cycleHours, 48)
  assert.equal(w.leadHours, 57, 'lead time starts at rig new, which is earlier than the code')
})

test('reduceWork: a work with no repos is never counted as merged', async () => {
  const w = reduceWork(soleWork(await produce([work({ repos: [] })])))
  assert.equal(w.merged, false)
  assert.deepEqual(w.orgs, ['(no repos)'])
})

test('reduceWork: a work spanning two orgs belongs to both, never to a composite of them', async () => {
  const p = await produce([work({ repos: [repo(), repo({ repo: 'ledger', org: 'other' })] })])
  const w = reduceWork(soleWork(p))
  assert.deepEqual(w.orgs.sort(), ['acme', 'other'])
  assert.ok(!w.orgs.some(o => o.includes('+')), 'no org named after a pair')
})

test('reduceWork: a refused lookup is flagged, not quietly counted as history', async () => {
  // gh is not on PATH at all, so the producer has nothing to put in `pr` and says why.
  const w = reduceWork(soleWork(await produce([work()], { github: 'missing' })))
  assert.equal(w.unknown, true)
  assert.equal(w.merged, false)
})

test('summarize: orgs are kept apart and never summed', async () => {
  const s = summarize(await produce([
    work({ id: 'a' }),
    work({ id: 'b', repos: [repo({ org: 'other' })] }),
  ]))
  assert.deepEqual(s.orgs.map(o => o.org).sort(), ['acme', 'other'])
  assert.ok(!('total' in s) && !('merged' in s), 'no figure spans the orgs')
  for (const o of s.orgs) assert.equal(o.merged, 1)
})

test('summarize: --org narrows to one org rather than combining', async () => {
  const p = await produce([work({ id: 'a' }), work({ id: 'b', repos: [repo({ org: 'other' })] })])
  const s = summarize(p, { org: 'other' })
  assert.deepEqual(s.orgs.map(o => o.org), ['other'])
  assert.equal(s.only, 'other')
})

test('summarize: --since drops work merged before the window, and keeps what is in flight', async () => {
  const p = await produce([
    work({ id: 'old', repos: [repo({ pr: pr({ mergedAt: '2026-01-01T00:00:00Z' }) })] }),
    work({ id: 'flying', repos: [repo({ pr: pr({ state: 'OPEN', mergedAt: null }) })] }),
    work({ id: 'recent' }),
  ])
  const [acme] = summarize(p, { since: '2026-02-01T00:00:00Z' }).orgs
  assert.equal(acme.merged, 1, 'only the work merged inside the window')
  assert.equal(acme.inFlight, 1, 'unmerged work is not filtered out by a merge-date window')
})

test('summarize: the spread is reported by type, with n, never as one median', async () => {
  const quick = id => work({ id, type: 'chore', repos: [repo({ pr: pr({ mergedAt: '2026-03-01T10:00:00Z' }) })] })
  const p = await produce([work(), work({ id: 'w2' }), quick('q1'), quick('q2')])
  const [acme] = summarize(p).orgs
  const chore = acme.byType.find(t => t.type === 'chore')
  assert.equal(chore.n, 2)
  assert.equal(chore.median, 1, 'an hour, not the 48h of the feat works alongside it')
  assert.equal(acme.byType.find(t => t.type === 'feat').median, 48)
})

const phasesOf = org => Object.fromEntries(org.phases.map(p => [p.label, p]))

test('summarize: the phases only count the stretches GitHub can date', async () => {
  const reviewed = work({
    id: 'reviewed',
    repos: [repo({
      pr: pr({
        reviews: [
          { submittedAt: '2026-03-02T15:00:00Z' },
          { state: 'APPROVED', submittedAt: '2026-03-03T08:00:00Z' },
        ],
      }),
    })],
  })
  const [acme] = summarize(await produce([reviewed, work({ id: 'never-reviewed' })])).orgs
  const byLabel = phasesOf(acme)
  assert.equal(byLabel['Before the PR'].n, 2, 'both works have a commit and an opened PR')
  assert.equal(byLabel['Waiting for a first look'].n, 1, 'only the reviewed one')
  assert.equal(byLabel['Waiting for a first look'].median, 6)
  assert.equal(byLabel['First look to approval'].median, 17)
  assert.equal(byLabel['Approval to merge'].median, 1)
})

test('summarize: a phase is measured inside one PR, never across two repos', async () => {
  // Repo A was reviewed an hour after its PR opened. Repo B opened days earlier and was
  // never reviewed. Pairing B's opening with A's review reports a wait nobody had.
  const p = await produce([work({
    id: 'cross',
    repos: [
      repo({ pr: pr({ openedAt: '2026-03-05T09:00:00Z', reviews: [{ submittedAt: '2026-03-05T10:00:00Z' }] }) }),
      repo({ repo: 'orders', pr: pr({ openedAt: '2026-03-02T09:00:00Z' }) }),
    ],
  })])
  const wait = phasesOf(summarize(p).orgs[0])['Waiting for a first look']
  assert.equal(wait.n, 1, 'only the PR that was reviewed')
  assert.equal(wait.median, 1, 'the hour that PR waited, not the three days the other one sat')
})

test('summarize: orgs of a cross-org work are both real orgs, and nothing is summed', async () => {
  const p = await produce([work({ id: 'both', repos: [repo(), repo({ repo: 'ledger', org: 'other' })] })])
  const s = summarize(p)
  assert.deepEqual(s.orgs.map(o => o.org).sort(), ['acme', 'other'])
  for (const o of s.orgs) assert.equal(o.merged, 1, 'the work is counted in full under each org')
  const narrowed = summarize(p, { org: 'acme' })
  assert.deepEqual(narrowed.orgs.map(o => o.org), ['acme'], '--org never renders a section for a pair')
})

test('summarize: a refused lookup is not a work in flight', async () => {
  const [acme] = summarize(await produce([work({ id: 'refused' })], { github: 'missing' })).orgs
  assert.equal(acme.unknown, 1)
  assert.equal(acme.inFlight, 0, 'a rate limit is not a backlog')
})

test('summarize: a merged work with no first commit is named, not quietly dropped', async () => {
  // The branch was deleted and GitHub would not answer for it: merged, but unmeasurable.
  const p = await produce([work({ id: 'gone', repos: [repo({ firstCommitAt: null })] }), work({ id: 'fine' })])
  const [acme] = summarize(p).orgs
  assert.equal(acme.merged, 2)
  assert.equal(acme.cycle.n, 1, 'only one has both ends')
  assert.equal(acme.unmeasured, 1, 'and the difference is stated rather than left to the reader')
})

test('summarize: a week with nothing merged is a gap, not a missing column', async () => {
  const at = (id, iso) => work({ id, repos: [repo({ pr: pr({ mergedAt: iso }) })] })
  const p = await produce([at('early', '2026-03-02T09:00:00Z'), at('late', '2026-03-23T09:00:00Z')])
  const [acme] = summarize(p).orgs
  assert.deepEqual(acme.perWeek, [
    { week: '2026-W10', n: 1 },
    { week: '2026-W11', n: 0 },
    { week: '2026-W12', n: 0 },
    { week: '2026-W13', n: 1 },
  ], 'three weeks apart reads as three weeks apart')
})

test('duration: units people can hold in their head', () => {
  assert.equal(duration(0.5), '30m')
  assert.equal(duration(3.25), '3.3h')
  assert.equal(duration(23.6), '24h')
  assert.equal(duration(72), '3.0d')
  assert.equal(duration(null), '—', 'nothing measured is a dash, never a zero')
})

test('renderDash: says when it was generated, and what the clocks mean', async () => {
  const p = await produce([work()])
  const html = renderDash(p)
  assert.ok(html.includes(`Generated <strong>${p.generatedAt}</strong>`))
  assert.ok(html.includes(`read from GitHub at ${p.generatedAt}`))
  assert.match(html, /Two clocks/)
  assert.match(html, /no pre-rig\s+period/, 'the page refuses the before-and-after claim')
})

test('renderDash: a --quick payload says nothing in it is live', async () => {
  const html = renderDash(await produce([work()], { live: false }))
  assert.match(html, /no PR state was looked up/)
  assert.doesNotMatch(html, /read from GitHub at/)
})

test('renderDash: a --quick payload carrying a recorded PR does not say nothing here is live', async () => {
  const backfilled = work({ id: 'backfilled', closedAt: '2026-03-04T00:00:00Z', repos: [repo({ recorded: true })] })
  const html = renderDash(await produce([backfilled], { live: false }))
  assert.match(html, /merged work is read from the records, which cannot change/)
  assert.doesNotMatch(html, /nothing here is live/)
  assert.doesNotMatch(html, /read from GitHub at/, 'still not claimed to be live')
})

test('renderDash: a payload that never said it was live is not claimed to be', async () => {
  // A payload from before the flag existed: absent is not `false`, and neither is live.
  const { live: _dropped, ...noClaim } = await produce([work()])
  assert.doesNotMatch(renderDash(noClaim), /read from GitHub at/)
})

test('renderDash: both cycle figures carry their own n', async () => {
  const p = await produce([work({ id: 'gone', repos: [repo({ firstCommitAt: null })] }), work()])
  const html = renderDash(p)
  assert.match(html, /work opened → last PR merged:[\s\S]*?over 2 works/)
  assert.match(html, /first commit → last PR merged:[\s\S]*?over 1 work /)
  assert.match(html, /1 work merged with no first commit to measure from/)
})

test('renderDash: is self-contained — no network, no script', async () => {
  const html = renderDash(await produce([work()]))
  assert.doesNotMatch(html, /<script/i, 'nothing to execute')
  assert.doesNotMatch(html, /https?:\/\//i, 'nothing to fetch')
})

test('renderDash: an id with markup in it is escaped, not rendered', async () => {
  const html = renderDash(await produce([work({ id: '<img src=x onerror=alert(1)>' })]))
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img/)
})

test('renderDash: an empty payload renders a page rather than failing', async () => {
  assert.match(renderDash(await produce([])), /No works matched/)
})

test('summarize: a window bounds what was merged, and says nothing about what is in flight', async () => {
  const p = await produce([
    work({ id: 'flying', repos: [repo({ pr: pr({ state: 'OPEN', mergedAt: null }) })] }),
    work(),
  ])
  const inside = summarize(p, { since: '2026-03-01T00:00:00Z' }).orgs[0]
  const outside = summarize(p, { since: '2026-06-01T00:00:00Z' }).orgs[0]
  assert.equal(inside.merged, 1)
  assert.equal(outside.merged, 0, 'the merge fell outside the window')
  assert.equal(outside.inFlight, 1, 'and the open work is still open, whatever the window')
})

test('reduceWork: a recorded PR counts as merged, exactly as a freshly looked-up one does', async () => {
  // `state` is not in the record — only a merged PR is ever recorded — so the producer puts
  // it back, and this is what asserts it did: without it, every closed work reads as in
  // flight and leaves the cycle-time figures.
  const p = await produce([
    work({ id: 'looked-up' }),
    work({ id: 'backfilled', closedAt: '2026-03-04T00:00:00Z', repos: [repo({ recorded: true })] }),
  ])
  assert.equal(workById(p, 'backfilled').repos[0].pr.recorded, true, 'read back from the record, not asked for')
  const recorded = reduceWork(workById(p, 'backfilled'))
  assert.equal(recorded.merged, true)
  assert.equal(recorded.mergedAt, '2026-03-03T09:00:00Z')
  assert.equal(recorded.cycleHours, 48)
  const lookedUp = reduceWork(workById(p, 'looked-up'))
  assert.deepEqual({ ...recorded, id: '' }, { ...lookedUp, id: '' }, 'a record and a lookup reduce identically')
})
