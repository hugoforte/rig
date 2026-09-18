// The dashboard is pure: a payload in, statistics and HTML out. That is the whole reason it
// is a module of its own — the numbers shown to other people are checkable without a browser,
// a data root or a GitHub call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { percentile, median, isoWeek, reduceWork, summarize, renderDash, duration } from '../bin/dash.mjs'

const pr = (over = {}) => ({
  number: 1, state: 'MERGED', url: 'u',
  openedAt: '2026-03-02T09:00:00Z', mergedAt: '2026-03-03T09:00:00Z',
  firstReviewAt: null, approvedAt: null, ...over,
})
const repo = (over = {}) => ({
  repo: 'billing', org: 'acme', base: 'main', role: '', attachedAt: '2026-03-01T08:00:00Z',
  pr: pr(), firstCommitAt: '2026-03-01T09:00:00Z', ...over,
})
const work = (over = {}) => ({
  id: 'w', title: 'A work', type: 'feat', status: 'closed', branch: 'feat/w',
  createdAt: '2026-03-01T00:00:00Z', closedAt: null, activityAt: '2026-03-03T09:00:00Z',
  repos: [repo()], ...over,
})
const payload = (works, over = {}) => ({
  rig: '1.3.0', recordFormat: 1, generatedAt: '2026-03-10T12:00:00Z', live: true, works, ...over,
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

test('reduceWork: a work is merged only when every one of its repos is', () => {
  const half = reduceWork(work({
    repos: [repo(), repo({ repo: 'orders', pr: pr({ number: 2, state: 'OPEN', mergedAt: null }) })],
  }))
  assert.equal(half.merged, false, 'one PR still open is a work in flight')
  assert.equal(half.mergedAt, null)
  assert.equal(half.cycleHours, null, 'and it contributes to no cycle-time figure')
})

test('reduceWork: across repos the clock runs from the earliest commit to the last merge', () => {
  const w = reduceWork(work({
    repos: [
      repo({ firstCommitAt: '2026-03-01T09:00:00Z', pr: pr({ mergedAt: '2026-03-02T09:00:00Z' }) }),
      repo({ repo: 'orders', firstCommitAt: '2026-03-01T12:00:00Z', pr: pr({ number: 2, mergedAt: '2026-03-03T09:00:00Z' }) }),
    ],
  }))
  assert.equal(w.merged, true)
  assert.equal(w.firstCommitAt, '2026-03-01T09:00:00Z')
  assert.equal(w.mergedAt, '2026-03-03T09:00:00Z')
  assert.equal(w.cycleHours, 48)
  assert.equal(w.leadHours, 57, 'lead time starts at rig new, which is earlier than the code')
})

test('reduceWork: a work with no repos is never counted as merged', () => {
  const w = reduceWork(work({ repos: [] }))
  assert.equal(w.merged, false)
  assert.deepEqual(w.orgs, ['(no repos)'])
})

test('reduceWork: a work spanning two orgs belongs to both, never to a composite of them', () => {
  const w = reduceWork(work({ repos: [repo(), repo({ repo: 'ledger', org: 'other' })] }))
  assert.deepEqual(w.orgs.sort(), ['acme', 'other'])
  assert.ok(!w.orgs.some(o => o.includes('+')), 'no org named after a pair')
})

test('reduceWork: a refused lookup is flagged, not quietly counted as history', () => {
  const w = reduceWork(work({ repos: [{ ...repo(), pr: undefined, prUnknown: 'gh not found on PATH' }] }))
  assert.equal(w.unknown, true)
  assert.equal(w.merged, false)
})

test('summarize: orgs are kept apart and never summed', () => {
  const s = summarize(payload([
    work({ id: 'a' }),
    work({ id: 'b', repos: [repo({ org: 'other' })] }),
  ]))
  assert.deepEqual(s.orgs.map(o => o.org).sort(), ['acme', 'other'])
  assert.ok(!('total' in s) && !('merged' in s), 'no figure spans the orgs')
  for (const o of s.orgs) assert.equal(o.merged, 1)
})

test('summarize: --org narrows to one org rather than combining', () => {
  const s = summarize(payload([work({ id: 'a' }), work({ id: 'b', repos: [repo({ org: 'other' })] })]), { org: 'other' })
  assert.deepEqual(s.orgs.map(o => o.org), ['other'])
  assert.equal(s.only, 'other')
})

test('summarize: --since drops work merged before the window, and keeps what is in flight', () => {
  const old = work({ id: 'old', repos: [repo({ pr: pr({ mergedAt: '2026-01-01T00:00:00Z' }) })] })
  const flying = work({ id: 'flying', repos: [repo({ pr: pr({ state: 'OPEN', mergedAt: null }) })] })
  const s = summarize(payload([old, flying, work({ id: 'recent' })]), { since: '2026-02-01T00:00:00Z' })
  const [acme] = s.orgs
  assert.equal(acme.merged, 1, 'only the work merged inside the window')
  assert.equal(acme.inFlight, 1, 'unmerged work is not filtered out by a merge-date window')
})

test('summarize: the spread is reported by type, with n, never as one median', () => {
  const quick = () => work({ id: `q${Math.random()}`, type: 'chore', repos: [repo({ pr: pr({ mergedAt: '2026-03-01T10:00:00Z' }) })] })
  const s = summarize(payload([work(), work({ id: 'w2' }), quick(), quick()]))
  const [acme] = s.orgs
  const chore = acme.byType.find(t => t.type === 'chore')
  assert.equal(chore.n, 2)
  assert.equal(chore.median, 1, 'an hour, not the 48h of the feat works alongside it')
  assert.equal(acme.byType.find(t => t.type === 'feat').median, 48)
})

const phasesOf = org => Object.fromEntries(org.phases.map(p => [p.label, p]))

test('summarize: the phases only count the stretches GitHub can date', () => {
  const reviewed = work({
    id: 'reviewed',
    repos: [repo({ pr: pr({ firstReviewAt: '2026-03-02T15:00:00Z', approvedAt: '2026-03-03T08:00:00Z' }) })],
  })
  const [acme] = summarize(payload([reviewed, work({ id: 'never-reviewed' })])).orgs
  const byLabel = phasesOf(acme)
  assert.equal(byLabel['Before the PR'].n, 2, 'both works have a commit and an opened PR')
  assert.equal(byLabel['Waiting for a first look'].n, 1, 'only the reviewed one')
  assert.equal(byLabel['Waiting for a first look'].median, 6)
  assert.equal(byLabel['First look to approval'].median, 17)
  assert.equal(byLabel['Approval to merge'].median, 1)
})

test('summarize: a phase is measured inside one PR, never across two repos', () => {
  // Repo A was reviewed an hour after its PR opened. Repo B opened days earlier and was
  // never reviewed. Pairing B's opening with A's review reports a wait nobody had.
  const w = work({
    id: 'cross',
    repos: [
      repo({ pr: pr({ openedAt: '2026-03-05T09:00:00Z', firstReviewAt: '2026-03-05T10:00:00Z' }) }),
      repo({ repo: 'orders', pr: pr({ number: 2, openedAt: '2026-03-02T09:00:00Z' }) }),
    ],
  })
  const wait = phasesOf(summarize(payload([w])).orgs[0])['Waiting for a first look']
  assert.equal(wait.n, 1, 'only the PR that was reviewed')
  assert.equal(wait.median, 1, 'the hour that PR waited, not the three days the other one sat')
})

test('summarize: orgs of a cross-org work are both real orgs, and nothing is summed', () => {
  const s = summarize(payload([work({ id: 'both', repos: [repo(), repo({ repo: 'ledger', org: 'other' })] })]))
  assert.deepEqual(s.orgs.map(o => o.org).sort(), ['acme', 'other'])
  for (const o of s.orgs) assert.equal(o.merged, 1, 'the work is counted in full under each org')
  const narrowed = summarize(payload([work({ id: 'both', repos: [repo(), repo({ repo: 'ledger', org: 'other' })] })]), { org: 'acme' })
  assert.deepEqual(narrowed.orgs.map(o => o.org), ['acme'], '--org never renders a section for a pair')
})

test('summarize: a refused lookup is not a work in flight', () => {
  const refused = work({ id: 'refused', repos: [{ ...repo(), pr: undefined, prUnknown: 'gh not found on PATH' }] })
  const [acme] = summarize(payload([refused])).orgs
  assert.equal(acme.unknown, 1)
  assert.equal(acme.inFlight, 0, 'a rate limit is not a backlog')
})

test('summarize: a merged work with no first commit is named, not quietly dropped', () => {
  // The branch was deleted and GitHub would not answer for it: merged, but unmeasurable.
  const gone = work({ id: 'gone', repos: [repo({ firstCommitAt: null })] })
  const [acme] = summarize(payload([gone, work({ id: 'fine' })])).orgs
  assert.equal(acme.merged, 2)
  assert.equal(acme.cycle.n, 1, 'only one has both ends')
  assert.equal(acme.unmeasured, 1, 'and the difference is stated rather than left to the reader')
})

test('summarize: a week with nothing merged is a gap, not a missing column', () => {
  const at = iso => work({ id: `w${iso}`, repos: [repo({ pr: pr({ mergedAt: iso }) })] })
  const [acme] = summarize(payload([at('2026-03-02T09:00:00Z'), at('2026-03-23T09:00:00Z')])).orgs
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

test('renderDash: says when it was generated, and what the clocks mean', () => {
  const html = renderDash(payload([work()]))
  assert.match(html, /Generated <strong>2026-03-10T12:00:00Z<\/strong>/)
  assert.match(html, /read from GitHub at 2026-03-10T12:00:00Z/)
  assert.match(html, /Two clocks/)
  assert.match(html, /no pre-rig\s+period/, 'the page refuses the before-and-after claim')
})

test('renderDash: a --quick payload says nothing in it is live', () => {
  const html = renderDash(payload([work()], { live: false }))
  assert.match(html, /no PR state was looked up/)
  assert.doesNotMatch(html, /read from GitHub at/)
})

test('renderDash: a payload that never said it was live is not claimed to be', () => {
  const { live: _dropped, ...noClaim } = payload([work()])
  assert.doesNotMatch(renderDash(noClaim), /read from GitHub at/)
})

test('renderDash: both cycle figures carry their own n', () => {
  const html = renderDash(payload([work({ id: 'gone', repos: [repo({ firstCommitAt: null })] }), work()]))
  assert.match(html, /work opened → last PR merged:[\s\S]*?over 2 works/)
  assert.match(html, /first commit → last PR merged:[\s\S]*?over 1 work /)
  assert.match(html, /1 work merged with no first commit to measure from/)
})

test('renderDash: is self-contained — no network, no script', () => {
  const html = renderDash(payload([work()]))
  assert.doesNotMatch(html, /<script/i, 'nothing to execute')
  assert.doesNotMatch(html, /https?:\/\//i, 'nothing to fetch')
})

test('renderDash: a title with markup in it is escaped, not rendered', () => {
  const html = renderDash(payload([work({ id: '<img src=x onerror=alert(1)>' })]))
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img/)
})

test('renderDash: an empty payload renders a page rather than failing', () => {
  const html = renderDash(payload([]))
  assert.match(html, /No works matched/)
})

test('summarize: a window bounds what was merged, and says nothing about what is in flight', () => {
  const flying = work({ id: 'flying', repos: [repo({ pr: pr({ state: 'OPEN', mergedAt: null }) })] })
  const inside = summarize(payload([flying, work()]), { since: '2026-03-01T00:00:00Z' }).orgs[0]
  const outside = summarize(payload([flying, work()]), { since: '2026-06-01T00:00:00Z' }).orgs[0]
  assert.equal(inside.merged, 1)
  assert.equal(outside.merged, 0, 'the merge fell outside the window')
  assert.equal(outside.inFlight, 1, 'and the open work is still open, whatever the window')
})
