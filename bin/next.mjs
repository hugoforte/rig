// What is available now — the answer to "what now?", read off live state and never off a
// remembered plan.
//
// The epic's principle in its most concrete form: **rig never adds a stop; it adds an answer
// to "what now".** Two guardrails hold it to that, and both are load-bearing rather than
// decorative:
//
//   1. **It only ever offers.** Never warns, never blocks, never says you should have.
//      Warnings live in `doctor`, and only for contradictions (decision 64). The moment this
//      command tells you off for not having recorded a design gate, it becomes a workflow
//      engine with a to-do list, which is the thing the whole epic exists not to build.
//   2. **It speaks only when asked.** A command you run — not a hook, never firing off the
//      back of another command.
//
// **Weight is derived, never declared.** A work earns how much ceremony it carries from what
// it actually contains: one repo and no stages gets "build it, open the PR, close it"; three
// repos start being offered a rollout plan, because deploy order now matters; a work with
// stages gets told which one is next. The rejected alternative — `rig new --track light|full`
// — is a prediction made before the work's shape is known, and predictions rot: the
// dependency bump that becomes a four-repo migration by Wednesday leaves the declaration
// wrong and nobody goes back to fix it. That is `status`'s disease exactly (#61).
//
// Pure, like `bin/phase.mjs`, `bin/workstate.mjs`, `bin/dash.mjs` and `bin/freshness.mjs`:
// no fs, no git, no gh. The gathering is the caller's job, which is what makes every ladder
// rung below assertable from an object literal.

import { phaseOf, STOP_WORDS, STOPPABLE } from './phase.mjs'
import { backToWorkBranch, nextStage, onLandedStage, unknownStages } from './stages.mjs'

// One offer: the phase it belongs to, a line saying what is available, and the command that
// does it. `command` is null when there is nothing to type — agreeing a design is a
// conversation, and only the recording of it is a command — and a list of lines, run in
// order, when there is more than one.
const offer = (phase, says, command = null) => ({ phase, says, command })

const DESIGNED = 'rig save -m "design agreed" --designed --adversarial'

// Three repos is where deploy order stops being obvious and starts being a thing that causes
// incidents. Two is a pair you can hold in your head. The weight threshold, derived from the
// repo count and nothing anybody declared: it offers the rollout plan, and it makes the design a
// stop again on a work that chose to skip it, since the work has outgrown what the human saw.
const HEAVY = 3

