# rig

A harness that assembles one git worktree per repo for a piece of cross-repo work and keeps the durable knowledge about that work in a committed data root.

## Language

**Work**:
One cross-repo unit of effort: a ticket, a multi-ticket change, a migration, or a spike. Identified by a local slug.
_Avoid_: story, task, project

**Catalogue**:
Committed, hand-corrected knowledge about an org's repos, one file per repo.
_Avoid_: inventory, registry

**Mirror**:
A bare clone rig owns, from which worktrees are cut.
_Avoid_: cache, clone

**Data root**:
The committed checkout holding the catalogue, the work records and `rig.json`. Private when the tool is public.
_Avoid_: knowledge repo, rig-data (that is its conventional name, not the concept)

**Tracker**:
The ticket system an org uses: GitHub Issues or Jira. Configured per org in `rig.json`.
_Avoid_: issue tracker, Jira (when the kind is not fixed)

**Ticket**:
The record of a work in the org's tracker. A GitHub issue or a Jira work item. A work has zero or more.
_Avoid_: issue, story, work item (those are tracker-specific names for the same thing)

**Key**:
A ticket's identifier: `PROJ-42` for Jira, `owner/repo#7` for GitHub. Only the Jira shape goes in a branch name.
_Avoid_: ticket number, id

**Declined ticket**:
The recorded decision that a work in a tracked org deliberately has no ticket. Distinct from a work whose tickets are merely absent.
_Avoid_: ticketless, none

**Gate**:
A point in a work's life where the agent stops for a decision before proceeding: ticket decided, repos confirmed, design agreed, closed.
_Avoid_: step, checkpoint, phase

**Stage**:
A delivery slice of a work, such as backend, API, UI. Not modelled yet. Never used for a gate.
_Avoid_: phase, milestone

**Agreement point**:
The moment a gate is passed. Where rig commits and pushes the data root.
_Avoid_: checkpoint, sync point

**Tool**:
The rig repo itself, as distinct from any checkout of it. The thing a release is a release of.
_Avoid_: rig (when the checkout is meant), binary

**Installation**:
One checkout of the tool on one machine, with its `rig.local.json`. Distinct from the tool (the repo) and from the data root.
_Avoid_: copy, instance

**Work root**:
The disposable tree worktrees are assembled under, with the mirrors and caches beside them. Machine-owned; nothing in it is durable.
_Avoid_: workspace, scratch

**Freshness**:
How far an installation is behind the remote it was cloned from. Measured, cached, and reported — never acted on without asking.
_Avoid_: staleness, drift (those name the problem, not the measure)

**Refresh**:
The detached process a command leaves behind to measure freshness. It writes a cache; the next command reads it. The refresh never speaks.
_Avoid_: check, poll, background job

**Record format**:
The shape of the records in the data root. The major version is this number and nothing else, derived from the migrations list.
_Avoid_: schema, version (when the format is meant)

**Migration**:
A record-format change, carried by a major version and run by `rig update`. Record-only and idempotent: it rewrites the data root and never touches a worktree.
_Avoid_: upgrade, schema change

**Write gate**:
The refusal that stops a rig writing a record format it has never seen. Mutating commands refuse; read-only ones carry on.
_Avoid_: lock, block, version check

**Save**:
Committing and pushing the data root, including edits made outside rig. `rig save` is the explicit form; every mutating command does it implicitly.
_Avoid_: check in, sync, snapshot
