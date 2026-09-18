// The dashboard, as pure functions: a `rig list --json` payload in, statistics and one
// self-contained HTML page out. Nothing here reads a record, spawns a process or touches the
// filesystem — `cmds.dash` in rig.mjs does that, and this module is testable without either.
//
// The page is meant to be shown to other people, which is the whole reason for the rules it
// enforces rather than remembers:
//
//   - no cross-org total, ever. Works on the tool itself and works for an employer are not
//     one number, and a combined figure is the fastest way to be dismissed.
//   - median AND p90, split by type. The data is bimodal — a dependabot bump and a feature
//     are both "a work" — so a lone median is an artifact of what got counted.
//   - `n` beside every statistic. A median of three is not a median.
//   - "since rig", never "faster than before". No pre-rig period exists in the records, so
//     the comparative claim is not one this page can support.
//   - when it was generated, in the header. A silently stale PR badge is worse than none.
//
// Zero dependencies holds here too: no chart library, no CDN, no script tag. Bars are divs
// with a width. The page has to open from a file:// URL on a machine with no network.

const HOUR = 3600000

// ---------------------------------------------------------------- statistics

const asDate = iso => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(+d) ? null : d
}
const hoursBetween = (from, to) => {
  const a = asDate(from)
  const b = asDate(to)
  if (!a || !b) return null
  const h = (b - a) / HOUR
  return Number.isFinite(h) && h >= 0 ? h : null
}

// Nearest-rank, so every value printed is a value that happened. Interpolating between two
// works and reporting the result as a duration invents a work that does not exist.
export function percentile (values, p) {
  const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}
export const median = values => percentile(values, 50)

