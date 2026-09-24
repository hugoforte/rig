// Where a work is in its life, derived — and the gates it passed, which are the only part
// stored.
//
// This replaces `status`, a stored field with four values, two of which (`planning`,
// `in-progress`) were observable facts written down: "no repos attached" and "repos
// attached". That is the class of bug DESIGN.md decision 3 exists to prevent, and the field
// had the symptom to match — four write sites, six read sites, and every read only *printed*
// it. Worse, it stopped narrating exactly where the work gets interesting: a work sat at
// `designed` from the moment the design was agreed until `rig close`, through the whole of
// build, review and release.
//
// So: **derive the phase, store only the gates.**
//
//   | phase     | what it means                               | what says so           |
//   | planning  | no repos attached yet                       | `work.repos`          |
//   | designing | repos attached, the design not yet agreed   | no `designedAt`       |
//   | building  | design agreed, no pull request anywhere     | the repo facts        |
//   | reviewing | a pull request exists and is not all merged | the repo facts        |
//   | landing   | every attached repo's PR merged             | the repo facts        |
//   | closed    | `rig close` ran                             | `closedAt`            |
//   | abandoned | stopped without finishing                   | `abandonedAt`         |
//
// **Tense rule**: active phases are present participles, terminal ones past. You can tell
// from the word alone whether the work is still moving — which is why `designed` became
// `building`, `in-progress` disappeared, and it is `landing` rather than `releasing`: rig's
// sight ends at the merge.
//
// **A gate is the only thing worth storing**, because it is the only lifecycle fact no
// lookup can recover: nothing in git or GitHub can say when a human agreed a design, or
// decided to stop. Everything else here is asked of the repos every time, so it cannot go
// stale.
//
// Everything in this module is a decision about state someone else gathered — no fs, no
// git, no gh, no spawning — the same contract as `bin/workstate.mjs`, `bin/dash.mjs` and
// `bin/freshness.mjs`. That is what makes the table above testable from object literals.

// In order. A work moves down this list and never back up on its own — though the facts
// can, since they are facts: reopening a PR moves `landing` back to `reviewing`, which is
// correct and is exactly what a stored field would have got wrong.
export const PHASES = ['planning', 'designing', 'building', 'reviewing', 'landing']

// Terminal, and deliberately not in `PHASES`: these are the two ways a work stops, not two
// more places it can be. `abandoned` is the recorded decision to stop unfinished, and it is
// distinct from `closed` — closing says the work landed, and a work that did not should not
// have to lie about it (the old alternative was `rig close --force`, which did).
export const TERMINAL = ['closed', 'abandoned']

// Each gate and the field its date is stored in. `closedAt` predates all of this; the others
// join it rather than replacing anything. `learnedAt` is the lesson review, and unlike the
// design gate it may be passed after the close: the catalogue and rig's tracker outlive the work.
export const GATES = { designed: 'designedAt', learned: 'learnedAt', abandoned: 'abandonedAt', closed: 'closedAt' }

const MERGED = 'MERGED'

// The gates a record has passed, in lifecycle order, each with the date it was passed.
export const gatesOf = work =>
  Object.entries(GATES)
    .filter(([, field]) => work?.[field])
    .map(([gate, field]) => ({ gate, at: work[field] }))

// The phase, from the gates and the repo facts. `repos` is one entry per attached repo in
// the shape `{ merged, pr }` — what `workState` already decided for `rig list`, `rig status`
// and `rig close`, and what `repoEntryJson` already looked up for `rig list --json`. Neither
// caller gathers anything twice for this.
//
// Omitting `repos` answers **the phase the record alone can prove** — `planning`,
// `designing`, `building` and the two terminal ones, every one of them a function of the
// gates and `repos.length` and nothing else. `reviewing` and `landing` are the two that need
// a lookup, so they are the two a caller that did none never hears.
//
// That split is what makes it safe to put this in a document. `syncDocHeader` and
// `regenerate` run inside `saveWork`, which asks GitHub nothing — so the header carries only
// phases that cannot go stale, and `rig status` is where the live two are answered. A
// generated file saying `Reviewing` would be a derived fact written down, which is decision
// 3's whole prohibition and the disease this module exists to cure.
export function phaseOf (work, repos = null) {
  // Terminal first, and abandoned above closed: a work can carry both when it was abandoned
  // through the close path, and the decision to stop is the more specific of the two.
  if (work?.abandonedAt) return 'abandoned'
  if (work?.closedAt) return 'closed'

  const entries = work?.repos || []
  const facts = repos || []
  const anyPr = facts.some(r => r.pr)
  const allMerged = facts.length === entries.length && facts.length > 0 && facts.every(r => r.merged)

  // Evidence outranks the absence of it, in both directions.
  //
  // A PR outranks the design gate rather than waiting for it: an unrecorded gate is an
  // *omission* — `rig next` offers it — and reporting a work that is visibly under review as
  // still being designed would be rig telling you something you can see is untrue.
  //
  // And the design gate outranks `repos.length`, which is why `planning` is last. A work
  // whose design has been agreed with nothing attached yet is a real record — a sweep across
  // repos not yet chosen is the ordinary way one starts — and calling it `planning` would
  // have the derived phase deny a gate that was recorded. That is the one thing a derivation
  // must never do, and `contradictions` below would be right to complain about it.
  if (allMerged) return 'landing'
  if (anyPr) return 'reviewing'
  if (work?.designedAt) return 'building'
  return entries.length ? 'designing' : 'planning'
}

