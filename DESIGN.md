# rig — design

A cross-repo work harness. You describe a piece of work, it decides which repos are
involved, assembles worktrees for them in one folder, and keeps the durable knowledge
about that work in a repo you commit.

Status: design agreed and built 2026-09-14; §3 updated the same day for the tool/data split; versioning and freshness added 2026-09-17 as 1.0.0 (§5, decisions 45–49, ADR-0002); releases automated 2026-09-18 as 1.1.0 (decisions 50–53, ADR-0003).

Vocabulary is [CONTEXT.md](./CONTEXT.md); this document uses it unchanged.

## Principles

The decision log says *what* was decided. These say what the decisions have in common.

**Keep it refactorable; don't factor it early.**
The rule of three, stated as a pair. A seam you can move later is worth more than an
abstraction you guessed at now — so two similar things are a coincidence, and you wait for
the third before naming the pattern. What "refactorable" buys is the right to wait: pure
modules where the logic is hard, one seam per external system, and no caller composing
three steps that one operation should own.

**Strong convictions, loosely held.**
Decide, write the reason down, then let evidence move you. A superseded decision is struck
through and names what replaced it, never deleted; a refuted hypothesis stays in the doc
with its date and its evidence. A position with no reason attached can't be argued out of,
and an opinion nobody recorded can't be corrected.

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

The terms this document leans on — work, catalogue, mirror, data root, tool, installation, work root, freshness, refresh, record format, write refusal — are defined once, in [CONTEXT.md](./CONTEXT.md), with the synonyms each one displaces. A term used here means what it means there.

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
setup:
  - dotnet restore
check:
  - dotnet test
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
rig dash [--org] [--since]  throughput and cycle time as one disposable HTML page
rig status                  the derived phase, plus live per-repo branch/ahead/behind/PR state
rig next                    what is available now; offers, never warns
rig stage [branch]          the stack, ordered by the branches; with a branch, declare one
rig pr                      one PR per repo, work branch to base branch
rig setup <repo>            run the catalogue's setup commands
rig check [repo...] [--run] print what verifies each repo; --run runs it
rig catalog [repo]          the repo catalogue: index, or one entry
rig plan [--refresh]        scaffold rollout-testing-plan.md; --refresh re-renders its deploy order
rig save [-m] [--designed]  commit edits made outside rig; --designed is the design gate
rig close [--abandoned]     safety-checked teardown; --abandoned stops a work unfinished
rig backfill [--work]       store each merged PR's terminal facts, once
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

The catalogue carries `check` beside `setup`: what *verifies* a repo — its test run, its
lint, its build. `rig check` prints it for every repo in the work, or for the ones named,
and `--run` opts in. The rule is the same one and it holds for the same reason — a check
in a worktree nothing has set up yet fails for a reason that is not the code's — plus one
of its own: a check is the thing you most often want in your own terminal, narrowed to a
single test or watched as it goes.

A command is a durable fact about a repo; a result is not, so nothing about a run is
written down (decision 3), and under `--run` a failure reaches the caller as the exit code
and nowhere else. The empty `check` a drafted entry ships with is a prompt, not a gap:
`rig check` names the repo and the file to write it in, which is rule 4 arriving at the
moment the knowledge is cheap.

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

