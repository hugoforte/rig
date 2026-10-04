// What `rig next` offers, over fixtures. Pure decisions, so every rung of the ladder is one
// object literal away from being asserted — and the two guardrails are assertable too, which
// is the point of testing this at all: "only ever offers" is a property of the whole output,
// not of any one line.
import test from 'node:test'
import assert from 'node:assert/strict'

import { nextFor } from '../bin/next.mjs'

const AT = '2026-09-19T10:00:00.000Z'

const work = (over = {}) => ({ id: 'w', branch: 'feat/x', repos: [], ...over })
const repo = (name, over = {}) => ({ repo: name, merged: false, pr: null, dirty: 0, unpushed: 0, pushed: false, missing: false, ...over })
const attached = (...names) => names.map(n => ({ repo: n }))
const says = out => out.map(o => o.says).join(' | ')
const commands = out => out.map(o => o.command).filter(Boolean)

test('a work with nothing attached is pointed at the repo interview', () => {
  const out = nextFor({ work: work() })
  assert.equal(out.length, 1)
  assert.equal(out[0].phase, 'planning')
  assert.equal(out[0].command, 'rig prompt select-repos')
})

test('the design gate is offered while it is unrecorded, and names the Direction when it is a stub', () => {
  const out = nextFor({ work: work({ repos: attached('a') }), repos: [repo('a')], directionTodo: true })
  assert.match(says(out), /Direction is still `_TODO_`/)
  assert.ok(commands(out).includes('rig save -m "design agreed" --designed --adversarial'))
  assert.match(says(out), /adversarial review \(`--no-adversarial` declines it\)/, 'both answers are named')
})

test('once the Direction is written the offer is only about the gate', () => {
  const out = nextFor({ work: work({ repos: attached('a') }), repos: [repo('a')], directionTodo: false })
  assert.match(says(out), /Direction is written but the design gate is not recorded/)
})

test('a recorded design gate stops being offered', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')] })
  assert.doesNotMatch(says(out), /design gate/)
})

// ------------------------------------------------- the stops a work chose

test('where the design is not a stop, the agent is offered the gate to record itself, with an adversarial review', () => {
  const out = nextFor({ work: work({ repos: attached('a'), stops: ['repos'] }), repos: [repo('a')] })
  assert.ok(commands(out).includes('rig save -m "design agreed" --designed --adversarial --by-agent'))
  assert.match(says(out), /the design is not a stop on this work/)
})

test('a work grown to three repos waits for the human at the design all the same', () => {
  const out = nextFor({ work: work({ repos: attached('a', 'b', 'c'), stops: [] }), repos: [repo('a'), repo('b'), repo('c')] })
  assert.ok(commands(out).includes('rig save -m "design agreed" --designed --adversarial'))
  assert.match(says(out), /3 repos is more than a skipped stop was chosen for — the design waits for the human/)
})

test('a gate the agent decided is offered to the human for review', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT, adversarial: true, agentDecided: ['repos', 'design'] }), repos: [repo('a')] })
  assert.match(says(out), /the agent decided the repo set and the design — go over them with the human/)
  assert.ok(commands(out).includes('rig save -m "design reviewed" --designed --adversarial'))
})

test('the review keeps the adversarial-review choice the design made', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT, adversarial: false, agentDecided: ['design'] }), repos: [repo('a')] })
  assert.ok(commands(out).includes('rig save -m "design reviewed" --designed --no-adversarial'))
})

test('a work whose gates the human decided is offered no review of them', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT, adversarial: true }), repos: [repo('a')] })
  assert.doesNotMatch(says(out), /the agent decided/)
})

test('uncommitted changes are named before anything that would build on them', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [repo('a', { dirty: 3 }), repo('b', { unpushed: 1 })],
  })
  assert.match(out[0].says, /uncommitted changes in a/)
})

test('unpushed commits are offered a push, and not also a pull request', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { unpushed: 2 })],
  })
  assert.match(says(out), /commits that are not pushed/)
  assert.doesNotMatch(says(out), /no PR open/, 'one branch state, one offer')
})

test('the push it offers names the branch, since a bare push goes to the base (#259)', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b', 'c'), designedAt: AT, stages: [{ branch: 'feat/x-stage' }] }),
    repos: [repo('a', { unpushed: 2, on: 'feat/x' }), repo('b', { unpushed: 1, on: 'feat/x' }), repo('c', { unpushed: 1, on: 'feat/x-stage' })],
  })
  assert.deepEqual(out.find(o => /not pushed/.test(o.says)).command, ['git push origin feat/x', 'git push origin feat/x-stage'])
})

test('a worktree switched off this work\'s branches is offered no push, so the base is never pushed to by name', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { unpushed: 1, on: 'main' })],
  })
  assert.equal(out.find(o => /a has commits that are not pushed/.test(o.says)).command, null)
})

test('a declared stage\'s branch is offered its push', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT, stages: [{ branch: 'feat/x-stage' }] }),
    repos: [repo('a', { unpushed: 1, on: 'feat/x-stage' })],
  })
  assert.deepEqual(out.find(o => /not pushed/.test(o.says)).command, ['git push origin feat/x-stage'])
})

test('a detached HEAD with unpushed commits is named, and offered no push it would not make', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { unpushed: 1, on: null })],
  })
  assert.equal(out.find(o => /a has commits that are not pushed/.test(o.says)).command, null)
})