export const phaseLabel = phase => (phase ? phase[0].toUpperCase() + phase.slice(1) : '')

const day = at => String(at).slice(0, 10)

// The one line the context doc header and the generated `AGENTS.md` show. The word `Status:`
// survives on screen — it is what a reader of a document expects to see — but what follows
// it is computed, plus the design gate once it has been passed, because that is the one part
// no amount of looking could have told you.
export function statusLine (work, repos = null) {
  const label = phaseLabel(phaseOf(work, repos))
  return work?.designedAt ? `${label} (design agreed ${day(work.designedAt)})` : label
}

const readable = at => !Number.isNaN(Date.parse(at))

// What a record says that reality denies. Since the derived half is no longer stored, drift
// is not possible any more: the only way these can fire is a bug in rig or a hand-edited
// record, which is why `doctor` reports them as `✗` and says to file an issue.
//
// **Contradictions belong here; omissions belong in `rig next`.** A doctor that warns about
// every unrecorded design gate is a doctor nobody reads, and a warning nobody reads is worse
// than no check at all — it teaches the reader to skip the ones that matter.
export function contradictions (work, repos = []) {
  const found = []
  if (!work) return found

  for (const [gate, field] of Object.entries(GATES)) {
    if (work[field] && !readable(work[field])) {
      found.push(`${work.id}: \`${field}\` is "${work[field]}", which is not a date — the ${gate} gate cannot be read`)
    }
  }

  // An abandoned work carries both dates, and that is not a contradiction: `closedAt` is when
  // the teardown ran and `abandonedAt` is the decision that it ended unfinished. The two are
  // different facts about the same moment, and `phaseOf` reports the more specific one. What
  // *is* wrong is the decision with no teardown behind it.
  if (work.abandonedAt && !work.closedAt) {
    found.push(`${work.id}: abandoned, but no \`closedAt\` — the decision was recorded and the teardown never ran`)
  }

  // A gate cannot have been passed after the work stopped. Compared only when both dates are
  // readable, so an unparseable one is reported once, above, rather than twice.
  const stoppedAt = work.abandonedAt || work.closedAt
  if (stoppedAt && readable(stoppedAt) && work.designedAt && readable(work.designedAt) &&
      Date.parse(work.designedAt) > Date.parse(stoppedAt)) {
    found.push(`${work.id}: the design gate (${day(work.designedAt)}) is dated after the work stopped (${day(stoppedAt)})`)
  }

  // An open PR under a closed work means rig closed something that had not landed, which its
  // own blockers forbid. Not asked of an abandoned one: leaving open PRs alone is what
  // `close --abandoned` promises, because closing someone's pull request is an outward-facing
  // act rig should not take on its own. Not asked of a **forced** one either, for the same
  // shape of reason: `rig close --force` exists to tear down past exactly this, so the state
  // is explained rather than impossible, and telling someone to file an issue about a
  // decision they made on purpose is not a health check.
  //
  // Unlike its three neighbours, this rule compares a record to *live* state, which keeps
  // moving after the record is written — reopen a merged pull request and nothing about the
  // work changed. It is the reason this one is `rig status`'s to report and not `doctor`'s.
  if (work.closedAt && !work.abandonedAt && !work.forcedAt) {
    for (const r of repos) {
      if (r.pr && r.pr.state === 'OPEN') {
        found.push(`${work.id}: closed, but ${r.repo} still has PR #${r.pr.number} open`)
      }
    }
  }

  return found
}
