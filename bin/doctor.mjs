// What `rig doctor` found — one list of findings, decided here and printed by the caller.
//
// `doctor` is the command you run *because* something is already broken, and it was the one
// command with no unit tests: twenty-odd checks interleaved probing, severity and printing
// down the length of one function, with a `problems` counter that became the exit code. So
// the checks could only be reached by spawning the CLI against a real installation, and what
// three of those spawns actually proved was that the function had not died before reaching
// its verdict.
//
// The split is `next.mjs`'s: the caller gathers a snapshot — the one impure half — and this
// decides what to say about it. **This module narrates**, where `checkouts.mjs` refuses to,
// and the difference is the audience: `checkouts.mjs` answers two callers who word the same
// outcome differently, while a doctor finding has exactly one reader and the wording *is* the
// check. An outcome code here would only put the messages back in `rig.mjs`, where they
// cannot be asserted.
//
// Pure, like `bin/phase.mjs`, `bin/next.mjs`, `bin/workstate.mjs`, `bin/stages.mjs`,
// `bin/dash.mjs` and `bin/freshness.mjs`: no fs, no git, no gh.

// Where a `✗` sends you. rig's own tracker, because a contradiction is rig's bug and not the
// reader's — see `docs/agents/issue-tracker.md`. It lives here because both the reports that
// use it are contradictions, and this is the module that words them.
export const ISSUES_URL = 'https://github.com/hugoforte/rig/issues'

// How many entries the catalogue-freshness line names before it stops counting out loud. A
// display bound and not a threshold: the count is always the whole population, and the tail of
// a ranked list is the same news as its head.
const CATALOGUE_NAMED = 5

// One finding: the glyph it prints as, what it says, and whether it moves the exit code.
//
//   verdict  'ok' (✓), 'warn' (!), 'bad' (✗) or 'note' (·) — the four channels the output
//            already had, named once instead of chosen twenty-one times
//   says     the whole line, bar the glyph
//   dim      a detail printed dim after `says` — only a passing check has one; a failing
//            one folds its detail into the sentence, because that is the part you read
//   counts   whether this finding is one of the "N thing(s) to look at"
//
// `counts` is a **separate axis on purpose**. It already was one and nowhere said so: a
// dirty data root warns and does not count, draft catalogue entries warn and do not count,
// and every other `!` did. Deciding it beside the wording is what stops the two drifting.
const ok = (says, dim = null) => ({ verdict: 'ok', says, dim, counts: false })
const warn = (says, { counts = true } = {}) => ({ verdict: 'warn', says, dim: null, counts })
const bad = says => ({ verdict: 'bad', says, dim: null, counts: true })
const note = says => ({ verdict: 'note', says, dim: null, counts: false })

// A pass/fail check, said either way. `detail.ok` shows when it passes, `detail.bad` when it
// fails.
const check = (label, good, detail = {}) =>
  good
    ? ok(label, detail.ok)
    : warn(`${label}${detail.bad ? ` — ${detail.bad}` : ''}`, { counts: detail.counts ?? true })

const trackerLabel = t => t?.kind
  ? `${t.kind}${t.repo ? ' ' + t.repo : ''}${t.project ? ' ' + t.project : ''}`
  : 'none — `rig new --ticket` unavailable (rig.json)'