test('a branch ahead of its base but wholly on the remote is not offered a push (#192)', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { ahead: 3, unpushed: 0, pushed: true })],
  })
  assert.doesNotMatch(says(out), /not pushed/)
  assert.match(says(out), /a is pushed with no PR open/)
})

test('a pushed branch with no PR is offered one', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { pushed: true })],
  })
  assert.match(says(out), /a is pushed with no PR open/)
  assert.ok(commands(out).includes('rig pr'))
})

test('a branch nobody has written on is never nagged about opening a PR', () => {
  // `unpushed` reads 0 both for a pushed branch and for one with nothing on it, which is why
  // this rung asks `pushed` instead. Getting it wrong here is a reproach, and this command
  // does not make them.
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')] })
  assert.doesNotMatch(says(out), /no PR open/)
  assert.match(says(out), /yours to write/)
})

test('an unpushed count git could not make is never read as nothing outstanding', () => {
  // `unpushed: null` is what `worktrees.state()` answers when git could not count at all.
  // Read as 0 it means "pushed, waiting for a PR", which is a confident answer to a question
  // nobody could answer (decision 62).
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { unpushed: null, pushed: true })],
  })
  assert.doesNotMatch(says(out), /no PR open/)
  assert.doesNotMatch(says(out), /not pushed/)
})

test('nor as work waiting to be written', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { unpushed: null, pushed: false })],
  })
  assert.doesNotMatch(says(out), /yours to write/)
})

// ---------------------------------------------------------------- weight, derived

test('one repo is never offered a rollout plan', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')] })
  assert.doesNotMatch(says(out), /rollout plan/)
})

test('three repos are, because that is where deploy order starts causing incidents', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b', 'c'), designedAt: AT }),
    repos: [repo('a'), repo('b'), repo('c')],
  })
  assert.match(says(out), /3 repos means deploy order matters/)
  assert.ok(commands(out).includes('rig plan'))
})

test('and not twice — a plan that exists is not offered again', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b', 'c'), designedAt: AT }),
    repos: [repo('a'), repo('b'), repo('c')],
    planExists: true,
  })
  assert.doesNotMatch(says(out), /rollout plan/)
})

// ---------------------------------------------------------------- landing and after

test('a partly merged work says what is still out', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [repo('a', { merged: true, pr: { number: 1, state: 'MERGED' } }), repo('b', { unpushed: 1 })],
  })
  assert.match(says(out), /1 of 2 merged — still out: b/)
})

test('everything merged and clean is offered the close', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { merged: true, pr: { number: 1, state: 'MERGED' } })],
  })
  assert.ok(commands(out).includes('rig close'))
})

test('everything merged but a dirty tree is not offered the close', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { merged: true, pr: { number: 1, state: 'MERGED' }, dirty: 1 })],
  })
  assert.ok(!commands(out).includes('rig close'))
  assert.match(says(out), /uncommitted changes/)
})

test('a stopped work has nothing to offer, and that is an answer', () => {
  assert.deepEqual(nextFor({ work: work({ repos: attached('a'), closedAt: AT }), repos: [repo('a')] }), [])
  assert.deepEqual(nextFor({ work: work({ repos: attached('a'), closedAt: AT, abandonedAt: AT }), repos: [repo('a')] }), [])
})

test('a stopped work whose folder is still on this machine is offered rig close, and nothing else', () => {
  const out = nextFor({ work: work({ repos: attached('a'), closedAt: AT }), repos: [repo('a')], leftover: true, drafts: ['a'] })
  assert.deepEqual(commands(out), ['rig close'])
})

// ---------------------------------------------------------------- stages

const stage = (branch, over = {}) => ({ branch, delivers: '', repos: [], started: false, open: false, landed: false, prs: [], ...over })

test('a work with stages is told which one is next, and what it delivers', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a')],
    stack: [
      stage('feat/one', { landed: true, started: true, repos: ['a'] }),
      stage('feat/two', { delivers: 'the endpoints', started: true, repos: ['a'], open: true }),
    ],
  })
  assert.match(says(out), /stage 2 of 2: feat\/two — the endpoints \(a — up for review\)/)
})

test('a stage nobody has cut yet says so rather than claiming progress', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a')],
    stack: [stage('feat/one')],
  })
  assert.match(says(out), /stage 1 of 1: feat\/one \(not cut in any repo yet\)/)
})

test('every stage in makes the work branch the thing that is left', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { pushed: true })],
    stack: [stage('feat/one', { landed: true, started: true, repos: ['a'] })],
  })
  assert.match(says(out), /every stage is in — the work branch is what is left to land/)
})

test('a branch whose PR lookup failed is never said to have no PR open', () => {
  // gh signed out over an open PR: offering `rig pr` would be a command that refuses, and "no
  // PR open" a claim nobody checked (decision 169).
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [repo('a', { pushed: true, prUnknown: 'gh is not authenticated' }), repo('b', { prUnknown: 'gh is not authenticated' })],
    bumps: [{ repo: 'a', release: 'a minor release (the branch prefix `feat/`)' }],
  })
  assert.doesNotMatch(says(out), /no PR open|would ask for|nothing has been written/)
  assert.ok(!commands(out).includes('rig pr'))
})

test('which release a PR would ask for is said once, beside the offer that names its repo (#228)', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { pushed: true })],
    stack: [stage('feat/one', { landed: true, started: true, repos: ['a'] })],
    bumps: [{ repo: 'a', release: 'a minor release (the branch prefix `feat/`)' }],
  })
  assert.match(says(out), /a is pushed with no PR open — its PR would ask for a minor release \(the branch prefix `feat\/`\)/)
  assert.equal(says(out).match(/would ask for/g).length, 1, 'not again beside "every stage is in"')
})

