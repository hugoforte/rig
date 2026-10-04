# How rig grew

rig went from an initial commit to version 3.38 in nineteen days, 15 September to 4 October 2026: 96 commits on `main`, 66 releases. This is that growth in broad strokes, as ten phases, each named by the capacity it added. The numbers come from the git tags; the phases are a reading of the pull request titles.

## In numbers

| Day | Milestone | Commands | Modules in `bin/` | Test lines |
|---|---|---|---|---|
| 15 Sep | initial commit | 14 | 1 | 0 |
| 18 Sep | v1.0 | 18 | 7 | 1.8k |
| 18 Sep | v2.0 | 20 | 11 | 3.9k |
| 19 Sep | v3.0 | 24 | 15 | 5.8k |
| 22 Sep | v3.10 | 26 | 22 | 9.4k |
| 25 Sep | v3.22 | 26 | 25 | 13.2k |
| 1 Oct | v3.35 | 27 | 26 | 17.6k |
| 4 Oct | v3.38 | 27 | 27 | 18.8k |

The command count all but stops moving after the first week: the twelve days after v3.10 added two commands, `tidy` and `note`, and took one away, `demo`. Everything since is depth: modules and test lines keep climbing while the surface stays where it is.

## Phase 1, 15 to 16 September: the core loop

Day one shipped the basic verb set: `new`, `attach`, `status`, `list`, `close`, `doctor`, `init`. Day two added the gated workflow: the ticket decision gate, Jira through twg ([ADR 0001](./adr/0001-jira-via-twg.md)), every `gh` call behind one GitHub module with an in-memory adapter, and the data root committed at every agreement point.

Capacity: one person can rig one work on one machine.

## Phase 2, 18 September: installable and self-maintaining

One day, some twenty pull requests. One-command install for both shells. rig knows when an installation is out of date and brings it up to date. The version bump and the release history are automated. Terminal PR facts are recorded so closed work never re-asks GitHub. One verdict for "this work is done", read by `list`, `close`, `status` and the ticket write-back. The first disposable dashboard, throughput and cycle time on one page. v2.0 marks the record format becoming a versioned contract ([ADR 0002](./adr/0002-the-major-version-is-the-record-format.md)).

Capacity: other people can install it, and trust it to stay current.

## Phase 3, 19 September: the SDLC

The vocabulary for phases, stages and branches is settled. New commands: `check`, `next`, `pr`, `stage`. rig now covers the life of a work from planning through merged, not just the worktree setup. v3.0 is the record format change that carries this.

Capacity: a work with several stacked branches and a defined path between phases.

## Phase 4, 20 to 21 September: many roots, many machines, a team

More than one data root on one installation. `doctor` checks every configured root and reports an unresolvable one instead of dying. End-to-end scenario tests, including the journey through a version you have not updated yet. Releases and merges that do not serialise, with the merge-queue findings kept as [ADR 0005](./adr/0005-a-merge-queue-replaces-the-up-to-date-rule.md). An interactive demo page for showing rig to a team.

Capacity: an organisation with several data roots, and a story to tell other people.

## Phase 5, 22 to 23 September: the catalogue steers, the suite gets fast

Catalogue corrections are offered from `next` and named at `close`. The `talks_to` graph is queried, not only drawn, so `attach` offers a repo's neighbours. `impact` says what a change reaches. The design's invariants are mapped to tests. Then the performance push: every git call went from three processes to one, the suite shed thousands of spawns, and the Windows CI run was sharded to under a minute.

Capacity: the catalogue steers decisions, and the suite scales with the codebase.

## Phase 6, 24 to 25 September: agents and portability

The agent skills ship with the tool: `rig`, `rig-handoff`, `rig-learn`. A lesson loop at close feeds what the work taught back into the catalogue. A landed work's merged branches are deleted on close. `restore` rebuilds a work's worktrees on a second machine in one command. DESIGN.md's test citations are enforced.

Capacity: an agent can pick up a work, hand it off, and learn from it, on any machine.

## Phase 7, 27 to 28 September: rig says what it believes

A philosophy page sets down what rig's frictions taught ([philosophy.md](./philosophy.md)). An org can say what it is trying to do, and every work reads it. The lesson review at close keeps that org doc true and grows the philosophy, which gains "Say it once". Every list of a data root's contents is checked to name all of it.

Capacity: an org states its direction, and each work is steered by it.

## Phase 8, 29 September to 1 October: the record stays true

A work always lands in the data root that holds it, and its record can be corrected after the fact. Two rig commands never write the data root at once. A work closed on another machine is cleared from this one, by `tidy`, but never while its id is open in another data root. A stack merged through GitHub closes cleanly and is registered as a GitHub stack. What `pr` and `close` say in public is safe, single and complete. Every twg answer is checked against the shape rig reads, and a `gh` lookup that could not ask says so, rather than answering not found. Whether a work gets an adversarial review is decided at the design gate.

Capacity: several machines, data roots and sessions share one record, and it does not lie to any of them.

## Phase 9, 2 to 4 October: what landed, said for people

The demo page goes: nobody was using it to make the case for rig, and what it drew is cheap to build again from what stays. One rule says which data root holds a work. A work records its outcome, what changed for someone and why that is good, and `dash` says what landed, not only how much. The `rig-digest` skill explains what landed for a work, a repo, an org or a period, every claim linked to its pull request. The `rig-docs` skill keeps a product's user docs true once a work has landed, reading the QA evidence kept beside the context doc.

Capacity: someone who never saw a work can learn what it did, and the product's own docs keep up.

## Phase 10, 4 October: the agent runs, the human checks

Eight changes, built as one work in eight stages. A work chooses which gates wait for the human, and the record says which the agent decided. `check --run` records a pass against the patch it ran at, so a stale green shows. `next` works the frontier of a stack, and names a moved base beside a failing check. The lesson review reads the sessions that did the work, and `close` names a session still at work before it takes the worktree. A pickup trusts the handoff rather than redoing it. `note` keeps every decision taken along the way with a pointer at its evidence, and a context doc is checked against its template.

Capacity: an agent can carry a work with less of the human's attention, and leave a trail the human can check afterwards.

## The arc

Solo tool, then installable product, then covering the SDLC, then multi-root and team-facing, then self-steering and fast to test, then agent-native and portable, then saying what it believes, then true under sharing, then readable by people who never saw the work, then trusted to run while the human checks afterwards. Each phase widened who could use rig or what it could hold, and since the first week they have grown the command surface by one command between them.