What counts as unfinished business is decided once, in `bin/workstate.mjs`, and read by
`close`, `list`, `status` and the ticket write-back (decision 62). Two rules carry it: a
**merged PR settles its branch**, so the commits a squash merge left behind under another
sha never demand `--force`; and a **missing worktree is not a verdict** — it means the
tree is gone, so the PR is what gets judged.

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
| 39 | ~~A work has gates (ticket decided, repos confirmed, design agreed, closed), not stages; gate state is recorded as `status` in `work.json`, not derived~~ — **superseded by decision 64.** The gates were right and the storage was half wrong: two of `status`'s four values were observable facts written down |
| 40 | `rig new` refuses without an explicit `--key`, `--ticket` or `--no-ticket` on any data root with a live tracker; `--no-ticket` records a declined ticket, distinct from an absent one |
| 41 | `twg` is Jira's client, handled like `gh` (ADR-0001); per-org ticket config (`project`, `type`, `fields`, `board`) lives in `rig.json`, field ids discovered via `field create-metadata`, never hardcoded |
| 42 | Every mutating command commits the whole data root and pushes it when it has an upstream — event-based (decision 20 stands), announced in one line, never prompting, never dying (the work is already done; a git failure warns and waits for the next command); fetch and rebase first, and on conflict abort and say so rather than leave the data root mid-rebase. The commit is owned by dispatch: a command registers what it is committing as, and `main` commits on success or on a reported failure |
| 43 | `rig save [-m] [--designed]` is the explicit commit for edits made outside rig, chiefly the context doc; `--designed` is the only way the design gate is ever recorded (decision 64; it set a `status` until then) |
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
| 55 | `rig list --json` is the one machine-readable surface, and every other reader of the works is a consumer of it rather than another command: a dashboard, a picker, a throughput figure. It carries the live timestamps a consumer cannot derive (`pr.openedAt`, `pr.firstReviewAt`, `pr.approvedAt`, `pr.mergedAt`, `firstCommitAt`) because the alternative — `createdAt` to `closedAt` — measures when teardown was remembered. The first commit is read from the PR, not the branch, which GitHub deletes on merge; under `--quick` every live field is **absent**, so "not looked up" never reads as "no PR" |
| 56 | Works are ordered by last activity, computed from timestamps the record already holds (`createdAt`, every `attachedAt`, `closedAt`) — no stored sort key, no git call. Creation date alone would sort a long-running work as stale, and a date baked into the folder name would break the id-folder-worktree identity every command resolves through. Closing counts as activity, so a batch `rig close` lifts six old works to the tail at once — the tail is "the work in hand" only if you did not just tidy up |
| 57 | The mirror and worktree lifecycle is one module, `bin/worktrees.mjs`: cut a worktree for a work, remove it, read its live state, base = the repo's remote HEAD (decisions 4, 9 and 10 restated as its invariants). Where a repo's remote lives is its own seam — `github.com` in production, a directory of bare repos under `RIG_FAKE_REMOTES` in tests (decision 38's shape) — which is what makes `attach`, `detach`, `close` and `status` reachable from the test suite at all |
| 58 | `rig dash` renders the `--json` payload and nothing else: no record reading, no GitHub call of its own, and the statistics and HTML live in `bin/dash.mjs` as pure functions so the numbers shown to other people are checkable without a browser. It writes to a temp path, never the data root — a tracked page bakes PR state into a file that is wrong by the next merge, which is decision 12's staleness with a generator attached |
| 59 | The page enforces its honesty rather than remembering it, because it is made to be shown to someone: no figure ever spans two orgs (work on the tooling and work for an employer are different questions), median **and** p90 split by type (the data is bimodal — a lockfile bump and a feature are both "a work"), `n` beside every statistic, "since rig" never "faster than before" (no pre-rig period exists in the records), and when it was generated in the header rather than a footnote. Two clocks, both labelled: `rig new` → merged holds the design time, first commit → merged holds the code's |
| 60 | A merged PR's terminal facts — `number`, `url`, `openedAt`, `firstCommitAt`, `firstReviewAt`, `approvedAt`, `mergedAt` — move into `repos[].pr` once the PR is `MERGED` (record format 2). Decision 39's `status` is the only prior exception to "never write derived state"; this is held to the same narrowness on purpose: never `state`, dirty, or ahead/behind, which keep moving after the record is written, and a merged PR's facts specifically because they cannot change again. `rig close` records them as it goes; `rig backfill [--work] [--force]` fills what closed before the field existed, idempotently and with no negative caching — a lookup GitHub refused is reported and left unstored, never guessed at. `repoEntryJson` (decision 55) prefers a stored record over asking again, `recorded: true` and all, even under `--quick` — the reason a `--quick` `rig list --json` now carries real cycle-time data for closed work, and `rig dash` renders it with no `gh` call at all |
| 61 | Jira **system** fields (`components`, `labels`, `priority`, `versions`, `fixVersions`) are a fixed list in rig, not a discovery: `field create-metadata` returns custom fields only, so there is nothing to discover them from, and a system field's id is its Jira name on every site. Allowed values are still the site's — components come from `twg api jira:/rest/api/3/project/<KEY>/components` through the Jira client, never argv built by a caller. create-metadata wins when both know a name; a name in neither still dies (hugoforte/rig#45) |
| 62 | "Is this work finished" is **one table, in `bin/workstate.mjs`**, read by `close`, `list`, `status` and the ticket write-back instead of each deriving it again. Blocks a close: uncommitted changes, `ahead > 0`, a distance git could not measure, a PR `OPEN`, a PR state GitHub would not answer for. Does not block, and counts as done: a PR `MERGED`, live or read back from the record (decision 60). Neither: no PR at all with a clean tree — safe to close, never "done". The module is pure (no fs, git or gh, like `bin/dash.mjs` and `bin/freshness.mjs`), so the table is testable from fixtures. **A merged PR settles the branch**: `main` requires linear history, every PR lands as a squash, GitHub deletes the head branch, and the pre-squash commits then read as unpushed — or unmeasurable — forever, which is a refusal `--force` was the only way past, on the ordinary path (#52, #42). It settles the branch and not the working tree: `dirty` blocks whatever the PR says, because unsaved work is the one thing a close could destroy. **A missing worktree is not a verdict**: it means the tree is gone, so nothing local is measurable and nothing local blocks; the PR is judged alone, and "worktree missing" is never why a ticket is left open. Facts survive their verdict — `distanceUnknown` is still reported when a merge makes it moot, so `status` can say what git could not measure |
| 63 | **The base a branch lands on is read live, and never written down.** `repos[].base` is the remote HEAD the worktree was cut from (decision 10) and it is right once: rebase the work onto another PR's branch and repoint the PR, and the record says `main` forever. `prForBranch` therefore answers `baseRefName` alongside the PR state — the same round trip, so a live base costs nothing on `list`, `status` or the generated AGENTS.md — and the live base wins for display, for `branchFirstCommitAt`, and for the no-upstream distance in `worktrees.state()`, where measuring a stacked branch from `main` counts the PR underneath as this work's own unpushed commits. Where they differ both are shown, `main → feat/other-work`: a bare live value hides that the record disagrees. A lookup GitHub refused shows the record *named as the record* (`prUnknown`'s rule, applied to a base), and a live base naming a branch this mirror never fetched falls back to the recorded one rather than turning a measurable distance into a `close` blocker. Nothing is stored: a recorded base per branch is hugoforte/rig#21's model change and costs a record-format major (decision 60's narrowness stands), and a base is never a blocker, so `bin/workstate.mjs` does not see one |
| 64 | **The phase is derived; only the gates are stored** (record format 3, `bin/phase.mjs`). `status` is deleted. It held four values and two of them — `planning` and `in-progress` — were `repos.length` written down, which is decision 3's own prohibition; it had the symptom to match, with four write sites, six read sites and every read only *printing* it. Worse, it stopped narrating at `designed` and sat there through build, review and release, which is why nothing ever read it. In its place: **phase** — `planning` → `designing` → `building` → `reviewing` → `landing`, terminating in `closed` or `abandoned` — computed every time from the gates, the repos, the branches and the PRs. **Tense rule**: active phases are present participles and terminal ones past, so the word alone says whether the work is still moving (`landing` over `releasing`, because rig's sight ends at the merge). **Gates are the only lifecycle facts stored**, each as a date — `designedAt` and `abandonedAt` join `closedAt` — because a decision someone took is the one thing no lookup can recover. Evidence outranks its absence in both directions: an open PR reads as `reviewing` even with no design gate recorded (an unrecorded gate is an *omission*, and `rig next` is where an omission is offered), and a recorded gate outranks an empty repo list, because a derived phase must never deny a gate. A document may only carry the phases the record alone can prove — `reviewing` and `landing` need a lookup, so `rig status` says them and the `Status:` header never does. **Contradictions are errors, not drift**: with the derived half no longer stored, the only way one fires is a bug or a hand-edited record, so `doctor` reports them `✗` and says to file an issue. There is no migration mechanism for `work/*/work.json` (`unrunnableHook`), so the record moves on the read path in `loadWork` and the migration exists to move the major, which is what stops an older rig writing the deleted field back. `status: 'designed'` becomes the gate, dated from the record's last activity — approximate for records written before this major, exact for every one after, and the alternative was losing nine live design gates to a rename |
| 65 | **`rig close --abandoned`: stopping a work is a decision worth recording.** Before it, the exits were to leave a dead work idling in `rig list` forever or `rig close --force`, which tears down identically and records a work that landed. It reuses the whole teardown and **drops only the did-it-land blockers** — an unmerged PR and unpushed commits are what being abandoned looks like, not a reason to refuse — while `dirty` still refuses, because unsaved work is the one thing a teardown can destroy whatever it is called. Two dates, two facts: `closedAt` is when the teardown ran and `abandonedAt` is the decision it ended unfinished, and `phaseOf` reports the more specific one. The ticket is commented and **never closed**, because whether the problem is still worth solving is not rig's answer; open PRs are **named and left alone**, because closing someone's pull request is an outward-facing act rig does not take on its own. Folded into record format 3 rather than filed separately: the major *is* the migration count, so as its own change later it would have cost a major of its own, and as one more optional field in a migration already happening it cost nothing |
| 66 | **`rig next` offers; it never warns and never stops** (`bin/next.mjs`, pure like `phase.mjs` and `workstate.mjs`). The epic's principle made concrete: *rig never adds a stop; it adds an answer to "what now"*. It reads live state — repos, branches, PRs, gates — and names what is available: attach, record the design gate, push, open a PR, scaffold a rollout plan, close. Two guardrails are asserted rather than merely intended: **it only offers** (a test runs every shape of work through the output and fails on any reproaching phrasing, because "only offers" is a property of the whole answer and not of any one line), and **it speaks only when asked** — a command, never a hook, never fired off the back of another. A stopped work returns nothing, which is an answer and is said out loud rather than papered over with an invented suggestion. |
| 67 | **Weight is derived from what a work contains, never declared.** ❌ REJECTED: `rig new --track light|full`, or a per-org default in `rig.json`. It is a prediction made before the work's shape is known, and predictions rot — the dependency bump that becomes a four-repo migration by Wednesday leaves the declaration wrong and nobody goes back to fix it, which is `status`'s disease exactly (decision 64). Instead the thresholds are read off the record: one repo gets "this part is yours to write"; **three repos** start being offered a rollout plan, because two is a pair you can hold in your head and three is where deploy order starts causing incidents. Nothing to choose at `rig new`, nothing to un-choose on Thursday. Tripwire, in #17's style: revisit the first time more than one person shares a data root and the org wants to enforce a policy. |
| 68 | **`pushed` asks whether the branch reached the remote, not whether it has an upstream.** `worktrees.state()` gains it, and only `rig next` passes the `branch` that answers it. The obvious implementation — `git rev-parse @{u}` succeeded — is wrong in a way that is invisible until it matters: cutting a branch from `refs/remotes/origin/main` makes git set tracking to *main*, so an upstream exists from the moment `rig attach` runs. `ahead` cannot stand in either, because it counts what is *un*pushed and reads 0 both for a branch that has been pushed and for one nobody has written on — and offering a pull request for an empty branch is precisely the reproach decision 66 forbids. |
| 69 | The catalogue carries a `check` beside `setup` — a repo's test run, its lint, its build — and `rig check` **prints it rather than running it**, with `--run` opting in: decision 31's rule, unchanged, for a command that fails for the same wrong reason in a worktree nothing has set up yet. A command is a durable fact about a repo; a result is not, so no pass or fail is stored anywhere (decision 3 stands) and a failure under `--run` reaches the caller as the exit code alone. One optional frontmatter key is not a record-format change: the catalogue is knowledge about a repo, not a work record, and the majors of decision 60 are `work.json`'s. The empty `check` on a drafted entry is a prompt — `rig check` names the repo and the file to write one in, which is rule 4 at the moment the knowledge is cheap |
| 70 | **Stages: the stacked branch model** (record format 3, `bin/stages.mjs`, closes hugoforte/rig#21). A work lands in its base branch **in one shot** per repo; a **stage** is a delivery slice carried by a branch, stacked on the work branch and merging down into it. The find that started it: rig *already had* a stage model and it was dead prose — `templates/rollout-testing-plan.md` opens with a `## The PRs (deploy order)` table, ordered slices each with a branch and a PR, hand-maintained in a document nothing read back, which is decision 3's prohibition and the failure mode that killed v1. **Stored: the branch and one line of what it delivers**, and nothing else. **Derived: everything else** — started (does the branch exist), up for review (is there a PR), landed (did it merge), which repos carry it (where the branch is found), and where it sits (what it was cut from, read live per decision 63). **Order is derived from the chain**, never stored: a stored order is a second answer to a question the branches already answer, and the two disagree the moment anything is rebased. **The branch name is the stage's identity** — same branch name in two repos is the same stage, which is the join, and is why there is no separate `name` beside it. The chain is per repo while the stage list is per work, so any one repo is enough to place a stage and three repos agreeing is the join working rather than a conflict. rig does not cut the branch: declaring a stage records intent across repos, and branches are made where branches are made. A stage transition is **not a gate** — stages are reported, never stopped at. ❌ REJECTED: a stage as a child work (own slug, folder, worktrees, ticket, close) — deferred not dead, since a `parent` field stays additive; keeping "stage" for the in-work slice is what stops the term meaning two structurally different things. ❌ REJECTED: each stage merging straight into `main` — it ships slices earlier, but these are ticket-sized works with a deploy-order document that exists because ordering caused real incidents, and one commit per work in `main` with a revert that undoes the whole thing is worth more |
| 71 | **A base and a PR belong to a branch, not to a repo.** `repos[].base` and `repos[].pr` become `repos[].branches[]`, one entry per branch of this work the repo carries — decision 60's narrowness unchanged, only correctly scoped now that a repo holds more than one. `loadWork` folds the old pair into the first entry on the way in, losslessly, and derives `entry.base` back off it for every caller that means the work branch — the same load-derive-and-strip-on-save trick `repos[].path` has used since decision 37. `workState` takes the scope this forced: "did it merge" is a question about one branch, and the verdict it reaches is about the **work branch**, because stages merge *down* into it and a work is finished when that branch lands whatever route its commits took. What moves the major is not the read — the new shape is additive and an old rig could read it — but the **write**: an old rig spreads the entry it read and knows neither key, so one mutating command would drop the whole stack. Additive reads are not enough when the write is lossy, and that distinction is exactly what the write refusal exists for |
| 72 | **`rig pr` opens one PR per repo, work branch → base branch.** rig had read PR state everywhere since it existed — `list`, `status`, `close`, `dash`, `workstate` — and had never opened one, which made review the phase it was most obviously absent from; the PR is also the one artifact rig is best placed to write, because it already holds everything the body needs. The body is **assembled, never retyped**: the title, the tickets, the context doc's **Direction** section lifted *verbatim* (a summary is a second copy that drifts, and the reviewer wants the reasoning that was agreed rather than rig's paraphrase of it), and the stage table rendered from the stack — which is the rollout plan's dead deploy-order table finally being generated by something. The scaffolded `_TODO_` is never lifted: an empty section in a PR body is worse than no section. **Not a gate** — a command you run when the stages are in. **Idempotent**: an open PR is reported, a merged one is reported, and neither is duplicated. rig opens the *work branch's* PR and never a stage's, because a stage is reviewed on its own in the repo it touches and rig would have to guess which of the stack was meant. `createPr` joins the interface in `bin/github.mjs` with its in-memory twin (decision 38), so the whole path is tested without a network. One asymmetry is pinned by a test rather than left to be discovered: an *unauthenticated* gh makes lookups answer null, which the adapter's contract makes indistinguishable from "no PR", so the refusal lands on the write instead of the lookup — the safe direction, and the alternative is a duplicate PR |
| 73 | **The rollout plan is made live: its deploy order is generated, its prose is not.** `rig plan` wrote a file and `regenerate` checked only that it *existed*, to add one pointer line — no parsing, no `doctor` check, absent from `rig list --json` and `rig dash`. Its first table was a hand-maintained list of stages, which is the concept decision 70 models properly and the exact shape decision 3 forbids. So the table moves inside `rig:deploy-order` markers and is **rewritten whole** from the stack, by the same renderer `rig pr` uses for the PR body — two generators would be two tables that disagree, which is how this document earned its reputation. Everything outside the markers stays prose, and it is the half that earns the file: why the order is mandatory, the rejection window, the per-tenant prerequisites, the verification queries, the rollback. A refresh never touches them, and a test pins that by hand-editing the prose and asserting it survives. A plan whose markers were removed is **refused**, not appended to: putting a table back somewhere arbitrary in a document someone has been editing is worse than saying the markers are gone. **The standard is "something has to read it back"** — the test this epic applies to every artifact, and the one this file failed for its whole existence. `rig next` is that something: it compares the rendered table to the live stack and offers `rig plan --refresh` when they disagree. An artifact nothing reads is how v1 ended up with a dead "Cross-Repo Contracts" table containing one blank row |
| 74 | **Two record changes that ship in one release are one migration** (ADR-0002, amended). This epic moved `work.json` twice — decision 64's phase-for-`status`, and decision 71's base-and-PR-per-branch — and both landed in a single release, so they are a single migration named for both. The rule follows from what the major is *for*: it gates writes by comparing a tool against a data root's stamp, so a major nothing was ever stamped with gates nothing. Counting shape edits instead would have claimed four formats when only three are reachable and left `v3.0.0` as a hole in the published majors — a version no release exists for and no `writtenBy` could carry. The test is **"was there a release between them?"**, not "were these two different changes"; had the phase change shipped on its own, a data root could have been stamped with it and it would have earned its own major. The two pieces stayed separately *reviewable* regardless — that was the stack's job, not the migration list's, and conflating the two is what made this look like a question in the first place. Splitting them later is explicitly not a free tidy-up: it would renumber a format installations are already stamped with |
| 75 | **A declared stage is discovered, never recorded — and a stage's pull request *merges* into the work branch** (closes hugoforte/rig#78). `rig stage` wrote the branch and its one line into `work.stages[]`, and nothing ever wrote a row into `repos[].branches[]` — the only thing `branchRows` read. So no declared stage could be placed in the chain, and every surface that reports stages reported nothing, however long ago the branch was cut: `rig stage` said "not cut in any repo yet", `rig plan` said "not started", `rig next` never advanced past the first, and `rig pr` carried the same wrong table. The fix is **discovery**: `worktrees.chain()` asks the mirror which of the work's branches this repo carries and what each sits on, and `branchRows` lays the record over the answer. **Nothing discovered is written back** (decision 3), and there is no record-format change — `repos[].branches[]` stays what it already was, the store for the work branch's cut base and a merged PR's terminal facts. What makes the derived chain trustworthy is a **merge convention**, and the measurement that produced it. Decision 70 refused a stored order because a rebase would falsify it; measured, a rebase falsifies the *derived* chain too — `main → work → s1 → s2` with `s1` rebased leaves `main` as the only ancestor of `s2`, so every stage above a rebased one loses its place. But the rebasing was self-inflicted: the epic's own stage pull requests (#69–#75) all merged with `parents=1`, squashes, and a squash replaces a stage's commits so the originals stop being ancestors of anything. So: **a stage's pull request merges into the work branch, and the work branch is squashed into the base branch.** Ancestry then holds at every point, including after the branch below lands and goes — its commits are ancestors of the work branch, so the stage above resolves there, which is where its pull request should then point. rig never merges anything, so this is relied on rather than enforced, and `stageOrder`'s declaration-order fallback is the net under a stage somebody squashes anyway. ❌ REJECTED: recording `{ branch, base }` at discovery — a second answer to a question the commits answer, and decision 3's disease; narrowing `branches[]` to terminal facts only — truer on its face, but **4.0.0** plus a migration for nothing that is needed now, and ADR-0002 says splitting a format change out later is not a free tidy-up; cutting a stage's branch in every attached repo — the repos a stage touches are *derived* from where its branch is found, so a branch cut on a guess is indistinguishable from one cut on purpose, and over-cutting corrupts the derived answer while under-cutting costs nothing |
| 76 | **rig cuts a stage's branch, and the repo is the folder you are standing in** (`rig stage <branch> --cut`). Declaring a stage and making its branch are two acts on two days — a stage is normally declared before anyone cuts anything, which is why decision 75's discovery had to exist and why recording the branch at declaration time could never be the whole answer. `--cut` is how the second act reaches a stage already declared; declaring and cutting at once is both in one command. **Which repo is never asked for**: it is the worktree the command runs in, the same convention rig already uses to resolve the work itself. ❌ REJECTED: a repo list on the command (`--in api,web`) — a prediction of a stage's scope made before the work is done, which is decision 67's argument; and cutting in every attached repo — the repos a stage touches are *derived* from where its branch is found, so a branch cut on a guess is indistinguishable from one cut on purpose, over-cutting corrupts the derived answer, and under-cutting costs nothing because discovery finds the branch you cut yourself. The base is the repo's own top of stack, and that is the point: at the moment of the cut the base is not in doubt, and it is *still* never written down (decision 3 stands, and decision 75's chain answers for it afterwards). Whatever is uncommitted comes along, because starting work and then realising it wants its own stage is the ordinary way round; git decides whether that is possible and its refusal is what comes back |
| 77 | **A stage can carry its own ticket, and an open slice stops a close** — the two halves of a stage being a real unit of delivery rather than a line in a table. GitHub fires a closing keyword only for a pull request that merges into the **default branch**, and a stage's pull request merges into the work branch, so a slice's ticket can never close itself; rig is the only thing that can, and it does so **at `rig close`, with every other ticket** — one outward-facing moment rather than a new rule about when rig speaks. A slice that landed closes its ticket; one that did not is commented on and left open, on decision 65's reasoning that whether the problem is still worth solving is not rig's answer. An optional `tickets` on a `stages[]` entry is additive and survives a round trip through `saveWork`, so it costs no major (decision 74's test: nothing was ever stamped with a format this changes). The close blocker goes **in `workstate.mjs`**, not beside it: "is this work finished" is one table (decision 62), and the stack is passed in rather than derived there because what it costs is not the same for every caller — `list` runs over every work and a git and GitHub pass per stage per work is not what a listing is. (Amended by decision 78: `close` was not the *only* caller that needed the stack. The ticket write-back and `rig next` needed it too and were not given it; `list` still does not, and still should not.) The verdict stays about the work branch; a slice still up for review is simply more unfinished business. And **`rig close --force` records `forcedAt`**: forcing past the blockers is a decision, decision 64's rule is that a decision no lookup can recover is the one thing worth storing, and without it a work closed over an open pull request was indistinguishable from a rig bug — which is precisely what `contradictions` called it, telling you to file an issue about something you did on purpose. That rule is now `rig status`'s to report rather than `doctor`'s, because unlike its three neighbours it compares a record to **live state that keeps moving**, and `status` is the command that has already paid for the lookup. ❌ REJECTED: dropping the rule (it is true once the force is recorded); and having `doctor` fetch the facts (it runs over every work, which is the reason its own comment gave — a comment that described behaviour `status` did not yet have, and now does) |
| 78 | **A reader says what it measured, and a forced close says it was forced** (closes hugoforte/rig#88). Decision 77 gave the stack to `close` and stopped there, and it was short in two directions. **`rig list` overclaimed**: it printed "safe to `rig close`" on a work `close` would have refused, because it never asks the stack — deliberately, since reading it is a git pass and a GitHub call per stage per work, which is not what a listing is. The fix is to **say less, not to look harder**: a work with declared stages gets " (stages not checked)", read off `work.stages` at no cost, and a work with none prints byte-identically to before. That is the rule `--quick` and `prUnknown` already follow — the honest report of a lookup not made is the absence of the claim, not a guess at what it would have said. **`close` and `next` under-asked**: `close` passed the stack to `ticketWriteBack`, which called `workState` again *without* it, so a forced close reached a kinder verdict on the ticket than the one the operator had just been forced past — the work branch landed, so the issue closed with no mention of the slice that did not, and `reasonFor`'s slice line was unreachable in production for want of its only consumer passing the option. `rig next` offered `rig close` one line after naming a slice as up for review; it held `stack` the whole time and the offer simply never asked it, so it now does and the stack is read once rather than twice. **And the ticket names the force**: `forcedAt` records the decision where only rig can read it (decision 77), while the ticket is what someone who was not the operator reads, and a close that tore down past an open pull request must not be indistinguishable there from one that had nothing to get past. ❌ REJECTED: reading branch presence from local git in `list` (issue #88's option 2 — cheaper than it sounds, still not free, and not precluded by this); documenting the asymmetry and leaving it (the complaint was never the asymmetry, it was that a hint read as a verdict); and closing the ticket anyway with the slice noted in the comment (a closed issue is the thing people act on, and the note under it is the thing they do not read) |
| 79 | **A stage the branches place outside the stack says so** (closes hugoforte/rig#89). `stageOrder` puts what the chain walk could not reach last, in declaration order. The fallback is right and it was invisible: a plausible numbered list with nothing to say the order had stopped being evidence. The first cut of this said so whenever **the walk fell short**, and measurement killed it — the walk falls short on the ordinary life of a sliced work. Every stage with a pull request reports the **work branch** as its base, because that is decision 75’s convention and `branchRows` prefers the live PR base, so the walk reaches exactly one and the note accused all the rest; and once the stage below lands and its branch goes, nothing surviving is an ancestor of the stage above, so it has no base at all — decision 75’s own justification has that ancestry backwards. Both are the steady state of every sliced work under review, and both are **indistinguishable from the squash this began as a net for**. So the condition is a **contradiction, not an absence**: `stageOrder` marks a stage `adrift` when some repo puts it on a branch this stack does not contain, `stageState` carries it, and `adriftNote` is the one line, rendered in `rig stage`, in the deploy-order table `rig plan` and `rig pr` share, and in `rig next`. An absence says nothing, on the rule that an unknown is not a fact. Two judgements. **One note, not a mark per row** — it names the branches, so being quieter than a column costs no precision. **The fact, never the guess** — “outside the stack” is what the branches report; “somebody squashed the branch below” is a guess about a merge button, and a rebase does the same thing. `adrift` is **any repo, not the first to answer**: which repo was attached first must not be something a reader can feel, and a stage rebased off the stack in one repo is genuinely adrift there. The note renders **inside `stageTable`**, because `planIsStale` compares rendered regions and a note beside it would leave a fresh rollout plan disagreeing with its stack with nothing able to see it. **Known limitation, deliberately not fixed here**: `worktrees.chain()` chooses a base from a candidate set of the work branch plus the declared stages, so a git-derived base is inside the stack by construction and a stage cut off the stack reports `base: null` — the same answer as an ordinary landed neighbour. Only a pull request can currently name a branch outside the stack, so only a pull request can currently raise this. Making git able to say it is a change to how a stage’s base is derived, which is a defect predating this and deserves its own issue. ❌ REJECTED: keying the note on the walk falling short (measured: it fires on the convention); a `Placed` column (a column of “yes” to say something about the exception); naming the likely cause (a guess dressed as a finding); treating two repos disagreeing about a base as adrift (a pull request retargeted in one repo and not yet in another disagree benignly, which is the same noise again) |
| 80 | **The two checkouts an installation owns are one module, `bin/checkouts.mjs`** (closes hugoforte/rig#82). The data root and the tool checkout are the only two git checkouts rig manages, and they differ in *policy* and never in mechanism — so eleven functions in `rig.mjs` held **two state shapes for one question** (`repo` a boolean in one and an enum in the other, `upstream` a name in one and a flag in the other) and **two implementations of fetch-then-fast-forward on the same directory**, disagreeing about what blocks a move. Decision 57's treatment, applied to the other half of rig's git: one shape, one fast-forward, and the operations rig actually performs on a checkout — read it, fetch, fast-forward, commit everything, rebase-and-push. **The module never narrates.** `worktrees.mjs` takes `step` and `warn`; this one answers named outcomes, because the wording *is* the policy — "run `rig save`" for the data root and "`git -C … status` shows them" for the tool are the same outcome said to two audiences, and a module returning prose would have to know which. `prepareDataRoot`, `commitDataRoot`, `updateCheckout`, `doctor` and the freshness paths become callers that decide policy rather than re-deriving mechanism. **What blocks a fast-forward is tracked changes, not any dirt** — a behaviour change, and the divergence resolved in favour of the reading that says why: git refuses on its own when a merge would overwrite an untracked file, so refusing on *any* untracked file lets one stray note wedge the installation, and for the data root the advice that followed would `git add -A` it and manufacture the divergence being avoided. `dirty` survives beside `modified` because it answers a different question — what `git add -A` would sweep up, which is what makes a tree unsafe to migrate in. **One shape does not mean one cost**: `identify` asks the freshness questions and `describe` asks the distance ones, because the first runs at the end of every command and a git call is tens of milliseconds, so merging the two readings naively would have taxed the whole tool for fields nobody reads. The seam is the injected `run` (decision 57's, and the spawn seam #81 filed as unfiled), which is what puts `GIT_TERMINAL_PROMPT=0` on the fetch itself rather than on one helper. **Naming an outcome is what found the bug in it**: `pushRebasing` inherited an unconditional `git rebase --abort` on any rebase failure, and `git rebase` fails for reasons that are not conflicts — a rebase the user left in progress is one, and aborting *that* throws away their work together with the commit rig has just made, leaving it reachable only from the reflog. The old code could not see this because it had no name for the state; the module has three (`underway`, `refused`, `conflict`), and the abort now only ever undoes a rebase this started. The same applies to the readings: a `git status` git would not answer used to count as a clean tree, which is what `rig update` decides to migrate on, and is now `null` — while `null` is explicitly *not* read as "there are changes in the way" either, because the merge is where git gets to refuse and its refusal names the index rather than guessing at it. ❌ REJECTED: a module per checkout — they would share every line of mechanism and differ only in wording, which is the duplication with a seam through the middle of it; a module that narrates — see above; and a fake runner for the tests — `worktrees.test.mjs` set the precedent with real local git, which is faster to read and harder to fool, so the fake appears only where real git will not produce the answer on demand |
| 81 | **`doctor`'s checks are findings, decided in `bin/doctor.mjs` and printed by `rig.mjs`** (closes hugoforte/rig#84). The largest function in the tool interleaved probing, severity and rendering over ~20 checks, with a `problems` counter that became the exit code — so the command you run *because something is already broken* was the command with no unit tests, and three of the seventeen `rig(['doctor'])` spawns existed only to prove it had not died before reaching its verdict. The caller now gathers one plain snapshot and the module turns it into `{ verdict, says, dim, counts }`, the exit code being `findings.filter(f => f.counts).length`. **`counts` is a separate axis from `verdict` because it already was one and nowhere said so**: a dirty data root and a draft catalogue entry warn without counting, and nineteen identical-looking `problems++` sat inline beside them. Unlike `checkouts.mjs` (decision 80) this module **narrates**: a finding has one audience, so the wording *is* the check, and outcome codes would only put the twenty-one messages back where they cannot be asserted — `next.mjs`'s split, not `checkouts.mjs`'s. Decision 54 stands and becomes a *field*: a check this machine cannot make arrives null in the snapshot and is dropped or noted, never counted. The crippled-PATH tests stay, all three — surviving a missing probe is a property of the probing, which is the half that is still impure |