test('a repo that is not ready for its PR is not named beside another\'s release (#228)', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [repo('a', { pushed: true, unpushed: 2 }), repo('b', { pushed: true })],
    bumps: [{ repo: 'a', release: 'a minor release' }, { repo: 'b', release: 'a patch release' }],
  })
  assert.match(says(out), /b is pushed with no PR open — its PR would ask for a patch release/)
  assert.doesNotMatch(says(out), /a minor release/)
})

test('every stage in, with a worktree still on a stage that landed, names the switch to the work branch (#200)', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [repo('a', { on: 'feat/one' }), repo('b', { on: 'feat/x' })],
    stack: [stage('feat/one', { landed: true, started: true, repos: ['a'] })],
  })
  const o = out.find(x => /every stage is in/.test(x.says))
  assert.match(o.says, /a is still on feat\/one, which has landed — move it to the work branch, then `rig pr`/)
  assert.deepEqual(o.command, ['git switch feat/x', 'git pull --ff-only origin feat/x'])
})

test('a worktree on a landed stage is offered the move, and not also a push or a pull request', () => {
  // Pushed, with no PR on the work branch: the state the move is offered in. Offering `rig pr`
  // or `git push` beside it would be acting from the stage the worktree is leaving.
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { on: 'feat/one', pushed: true, unpushed: 1 })],
    stack: [stage('feat/one', { landed: true, started: true, repos: ['a'] })],
  })
  assert.deepEqual(commands(out), [['git switch feat/x', 'git pull --ff-only origin feat/x']])
})

test('several repos on one landed stage are named together', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [repo('a', { on: 'feat/one' }), repo('b', { on: 'feat/one' })],
    stack: [stage('feat/one', { landed: true, started: true, repos: ['a', 'b'] })],
  })
  assert.match(says(out), /every stage is in — a, b are still on feat\/one, which has landed — move each to the work branch/)
})

test('a worktree already on the work branch is not told to move', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { on: 'feat/x' })],
    stack: [stage('feat/one', { landed: true, started: true, repos: ['a'] })],
  })
  assert.ok(commands(out).includes('rig pr'))
  assert.doesNotMatch(says(out), /still on/)
})

const HEAD = 'a'.repeat(40)
const squashStack = () => [
  stage('feat/one', { landed: true, started: true, repos: ['a'] }),
  stage('feat/two', { started: true, repos: ['a'], open: true }),
  stage('feat/three', { started: true, repos: ['a'], open: true }),
]
const replacedOffer = (replaced, over = {}) => nextFor({
  work: work({ repos: attached('a'), designedAt: AT }),
  repos: [repo('a', over)],
  stack: squashStack(),
  replaced: [{ repo: 'a', branch: 'feat/one', head: HEAD, ...replaced }],
}).find(x => /feat\/one/.test(x.says) && !/^stage /.test(x.says))

test('a stage squashed under the one above it is offered the rebase, with the real sha (#193)', () => {
  const o = replacedOffer({ carriers: ['feat/two'], rebased: false, behind: [], sameTree: true })
  assert.match(o.says, /feat\/one landed as new commits \(a squash or a rebase\), and feat\/two in a still carries the commits it replaced/)
  assert.deepEqual(o.command, ['git switch feat/two', `git rebase --onto origin/feat/x ${HEAD}`, 'git push --force-with-lease origin feat/two'])
})

test('several stages carrying it are replayed in one rebase from the top, and each is pushed', () => {
  const o = replacedOffer({ carriers: ['feat/two', 'feat/three'], rebased: false, behind: [], sameTree: true })
  assert.deepEqual(o.command, ['git switch feat/three', `git rebase --update-refs --onto origin/feat/x ${HEAD}`,
    'git push --force-with-lease origin feat/two', 'git push --force-with-lease origin feat/three'])
})

test('once the stages are replayed here, only the push is offered, and not a plain git push', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { unpushed: 1 })],
    stack: squashStack(),
    replaced: [{ repo: 'a', branch: 'feat/one', head: HEAD, carriers: ['feat/two'], rebased: true, behind: ['feat/two'], sameTree: true }],
  })
  assert.ok(commands(out).some(c => String(c) === 'git push --force-with-lease origin feat/two'))
  assert.ok(!out.some(o => /commits that are not pushed/.test(o.says)), 'no plain push beside it')
})

test('a squash that is not the stage as it stood is named, and no command is offered for it', () => {
  const o = replacedOffer({ carriers: ['feat/two'], rebased: false, behind: [], sameTree: false })
  assert.match(o.says, /is not the stage as it stood/)
  assert.equal(o.command, null)
})