// The ISO week a moment falls in, as `2026-W38`. Weeks, not months, because the whole record
// is weeks long; and ISO because its weeks start on Monday and do not drift.
export function isoWeek (iso) {
  const d = asDate(iso)
  if (!d) return null
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  // Thursday decides the year, which is what stops the last days of December landing in
  // week 1 of the wrong year.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// Timestamps are compared as moments, not as strings: git writes `%aI` with the author's own
// UTC offset while GitHub answers in Z, so `+02:00` sorts after `Z` for a moment an hour
// earlier. One payload carries both.
const byMoment = (a, b) => new Date(a) - new Date(b)
const earliest = xs => xs.filter(Boolean).sort(byMoment)[0] || null
const latest = xs => xs.filter(Boolean).sort(byMoment).pop() || null

// One work, reduced to the moments that matter. A work spans repos, so its start is the
// earliest first commit and its end the latest merge: it is not finished while one PR is open.
export function reduceWork (work) {
  const repos = work.repos || []
  const prs = repos.map(r => r.pr).filter(Boolean)
  const orgs = [...new Set(repos.map(r => r.org).filter(Boolean))]

  const merged = repos.length > 0 && prs.length === repos.length && prs.every(p => p.state === 'MERGED')
  const firstCommitAt = earliest(repos.map(r => r.firstCommitAt))
  const mergedAt = merged ? latest(prs.map(p => p.mergedAt)) : null

  return {
    id: work.id,
    createdAt: work.createdAt || null,
    type: work.type || 'other',
    // Every org the work touched. A work spanning two orgs belongs to both and is counted
    // under each — never to a third, invented org named after the pair.
    orgs: orgs.length ? orgs : ['(no repos)'],
    repoCount: repos.length,
    merged,
    firstCommitAt,
    mergedAt,
    // Each phase belongs to a pull request, so each is measured inside one. Taking the
    // earliest `openedAt` of one repo and the earliest `firstReviewAt` of another and calling
    // the difference "review wait" reports a delay that nobody experienced.
    prs: repos.filter(r => r.pr).map(r => ({
      firstCommitAt: r.firstCommitAt || null,
      openedAt: r.pr.openedAt || null,
      firstReviewAt: r.pr.firstReviewAt || null,
      approvedAt: r.pr.approvedAt || null,
      mergedAt: r.pr.mergedAt || null,
    })),
    cycleHours: merged ? hoursBetween(firstCommitAt, mergedAt) : null,
    // When the work was decided on, not when its code first existed. For a workflow that
    // commits and opens the PR in the same minute, the first commit is a poor start line:
    // the design happened before it, and `rig new` is the moment that dates that.
    leadHours: merged ? hoursBetween(work.createdAt, mergedAt) : null,
    // A lookup GitHub refused is not a work with no history, and must not be counted as one
    // — in flight least of all, which would read as a backlog that does not exist.
    unknown: repos.some(r => r.prUnknown || r.firstCommitAtUnknown || r.prTimelineUnknown),
  }
}

const bucket = (rows, key) => rows.reduce((acc, row) => {
  const k = key(row)
  if (k === null || k === undefined) return acc
  ;(acc[k] = acc[k] || []).push(row)
  return acc
}, {})

const spread = (rows, field = 'cycleHours') => {
  const hours = rows.map(r => r[field]).filter(Number.isFinite)
  return { n: hours.length, median: median(hours), p90: percentile(hours, 90) }
}

// Every week between the first merge and the last, so a fortnight with nothing in it is a
// gap on the chart rather than two productive weeks drawn side by side.
function weeksFrom (done) {
  const dates = done.map(w => w.mergedAt).filter(Boolean).sort(byMoment)
  if (!dates.length) return []
  const counts = {}
  for (const w of done) counts[isoWeek(w.mergedAt)] = (counts[isoWeek(w.mergedAt)] || 0) + 1
  const weeks = []
  for (const at = new Date(dates[0]), end = new Date(dates[dates.length - 1]); at <= end; at.setUTCDate(at.getUTCDate() + 7)) {
    const week = isoWeek(at.toISOString())
    if (!weeks.some(w => w.week === week)) weeks.push({ week, n: counts[week] || 0 })
  }
  const last = isoWeek(dates[dates.length - 1])
  if (!weeks.some(w => w.week === last)) weeks.push({ week: last, n: counts[last] || 0 })
  return weeks
}

// Everything the page shows, per org. Works are never summed across orgs — see the header
// comment; `only` narrows to one org instead.
export function summarize (payload, { org: only, since } = {}) {
  const all = (payload.works || []).map(reduceWork)
  const kept = all.filter(w => (!only || w.orgs.includes(only)) &&
    (!since || !w.mergedAt || w.mergedAt >= since))

  // A work belongs to every org it touched, so a cross-repo work appears under each. Nothing
  // is ever summed across the sections, which is what makes counting it twice honest. Asking
  // for one org gives one section: a work that also touched another is shown here in full,
  // and the other org's section is simply not drawn.
  const byOrg = {}
  for (const w of kept) for (const org of w.orgs) {
    if (only && org !== only) continue
    ;(byOrg[org] = byOrg[org] || []).push(w)
  }

  const orgs = Object.entries(byOrg).map(([name, works]) => {
    const done = works.filter(w => w.merged)
    const cycle = spread(done)
    return {
      org: name,
      works: works.length,
      merged: done.length,
      // A refused lookup is not a work in flight. Counting it as one turns a rate limit
      // into a backlog.
      inFlight: works.filter(w => !w.merged && !w.unknown).length,
      unknown: works.filter(w => w.unknown).length,
      // Merged, but with no first commit to measure from — a deleted branch GitHub would
      // not answer for. Named, because it is the difference between the two denominators.
      unmeasured: done.length - cycle.n,
      perWeek: weeksFrom(done),
      byType: Object.entries(bucket(done, w => w.type))
        .map(([type, rows]) => ({ type, ...spread(rows) })).sort((a, b) => b.n - a.n),
      cycle,
      lead: spread(done, 'leadHours'),
      // Where the time went, measured inside each pull request. Split so a slow figure can be
      // attributed rather than worn: before the PR existed is yours, after it is shared.
      phases: [
        ['Before the PR', 'firstCommitAt', 'openedAt'],
        ['Waiting for a first look', 'openedAt', 'firstReviewAt'],
        ['First look to approval', 'firstReviewAt', 'approvedAt'],
        ['Approval to merge', 'approvedAt', 'mergedAt'],
      ].map(([label, from, to]) => {
        const hours = done.flatMap(w => w.prs.map(p => hoursBetween(p[from], p[to]))).filter(Number.isFinite)
        return { label, n: hours.length, median: median(hours), p90: percentile(hours, 90) }
      }),
      repoSpread: Object.entries(bucket(works, w => w.repoCount))
        .map(([repos, rows]) => ({ repos: Number(repos), n: rows.length })).sort((a, b) => a.repos - b.repos),
      recent: done.slice().sort((a, b) => byMoment(b.mergedAt, a.mergedAt)).slice(0, 12),
    }
  }).sort((a, b) => b.merged - a.merged || b.works - a.works)

  return {
    generatedAt: payload.generatedAt || null,
    // A payload with no `live` key is one this page knows nothing about, and must not claim
    // was read from GitHub.
    live: payload.live === true,
    // A `--quick` payload can still carry real PR data — `repoEntryJson` emits a stored
    // record (`recorded: true`) with no lookup, `--quick` included. "Nothing here is live"
    // would be false for that payload, so the header needs to tell the two `!live` cases
    // apart; read straight off the payload, since `reduceWork` does not keep the flag.
    recorded: (payload.works || []).some(w => (w.repos || []).some(r => r.pr?.recorded)),
    rig: payload.rig,
    only,
    since,
    orgs,
  }
}

// ---------------------------------------------------------------- rendering

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

// Durations people can hold in their head. Two significant figures is already more precision
// than a sample of nine supports.
export function duration (hours) {
  if (!Number.isFinite(hours)) return '—'
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`
  return `${(hours / 24).toFixed(1)}d`
}

const bar = (n, max) => `<span class="bar" style="width:${max ? Math.max(2, Math.round((n / max) * 100)) : 0}%"></span>`

const statCells = s => `<td class="n">${s.n}</td><td>${duration(s.median)}</td><td>${duration(s.p90)}</td>`

// `stats` tables size to their content, so a count and its median sit beside the label they
// belong to instead of at opposite edges of the page.
const table = (head, rows, cls = '') => rows.length
  ? `<table class="${cls}"><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
  : '<p class="empty">Nothing to show yet.</p>'

function orgSection (o) {
  const busiest = Math.max(1, ...o.perWeek.map(w => w.n))
  const weeks = o.perWeek.map(w =>
    `<tr><th>${esc(w.week)}</th><td class="barcell">${bar(w.n, busiest)}</td><td class="n">${w.n}</td></tr>`)
  const types = o.byType.map(t => `<tr><th>${esc(t.type)}</th>${statCells(t)}</tr>`)
  const phases = o.phases.map(p => `<tr><th>${esc(p.label)}</th>${statCells(p)}</tr>`)
  const spreadRows = o.repoSpread.map(r =>
    `<tr><th>${r.repos} repo${r.repos === 1 ? '' : 's'}</th><td class="n">${r.n}</td></tr>`)
  const recent = o.recent.map(w => `<tr><th>${esc(w.id)}</th><td>${esc(w.type)}</td>` +
    `<td>${esc((w.mergedAt || '').slice(0, 10))}</td><td>${duration(w.cycleHours)}</td></tr>`)

  const works = n => `${n} work${n === 1 ? '' : 's'}`
  const lede = [
    `<p class="lede"><span class="count">${o.merged}</span> merged · ${o.inFlight} in flight`,
    o.unknown ? ` · <span class="warn">${o.unknown} with a lookup GitHub refused</span>` : '',
    `<br>work opened → last PR merged: <strong>${duration(o.lead.median)}</strong> median, `,
    `${duration(o.lead.p90)} p90, over ${works(o.lead.n)}`,
    `<br>first commit → last PR merged: <strong>${duration(o.cycle.median)}</strong> median, `,
    `${duration(o.cycle.p90)} p90, over ${works(o.cycle.n)}`,
    // The two denominators differ whenever a merged work's branch is gone, and a median of
    // one printed beside a count of six is the quietest way to mislead on this page.
    o.unmeasured ? ` <span class="warn">(${works(o.unmeasured)} merged with no first commit to measure from)</span>` : '',
    '</p>',
  ].join('')

  return `<section>
  <h2>${esc(o.org)}</h2>
  ${lede}

  <h3>Merged per week</h3>
  ${table(['Week', '', 'n'], weeks)}

  <h3>Cycle time by type</h3>
  <p class="note">Split because a lockfile bump and a feature are both “a work”. One median
  across both is an artifact of what got counted.</p>
  ${table(['Type', 'n', 'Median', 'p90'], types, 'stats')}

  <h3>Where the time went</h3>
  <p class="note">Measured inside each pull request, not across a work — so a cross-repo work
  contributes one row per PR. Only the stretches GitHub can date: a PR nobody reviewed has no
  review row at all, which is why the counts differ.</p>
  ${table(['Phase', 'n', 'Median', 'p90'], phases, 'stats')}

  <h3>Repos per work</h3>
  ${table(['Span', 'n'], spreadRows, 'stats')}

  <h3>Most recently merged</h3>
  ${table(['Work', 'Type', 'Merged', 'Cycle'], recent)}
</section>`
}

// Dark by default — a page opened from a file:// URL with no stated preference should look
// like the terminal it was asked for from, not like a printout. The light variant is the
// override, for the one machine whose OS says so.
const STYLE = `
:root {
  color-scheme: dark;
  --bg: #12201a; --panel: #18291f; --raise: #1e3a2b; --edge: #2b4634;
  --text: #e6efe8; --dim: #8ba795;
  --accent: #e0559a; --good: #3ec98a; --amber: #e8b93a; --link: #6aa9e0;
  --bar-from: #2f8f68; --bar-to: #3ec98a;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #fbfdfb; --panel: #f2f6f3; --raise: #e7efe9; --edge: #d3e0d7;
    --text: #16241c; --dim: #5d7767;
    --accent: #b5246c; --good: #1d7d55; --amber: #9a6f00; --link: #2a6aa8;
    --bar-from: #7fd0aa; --bar-to: #2f8f68;
  }
}
* { box-sizing: border-box; }
body {
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg); color: var(--text);
  margin: 0 auto; max-width: 64rem; padding: 2.5rem 1.5rem 5rem;
  -webkit-font-smoothing: antialiased;
}
h1 { margin: 0; font-size: 1.5rem; font-weight: 600; letter-spacing: -.01em; }
h1 .tag {
  display: inline-block; margin-right: .5rem; padding: .1rem .45rem; vertical-align: .12em;
  border-radius: 5px; background: var(--accent); color: #fff;
  font: 600 .7rem/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .04em;
}
h2 {
  margin: 0 0 .1rem; font-size: 1.15rem; font-weight: 600; letter-spacing: -.01em;
  display: flex; align-items: center; gap: .5rem;
}
h2::before { content: ""; width: .55rem; height: .55rem; border-radius: 50%; background: var(--accent); flex: none; }
h3 {
  margin: 1.6rem 0 .3rem; font-size: .7rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: .09em; color: var(--dim);
}
section { background: var(--panel); border: 1px solid var(--edge); border-radius: 12px; padding: 1.25rem 1.4rem 1.5rem; margin-top: 1.25rem; }
table { border-collapse: collapse; width: 100%; margin: .2rem 0 0; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: .38rem .55rem; border-bottom: 1px solid var(--edge); }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover th, tbody tr:hover td { background: var(--raise); }
tbody tr:first-child th { border-top-left-radius: 7px; } tbody tr:first-child td:last-child { border-top-right-radius: 7px; }
thead th {
  font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em;
  color: var(--dim); border-bottom-color: var(--edge);
}
tbody th { font-weight: 500; }
td.n { width: 3.5rem; }
table.stats { width: auto; min-width: min(30rem, 100%); }
table.stats th:not(:first-child), table.stats td { text-align: right; }
table.stats td, table.stats thead th:not(:first-child) { padding-left: 1.6rem; }
td.barcell { width: 58%; }
.bar { display: block; height: .55rem; border-radius: 999px; background: linear-gradient(90deg, var(--bar-from), var(--bar-to)); }
.lede { margin: .5rem 0 0; color: var(--dim); font-size: .92rem; }
.lede strong { color: var(--text); font-size: 1.05rem; font-weight: 600; }
.lede .count { color: var(--good); font-weight: 600; }
.note, .empty, .caveats { color: var(--dim); font-size: .82rem; }
.note { margin: .15rem 0 .5rem; }
.warn { color: var(--amber); }
code { background: var(--raise); border: 1px solid var(--edge); border-radius: 5px; padding: .05rem .3rem; font: .85em ui-monospace, SFMono-Regular, Consolas, monospace; }
header.meta { background: var(--panel); border: 1px solid var(--edge); border-radius: 12px; padding: 1rem 1.25rem; margin-top: 1.1rem; }
header.meta p { margin: .35rem 0; font-size: .82rem; color: var(--dim); }
header.meta p:first-child { color: var(--text); }
header.meta strong { color: var(--link); font-weight: 500; }
header.meta em { font-style: normal; color: var(--text); }
.caveats { padding-left: 1.1rem; margin: .3rem 0 0; }
.caveats li { margin: .35rem 0; }
`

export function renderDash (payload, opts = {}) {
  const s = summarize(payload, opts)
  const scope = s.only ? `${s.only}` : 'every org, each on its own'
  const stale = s.live
    ? `PR state was read from GitHub at ${esc(s.generatedAt)}. It is right as of then and not after.`
    : s.recorded
      ? 'Generated with <code>--quick</code>: merged work is read from the records, which cannot change; nothing in flight was looked up.'
      : 'Generated with <code>--quick</code>: no PR state was looked up, so nothing here is live.'

  return `<!doctype html>
<meta charset="utf-8">
<title>rig — throughput and cycle time</title>
<style>${STYLE}</style>
<h1><span class="tag">rig</span>Throughput and cycle time</h1>
<header class="meta">
  <p>Generated <strong>${esc(s.generatedAt)}</strong> by rig ${esc(s.rig || '')} · scope: ${esc(scope)}${s.since ? ` · merged since ${esc(s.since)}` : ''}</p>
  <p>${stale}</p>
  <p><em>Two clocks.</em> <em>Work opened → merged</em> starts when <code>rig new</code>
  ran, which is when the work was decided on and where its design time sits. <em>First commit →
  merged</em> starts when code first existed. Where the two are close, the work was committed
  as soon as it was started; where they differ, the difference is the thinking.</p>
  <p>Work with a PR still open is counted as in flight, never as a fast work that has not
  finished. A window given with <code>--since</code> bounds what was merged; work in flight is
  counted as of now, whatever the window. <code>rig close</code> is used for neither clock: it records when teardown was
  remembered, not when anything landed.</p>
</header>
${s.orgs.map(orgSection).join('\n') || '<p class="empty">No works matched.</p>'}
<section>
  <h2>How to read this</h2>
  <ul class="caveats">
    <li>Orgs are never summed. Work on the tooling and work for an employer are different
    questions, and one number across both answers neither.</li>
    <li>These are the works recorded since rig started keeping them. There is no pre-rig
    period in the data, so nothing here is a before-and-after.</li>
    <li>Every figure carries its <code>n</code>. Several of these are counts you could hold
    in one hand.</li>
    <li>A work spanning two orgs is counted under each of them. Nothing is summed across
    sections, which is what makes counting it twice honest rather than double-counting.</li>
    <li>Medians are nearest-rank: the figure shown is a duration that actually happened,
    never the average of two that did. With ten or fewer works, p90 is the slowest one.</li>
    <li>Lines of code and commit counts are deliberately absent.</li>
  </ul>
</section>
`
}