// Everything `rig next` needs that it cannot work out for itself. Gathered by the caller so
// this module stays pure:
//
//   work           the record: repos, gates, tickets
//   repos          one `{ repo, merged, pr, dirty, unpushed, pushed, on, missing }` per
//                  attached repo — what `workState` already decided for `list`, `status` and
//                  `close`, plus `pushed` and `on`, the branch checked out, from the worktree
//                  state; `missing` is a worktree not on this machine
//   directionTodo  the context doc's Direction section is still the scaffolded `_TODO_`
//   planExists     a rollout plan has been scaffolded for this work
//   planStale      that plan has one, and its generated deploy order disagrees with the stack
//   prStale        the repos whose open PR's title or body is not what `rig pr` would write now
//   stack          the work's stages, ordered and with their state (`stackOf`), empty when
//                  the work has none — which is most works, and is not a deficiency
//   replaced       one `{ repo, branch, head, ... }` per merged stage `worktrees.replaced`
//                  answered for, with what it answered: `head` is the commit its PR carried
//   drafts         the attached repos whose catalogue entry is still `DRAFT: unreviewed`
//   neighbours     one `{ repo, via, direction }` per repo the catalogue says talks to an
//                  attached one and which is not itself attached — `via` is the attached repo
//                  it was reached from, `direction` its stated direction or null
//   bumps          one `{ repo, release }` per repo with no PR, where `release` is which release
//                  its PR would ask for and why; absent where the repo does not release by bump
//   unstacked      the repos whose open stage PRs, two or more and a chain, GitHub does not
//                  show as one stack; empty where GitHub would not list its stacks
//   reviews        one `{ repo, unresolved, checks }` per repo whose work-branch PR is open: how
//                  many of its review threads are unresolved and its head commit's check rollup
//                  (`SUCCESS`, `PENDING`, `FAILURE`, …, or null where none are set up); both
//                  null where GitHub would not say. A failing one also carries its `base` and
//                  `behind`, how many commits the base has that the branch does not, read off
//                  a fresh fetch; null where git could not count them
//   verification   one `{ repo, state }` per attached repo whose catalogue entry has a `check`:
//                  `verified`, `stale`, `unverified` or `unknown` against the pass `rig check
//                  --run` recorded
//   leftover       the work is closed and its folder is still on this machine — closed on
//                  another one, whose close could not reach this disk
//
// Returns the offers in the order they became available, most immediate first. An empty list
// means there is genuinely nothing to suggest, which `rig next` says out loud rather than
// inventing something.
export function nextFor ({ work, repos = [], directionTodo = false, planExists = false, planStale = false, prStale = [], stack = [], replaced = [], drafts = [], neighbours = [], bumps = [], unstacked = [], reviews = [], docs = [], verification = [], leftover = false } = {}) {
  const phase = phaseOf(work, repos)
  const out = []

  // Terminal first: a stopped work has no next step, and saying so is a real answer. Bar one:
  // the copy of it still on this machine, which only this machine can clear.
  if (phase === 'closed' || phase === 'abandoned') {
    if (leftover) out.push(offer(phase, `this work is ${phase}, but its folder is still on this machine — clear this machine's copy`, 'rig close'))
    return out
  }

  const entries = work?.repos || []

  if (!entries.length) {
    out.push(offer('planning', 'nothing is attached yet — pick the repos this touches', 'rig prompt select-repos'))
    return out
  }

  // A worktree that is not on this machine comes first, because everything below happens in
  // one: a work picked up on a second machine, or whose folder was cleared, is where being
  // missing is the thing most worth saying rather than a reason to say less. Only for a repo
  // that can still come back — a pull request that merged or closed usually took its branch
  // with it, and `rig restore` has already said so once.
  const away = repos.filter(r => r.missing && !r.merged && r.pr?.state !== 'CLOSED')
  if (away.length) {
    out.push(offer(phase, `${away.map(r => r.repo).join(', ')} ${away.length === 1 ? 'is' : 'are'} not on this machine — put back from the record`, `rig restore ${work.id}`))
  }

  // The design gate is offered whenever it has not been recorded, and it is an *offer*: a
  // work can reach review without one and that is not an error, it is an omission. Which is
  // exactly why this lives here and not in `doctor`. The gate carries the adversarial-review
  // choice (decision 168), so the offer names both answers and the command carries one.
  //
  // A work that chose not to stop at the design has the agent record it, and the agent's
  // default is the adversarial review: it costs the agent effort and the human nothing. A work
  // grown heavy since is offered the human's gate all the same, since a stop skipped for a small
  // work was not chosen for this one.
  const skipsDesign = work?.stops && !work.stops.includes('design')
  if (!work?.designedAt && skipsDesign && entries.length < HEAVY) {
    out.push(offer('designing', 'the design is not a stop on this work — agree it yourself, write it in the Direction, and record it as the agent\'s, with an adversarial review', `${DESIGNED} --by-agent`))
  } else if (!work?.designedAt) {
    const choose = 'and decide whether its PRs get an adversarial review (`--no-adversarial` declines it)'
    const grown = skipsDesign ? `${entries.length} repos is the weight at which the design waits for the human; ` : ''
    out.push(directionTodo
      ? offer('designing', `${grown}the context doc's Direction is still \`_TODO_\` — agree the approach, write it down, then record the gate ${choose}`, DESIGNED)
      : offer('designing', `${grown}Direction is written but the design gate is not recorded — record it ${choose}`, DESIGNED))
  }

  // Unsaved work outranks everything below it: it is the one thing every other suggestion
  // here would be built on top of, and the one thing a teardown can destroy.
  const dirty = repos.filter(r => r.dirty)
  if (dirty.length) {
    out.push(offer(phase, `uncommitted changes in ${dirty.map(r => r.repo).join(', ')} — commit them where they belong`))
  }

  // Every stage is in and a worktree is still on one of them. It is moved first, so it is not
  // also offered a push or a pull request from the stage it is on (`onLandedStage`).
  const stranded = stack.length && !nextStage(stack) ? repos.filter(r => onLandedStage(stack, r.on)) : []

  // A work with stages gets told which one is next and what it delivers, before anything
  // about the work branch — the stack is what you are actually working through, and the work
  // branch's own PR is the thing that happens *after* it. A work with no stages skips all of
  // this and behaves exactly as it did before stages existed, which is the point.
  if (stack.length) {
    const up = nextStage(stack)
    if (up) {
      // "stage 2 of 5" is itself a claim about the order, so where the branches contradict it
      // — this stage sits on something the stack does not contain — it says so. A fact about
      // what the branches report, not a reproach and not a guess at why. The ordinary reasons
      // a stack cannot be walked end to end are deliberately silent here.
      // A stage GitHub would not answer for may have landed and lost its branch, so it is never
      // called uncut (decision 171).
      const where = up.started
        ? `${up.repos.join(', ')}${up.open ? ' — up for review' : ''}${up.adrift ? ' — outside the stack' : ''}`
        : up.prUnknown ? `PR state unknown in ${up.prUnknown.join(', ')}` : 'not cut in any repo yet'
      // The frontier: the lowest stage still to land is the only PR that matters until it
      // merges, so what is stacked above it is named as waiting on it rather than offered.
      // Not a stage whose place the order only guessed (adrift), nor one GitHub would not say
      // about, which may have landed (decision 171): neither is known to be waiting on this one.
      const waiting = stack.slice(stack.indexOf(up) + 1).filter(st => !st.landed && !st.withdrawn && !st.adrift && !st.prUnknown?.length).map(st => st.branch)
      out.push(offer('building', `stage ${stack.indexOf(up) + 1} of ${stack.length}: ${up.branch}${up.delivers ? ` — ${up.delivers}` : ''} (${where})${waiting.length ? ` — waiting on it: ${waiting.join(', ')}` : ''}`))
    } else {
      const on = new Map()
      for (const r of stranded) on.set(r.on, [...(on.get(r.on) || []), r.repo])
      const where = [...on].map(([b, rs]) => `${rs.join(', ')} ${rs.length === 1 ? 'is' : 'are'} still on ${b}, which has landed`).join('; ')
      out.push(stranded.length
        ? offer('reviewing', `every stage is in — ${where} — move ${stranded.length === 1 ? 'it' : 'each'} to the work branch, then \`rig pr\``, backToWorkBranch(work))
        : offer('reviewing', `every stage is ${stack.some(st => st.withdrawn) ? 'in or withdrawn' : 'in'} — the work branch is what is left to land`, 'rig pr'))
    }
    // Decision 113. The rebase is offered only where the squash is the stage as it stood;
    // anywhere else, replaying onto it is a merge somebody has to look at.
    for (const r of replaced) {
      if (r.unfetched) {
        out.push(offer('building', `${r.branch} merged in ${r.repo}, and this machine has not fetched it — fetch, then ask \`rig next\` again`, 'git fetch origin'))
        continue
      }
      const one = r.carriers.length === 1
      const which = r.carriers.join(', ')
      const push = r.carriers.map(b => `git push --force-with-lease origin ${b}`)
      if (r.rebased) {
        out.push(offer('building', `${which} ${one ? 'is' : 'are'} replayed onto the work branch here and not pushed`, push))
        continue
      }
      const says = `${r.branch} landed as new commits (a squash or a rebase), and ${which} in ${r.repo} still ${one ? 'carries' : 'carry'} the commits it replaced`
      if (r.behind.length) {
        out.push(offer('building', `${says} — the copy here of ${r.behind.join(', ')} is behind the remote's, so bring it up to date, then ask \`rig next\` again`))
        continue
      }
      out.push(r.sameTree
        ? offer('building', `${says} — replay only ${one ? 'its' : 'their'} own onto the work branch`, [
          `git switch ${r.carriers[r.carriers.length - 1]}`,
          `git rebase ${one ? '' : '--update-refs '}--onto origin/${work.branch} ${r.head}`,
          ...push,
        ])
        : offer('building', `${says}, and the squash is not the stage as it stood — rebase ${one ? 'it' : 'them'} onto the work branch by hand`))
    }
  }

  // Asked of `unpushed`, never of `ahead`, which counts what has not landed on the base
  // (decision 110). `unpushed` is `null`, never 0, when git could not count, so every filter
  // below compares it explicitly: `!r.unpushed` is true for both 0 and null, and treating
  // "nobody could tell" as "nothing outstanding" is the mistake decision 62 exists to prevent.
  // A repo git could not count for matches none of these and is simply not spoken about: this
  // command offers, and there is nothing to offer about a fact nobody has.
  // A repo whose stages are replayed here is offered their force-push above; a plain push fails.
  const replaying = replaced.filter(r => r.rebased).map(r => r.repo)
  const unpushed = repos.filter(r => !r.merged && r.unpushed > 0 && !stranded.includes(r) && !replaying.includes(r.repo))
  // Pushed by name: a work branch's upstream is its base (decision 110), so a bare `git push`
  // is refused under git's default `push.default` and lands on the base under `upstream`
  // (decision 159). Only this work's own branches are named: a detached HEAD has none, and a
  // worktree switched to the base would be offered a push straight onto it.
  if (unpushed.length) {
    const ours = new Set([work.branch, ...(work.stages || []).map(s => s.branch)])
    const pushes = [...new Set(unpushed.filter(r => ours.has(r.on)).map(r => `git push origin ${r.on}`))]
    out.push(offer('building', `${unpushed.map(r => r.repo).join(', ')} ${unpushed.length === 1 ? 'has' : 'have'} commits that are not pushed`, pushes.length ? pushes : null))
  }

  // The checks, for a repo with work on it whose diff no recorded pass covers: never run, or
  // run against a diff that has changed since. Only where something has been written, for the
  // reason the PR offer below asks `pushed` too, and only before the merge.
  const written = r => r.pushed || r.unpushed > 0
  const unproven = verification.filter(v => (v.state === 'unverified' || v.state === 'stale') &&
    repos.some(r => r.repo === v.repo && written(r) && !r.merged && !r.missing))
  if (unproven.length) {
    const said = unproven.map(v => v.state === 'stale' ? `${v.repo}'s pass was for an earlier diff` : `${v.repo} has no pass recorded at the diff it carries`)
    out.push(offer(phase, `${said.join('; ')} — run its checks, and a pass is kept against this patch`, `rig check ${unproven.map(v => v.repo).join(' ')} --run`))
  }

  // A branch that reached the remote and has no PR is the review phase waiting to start.
  // Asked of `pushed` as well as `unpushed`: `unpushed` reads 0 both for a branch that has
  // been pushed and for one nobody has written anything on, and nagging the second to open a
  // pull request for nothing is exactly the reproach this command does not make.
  // A repo whose PR lookup failed is neither: its PR may be open, and `rig pr` would refuse.
  const noPr = r => !r.pr && !r.prUnknown && !r.merged && !r.missing && r.unpushed === 0
  const untouched = repos.filter(r => noPr(r) && !r.pushed)
  const awaiting = repos.filter(r => noPr(r) && r.pushed && !stranded.includes(r))
  if (awaiting.length) {
    // Which release each of those PRs would ask for, said while a label can still change it
    // (decision 130), and said here alone: this is the offer that names the repos.
    const releases = bumps.filter(b => awaiting.some(r => r.repo === b.repo))
      .map(b => (awaiting.length === 1 ? `its PR would ask for ${b.release}` : `${b.repo}'s PR would ask for ${b.release}`))
    out.push(offer('reviewing', [`${awaiting.map(r => r.repo).join(', ')} ${awaiting.length === 1 ? 'is' : 'are'} pushed with no PR open`, ...releases].join(' — '), 'rig pr'))
  }

  if (entries.length >= HEAVY && !planExists) {
    out.push(offer('landing', `${entries.length} repos means deploy order matters — a rollout plan is worth having`, 'rig plan'))
  }

  // The read-back. An artifact nothing reads is how v1 ended up with a dead table containing
  // one blank row, and the rollout plan failed that test for its whole existence: `rig plan`
  // wrote it and nothing ever looked again. This is the something that looks.
  if (planStale) {
    out.push(offer('landing', 'the rollout plan\'s deploy order no longer matches the stack', 'rig plan --refresh'))
  }

  // The same read-back for the open pull request: its title and body, compared with what
  // `rig pr` would write now.
  if (prStale.length) {
    out.push(offer('reviewing', `${prStale.join(', ')}: the open PR no longer says what the record does`, 'rig pr --refresh'))
  }

  // Stage pull requests GitHub shows as unrelated, which a stack would show together and let
  // merge together (decision 152).
  if (unstacked.length) {
    out.push(offer('reviewing', `${unstacked.join(', ')}: the open stage PRs are not a GitHub stack`, 'rig stage --link'))
  }

  // After the PR is open, three steps in the order they run, each waiting for the one before
  // it (decision 168): the review already on the PR, the adversarial review the design chose,
  // then the hand-over to a human. The first is read off GitHub; the other two are read off
  // the record, because nothing on GitHub says a design chose a review or that one happened.
  // Asked only of open PRs: a phase of `reviewing` can be a PR closed unmerged, or one repo
  // merged beside another never opened, and neither has anything to review or hand over.
  const openPrs = phase === 'reviewing' ? repos.filter(r => r.pr?.state === 'OPEN') : []
  if (openPrs.length) {
    const reviewOf = r => reviews.find(t => t.repo === r.repo)
    const open = reviews.filter(t => t.unresolved > 0)
    if (open.length) {
      const counts = open.map(t => `${t.repo}: ${t.unresolved} unresolved review thread${t.unresolved === 1 ? '' : 's'}`)
      out.push(offer('reviewing', `${counts.join('; ')} — action what is worth actioning, reply to every thread, resolve ${open.length === 1 && open[0].unresolved === 1 ? 'it' : 'them'}`))
    }
    // Every open PR's threads known to be resolved. Unknown is not resolved: going on past a
    // count GitHub would not give is the "nobody could tell" mistake decision 62 exists to prevent.
    const resolved = openPrs.every(r => reviewOf(r)?.unresolved === 0)
    // A review recorded before the design was last agreed was a review of another design. Dates
    // are compared as instants, not strings, and one nobody can read is no review at all.
    const adversarial = work.adversarial === true && !(Date.parse(work.reviewedAt) >= (Date.parse(work.designedAt) || 0))
    if (adversarial && resolved) {
      out.push(offer('reviewing',
        'the design chose an adversarial review — a reviewer told to find what is wrong with the PR, fixing what it finds and pushing',
        'rig save -m "adversarial review" --reviewed'))
    }
    // A failing check is the PR's to fix. Where the base has moved past the branch, that is said
    // beside it as a possible cause and never as the cause: a moved base is ordinary in a busy
    // repo, and only a failure in code the diff never touched is a stale base's. The merge is a
    // command only on the work branch, so it never lands on a stage checked out instead.
    const failing = openPrs.filter(r => ['FAILURE', 'ERROR'].includes(reviewOf(r)?.checks))
    const moved = failing.filter(r => reviewOf(r).behind > 0)
    for (const r of moved) {
      const { base, behind } = reviewOf(r)
      const onWork = r.on === work.branch
      out.push(offer('reviewing',
        `${r.repo}: the PR's checks are failing — fix them before it is handed over; ${base} has ${behind} commit${behind === 1 ? '' : 's'} the branch does not, so a failure in code the diff never touched may be a stale base: merge it ${onWork ? 'in' : `into ${work.branch}`} first, then push`,
        onWork ? [`git merge origin/${base}`, `git push origin ${work.branch}`] : null))
    }
    const own = failing.filter(r => !moved.includes(r))
    if (own.length) {
      out.push(offer('reviewing', `${own.map(r => r.repo).join(', ')}: the PR's checks are failing — fix them before it is handed over`))
    }
    // Neither green nor failing — running, or required and never reported. Said, because the
    // hand-over waits on it, and a wait nothing names reads as "nothing to suggest".
    const unreported = openPrs.filter(r => ![null, 'SUCCESS', 'FAILURE', 'ERROR'].includes(reviewOf(r)?.checks ?? null))
    if (unreported.length) {
      out.push(offer('reviewing', `${unreported.map(r => `${r.repo} (${reviewOf(r).checks})`).join(', ')}: the PR's checks have not all reported — it is handed over once they pass`))
    }
    // The design gate passed, with its review choice; every check green or none set up; nothing
    // local left, or that nobody could count, including on a landed stage; no stage still to
    // come, no PR body behind the record, and no sibling PR closed without merging, since the
    // work cannot land as a whole while one is.
    const green = openPrs.every(r => [null, 'SUCCESS'].includes(reviewOf(r)?.checks ?? null))
    const pending = dirty.length || unpushed.length || stranded.length || awaiting.length || prStale.length || (stack.length && nextStage(stack)) ||
      repos.some(r => !r.merged && (r.missing || r.unpushed === null || r.pr?.state === 'CLOSED'))
    if (work.designedAt && resolved && !adversarial && green && !pending) {
      out.push(offer('reviewing', 'the PR is ready for a human reviewer — hand it over'))
    }
  }

  const merged = repos.filter(r => r.merged)
  if (merged.length && merged.length < repos.length) {
    const left = repos.filter(r => !r.merged).map(r => r.repo).join(', ')
    out.push(offer('landing', `${merged.length} of ${repos.length} merged — still out: ${left}`))
  }

  // A neighbour the catalogue names that is not attached. Decided here, above the floor, because
  // unlike the draft and close offers below it *is* about the work itself — its repo set — and a
  // floor saying "everything is attached" one line above "orders — not attached" contradicts
  // itself. Pushed further down, in the order the ladder reads.
  const offeringNeighbours = neighbours.length > 0 && ['planning', 'designing', 'building'].includes(phase)

  // The floor: repos attached, design agreed, nothing written anywhere. There is only one
  // thing left to do and rig is not the tool that does it. Asked here, before the draft and
  // close offers below are pushed, because both are about something other than the work
  // itself: a draft entry must not silence the one line that says the code is yours to write.
  const floor = !out.length && untouched.length === repos.length && !offeringNeighbours
  if (floor) {
    out.push(offer('building', 'everything is attached and agreed — this part is yours to write'))
  }

  // What the agent decided where the human chose not to stop, offered back to the human. Below
  // the floor, like the drafts, and addressed to the human by name: to the agent reading it, it
  // is no wait, and an unattended run goes on with the work. The human confirming it, with the
  // review choice it already made, records it as theirs and keeps the design's date.
  const decided = STOPPABLE.filter(n => work?.agentDecided?.includes(n))
  if (work?.designedAt && decided.length) {
    const choice = work.adversarial === false ? '--no-adversarial' : '--adversarial'
    out.push(offer(phase, `for the human: the agent decided ${decided.map(n => STOP_WORDS[n]).join(' and ')} — go over them, then record the design as theirs`, `rig save -m "design reviewed" --designed ${choice}`))
  }

  // Correcting the catalogue, offered while the worktrees still exist — which is the only span
  // in which the repos are both loaded in your head *and* on disk.
  //
  // `rig close` cannot be the moment, though it is the obvious guess. Not because of any
  // ordering inside close — the teardown does run before `commitAs`, which only sets the commit
  // dispatch makes after the command returns — but because **no rig command waits for a human**.
  // Close tears the worktrees down and exits, so a close that printed the request would be
  // asking for work to be done on repos it had already deleted. It keeps a last call naming the
  // entries; the offer lives here, in the command whose whole job is what is available now.
  //
  // **Above the close offer**, for the reason the dirty-tree rung is ranked first: `rig close`
  // ends the window this offer exists for, and a ladder read top-down would have run the
  // teardown before reaching the line that needed the trees.
  if (drafts.length) {
    const many = drafts.length > 1
    // Never a command. `rig catalog <repo>` shows an entry and names the file, but correcting
    // one is editing prose — the design gate above sets the precedent for an offer whose work
    // is a conversation and not a line to type.
    out.push(offer(phase,
      `the catalogue ${many ? `entries for ${drafts.join(', ')} are still drafts` : `entry for ${drafts[0]} is still a draft`}`
      + ` — correct ${many ? 'them' : 'it'} while the repo${many ? 's are' : ' is'} still in your head`
      + ` (\`rig catalog ${drafts[0]}\` names the file)`))
  }

  // What the work taught, asked once a pull request gives it a story to read, and in this
  // command rather than `close` for the same reason as the catalogue offer above: a lesson for
  // a repo is committed in its worktree, and close removes the trees and exits. Above the close
  // offer for that reason too. The skill does the conversation; the command records the gate.
  if (!work?.learnedAt && (phase === 'reviewing' || phase === 'landing')) {
    out.push(offer(phase,
      'what did this work teach? — the rig-learn skill offers each lesson a home',
      'rig save -m "lessons reviewed" --learned'))
  }

  // What landed and why it was worth doing, asked once everything has landed and the story is
  // still in hand. Above the close offer only because it reads as part of finishing; nothing it
  // needs goes with the trees, and `rig close` names it again on the way out.
  if (!work?.outcome && repos.length && merged.length === repos.length) {
    out.push(offer(phase,
      `what changed for someone, and why is that good? — a sentence or two; the ${work?.learnedAt ? 'rig-digest' : 'rig-learn'} skill drafts it`,
      'rig save --outcome "…"'))
  }

  // The user docs, kept true once everything has landed: offered only where a repo says where
  // its docs live, since a nag for a repo with none would be on every work. A repo beside it
  // with none is named, as an empty `check` is, with where to say it.
  const documented = docs.filter(d => d.targets.length)
  if (!work?.documentedAt && documented.length && repos.length && merged.length === repos.length) {
    const where = documented.map(d => `${d.repo}: ${d.targets.map(t => `\`${t}\``).join(', ')}`).join('; ')
    const none = docs.filter(d => !d.targets.length).map(d => d.missing
      ? `; ${d.repo} has no catalogue entry — write one at \`${d.missing}\`, with \`docs:\``
      : `; ${d.repo} has no docs target — \`docs:\` in its catalogue entry (\`rig catalog ${d.repo}\` names the file)`).join('')
    out.push(offer(phase,
      `once it is verified where it was deployed, keep the user docs true — the rig-docs skill drafts the edit (${where})${none}`,
      'rig save -m "user docs updated" --documented'))
  }

  // Rule 5 says attaching a fourth repo on day two is normal, and §6 says the repo you forget
  // is almost always one hop from one you remembered. This is that, with a graph behind it
  // rather than a reminder.
  //
  // **Only while the repos are still being chosen.** Offered through planning, designing and
  // building, and silent from `reviewing` on: once a pull request is open, adding a repo is a
  // different decision and one already taken, so naming it then is second-guessing rather than
  // offering. The declared graph only — a co-attachment from the records is evidence about the
  // catalogue rather than about this work, and `rig impact` is where it is asked for.
  //
  // One offer for all of them, not one each. `next` is read top to bottom, and a list that
  // grows a line per neighbour is the to-do list guardrail 1 exists to prevent.
  if (offeringNeighbours) {
    const reason = n => (n.direction === 'downstream' ? ` (a change in ${n.via} can break it)`
      : n.direction === 'upstream' ? ` (a change in it can break ${n.via})`
        : n.direction === 'both' ? ` (either can break the other)` : '')
    out.push(offer(phase,
      `${neighbours.map(n => `${n.repo} talks to ${n.via}${reason(n)}`).join('; ')} — not attached`,
      `rig attach ${neighbours[0].repo}`))
  }

  // A slice still up for review, or one GitHub would not answer for, is a refusal `close` makes
  // (decision 173), so offering it here would be a command that fails and a second answer one
  // line under the stage offer that just named the slice. The stack was in hand the whole time;
  // this asks it. Silence rather than a warning, because the stage offer above has already said
  // what is next.
  //
  // Last, because it is the one offer that takes the worktrees away.
  if (phase === 'landing' && !dirty.length && !stack.some(st => st.open) && !unknownStages(stack).length) {
    out.push(offer('landing', 'every PR is merged and nothing is uncommitted', 'rig close'))
  }

  return out
}