test('a stage whose copy here is behind the remote\'s is named, and no command is offered for it', () => {
  const o = replacedOffer({ carriers: ['feat/two'], rebased: false, behind: ['feat/two'], sameTree: true })
  assert.match(o.says, /the copy here of feat\/two is behind the remote's/)
  assert.equal(o.command, null)
})

test('a merge this machine has not fetched is offered the fetch', () => {
  const o = replacedOffer({ unfetched: true })
  assert.match(o.says, /feat\/one merged in a, and this machine has not fetched it/)
  assert.equal(o.command, 'git fetch origin')
})

test('a work with no stages behaves exactly as it did before stages existed', () => {
  const withNone = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')] })
  const withEmpty = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')], stack: [] })
  assert.deepEqual(withNone, withEmpty)
  assert.doesNotMatch(says(withNone), /stage/)
})

// ---------------------------------------------------------------- the guardrails

test('it only ever offers: nothing it says is a warning or a reproach', () => {
  // Every shape of work this module knows about, run through one assertion. The guardrail is
  // a property of the whole output, so this is the test that would catch it eroding.
  const shapes = [
    { work: work() },
    { work: work({ repos: attached('a') }), repos: [repo('a')], directionTodo: true },
    { work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a', { dirty: 2, unpushed: 1 })] },
    { work: work({ repos: attached('a', 'b', 'c'), designedAt: AT }), repos: [repo('a'), repo('b'), repo('c')] },
    { work: work({ repos: attached('a'), stops: [] }), repos: [repo('a')] },
    { work: work({ repos: attached('a', 'b', 'c'), stops: [] }), repos: [repo('a'), repo('b'), repo('c')] },
    { work: work({ repos: attached('a'), designedAt: AT, adversarial: true, agentDecided: ['repos', 'design'] }), repos: [repo('a')] },
    {
      work: work({ repos: attached('a'), designedAt: AT }),
      repos: [repo('a', { merged: true, pr: { number: 1, state: 'MERGED' } })],
    },
  ]
  for (const s of shapes) {
    for (const o of nextFor(s)) {
      assert.doesNotMatch(o.says, /should have|you failed|missing|must |required|error/i,
        `"${o.says}" reads as a reproach, and this command never reproaches`)
    }
  }
})

test('every offer names the phase it belongs to', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b', 'c'), designedAt: AT }),
    repos: [repo('a', { unpushed: 1 }), repo('b'), repo('c')],
  })
  assert.ok(out.length > 0)
  for (const o of out) assert.match(o.phase, /^(planning|designing|building|reviewing|landing)$/)
})

// Correcting the catalogue is offered while the worktrees still exist — through building,
// reviewing and landing — because that is the only span in which the repos are both loaded in
// the operator's head and present on disk. `rig close` cannot be the moment: it commits before
// it removes the worktrees, and no rig command waits for a human.
test('a draft catalogue entry for an attached repo is offered for correction', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [repo('a'), repo('b')],
    drafts: ['a'],
  })
  assert.match(says(out), /catalogue entry for a is still a draft/)
})

test('the correction carries no command, because editing prose is not one', () => {
  // Same idiom as the design gate: an offer whose work is a conversation names no command. The
  // line points at `rig catalog`, which shows the entry and names its file, and stops there —
  // rig has no edit mode and should not grow one.
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')], drafts: ['a'] })
  const catalogue = out.find(o => /catalogue/.test(o.says))
  assert.equal(catalogue.command, null)
  assert.match(catalogue.says, /`rig catalog a` names the file/)
})

test('several drafts are one offer, because they are one sitting of work', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [repo('a'), repo('b')],
    drafts: ['a', 'b'],
  })
  assert.equal(out.filter(o => /catalogue entr/.test(o.says)).length, 1)
  assert.match(says(out), /catalogue entries for a, b are still drafts/)
})

test('correcting the catalogue is offered, never demanded', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a')],
    drafts: ['a'],
  })
  assert.doesNotMatch(says(out), /should|must|need to|failed/i)
})

test('no drafts means nothing is said about the catalogue', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')], drafts: [] })
  assert.doesNotMatch(says(out), /catalogue/)
})

test('a closed work is not asked to correct anything: the worktrees are already gone', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT, closedAt: AT }),
    repos: [repo('a', { merged: true })],
    drafts: ['a'],
  })
  assert.deepEqual(out, [])
})

test('the catalogue offer comes above rig close, which ends the window it exists for', () => {
  // Read top-down, a close offered first is a teardown run before the line that needed the
  // worktrees. Same argument as ranking uncommitted changes first.
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { merged: true, pr: { state: 'MERGED' } })],
    drafts: ['a'],
  })
  const order = out.map(o => o.says)
  const cat = order.findIndex(s => /catalogue/.test(s))
  const close = order.findIndex(s => /every PR is merged/.test(s))
  assert.ok(close !== -1, 'the close offer is reachable in this state')
  assert.ok(cat < close, 'the correction is offered before the command that removes the trees')
})

test('a draft entry does not silence the line saying the code is yours to write', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a')], drafts: ['a'] })
  assert.match(says(out), /this part is yours to write/)
  assert.match(says(out), /catalogue entry for a is still a draft/)
})
test('the catalogue offer comes after the work itself, never ahead of unsaved changes', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { dirty: 2 })],
    drafts: ['a'],
  })
  const order = out.map(o => o.says)
  assert.ok(order.findIndex(s => /uncommitted/.test(s)) < order.findIndex(s => /catalogue/.test(s)))
})

// -------------------------------------------------- the neighbours not attached

// Rule 5's "attaching a fourth repo on day two is normal", with something behind it. The
// gathering is the caller's — this asserts only what is worth offering, and that it stops
// being worth offering once the pull requests are open.

const near = (repo, via, direction = null) => ({ repo, via, direction })

test('a repo the catalogue says talks to an attached one, and is not attached, is offered', () => {
  const out = nextFor({
    work: work({ repos: attached('billing'), designedAt: AT }),
    repos: [repo('billing')],
    neighbours: [near('orders', 'billing', 'downstream')],
  })
  assert.match(says(out), /orders talks to billing/)
  assert.ok(commands(out).includes('rig attach orders'))
})