// One data root, checked in full: where it is, what git makes of it, the org half it carries
// and the catalogue in it. Every check here is answerable from that root alone, which is what
// makes repeating it per root the right shape — and what leaves the two work-root checks out,
// since the work root is shared and no single root can answer for it.
function rootFindings (root) {
  const out = []
  out.push(check('data root', !!(root.split && root.exists), {
    ok: root.path,
    bad: root.split
      ? `${root.path} missing — check ${root.name ? `dataRoots.${root.name}` : 'dataRoot'} in rig.local.json`
      : "is inside the tool checkout — not set up; knowledge must not live inside a public tool's tree. Run `rig prompt setup`",
  }))
  // A root whose directory has gone is one finding and not eight: there is nothing there to
  // read, so every check below would be reporting the same absence again. The roots after it
  // are still checked, which is the whole reason this is a finding rather than a throw.
  if (!root.exists) return out

  if (root.state) {
    const state = root.state
    out.push(check('data root is a git checkout of its own', state.repo === 'own', {
      bad: state.repo === 'nested'
        ? `it is a directory inside ${state.top} — rig will not commit there, since \`git add -A\` would stage all of it`
        : 'records written there are not versioned',
    }))
    if (state.repo === 'own') {
      // rig commits after its own commands; an edit made outside rig waits for `rig save`.
      // `dirty` is null when git could not read the tree, which is neither clean nor a
      // count — a green tick on the strength of a command that failed is the one thing
      // this check must never print.
      const dirty = state.dirty
      if (dirty === null) out.push(warn(`data root: git could not read the working tree — \`git -C ${root.path} status\` says why`))
      else if (dirty) out.push(warn(`data root has ${dirty} uncommitted change(s) — \`rig save\` commits edits made outside rig`, { counts: false }))
      if (!state.branch) out.push(warn('data root is on a detached HEAD — rig commits there go nowhere; check out main'))
      else if (!state.upstream) out.push(note('data root has no upstream — local only; push it to a private repo when ready'))
      else if (state.ahead) out.push(warn(`data root has ${state.ahead} unpushed commit(s)`, { counts: false }))
      else if (dirty === 0) out.push(ok('data root is committed and pushed'))
      // Measured against the last fetch, which a mutating command does for itself.
      if (state.behind) out.push(warn(`data root is ${state.behind} commit(s) behind origin — \`rig update\` fast-forwards it`))
    }
  }

  const rc = root.repoConfig || {}
  out.push(check('rig.json', rc.exists, { ok: rc.path, bad: `missing in ${root.path} — not set up; run \`rig prompt setup\`` }))
  if (rc.exists && !rc.orgs) out.push(warn('rig.json has no orgs — not set up; run `rig prompt setup`'))
  // Reported, never run: doctor does not mutate, which is what makes it the command you can
  // always run to ask a question without answering it.
  if (rc.exists) {
    const stamp = rc.stamp || {}
    if (stamp.unreadable) {
      out.push(warn(`data root records writtenBy ${JSON.stringify(stamp.writtenBy)}, which is not a record format any rig wrote — mutating commands refuse until it is fixed by hand`))
    } else if (stamp.blocked) {
      out.push(warn(`data root is at record format ${stamp.dataMajor}, this rig writes ${stamp.major} — mutating commands refuse until this rig is updated`))
    } else if (stamp.pending?.length) {
      out.push(warn(`${stamp.pending.length} pending migration(s) — run \`rig update\`: ${stamp.pending.join('; ')}`))
    } else {
      // No "stamped by rig X": `writtenBy` is derived from the format now, so naming it here
      // would be this line saying the same number twice and calling the second one a rig
      // (ADR 0004). A data root from before stamping existed still has something to say.
      out.push(note(stamp.writtenBy ? `record format ${stamp.major}` : `record format ${stamp.major}, from before stamping existed`))
    }
  }

  // rig cannot know which address is *correct* for an org, only which one git will use, so
  // this reports rather than warns. The one state worth a warning is git having no answer.
  // Asked per root because an identity is per org *and* per root: the same org name means a
  // different person in a personal root and a paid one.
  for (const o of root.orgs || []) {
    const id = o.identity || {}
    if (id.source === 'unknown') out.push(note(`identity for ${o.org}: no mirror yet — git decides once one is cloned`))
    else {
      out.push(check(`identity for ${o.org}`, !!id.email, {
        ok: `${id.email}${id.source === 'git' ? ' — from git, not rig' : ''}`,
        bad: 'git has no user.email to commit with',
      }))
    }
    out.push(note(`tracker for ${o.org}: ${trackerLabel(o.tracker)}`))
  }

  // A draft entry is an invitation to correct the catalogue while the repo is still loaded in
  // your head (rule 4), not a fault: it warns and does not count.
  const drafts = root.drafts || []
  if (drafts.length) {
    out.push(warn(`${drafts.length} draft catalogue entr${drafts.length === 1 ? 'y' : 'ies'}: ${drafts.join(', ')}`, { counts: false }))
  }

  // An entry behind the repo it describes is the same kind of finding as a draft — an invitation
  // to correct it, not a fault — so it warns and does not count. Drafts are left out: a stub
  // nobody has written yet is already reported above, and saying it twice would make the shorter
  // list the noisier one.
  //
  // **Reported, never judged**, which is what CONTEXT.md's Freshness has always meant. The line
  // carries the count and the date and no opinion about either, because rig cannot know which
  // commits touched what the entry claims: 400 in code the entry never described is not
  // staleness, and 3 that moved a `talks_to` edge is. Zero is dropped all the same — it is the
  // answer for every entry anyone has just corrected, and it is not news.
  const behind = (root.catalogueFreshness || [])
    .filter(e => e.commits > 0 && !drafts.includes(e.repo))
    .sort((a, b) => b.commits - a.commits)
  if (behind.length) {
    const named = behind.slice(0, CATALOGUE_NAMED)
    const rest = behind.length - named.length
    const list = named.map(e => `${e.repo} (${e.commits} commit${e.commits === 1 ? '' : 's'} since ${e.writtenAt})`).join(', ')
    const one = behind.length === 1
    out.push(warn(
      `${behind.length} catalogue entr${one ? 'y' : 'ies'} behind ${one ? 'its repo' : 'their repos'}: ${list}${rest ? `, and ${rest} more` : ''}`,
      { counts: false },
    ))
  }
  return out
}

