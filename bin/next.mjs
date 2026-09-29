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

import { phaseOf } from './phase.mjs'
import { backToWorkBranch, nextStage, onLandedStage } from './stages.mjs'

// One offer: the phase it belongs to, a line saying what is available, and the command that
// does it. `command` is null when there is nothing to type — agreeing a design is a
// conversation, and only the recording of it is a command — and a list of lines, run in
// order, when there is more than one.
const offer = (phase, says, command = null) => ({ phase, says, command })

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
//   stack          the work's stages, ordered and with their state (`stackOf`), empty when
//                  the work has none — which is most works, and is not a deficiency
//   replaced       one `{ repo, branch, head, ... }` per merged stage `worktrees.replaced`
//                  answered for, with what it answered: `head` is the commit its PR carried
//   drafts         the attached repos whose catalogue entry is still `DRAFT: unreviewed`
//   neighbours     one `{ repo, via, direction }` per repo the catalogue says talks to an
//                  attached one and which is not itself attached — `via` is the attached repo
//                  it was reached from, `direction` its stated direction or null
//
// Returns the offers in the order they became available, most immediate first. An empty list
// means there is genuinely nothing to suggest, which `rig next` says out loud rather than
// inventing something.
export function nextFor ({ work, repos = [], directionTodo = false, planExists = false, planStale = false, stack = [], replaced = [], drafts = [], neighbours = [] } = {}) {
  const phase = phaseOf(work, repos)
  const out = []

  // Terminal first: a stopped work has no next step, and saying so is a real answer.
  if (phase === 'closed' || phase === 'abandoned') return out

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
  // exactly why this lives here and not in `doctor`.
  if (!work?.designedAt) {
    out.push(directionTodo
      ? offer('designing', 'the context doc\'s Direction is still `_TODO_` — agree the approach, write it down, then record the gate', 'rig save -m "design agreed" --designed')
      : offer('designing', 'Direction is written but the design gate is not recorded', 'rig save -m "design agreed" --designed'))
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
      const where = up.started
        ? `${up.repos.join(', ')}${up.open ? ' — up for review' : ''}${up.adrift ? ' — outside the stack' : ''}`
        : 'not cut in any repo yet'
      out.push(offer('building', `stage ${stack.indexOf(up) + 1} of ${stack.length}: ${up.branch}${up.delivers ? ` — ${up.delivers}` : ''} (${where})`))
    } else {
      const on = new Map()
      for (const r of stranded) on.set(r.on, [...(on.get(r.on) || []), r.repo])
      const where = [...on].map(([b, rs]) => `${rs.join(', ')} ${rs.length === 1 ? 'is' : 'are'} still on ${b}, which has landed`).join('; ')
      out.push(stranded.length
        ? offer('reviewing', `every stage is in — ${where} — move ${stranded.length === 1 ? 'it' : 'each'} to the work branch, then \`rig pr\``, backToWorkBranch(work))
        : offer('reviewing', `every stage is in — the work branch is what is left to land`, 'rig pr'))
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
  if (unpushed.length) {
    out.push(offer('building', `${unpushed.map(r => r.repo).join(', ')} ${unpushed.length === 1 ? 'has' : 'have'} commits that are not pushed`, 'git push'))
  }

  // A branch that reached the remote and has no PR is the review phase waiting to start.
  // Asked of `pushed` as well as `unpushed`: `unpushed` reads 0 both for a branch that has
  // been pushed and for one nobody has written anything on, and nagging the second to open a
  // pull request for nothing is exactly the reproach this command does not make.
  const untouched = repos.filter(r => !r.pr && !r.merged && !r.missing && r.unpushed === 0 && !r.pushed)
  const awaiting = repos.filter(r => !r.pr && !r.merged && !r.missing && r.unpushed === 0 && r.pushed && !stranded.includes(r))
  if (awaiting.length) {
    out.push(offer('reviewing', `${awaiting.map(r => r.repo).join(', ')} ${awaiting.length === 1 ? 'is' : 'are'} pushed with no PR open`, 'rig pr'))
  }

  // Three repos is where deploy order stops being obvious and starts being a thing that
  // causes incidents. Two is a pair you can hold in your head; this is the weight threshold,
  // derived from the repo count and nothing anybody declared.
  if (entries.length >= 3 && !planExists) {
    out.push(offer('landing', `${entries.length} repos means deploy order matters — a rollout plan is worth having`, 'rig plan'))
  }

  // The read-back. An artifact nothing reads is how v1 ended up with a dead table containing
  // one blank row, and the rollout plan failed that test for its whole existence: `rig plan`
  // wrote it and nothing ever looked again. This is the something that looks.
  if (planStale) {
    out.push(offer('landing', 'the rollout plan\'s deploy order no longer matches the stack', 'rig plan --refresh'))
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

  // A slice still up for review is a refusal `close` makes, so offering it here would be a
  // command that fails and a second answer one line under the stage offer that just named the
  // slice. The stack was in hand the whole time; this asks it. Silence rather than a warning,
  // because the stage offer above has already said what is next.
  //
  // Last, because it is the one offer that takes the worktrees away.
  if (phase === 'landing' && !dirty.length && !stack.some(st => st.open)) {
    out.push(offer('landing', 'every PR is merged and nothing is uncommitted', 'rig close'))
  }

  return out
}