test('the direction rides along when the catalogue states one, and is left out when it does not', () => {
  const stated = nextFor({
    work: work({ repos: attached('billing'), designedAt: AT }),
    repos: [repo('billing')],
    neighbours: [near('orders', 'billing', 'downstream')],
  })
  assert.match(says(stated), /a change in billing can break it/)

  const silent = nextFor({
    work: work({ repos: attached('billing'), designedAt: AT }),
    repos: [repo('billing')],
    neighbours: [near('orders', 'billing')],
  })
  assert.doesNotMatch(says(silent), /can break/)
})

test('several neighbours are one offer, not one each', () => {
  const out = nextFor({
    work: work({ repos: attached('billing'), designedAt: AT }),
    repos: [repo('billing')],
    neighbours: [near('orders', 'billing'), near('ledger', 'billing')],
  })
  assert.equal(out.filter(o => /talks to/.test(o.says)).length, 1)
})

test('nothing is offered once the work is up for review — attaching a repo then is a different decision', () => {
  const out = nextFor({
    work: work({ repos: attached('billing'), designedAt: AT }),
    repos: [repo('billing', { pr: { number: 7, state: 'OPEN' }, pushed: true })],
    neighbours: [near('orders', 'billing')],
  })
  assert.doesNotMatch(says(out), /talks to/)
})

test('the offer is an offer: it never warns and never refuses', () => {
  const out = nextFor({
    work: work({ repos: attached('billing'), designedAt: AT }),
    repos: [repo('billing')],
    neighbours: [near('orders', 'billing')],
  })
  assert.doesNotMatch(says(out), /should|must|missing|forgot/i)
})

test('the floor does not say everything is attached one line above a repo that is not', () => {
  const out = nextFor({
    work: work({ repos: attached('billing'), designedAt: AT }),
    repos: [repo('billing')],
    neighbours: [near('orders', 'billing')],
  })
  assert.doesNotMatch(says(out), /everything is attached/)
  assert.match(says(out), /orders talks to billing/)
})

test('with no neighbour to offer, the floor still says the code is yours to write', () => {
  const out = nextFor({ work: work({ repos: attached('billing'), designedAt: AT }), repos: [repo('billing')] })
  assert.match(says(out), /everything is attached and agreed/)
})

// ------------------------------------------------------------- the lesson review

// What the work taught is asked once there is a story to read — a pull request — and while
// the worktrees are still on disk, because a lesson for a repo has to be committed in one.
// `rig close` cannot ask it for the reason it cannot ask for catalogue corrections.

const inReview = () => repo('a', { pr: { number: 1, state: 'OPEN' } })
const landed = () => repo('a', { merged: true, pr: { number: 1, state: 'MERGED' } })

test('a work under review is offered the lesson review', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [inReview()] })
  assert.match(says(out), /rig-learn/)
  assert.ok(commands(out).includes('rig save -m "lessons reviewed" --learned'))
})

test('a work still being built is not asked what it taught', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a', { unpushed: 1 })] })
  assert.doesNotMatch(says(out), /rig-learn/)
})

test('a recorded lesson review is not offered again', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT, learnedAt: AT }), repos: [landed()] })
  assert.doesNotMatch(says(out), /rig-learn/)
})

test('the lesson review comes above rig close, which removes the trees a repo lesson lands in', () => {
  const order = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [landed()] }).map(o => o.says)
  const learn = order.findIndex(s => /rig-learn/.test(s))
  const close = order.findIndex(s => /every PR is merged/.test(s))
  assert.ok(learn !== -1 && close !== -1, 'both are reachable in this state')
  assert.ok(learn < close)
})

test('the lesson review is offered, never demanded', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [landed()] })
  assert.doesNotMatch(says(out), /should|must|need to|failed/i)
})

// ------------------------------------------------------------- the outcome

// What landed and why it was worth doing, asked once there is something landed to say it of.

const OUTCOME = 'rig save --outcome "…"'

test('a work whose PRs have all merged is offered the outcome', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [landed()] })
  assert.ok(commands(out).includes(OUTCOME))
})

test('a work with a PR still to merge is not asked its outcome', () => {
  const out = nextFor({ work: work({ repos: attached('a', 'b'), designedAt: AT }), repos: [landed(), repo('b', { pr: { number: 2, state: 'OPEN' } })] })
  assert.ok(!commands(out).includes(OUTCOME))
})

test('a recorded outcome is not offered again', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT, outcome: { text: 'It landed.', at: AT } }), repos: [landed()] })
  assert.ok(!commands(out).includes(OUTCOME))
})

test('the outcome offer names the skill that drafts it, while the lesson review is still to run', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [landed()] })
  assert.match(out.find(o => o.command === OUTCOME).says, /the rig-learn skill drafts it/)
})

test('once the lesson review has run, the outcome offer names the digest skill instead', () => {
  // The review usually runs while a PR is still open, before there is an outcome to draft.
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT, learnedAt: AT }), repos: [landed()] })
  const says = out.find(o => o.command === OUTCOME).says
  assert.doesNotMatch(says, /rig-learn/)
  assert.match(says, /the rig-digest skill drafts it/)
})

test('the outcome is offered, never demanded', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT, learnedAt: AT }), repos: [landed()] })
  const offer = out.find(o => o.command === OUTCOME)
  assert.doesNotMatch(offer.says, /should|must|need to|missing/i)
})