// Everything the findings need that they cannot work out for themselves, gathered by the
// caller so this stays pure. **Decision 54 is a field here, not a branch**: a check this
// machine cannot make arrives null — `git: null` with no git on PATH, `gitConfig: null`
// with it, `disk: null` on a machine with neither free-space probe — and a null is dropped
// or noted, never counted against the machine.
//
//   setUp             there is a rig.local.json at all; nothing below is gathered without one
//   localFile         its path
//   strayOrgKeys      keys of the org half left behind in the machine file
//   selection         { error } — why no data root could be resolved, or null when one was.
//                     The only field here that is a *failure* to gather rather than a thing
//                     gathered, and the reason is decision 83's: everything else comes from
//                     the registry and the machine half, which answer whether or not a root
//                     was chosen
//   node, git         the version strings; `git` null when it is not on PATH
//   rig               { version, root, mark } — the release this checkout stands on, or null
//   freshness         { skipped, fetchError, behind, upstream }, measured live by the caller
//   gh                'ok' | 'missing' | anything else for a gh that is not authenticated
//   jira              { needed, present } — needed when any root has an org tracking in
//                     Jira, since twg is one tool on one machine
//   gitConfig         { longpaths, symlinks } as git answered them, or null without git
//   workRoot          { path, exists, entries } — `entries` is what is directly under it,
//                     minus the two things rig keeps there itself
//   mirrorRoot        { path, exists }
//   dataRoots         one per root this installation configures, each
//                     { name, path, split, exists, state, repoConfig, orgs, drafts }:
//                     `state` is `checkouts.describe()` and null when there is nothing
//                     readable to describe, `repoConfig` is { path, exists, orgs, stamp }
//                     with `stamp` the record-format reading, and `orgs` is
//                     [{ org, identity: { email, source }, tracker }]
//   works             every root's, in one list — [{ id, closed, contradictions,
//                     folderMissing, strays, repos }]
//   disk              { label, freeGb } or null
//
// Returns the findings in the order they are printed. `problemCount` is the exit code.
export function doctorFindings (snap = {}) {
  const out = []

  // Nothing else can be asked of an installation that does not exist yet.
  if (!snap.setUp) {
    out.push(warn(`not set up — no ${snap.localFile}. Run \`rig prompt setup\` and follow it; it ends in one \`rig init\`.`))
    return out
  }

  for (const key of snap.strayOrgKeys || []) {
    out.push(warn(`${snap.localFile} has "${key}" — ignored; it lives in rig.json. Remove it.`))
  }

  // The two things everything below needs, reported before anything that needs them: doctor
  // used to reach the tool checkout first and die there when git was absent, saying nothing.
  out.push(ok('node', snap.node))
  out.push(check('git', !!snap.git, { ok: snap.git, bad: 'not on PATH' }))
  // The mark *is* the version (ADR 0004), so it is said once. With no mark at all — no git on
  // PATH, or a copy of the tool with no `.git` — the sentence would otherwise lose its subject
  // and read `rig at C:\rig`, so it falls back to the one fact that needs nothing to derive.
  out.push(note(`rig ${snap.rig?.mark ?? `record format ${snap.rig?.recordFormat}`} at ${snap.rig?.root}`))

  // The asymmetry is deliberate: a machine that was never going to answer costs a note,
  // while one that tried and failed counts. "Nothing to measure here" and "the fetch broke"
  // are different news.
  const f = snap.freshness || {}
  if (f.skipped) out.push(note(`freshness not checked — ${f.skipped}`))
  else if (f.fetchError) out.push(warn(`freshness not checked — could not fetch (${f.fetchError})`))
  else if (f.behind === null) out.push(warn(`freshness not checked — git could not measure the distance from ${f.upstream}`))
  else {
    out.push(check('installed rig', f.behind === 0, {
      ok: `up to date with ${f.upstream}`,
      bad: `${f.behind} commit(s) behind ${f.upstream} — run \`rig update\``,
    }))
  }

  out.push(check('gh authenticated', snap.gh === 'ok',
    { bad: snap.gh === 'missing' ? 'gh not on PATH' : 'PR state and org resolution will not work' }))
  if (snap.jira?.needed) {
    out.push(check('twg present', snap.jira.present,
      { bad: 'Jira ticket creation, fetch and write-back will not work' }))
  }

  // Skipped rather than attempted without git, like every git-dependent check below it.
  if (snap.gitConfig) {
    out.push(check('core.longpaths', snap.gitConfig.longpaths === 'true',
      { bad: 'run `rig init`; deep node_modules paths will break without it' }))
    if (snap.gitConfig.symlinks === 'false') out.push(note('core.symlinks=false — by design, rig never symlinks'))
  }

  out.push(check('config file', snap.configFileExists, { bad: `${snap.localFile} missing — run \`rig init\`` }))
  const wr = snap.workRoot || {}
  out.push(check('work root', wr.exists, { ok: wr.path, bad: `${wr.path} missing` }))
  const mr = snap.mirrorRoot || {}
  out.push(check('mirror root', mr.exists, { ok: mr.path, bad: `${mr.path} missing` }))

  // Which root is in hand, when the machine cannot say. Everywhere else this refusal is fatal
  // — a command that carried on would work in a root nobody chose — and here it is a finding,
  // because a configuration doctor cannot resolve is the class of problem doctor exists to
  // report, and dying on it is how it came to report nothing at all. Said immediately before
  // the roots, which are read from the registry and so are all still checked below.
  //
  // The message is `bin/roots.mjs`'s own, carried rather than reworded: it is written for a
  // person, it already names the fix, and there are several distinct refusals behind it that
  // wording this again would have to enumerate. `freshness.fetchError` is the same bargain —
  // this module narrates the frame and carries the detail.
  if (snap.selection?.error) out.push(bad(snap.selection.error))

  // Every configured root, each checked in full, because the roots nobody looks at are the
  // ones that rot. Named when there is more than one, and silent when there is not: a
  // single-root installation has never had to say which, and every line it prints would grow
  // a word for nothing — the rule `rig update` labels its roots by.
  const roots = snap.dataRoots || []
  for (const root of roots) {
    for (const finding of rootFindings(root)) {
      out.push(roots.length > 1 ? { ...finding, says: `${root.name}: ${finding.says}` } : finding)
    }
  }

  // Contradictions: a recorded gate that reality denies. Since the phase is derived, drift is
  // no longer possible — the only way one of these fires is a bug in rig or a hand-edited
  // record, which is why they are `✗` and say so. Omissions are deliberately *not* here: a
  // work with no design gate recorded is an ordinary work, `rig next` is where the offer to
  // record one belongs, and a doctor that warns about every one of them is a doctor nobody
  // reads.
  //
  // Asked of the records alone, with no PR lookup: doctor already fetches once and runs over
  // every work, and a GitHub call per repo per work would make the command too slow to be the
  // one you reach for. The contradictions that need live state are caught by `rig status`,
  // which looks them up anyway. Closed works are asked too — a contradiction outlives the
  // close that produced it, which is exactly how a forced close is told from a bug.
  for (const w of snap.works || []) {
    for (const message of w.contradictions || []) {
      out.push(bad(`${message} — this should not be possible; please file an issue at ${ISSUES_URL}`))
    }
  }

  // Strays: anything directly under a work folder that rig did not create. Over every root's
  // works at once, which is what makes the missing-folder warning below reach an unclosed work
  // whatever root holds its record.
  for (const w of snap.works || []) {
    if (w.closed) continue
    if (w.folderMissing) { out.push(warn(`${w.id}: work folder missing but not closed`)); continue }
    for (const entry of w.strays || []) {
      out.push(warn(`${w.id}: unmanaged entry "${entry}" under the work root — rig owns this folder`))
    }
    for (const r of w.repos || []) {
      if (r.worktreeMissing) out.push(warn(`${w.id}: ${r.repo} is attached but its worktree is gone`))
      if (r.secretsUnconfigured) {
        out.push(warn(`${w.id}: ${r.repo} mentions secrets in its catalogue entry but has no source in rig.local.json`))
      }
    }
  }

  // And the work root itself: a folder no root has a record for. Asked once against the union
  // and never per root, because the work root is shared — "is this folder accounted for" has
  // one answer per folder and one place to look it up per root, and a loop over the roots
  // would have each of them report the others' live work folders as junk. Said without naming
  // a root for the same reason the warnings above are: a work id is unique across every data
  // root on the machine, so the id is the whole answer to which work a folder belongs to.
  const accounted = new Set((snap.works || []).map(w => w.id))
  for (const entry of wr.entries || []) {
    if (accounted.has(entry)) continue
    out.push(warn(`unmanaged entry "${entry}" in ${wr.path} — no data root has a work record for it; rig owns this tree`))
  }

  // The label comes from the probe, not from the path: a drive letter on Windows, the mount
  // point the work root actually sits on anywhere else.
  if (snap.disk) {
    out.push(check(`disk on ${snap.disk.label}`, snap.disk.freeGb > 20, {
      ok: `${snap.disk.freeGb} GB free`,
      bad: `only ${snap.disk.freeGb} GB free`,
    }))
  }

  return out
}

// The exit code, and the number in the verdict line. Arithmetic over what the findings
// already say — never a counter something incremented on the way past, which is the shape
// that made the old function impossible to reach.
export const problemCount = findings => findings.filter(f => f.counts).length
