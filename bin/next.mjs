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
import { nextStage } from './stages.mjs'

// One offer: the phase it belongs to, a line saying what is available, and the command that
// does it. `command` is null when there is nothing to type — agreeing a design is a
// conversation, and only the recording of it is a command.
const offer = (phase, says, command = null) => ({ phase, says, command })

// Everything `rig next` needs that it cannot work out for itself. Gathered by the caller so
// this module stays pure:
//
//   work           the record: repos, gates, tickets
//   repos          one `{ repo, merged, pr, dirty, ahead, pushed, missing }` per attached
//                  repo — what `workState` already decided for `list`, `status` and `close`,
//                  plus `pushed` from the worktree state
//   directionTodo  the context doc's Direction section is still the scaffolded `_TODO_`
//   planExists     a rollout plan has been scaffolded for this work
//   planStale      that plan has one, and its generated deploy order disagrees with the stack
//   stack          the work's stages, ordered and with their state (`stackOf`), empty when
//                  the work has none — which is most works, and is not a deficiency
//
// Returns the offers in the order they became available, most immediate first. An empty list
// means there is genuinely nothing to suggest, which `rig next` says out loud rather than
// inventing something.
export function nextFor ({ work, repos = [], directionTodo = false, planExists = false, planStale = false, stack = [] } = {}) {
  const phase = phaseOf(work, repos)
  const out = []

  // Terminal first: a stopped work has no next step, and saying so is a real answer.
  if (phase === 'closed' || phase === 'abandoned') return out

  const entries = work?.repos || []

  if (!entries.length) {
    out.push(offer('planning', 'nothing is attached yet — pick the repos this touches', 'rig prompt select-repos'))
    return out
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
      out.push(offer('reviewing', `every stage is in — the work branch is what is left to land`, 'rig pr'))
    }
  }

  // `ahead` is `null`, never 0, when git could not measure the distance at all — which is the
  // *ordinary* state of a branch whose PR was squash-merged and whose refs are gone (decision
  // 62). Every filter below therefore compares it explicitly: `!r.ahead` is true for both 0 and
  // null, and treating "nobody could tell" as "nothing outstanding" is the exact mistake
  // decision 62 exists to prevent, one command further along.
  //
  // A repo whose distance is unknown matches none of these and is simply not spoken about. That
  // is deliberate: this command offers, and there is nothing to offer about a fact nobody has.
  // `workState` already blocks a close on the same condition, which is where a refusal belongs.
  const unpushed = repos.filter(r => !r.merged && r.ahead > 0)
  if (unpushed.length) {
    out.push(offer('building', `${unpushed.map(r => r.repo).join(', ')} ${unpushed.length === 1 ? 'has' : 'have'} commits that are not pushed`, 'git push'))
  }

  // A branch that reached the remote and has no PR is the review phase waiting to start.
  // Asked of `pushed` rather than `ahead`: `ahead` counts what is *un*pushed and reads 0 both
  // for a branch that has been pushed and for one nobody has written anything on, and nagging
  // the second to open a pull request for nothing is exactly the reproach this command does
  // not make.
  const untouched = repos.filter(r => !r.pr && !r.merged && !r.missing && r.ahead === 0 && !r.pushed)
  const awaiting = repos.filter(r => !r.pr && !r.merged && !r.missing && r.ahead === 0 && r.pushed)
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

  // A slice still up for review is a refusal `close` makes, so offering it here would be a
  // command that fails and a second answer one line under the stage offer that just named the
  // slice. The stack was in hand the whole time; this asks it. Silence rather than a warning,
  // because the stage offer above has already said what is next.
  if (phase === 'landing' && !dirty.length && !stack.some(st => st.open)) {
    out.push(offer('landing', 'every PR is merged and nothing is uncommitted', 'rig close'))
  }

  // The floor: repos attached, design agreed, nothing written anywhere. There is only one
  // thing left to do and rig is not the tool that does it.
  if (!out.length && untouched.length === repos.length) {
    out.push(offer('building', 'everything is attached and agreed — this part is yours to write'))
  }

  return out
}