// ------------------------------------------------------------- the user docs

// Kept true once the work has landed and been seen working where it was deployed: offered for
// a work whose repos say where their user docs live, and recorded like the lesson review.

const DOCUMENTED = 'rig save -m "user docs updated" --documented'
const docsAt = (...targets) => [{ repo: 'a', targets }]

test('a landed work whose repo has a docs target is offered the docs edit', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [landed()], docs: docsAt('docs/guide.md') })
  const offer = out.find(o => o.command === DOCUMENTED)
  assert.ok(offer, commands(out).join(', '))
  assert.match(offer.says, /the rig-docs skill drafts the edit/)
  assert.match(offer.says, /a: `docs\/guide\.md`/, 'and says where the docs live')
})

test('a work with a PR still to merge is not offered the docs edit', () => {
  const out = nextFor({ work: work({ repos: attached('a', 'b'), designedAt: AT }), repos: [landed(), repo('b', { pr: { number: 2, state: 'OPEN' } })], docs: docsAt('docs/') })
  assert.ok(!commands(out).includes(DOCUMENTED))
})

test('recorded docs are not offered again', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT, documentedAt: AT }), repos: [landed()], docs: docsAt('docs/') })
  assert.ok(!commands(out).includes(DOCUMENTED))
})

test('a work none of whose repos has a docs target is not offered the docs edit', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [landed()], docs: [{ repo: 'a', targets: [] }] })
  assert.ok(!commands(out).includes(DOCUMENTED))
})

test('the docs offer names an attached repo with no docs target, with where to say it', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [landed(), repo('b', { merged: true, pr: { number: 2, state: 'MERGED' } })],
    docs: [{ repo: 'a', targets: ['docs/'] }, { repo: 'b', targets: [] }],
  })
  assert.match(out.find(o => o.command === DOCUMENTED).says, /b has no docs target — `docs:` in its catalogue entry \(`rig catalog b` names the file\)/)
})

test('a repo with no catalogue entry at all is pointed at where its entry would go', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT }),
    repos: [landed(), repo('b', { merged: true, pr: { number: 2, state: 'MERGED' } })],
    docs: [{ repo: 'a', targets: ['docs/'] }, { repo: 'b', targets: [], missing: 'catalog/acme/b.md' }],
  })
  const says = out.find(o => o.command === DOCUMENTED).says
  assert.match(says, /b has no catalogue entry — write one at `catalog\/acme\/b\.md`, with `docs:`/)
  assert.doesNotMatch(says, /rig catalog b/, 'a command that would only say there is no entry')
})

test('the docs edit is offered, never demanded', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [landed()], docs: docsAt('docs/') })
  assert.doesNotMatch(out.find(o => o.command === DOCUMENTED).says, /should|must|need to|missing/i)
})

test('a worktree not on this machine is offered the restore, before anything else', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b') }),
    repos: [repo('a', { missing: true, pr: { number: 14, state: 'OPEN' } }), repo('b', { missing: true })],
    directionTodo: true,
  })
  assert.equal(out[0].command, 'rig restore w')
})

test('a missing worktree whose PR closed is not offered the restore it cannot have', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT }),
    repos: [repo('a', { missing: true, pr: { number: 3, state: 'CLOSED' } })],
  })
  assert.ok(!commands(out).includes('rig restore w'))
})

test('a stack whose other stages were withdrawn says so, rather than calling every stage in', () => {
  const stack = [
    { branch: 'feat/one', landed: true, withdrawn: null, prs: [], repos: ['a'] },
    { branch: 'feat/two', landed: false, withdrawn: { at: AT, reason: 'not needed' }, prs: [], repos: [] },
  ]
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a', { pushed: true })], stack })
  assert.match(says(out), /every stage is in or withdrawn — the work branch is what is left to land/)
})

test('an open PR that no longer matches the record is offered a refresh', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a', { pr: { state: 'OPEN' }, pushed: true })], prStale: ['a'] })
  assert.match(says(out), /a: the open PR no longer says what the record does/)
  assert.ok(commands(out).includes('rig pr --refresh'))
})

test('open stage PRs that are not a GitHub stack are offered rig stage --link', () => {
  const out = nextFor({ work: work({ repos: attached('a'), designedAt: AT }), repos: [repo('a', { pushed: true })], unstacked: ['a'] })
  assert.match(says(out), /a: the open stage PRs are not a GitHub stack/)
  assert.ok(commands(out).includes('rig stage --link'))
})

// ------------------------------------------------------------- after the PR is open

// The flow once a pull request is up: resolve the review already on it, then the adversarial
// review if the design chose one, then hand the PR to a human. Threads are derived from GitHub;
// the adversarial choice and its review are recorded, because nothing on GitHub can say either.
const reviewing = (over = {}) => ({
  work: work({ repos: attached('a'), designedAt: AT, ...over }),
  repos: [repo('a', { pr: { number: 4, state: 'OPEN' }, pushed: true })],
})

test('an open PR with unresolved review threads is offered the review, with no command', () => {
  const out = nextFor({ ...reviewing(), reviews: [{ repo: 'a', unresolved: 2 }] })
  const resolve = out.find(o => /unresolved review thread/.test(o.says))
  assert.match(resolve.says, /a: 2 unresolved review threads/)
  assert.equal(resolve.command, null)
})

