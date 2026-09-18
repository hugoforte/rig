# rig — design

A cross-repo work harness. You describe a piece of work, it decides which repos are
involved, assembles worktrees for them in one folder, and keeps the durable knowledge
about that work in a repo you commit.

Status: design agreed and built 2026-09-14; §3 updated the same day for the tool/data split; versioning and freshness added 2026-09-17 as 1.0.0 (§5, decisions 45–49, ADR-0002); releases automated 2026-09-18 as 1.1.0 (decisions 50–53, ADR-0003).

Vocabulary is [CONTEXT.md](./CONTEXT.md); this document uses it unchanged.

1. [The problem, stated honestly](#1-the-problem-stated-honestly)
2. [Shape](#2-shape)
3. [On-disk layout](#3-on-disk-layout)
4. [The catalogue](#4-the-catalogue)
5. [Commands](#5-commands)
6. [The repo interview](#6-the-repo-interview)
7. [Documents](#7-documents)
8. [Staying used](#8-staying-used)
9. [Scope: in and out](#9-scope-in-and-out)
10. [Decision log](#10-decision-log)

---

## 1. The problem, stated honestly

Work in a multi-repo org spans repos. A single ticket routinely touches four of them — a
billing service, the integration hub that feeds it, an API and its web UI. Getting set up
means finding the repos, cutting a branch in each with the same name, and holding the
cross-repo picture in your head.

This had been solved by hand 51 times. The old clone directory held 51 worktrees across three
different placement conventions, four redundant full clones, and a prunable worktree pointing
into a deleted workspace.

### 1.1 v1 exists, and it failed

A previous coordination repo already implemented much of this idea: a `/feature-new`
command, a `/feature-status` command, a context-doc template, a rollout-plan template, a
`repos.json` manifest, a bootstrap script and a status script. The entire scaffold landed in
one sitting on 2026-06-16. There are five commits total.

It was never adopted. Diagnosis (from the author): **it got forgotten, and it wasn't really
thought through.** The observable symptoms:

- `repos.json` was generated once and never regenerated; ~40 directories appeared on disk
  that it doesn't know about.
- Docs were deliberately kept in two places (untracked originals at root, "canonical" copies
  in `features/`). They have since diverged.
- `/feature-status` exists; its output was never committed.
- All substantial work from July–September 2026 happened untracked at the root, outside the
  convention entirely.
- **v1 had no worktree story at all.** The sprawl grew in the space the convention didn't cover.

The one artifact that got added months later, and is by far the most polished thing in the
repo, is a *skill* (a deployment helper) — not a feature doc.

### 1.2 What v2 does differently

1. **The doc rides in on the thing you already want.** You reach for worktrees 51 times;
   you reached for a context doc five. So worktree assembly is the entry point, and the
   context doc is scaffolded because you asked for worktrees — never as a separate step.
2. **Nothing that must be hand-maintained to stay true.** v1's `Branches` table, its
   `Active features` table, and `repos.json` all rotted for one reason: a human had to
   remember. Anything derivable is derived on read.
3. **One place for each fact.** No second copy of anything, ever.
4. **A hard durable/disposable split**, so cleanup is never a judgement call.

---

## 2. Shape

`rig` is a **zero-dependency Node CLI**. That is the spine, not an adapter.

Agent integration is a thin layer over it: agents run `rig` commands and read
`rig prompt <name>` output. No MCP server, no per-agent generated adapters. Any agent that
can run a shell command can drive it. `AGENTS.md` is the real instruction file; `CLAUDE.md`
is a one-line pointer to it — the convention the org's repos are already converging on.

`rig` authenticates to nothing except git. GitHub state is read by shelling out to `gh`,
and Jira by shelling out to `twg` (ADR-0001, superseding the original "agent pipes the
brief in" design) — both already authenticated on the machine.

### 2.1 Vocabulary

The terms this document leans on — work, catalogue, mirror, data root, tool, installation, work root, freshness, refresh, record format, write gate — are defined once, in [CONTEXT.md](./CONTEXT.md), with the synonyms each one displaces. A term used here means what it means there.

---

## 3. On-disk layout

The split is the design. `D:\rig` and `D:\rig-data` are only durable, committed things.
`D:\w` is only things you could delete tonight and lose nothing.

```
D:\rig\                          the tool. durable, committed, public
  AGENTS.md                      how to use rig (CLAUDE.md -> pointer)
  DESIGN.md                      this file
  bin/rig.mjs                    the CLI
  prompts/  templates/           markdown printed by `rig prompt`; doc scaffolds
  rig.local.json                 gitignored: machine paths, identities, secrets sources,
                                 `dataRoot` -> D:\rig-data, and a freshness override.
                                 `RIG_LOCAL_CONFIG` moves this file; nothing moves the
                                 tool root, which is measured, not configured

D:\rig-data\                     the knowledge. durable, committed, private
  rig.json                       org-level: orgs, tracker per org, freshness policy,
                                 and `writtenBy` — the record-format stamp (ADR-0002)
  catalog/<org>/<repo>.md        repo knowledge
  work/<work-id>/
    context.md                   THE prose doc. Only copy.
    rollout-testing-plan.md      only when deploy-bearing

D:\w\                            disposable, gitignored, reconstructible
  .mirrors/<org>/<repo>.git      bare mirrors (a cache)
  .rig/                          freshness and data-fetch caches (decision 45)
  PROJ-42-refund-double-charge/
    AGENTS.md                    GENERATED, regenerated on every mutation
    CLAUDE.md                    pointer
    .rig/                        work metadata
    billing\                     worktree
    orders-api\                  worktree
    orders-web\                  worktree
```

The tool never learns that the data is in a different repo: every org-level path resolves
against the data root. Unset `dataRoot` still falls back to the tool's own checkout so old
installs keep working, but `doctor` reports that layout as *not set up*: with the tool
public, knowledge inside its tree is one `git add` from a leak. Setup's first question is
where the knowledge lives — join an existing private data repo, create one, or a local
directory beside the tool — and `init --data-repo owner/name` does the joining or creating.
The data repo is named `rig-data` by convention, which is what lets the interview find one.

Repos sit **flat** at the work root, not under `repos/` — six characters of MAX_PATH budget
matters more than the cosmetic intermingling, and `.rig/` keeps the root readable.

### 3.1 Windows constraints, designed around

- **Symlinks are disabled** (`core.symlinks=false` system-wide, Developer Mode off).
  Nothing in this design symlinks. Secrets and shared config are **copied**.
- **`core.longpaths` is not set.** `rig init` sets it globally on first run.
  `D:\w\<work>\<a-repo-with-a-long-name>\node_modules\...` otherwise breaks.
- **The system drive was 78% full (50 GB free); the data drive had 785 GB.** Everything lives
  on the data drive.
- `core.autocrlf=true` globally; `.gitattributes` normalises committed text.

---

## 4. The catalogue

One markdown file per repo: YAML frontmatter for machine-readable identity, prose body for
the part that matters.

```markdown
---
repo: pos-desktop
org: example-org
stack: .NET (thick client + services)
role: In-store point of sale — returns and store credit live here
talks_to:
  - repo: billing
    how: pushes refunds through the orders bus (not directly, since PROJ-1291)
  - repo: orders-api
    how: confirms returns against online orders
---

Prose. What this repo actually is, the gotchas, the expensive-to-rediscover facts.
```

**Durable facts only.** No `branch`, no local path, no status. v1's `repos.json` stored
`branch` — a snapshot of whatever each clone happened to be on (`chore/PROJ-868`,
`pr-98-review`, `release/1.5.0`) — and was stale within days. Anything git or `gh` can
answer is derived live and never written down.

`talks_to` is the field that earns its keep: repo selection is graph traversal.

### 4.1 Seeding

Mine the existing docs first. The hand-written cross-repo notes already contained role lines
for six repos ("the desktop backend — invoices live here"); a second doc added more. That is
earned prose sitting on disk. Commit those as the seed — day one is not a blank directory.

Do not backfill the other ~129. `rig attach` drafts an entry on first use, marked
`<!-- DRAFT: unreviewed -->`, which gets corrected in passing while the repo is loaded in
your head. The catalogue's value comes from those corrections, not from a writing sprint.

---

## 5. Commands

```
rig init                    one-time setup; writes rig.local.json, and rig.json in the data root
rig new <id> [--type]       create a work: ticket decision, worktrees, context doc
rig ticket <key>            record an existing ticket on the current work
rig attach <repo>           add a repo to the current work
rig detach <repo>           remove a repo from the current work
rig list [--json]           all works + staleness signals, least recently touched first
rig status                  live per-repo branch/ahead/behind/PR state (derived)
rig setup <repo>            run the catalogue's setup commands
rig catalog [repo]          the repo catalogue: index, or one entry
rig plan                    scaffold rollout-testing-plan.md
rig save [-m] [--designed]  commit edits made outside rig; --designed is the design gate
rig close                   safety-checked teardown
rig doctor                  environment + consistency checks
rig update                  fast-forward the tool and the data root, migrate, then doctor
rig prompt <name>           print an agent prompt to stdout
```

Every command prints what it is about to do and is idempotent. Re-running `attach` on an
attached repo is a no-op, not an error. Every command that changes a work ends by
committing the whole data root and pushing it when it has an upstream (decision 42).

### 5.1 `rig new` — the entry point

1. Takes a work id, a title, and an optional brief on stdin. A GitHub key still needs its
   brief piped in; a Jira key is fetched by `rig` itself via `twg` (ADR-0001), the piped
   brief only overriding what was fetched. When a tracker is configured, `rig new` refuses
   until one of `--key`, `--ticket`, or `--no-ticket` makes the ticket decision explicit
   (decision 40).
2. Runs the repo interview (§6).
3. For each selected repo: lazily create the bare mirror if absent, `git fetch` it, cut a
   worktree on the shared branch.
4. Writes `<data root>\work\<id>\context.md` from the template.
5. Generates `D:\w\<id>\AGENTS.md`.

The repo set is **mutable**. Discovering a fourth repo on day two is normal; `rig attach`
must work without ceremony.

### 5.2 Branches

One branch name across every repo in a work — already the existing habit (the same
`feat/PROJ-42-refund-double-charge` appears in every repo of the work).

- Format `<type>/<KEY>-<slug>`; type defaults to the Jira issue type when a key is present,
  else `feat`. Asked once at creation.
- Base = **each repo's actual remote HEAD**, detected from the mirror. The `master`/`main`
  mix across orgs makes a global default wrong.
- If the branch already exists on the remote, **check it out with a loud notice**. That is
  what makes a work re-creatable on another machine.

### 5.3 Mirrors

Lazy. A repo is mirrored the first time a work attaches it, and **fetched on every attach**.
No scheduled fetching, no background daemons. Bulk-mirroring 135 repos means cloning 13
VB.NET legacy apps and 20 archived repos to no benefit; lazy self-warms to the real working
set within two weeks.

A stale mirror silently branching you off a month-old `main` is a miserable bug. Hence
fetch-on-attach.

The whole lifecycle around a mirror — cut a worktree for a work, remove it, read its live
state — is one module, `bin/worktrees.mjs`. A bare clone has no fetch refspec, so the module
gives it one; everything that follows from that refspec, including the
`refs/remotes/origin/` prefix, is known there and nowhere else. Callers speak in org, repo,
branch and directory.

Where a repo's remote lives is that module's own seam, with two adapters: `github.com` in
production, and a directory of bare repos when `RIG_FAKE_REMOTES` names one. That is the
same shape as decision 38's in-memory `gh`, and it is what makes `attach`, `detach`, `close`
and `status` testable against real git — real clones, fetches, pushes and worktrees — with
no network and no `gh`.

### 5.4 Post-create setup

The catalogue carries `setup` commands. `rig attach` **prints them; it does not run them.**
`rig attach --setup` opts in.

Running automatically makes attach slow and failure-prone for a step that often cannot
succeed yet — `npm ci` before `.env` exists, a restore that needs a VPN, a repo attached
only in order to read it. An attach that appears to fail is worse than one that tells you
what to run next. (Background-with-logging is the likely v2 of this, once it's known which
repos are slow.)

### 5.5 Secrets

`rig.local.json` (gitignored, machine-specific) maps repo -> secrets source path, e.g.
`billing` -> `<old clone dir>\billing\.secrets.env`. `rig` copies on attach. Symlinks are
unavailable, so copy is the only option.

The mapping **never goes in the catalogue** — the catalogue is committed and pushed, and
machine-specific paths there is how `repos.json`'s absolute-path problem comes back. A secrets
store *inside* `D:\rig` is likewise rejected: that is secret material inside a repo pushed
to GitHub, one `.gitignore` mistake from a bad day.

`rig doctor` warns when a work's repo has no registered secrets source but the catalogue
says it needs one.

### 5.6 Git identity

Global `user.email` is a personal address; org repos want the work address. Every commit in
an org repo from this machine was being attributed to the personal one.

`rig.local.json` maps org -> email, applied per worktree at creation. Personal repos keep
the global default. `rig doctor` warns about repos `rig` didn't create.

### 5.7 `rig close`

Never automatic. Checks each worktree for uncommitted changes, unpushed commits, and PR
state; refuses or warns; then removes worktrees and prunes.

Auto-deletion is the one thing this tool could do that would genuinely hurt — uncommitted
spike work in a forgotten work. But the reason the old clone directory had 51 worktrees is
not that deletion was hard, it is that nothing ever *told* you a work was done. So `rig list` surfaces
"PR merged 3 weeks ago, 0 uncommitted changes, safe to close." **Information, not automation.**

---

## 6. The repo interview

`rig prompt select-repos` prints the prompt; the agent runs it.

- **Input:** work title/brief + the catalogue index (name + role line per repo), with full
  bodies pulled on demand.
- **Catalogue only. No code reading.** This keeps the interview fast and cheap, and — more
  importantly — makes the tool *visibly* only as good as its catalogue. Grepping repos would
  paper over a thin catalogue, so the pain that drives improvement never arrives.
- **`talks_to` traversal is explicit:** for every selected repo, check its neighbours and say
  why each is or isn't in scope. This is the mechanism that catches the fourth repo.
- **Output:** ranked shortlist with a one-line reason each, a mandatory
  "considered and excluded, because…" list, and a "repos I'd check if this turns out to
  touch X" line.

One round, propose-and-confirm. Not Socratic: multi-round questioning front-loads questions
you often can't answer until you've read code. Err inclusive — the failure mode that costs
you is a *missing* repo, not a spare one.

---

## 7. Documents

### 7.1 Where the prose lives

`<data root>\work\<id>\context.md` is **the only copy**. The work folder's generated
`AGENTS.md` points at its absolute path.

This is the direct correction of v1's root-vs-`features/` split. The doc is the durable
asset — one doc's "Key data points" section (the column semantics of a ledger table, which
flag means settled, which field is the idempotency key) is knowledge that must outlive the
worktrees by years. Keeping it in the disposable tree throws it away; syncing on close
recreates the two-copies problem with a step that gets skipped.

Consequence: `D:\w\<id>\` holds only disposable things, which is what makes teardown safe.

### 7.2 The context template

Inherit v1's context template near-wholesale. It was earned — the generalization of the
original hand-written cross-repo doc, refactored the same day the flat version was written.
Spine:

> Repos → Problem → Direction (why NOT the adjacent effort) → Target architecture (ASCII
> data-flow diagram) → Key data points → Open questions (numbered, each with a leaning) →
> Sequencing & dependencies (deploy order + hazard window) → Verification → Decisions log →
> Status

Keep its HTML-comment instructions explaining *why* each field exists. Keep the inline
`✅ CONFIRMED (date)` / `❌ REFUTED by data (date)` epistemic ledger — that habit is the most
distinctive thing in the v1 docs and it is genuinely good.

Two changes:

- **Drop the `Branches` table.** Derived. It was one of the three things that rotted.
- **Scaffold minimal, not full.** `rig new` writes Repos + Problem + Direction and stubs
  nothing else. The agent knows the full section catalogue and adds sections when content
  exists. Scaffolding eleven empty sections is how v1 got a dead `## Cross-Repo Contracts`
  table with one blank row.

### 7.3 Rollout plans

`rollout-testing-plan.md` stays a first-class second artifact, generated on demand by
`rig plan`, **never scaffolded at creation** — it's meaningless before PRs exist.

Justified by the work: multi-tenant deploys with mandatory cross-repo ordering and real
hazard windows. The two written so far are 126 and 122 lines, and the "⚠️ rejection window"
section prevents an actual outage. Spine: PRs + deploy order → why the order is mandatory →
config prerequisites → UAT + test matrix → sign-off gate → per-tenant production rollout →
rollback → risks → status.

### 7.4 The generated work file

`D:\w\<id>\AGENTS.md` carries the one-line purpose, the repo list with each repo's *role in
this work*, per-repo run commands from the catalogue, and the absolute path to `context.md`.

**Regenerated on every `rig` command that mutates the work**, with a
`GENERATED — do not edit; see context.md` header. Hand-editable generated files are exactly
how v1's two copies diverged.

---

## 8. Staying used

Two mechanisms, deliberately minimal:

1. **Entry-point capture.** `rig new` is how worktrees happen, so the doc can't be skipped
   without skipping the thing you actually wanted.
2. **Ambient state.** `rig list` surfaces works with merged PRs and no close. The remaining
   forgetting-risk after (1) is *closing* things, and this fixes it with zero discipline.

Rejected: git hooks in worktrees (invasive, breaks outside the harness) and a scheduled agent
(premature).

### 8.1 Scope boundary

Inside `D:\w`, `rig` is exclusive: worktrees are created by `rig attach`, not by hand.
This is enforced by **instruction plus detection**, not prevention — the generated `AGENTS.md`
states the rule, and `rig doctor` fails loudly on a worktree under `D:\w` that `rig` didn't
create. `rig` cannot technically block `git worktree add`; this is a convention, not a lock.

Outside `D:\w` — notably the old clone directory — hand-rolled worktrees remain entirely
fine and `rig` ignores them. It does not model, adopt, or clean up the legacy layout.

---

## 9. Scope: in and out

**In**

- Repo catalogue, interview, worktree assembly, branch management, context docs,
  rollout plans, teardown, doctor.

**Out**

- Migrating the old clone directory. It drains naturally as its worktrees merge. A one-off
  assisted cleanup (inventory every worktree with branch + dirty state + merged-PR status,
  approve, delete) is worth doing as its **own session, later**, once new work is landing in
  `D:\w`. It must not become a `rig` command: a cleanup command for a directory being
  abandoned outlives its purpose and becomes permanent complexity. Also in that pass: 4
  redundant full clones, 1 prunable worktree, ~270 scratch workspace dirs on the system drive.
- Multi-user features (shared catalogue, server, config layering). Built for one user;
  portable by accident (no hardcoded paths, config-driven roots) so multi-agent is free and
  multi-user is cheap later.
- Credential management of any kind beyond git.
- **Publishing this repo** — done. The tool is generic, and everything that describes real
  orgs (`catalog/`, `work/`, `rig.json`) lives in a private data repo reached through
  `dataRoot` (§3). This repo started from a single fresh initial commit of the scrubbed tree
  — the private predecessor's history carried the catalogue seed, so it was not reused —
  and each machine's `RIG_ROOT` was cut over afterward. The work record for the whole
  effort, including the leak check that gated publishing, stays in the private data repo's
  `work/rig-go-public/context.md`; decisions 33–35 below are the durable summary.

---

## 10. Decision log

One line per decision, in the order they were made. The section each summarises carries the reasoning; a struck-through entry names what superseded it.

| # | Decision |
|---|----------|
| 1 | Zero-dep Node CLI is the spine; agent layers are thin |
| 2 | Work identity is a local slug; Jira keys are plural and optional |
| 3 | Hybrid catalogue: seeded from existing docs, appended on use |
| 4 | Harness-owned bare mirrors, not worktrees off working clones |
| 5 | Durable (`D:\rig`, `D:\rig-data`) / disposable (`D:\w`) split |
| 6 | Single-user, portable by accident |
| 7 | Supersede v1; no migration |
| 8 | Propose-and-confirm interview, one round, mutable repo set |
| 9 | Lazy mirrors, fetch on attach, no scheduled fetch |
| 10 | One shared branch name; base = per-repo remote HEAD |
| 11 | Flat repo dirs under a short work root; longpaths on; no symlinks |
| 12 | `rig close` never automatic; `rig list` surfaces staleness |
| 13 | Idempotent commands (eleven at v2, `ticket`, `catalog` and `save` since), each announcing its actions |
| 14 | v1 died of forgetting: fix via entry-point capture + ambient state |
| 15 | Prose doc lives in the data root only — exactly one copy |
| 16 | Inherit v1's context template; scaffold minimal; drop Branches |
| 17 | Rollout plan is a separate on-demand artifact |
| 18 | Tool is `rig`; the unit is a `work` |
| 19 | Agent-agnostic by construction, not by adapters |
| 20 | Entry-point capture + ambient state; no hooks, no cron |
| 21 | Catalogue = one md per repo, frontmatter + prose, `talks_to` |
| 22 | CLI + printable prompts; `AGENTS.md` real, `CLAUDE.md` a pointer |
| 23 | Work `AGENTS.md` is generated and regenerated, never edited |
| 24 | `D:\rig` + `D:\rig-data` + `D:\w`; mirrors are a cache under `D:\w` |
| 25 | org -> email mapping applied per worktree at creation |
| 26 | Seed catalogue from existing context docs; draft-on-attach after |
| 27 | Selection is catalogue-only; no code reading |
| 28 | Unmanaged worktrees outside `D:\w` are ignored, not adopted |
| 29 | ~~Agent fetches Jira; `rig` shells to `gh`; no credentials in `rig`~~ — superseded by ADR-0001: `rig` shells to `twg` for Jira too |
| 30 | Old-clone-directory cleanup is a separate later session, not a `rig` feature |
| 31 | Setup commands are printed, not run; `--setup` opts in |
| 32 | Secrets sources in `rig.local.json`, copied on attach |
| 33 | ~~`rig new --ticket` opens GitHub issues via `gh`; Jira tickets stay with the agent~~ — superseded by ADR-0001: `--ticket` creates in either tracker |
| 34 | Tool and knowledge split: `rig` public, `rig-data` private, joined by `dataRoot` |
| 35 | Org-level config (`orgs`, `tracker`) is data: `rig.json` in the data root, nothing in code |
| 36 | Setup asks where the knowledge lives first; the tool checkout is never the data root; `rig-data` is the name convention |
| 37 | Worktree paths are derived from the work root, never stored — one record works on every machine |
| 38 | Every `gh` call lives in `bin/github.mjs` behind one interface; a second, in-memory adapter (`RIG_FAKE_GITHUB`) runs the ticket and PR paths under test |
| 39 | A work has gates (ticket decided, repos confirmed, design agreed, closed), not stages; gate state is recorded as `status` in `work.json`, not derived |
| 40 | `rig new` refuses without an explicit `--key`, `--ticket` or `--no-ticket` on any data root with a live tracker; `--no-ticket` records a declined ticket, distinct from an absent one |
| 41 | `twg` is Jira's client, handled like `gh` (ADR-0001); per-org ticket config (`project`, `type`, `fields`, `board`) lives in `rig.json`, field ids discovered via `field create-metadata`, never hardcoded |
| 42 | Every mutating command commits the whole data root and pushes it when it has an upstream — event-based (decision 20 stands), announced in one line, never prompting, never dying (the work is already done; a git failure warns and waits for the next command); fetch and rebase first, and on conflict abort and say so rather than leave the data root mid-rebase. The commit is owned by dispatch: a command registers what it is committing as, and `main` commits on success or on a reported failure |
| 43 | `rig save [-m] [--designed]` is the explicit commit for edits made outside rig, chiefly the context doc; `--designed` is the only way a work reaches status `designed` |
| 44 | Writing a work record, syncing its context doc header and regenerating its folder is one operation (`saveWork`); no caller composes the three, and `doctor` reads the folder's owned entries from the same place `regenerate` writes them |
| 45 | An installation knows its own freshness, and the check rides on usage: a command ends by spawning a detached fetch that writes a cache, and the *next* command reads it. No timer, no daemon, no latency on the command that pays for it (decision 20 stands). `rig doctor` is the one exception and fetches live, because a health check you asked for should answer about now |
| 46 | One semver, and the major **is** the record format, derived as `MIGRATIONS.length` so it cannot be forgotten (ADR-0002). A rig whose major is below the data root's refuses mutating commands and still answers read-only ones. The stamp (`writtenBy`) is written by `applyMigrations` whenever a migration runs, never by an individual migration — a stamp only migration 1 knows how to write stops moving after migration 1 |
| 47 | Migrations are record-only and idempotent, so open work survives one; the gate on an update is the migration, not whether anything is open. A migration may carry only a hook rig can run, and is refused rather than reported as applied when it carries anything else |
| 48 | The data root is fast-forwarded at the **start** of every mutating command, not at the end: what was unsafe was the *read*, and `commitDataRoot` already protects the push. Fast-forward or leave alone — never merge, never rebase behind your back. A failed fetch backs off instead of costing a connect timeout on every command |
| 49 | The freshness line goes to **stderr** and is not gated on a TTY. An agent or CI job shelling out to rig is the audience that most needs telling, and stderr is what keeps it out of a pipe someone is reading an answer from |
| 50 | The PR carries its own version (ADR-0003): a required check fails until `package.json` says what the PR lands as, and the merge only tags it. A bot that bumped on `main` would need a bypass actor cut into its ruleset, and would put a second commit on `main` per PR — which every installation then measures itself behind, by decision 45 |
| 51 | The bump is read off what rig already writes: `feat/` → minor, `fix/` → patch, with a `release:minor\|patch\|none` label as the override. The major is never asked for — a PR that adds a migration lands as `MAJOR.0.0` however it is labelled (ADR-0002 stands) |
| 52 | Release notes are the merged PR descriptions since the previous tag, assembled by the workflow. History lives in GitHub releases, not a committed `CHANGELOG.md`, which the PR would have to write by hand — revisit when #16 publishes without a checkout |
| 53 | `rig doctor` names the release a checkout stands on, or the distance past it. Freshness still measures `origin/main` (decision 45 stands): with a release per merge the tag and `main` track each other, and measuring against the tag would only hide unreleased commits |
| 54 | A check `doctor` cannot make on this machine is **dropped, never fatal**: the probe is chosen by platform (`Get-PSDrive` through PowerShell on Windows, `df -Pk` on POSIX) and a missing or unreadable probe costs one line, not the verdict. Doctor is the command you run because something is already broken |
| 55 | `rig list --json` is the one machine-readable surface, and every other reader of the works is a consumer of it rather than another command: a dashboard, a picker, a throughput figure. It carries the live timestamps a consumer cannot derive (`pr.openedAt`, `pr.mergedAt`, `firstCommitAt`) because the alternative — `createdAt` to `closedAt` — measures when teardown was remembered. The first commit is read from the PR, not the branch, which GitHub deletes on merge; under `--quick` every live field is **absent**, so "not looked up" never reads as "no PR" |
| 56 | Works are ordered by last activity, computed from timestamps the record already holds (`createdAt`, every `attachedAt`, `closedAt`) — no stored sort key, no git call. Creation date alone would sort a long-running work as stale, and a date baked into the folder name would break the id-folder-worktree identity every command resolves through. Closing counts as activity, so a batch `rig close` lifts six old works to the tail at once — the tail is "the work in hand" only if you did not just tidy up |
| 57 | The mirror and worktree lifecycle is one module, `bin/worktrees.mjs`: cut a worktree for a work, remove it, read its live state, base = the repo's remote HEAD (decisions 4, 9 and 10 restated as its invariants). Where a repo's remote lives is its own seam — `github.com` in production, a directory of bare repos under `RIG_FAKE_REMOTES` in tests (decision 38's shape) — which is what makes `attach`, `detach`, `close` and `status` reachable from the test suite at all |
