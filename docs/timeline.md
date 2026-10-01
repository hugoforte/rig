# How rig grew

rig went from an initial commit to version 3.22 in ten days, 15 to 25 September 2026: 68 commits on `main`, 44 releases. This is that growth in broad strokes, as six phases, each named by the capacity it added. The numbers come from the git tags; the phases are a reading of the pull request titles.

## In numbers

| Day | Milestone | Commands | Modules in `bin/` | Test lines |
|---|---|---|---|---|
| 15 Sep | initial commit | 14 | 1 | 0 |
| 18 Sep | v1.0 | 18 | 7 | 1.8k |
| 18 Sep | v2.0 | 20 | 11 | 3.9k |
| 19 Sep | v3.0 | 24 | 15 | 5.8k |
| 22 Sep | v3.10 | 26 | 22 | 9.4k |
| 25 Sep | v3.22 | 26 | 25 | 13.2k |

The command count stops moving after day five. Everything since is depth: modules and test lines keep climbing while the surface stays where it is.

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

## The arc

Solo tool, then installable product, then covering the SDLC, then multi-root and team-facing, then self-steering and fast to test, then agent-native and portable. Each phase widened who could use rig or what it could hold, and none of them grew the command surface past what day five had.