test('a work that chose an adversarial review is offered it once no thread is unresolved', () => {
  const out = nextFor({ ...reviewing({ adversarial: true }), reviews: [{ repo: 'a', unresolved: 0 }] })
  assert.match(says(out), /adversarial review/)
  assert.ok(commands(out).includes('rig save -m "adversarial review" --reviewed'))
})

test('the adversarial review waits while the review already on the PR is unresolved', () => {
  const out = nextFor({ ...reviewing({ adversarial: true }), reviews: [{ repo: 'a', unresolved: 1 }] })
  assert.doesNotMatch(says(out), /adversarial review/)
})

test('a work that declined the adversarial review is never offered one', () => {
  const out = nextFor({ ...reviewing({ adversarial: false }), reviews: [{ repo: 'a', unresolved: 0 }] })
  assert.doesNotMatch(says(out), /adversarial review/)
})

test('a work designed before the choice existed is not offered an adversarial review', () => {
  const out = nextFor({ ...reviewing(), reviews: [{ repo: 'a', unresolved: 0 }] })
  assert.doesNotMatch(says(out), /adversarial review/)
})

test('a recorded adversarial review is not offered again, and the PR is offered to a human', () => {
  const out = nextFor({ ...reviewing({ adversarial: true, reviewedAt: AT }), reviews: [{ repo: 'a', unresolved: 0 }] })
  assert.doesNotMatch(says(out), /adversarial review/)
  assert.match(says(out), /ready for a human reviewer/)
})

test('a PR is offered to a human once its threads are resolved and no adversarial review is pending', () => {
  const out = nextFor({ ...reviewing({ adversarial: false }), reviews: [{ repo: 'a', unresolved: 0 }] })
  const handover = out.find(o => /ready for a human reviewer/.test(o.says))
  assert.equal(handover.command, null, 'who reviews is the human\'s call, and rig takes no outward-facing step')
})

test('the hand-over waits for unresolved threads, a pending adversarial review, and unpushed commits', () => {
  for (const [why, input] of [
    ['threads', { ...reviewing({ adversarial: false }), reviews: [{ repo: 'a', unresolved: 1 }] }],
    ['adversarial', { ...reviewing({ adversarial: true }), reviews: [{ repo: 'a', unresolved: 0 }] }],
    ['unpushed', { ...reviewing({ adversarial: false }), repos: [repo('a', { pr: { number: 4, state: 'OPEN' }, pushed: true, unpushed: 1 })], reviews: [{ repo: 'a', unresolved: 0 }] }],
    ['dirty', { ...reviewing({ adversarial: false }), repos: [repo('a', { pr: { number: 4, state: 'OPEN' }, pushed: true, dirty: 1 })], reviews: [{ repo: 'a', unresolved: 0 }] }],
  ]) assert.doesNotMatch(says(nextFor(input)), /ready for a human reviewer/, why)
})

test('the hand-over is not offered while GitHub would not say whether threads are unresolved', () => {
  const out = nextFor({ ...reviewing({ adversarial: false }), reviews: [{ repo: 'a', unresolved: null }] })
  assert.doesNotMatch(says(out), /ready for a human reviewer/)
})

test('nothing about the review is offered before a PR is open, or once every PR merged', () => {
  const building = nextFor({ work: work({ repos: attached('a'), designedAt: AT, adversarial: true }), repos: [repo('a', { pushed: true })] })
  assert.doesNotMatch(says(building), /adversarial review|human reviewer/)
  const landing = nextFor({
    work: work({ repos: attached('a'), designedAt: AT, adversarial: true }),
    repos: [repo('a', { merged: true, pr: { number: 4, state: 'MERGED' } })],
  })
  assert.doesNotMatch(says(landing), /adversarial review|human reviewer/)
})

test('the review offers come in the order the flow runs: threads, adversarial, hand-over', () => {
  // One at a time, each waiting for the one before it.
  const step = input => nextFor(input).filter(o => /review thread|adversarial review|human reviewer/.test(o.says)).map(o => o.says)
  const threads = step({ ...reviewing({ adversarial: true }), reviews: [{ repo: 'a', unresolved: 3 }] })
  assert.equal(threads.length, 1)
  assert.match(threads[0], /review threads/)
  const adversarial = step({ ...reviewing({ adversarial: true }), reviews: [{ repo: 'a', unresolved: 0 }] })
  assert.equal(adversarial.length, 1)
  assert.match(adversarial[0], /adversarial review/)
  const handover = step({ ...reviewing({ adversarial: true, reviewedAt: AT }), reviews: [{ repo: 'a', unresolved: 0 }] })
  assert.equal(handover.length, 1)
  assert.match(handover[0], /human reviewer/)
})

test('a PR closed without merging is neither reviewed nor handed over', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT, adversarial: true }),
    repos: [repo('a', { pr: { number: 4, state: 'CLOSED' }, pushed: true })],
  })
  assert.doesNotMatch(says(out), /adversarial review|human reviewer/)
})

test('one repo merged beside one never opened has no PR to hand over', () => {
  const out = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT, adversarial: false }),
    repos: [repo('a', { merged: true, pr: { number: 4, state: 'MERGED' } }), repo('b')],
  })
  assert.doesNotMatch(says(out), /human reviewer/)
})

test('the adversarial review waits while GitHub would not say whether threads are unresolved', () => {
  const out = nextFor({ ...reviewing({ adversarial: true }), reviews: [{ repo: 'a', unresolved: null }] })
  assert.doesNotMatch(says(out), /adversarial review/)
})

test('the hand-over waits for the design gate, which carries the review choice', () => {
  const input = reviewing()
  delete input.work.designedAt
  const out = nextFor({ ...input, reviews: [{ repo: 'a', unresolved: 0 }] })
  assert.doesNotMatch(says(out), /human reviewer/)
})

test('a design agreed again after the adversarial review asks for another', () => {
  const out = nextFor({
    ...reviewing({ adversarial: true, reviewedAt: '2026-09-01T00:00:00.000Z', designedAt: '2026-09-10T00:00:00.000Z' }),
    reviews: [{ repo: 'a', unresolved: 0 }],
  })
  assert.match(says(out), /the design chose an adversarial review/)
  assert.doesNotMatch(says(out), /human reviewer/)
})

test('the hand-over waits while a worktree is missing or git could not count what is unpushed', () => {
  for (const [why, over] of [['missing', { missing: true, unpushed: null }], ['uncounted', { unpushed: null }]]) {
    const out = nextFor({
      ...reviewing({ adversarial: false }),
      repos: [repo('a', { pr: { number: 4, state: 'OPEN' }, pushed: true, ...over })],
      reviews: [{ repo: 'a', unresolved: 0 }],
    })
    assert.doesNotMatch(says(out), /human reviewer/, why)
  }
})

test('the hand-over waits for the PR\'s checks to go green', () => {
  for (const checks of ['PENDING', 'EXPECTED', 'FAILURE', 'ERROR']) {
    const out = nextFor({ ...reviewing({ adversarial: false }), reviews: [{ repo: 'a', unresolved: 0, checks }] })
    assert.doesNotMatch(says(out), /human reviewer/, checks)
  }
  const green = nextFor({ ...reviewing({ adversarial: false }), reviews: [{ repo: 'a', unresolved: 0, checks: 'SUCCESS' }] })
  assert.match(says(green), /human reviewer/)
})

test('failing checks on an open PR are named, with no command', () => {
  for (const checks of ['FAILURE', 'ERROR']) {
    const out = nextFor({ ...reviewing({ adversarial: false }), reviews: [{ repo: 'a', unresolved: 0, checks }] })
    const failing = out.find(o => /checks are failing/.test(o.says))
    assert.match(failing.says, /^a: the PR's checks are failing/, checks)
    assert.equal(failing.command, null)
  }
})

test('checks that have not reported are named, so the wait is never silent', () => {
  for (const checks of ['PENDING', 'EXPECTED']) {
    const out = nextFor({ ...reviewing({ adversarial: false }), reviews: [{ repo: 'a', unresolved: 0, checks }] })
    assert.match(says(out), new RegExp(`a \\(${checks}\\): the PR's checks have not all reported`), checks)
  }
})

test('the hand-over waits for a worktree with commits on a stage that landed', () => {
  const out = nextFor({
    work: work({ repos: attached('a'), designedAt: AT, adversarial: false }),
    repos: [repo('a', { pr: { number: 4, state: 'OPEN' }, pushed: true, on: 'feat/one', unpushed: 3 })],
    stack: [stage('feat/one', { landed: true, started: true, repos: ['a'] })],
    reviews: [{ repo: 'a', unresolved: 0, checks: 'SUCCESS' }],
  })
  assert.match(says(out), /move it to the work branch/)
  assert.doesNotMatch(says(out), /human reviewer/)
})

test('the hand-over waits for a repo pushed with no PR, and for a stage still to come', () => {
  const awaiting = nextFor({
    work: work({ repos: attached('a', 'b'), designedAt: AT, adversarial: false }),
    repos: [repo('a', { pr: { number: 4, state: 'OPEN' }, pushed: true }), repo('b', { pushed: true })],
    reviews: [{ repo: 'a', unresolved: 0 }],
  })
  assert.doesNotMatch(says(awaiting), /human reviewer/, 'a pushed with no PR')
  const staged = nextFor({
    ...reviewing({ adversarial: false }),
    stack: [stage('feat/one', { started: true, repos: ['a'] })],
    reviews: [{ repo: 'a', unresolved: 0 }],
  })
  assert.doesNotMatch(says(staged), /human reviewer/, 'a stage still to come')
})

test('a sibling PR closed without merging holds the hand-over, and is never asked about', () => {
  const input = {
    work: work({ repos: attached('a', 'b'), designedAt: AT, adversarial: true }),
    repos: [repo('a', { pr: { number: 4, state: 'OPEN' }, pushed: true }), repo('b', { pr: { number: 5, state: 'CLOSED' }, pushed: true })],
    reviews: [{ repo: 'a', unresolved: 0 }],
  }
  assert.match(says(nextFor(input)), /the design chose an adversarial review/, 'the open PR alone decides the review')
  input.work.reviewedAt = AT
  assert.doesNotMatch(says(nextFor(input)), /human reviewer/)
})

test('review and design dates are compared as instants, and an unreadable review is no review', () => {
  const later = nextFor({
    ...reviewing({ adversarial: true, designedAt: '2026-09-10T12:00:00+02:00', reviewedAt: '2026-09-10T11:00:00Z' }),
    reviews: [{ repo: 'a', unresolved: 0 }],
  })
  assert.doesNotMatch(says(later), /adversarial review/, '11:00Z is after 10:00Z')
  const garbage = nextFor({ ...reviewing({ adversarial: true, reviewedAt: 'yes' }), reviews: [{ repo: 'a', unresolved: 0 }] })
  assert.match(says(garbage), /the design chose an adversarial review/)
})
