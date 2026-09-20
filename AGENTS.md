# rig — agent instructions

`rig` assembles cross-repo worktrees for a piece of work and keeps the durable knowledge
about that work in a **data root** — a committed checkout that holds the catalogue, the
work records and `rig.json`. Read `DESIGN.md` for why it is shaped this way; this file is
how to *use* it.

## The three roots

| | |
|---|---|
| `C:\rig` (this repo) | **The tool.** Committed, generic, public. |
| the data root | **The knowledge.** Committed, private. `catalog/`, `work/`, `rig.json`. A separate checkout named in `rig.local.json` — never this one. `rig doctor` prints which. An installation may know several, by name; see "More than one data root". |
| `C:\w` (the work root) | **Disposable.** Worktrees and bare mirrors. Deleting it loses nothing. |

Never put durable prose in the work root. Never put anything that names a real org, repo or
system in this repo — that is what the data root is for. Never put machine-specific paths
or secrets in either committed repo.

## First run

Installing is the README's job: clone, `npm install -g` the clone, and `rig` is on PATH.
`rig doctor` says "not set up" until there is a data root — separate from this checkout —
with a `rig.json` in it. Run the setup interview; its first question is where the knowledge
lives:

```bash
rig prompt setup      # join an existing private data repo, create one, or go local; ends in one `rig init`
rig init --data-repo owner/rig-data --email you@work   # the join path, if you already know the answer
```

The tool checkout is never the data root. Knowledge inside a public tool's tree is one
`git add` from a leak, and `doctor` reports that layout as not set up.

## Starting a work

`rig new` **refuses** on any data root with a live tracker (`rig.json`) unless you pass
one of `--key`, `--ticket`, or `--no-ticket` — the ticket decision must be explicit.
`rig prompt new-work` is the full procedure; the shape:

```bash
rig new PROJ-42-refund-double-charge --title "Refunds double-charge on retry" --key PROJ-42
```

Already have a key? A GitHub key (`owner/repo#7`) still needs its brief piped in; a Jira
key (`PROJ-42`) rig fetches the summary and description for itself — no pipe needed:

```bash
<your github issue fetch> | rig new <id> --title "..." --key owner/repo#7
rig new <id> --key PROJ-42                       # rig fetches the brief
```

No ticket yet? `rig new --ticket --dry-run` resolves what would be created (for Jira: the
project, type, and every field, with `sprint: "active"` and named fields like `components`
resolved to real ids via `rig.json`'s per-org config) and exits without creating anything
— present it and stop for the user's decision, then run the same command without
`--dry-run` to create for real:

```bash
<brief> | rig new refund-double-charge --title "..." --ticket --dry-run   # preview
<brief> | rig new refund-double-charge --title "..." --ticket             # then create
```

No ticket wanted at all? `rig new <id> --title "..." --no-ticket` records the decision —
`Tickets: none (declined)`, not a silent empty list. On `rig close`, every ticket gets a
comment with the PR links; GitHub tickets also close when every PR is merged. Jira tickets
never auto-transition — that stays with you (`docs/adr/0001-jira-via-twg.md`).

Then run the repo interview and attach what it selects:

```bash
rig prompt select-repos     # read this and follow it
rig attach billing
rig attach orders-web
```

## Rules that matter

1. **Never `git worktree add` inside the work root.** Use `rig attach`. rig owns that tree and
   `rig doctor` fails on strays. Outside it — your old clone directory, say — do
   whatever you like; rig neither models nor touches it.
2. **Never edit a generated file.** `C:\w\<work>\AGENTS.md` is regenerated on every mutating
   command. The context doc in `<data root>/work/<id>/context.md` is the only place prose
   lives.
3. **Never write derived state into a doc.** Branch, base, ahead/behind, PR state, and the
   **phase** — all of it comes from `rig status`. The previous attempt at this tool died of
   hand-maintained tables going stale. What rig *does* record are **gates**: `designedAt`,
   `abandonedAt` and `closedAt`, each a decision on a date that nothing can observe
   afterwards. The phase (`planning` → `designing` → `building` → `reviewing` → `landing`,
   terminating in `closed` or `abandoned`) is computed from those gates and the repos,
   branches and PRs every time it is shown — see `bin/phase.mjs`. A merged PR's terminal
   facts (`number`, `url`, `openedAt`, `firstCommitAt`, `firstReviewAt`, `approvedAt`,
   `mergedAt`) are the other thing stored, recorded by `rig close` and `rig backfill` once a
   PR is `MERGED` — a terminal fact cannot go stale the way branch or PR state can, which is
   what makes storing it a different act from storing state.

   A repo's record carries `branches[]` — one entry per branch of this work it holds, each
   with the base it lands on and, once merged, that PR's terminal facts. A base belongs to the
   branch it was cut for, not to the repo, because a repo carries several once a work has
   stages.

   The `Status:` line in the context doc header and the generated `AGENTS.md` carries only
   the phases the record alone can prove, because nothing written into a file may depend on a
   lookup: `reviewing` and `landing` are said by `rig status`, never by a document.
4. **Correct the catalogue in passing.** `rig attach` drafts a stub entry marked
   `DRAFT: unreviewed` for any repo it hasn't seen. Fix it while the repo is still loaded in
   your head — that is the only moment the knowledge is cheap.
5. **The repo set is mutable.** Attaching a fourth repo on day two is normal.

## The catalogue

One file per repo at `<data root>/catalog/<org>/<repo>.md`: YAML frontmatter (`repo`,
`org`, `stack`, `role`, `talks_to`, `setup`, `check`) plus prose.

**Durable facts only.** No branch, no local path, no status — anything git or `gh` can
answer is derived live. `talks_to` is the load-bearing field: repo selection is graph
traversal over it.

`setup` is how a repo is made ready; `check` is how it is verified — its test run, its
lint, its build. Both are commands and never results: no pass or fail is ever stored.

```bash
rig check                 # what verifies every repo in this work — printed, not run
rig check billing --run   # run billing's, in its worktree; non-zero if one fails
```

Neither is run behind your back: `rig attach` prints the setup commands and `--setup` opts
in, `rig check` prints the check commands and `--run` opts in. A command that cannot
succeed yet — a test run in a worktree nothing has installed — is worse run than shown. A
repo whose `check` is empty is named, with the file to write one in; write it while the
repo is still loaded in your head (rule 4).

## Writing a context doc

`rig new` scaffolds four sections. Add more from `templates/context-sections.md` **only when
you have content for them**. Empty stubs are how the last attempt ended up with a dead
"Cross-Repo Contracts" table containing one blank row.

Two habits worth keeping from the docs this inherits:

- **Inline epistemic markers.** `✅ CONFIRMED (2026-06-12)` / `❌ REFUTED by data (2026-06-12)`
  with the evidence. Leave refuted hypotheses in place — the record of what you believed and
  why you stopped is worth more than a tidy answer.
- **"Key data points"** — column semantics, config keys, idempotency keys. The
  expensive-to-rediscover facts. This is the section that must still be useful in two years.

**End the design gate with `rig save --designed`.** Every rig command that changes a work
(`new`, `ticket`, `attach`, `detach`, `plan`, `save`, `close`) ends by committing the whole
data root and pushing it when it has an upstream — one line says which commit and whether
the push landed; a push that fails warns and never dies. But the context doc is edited by
you, not by rig, so when the Direction section is agreed, run:

```bash
rig save -m "design agreed" --designed   # records the design gate, commits, pushes
rig save -m "refuted the sync hypothesis" # any later edit made outside rig
```

Nothing asks first, and nothing runs on a timer: knowledge is committed at the moments it
was just agreed, with the catalogue corrections you made in passing swept up alongside.

## More than one data root

Personal, public and employer knowledge are separate repos because they have separate
readers. One installation knows them all, by name:

```bash
rig use                  # every data root this machine knows; * marks the current one
rig use employer         # move `current` — verified first, refused if it cannot be worked in
rig list --data personal # one command against another root, without moving anything
rig init --data-repo me/rig-data --name personal   # add one
```

Which root a command reads is the first of these that answers: `--data <name>`,
`RIG_DATA_ROOT`, **the work folder the command is running in**, **the repo it is about**,
then `current`. The middle two are the ones that matter: `C:\w\<id>\.rig\data` names the
root a work's records live in, and a repo's catalogue entry — drafted by `rig attach` the
first time it saw that repo — names the root that repo belongs to. So `rig new <id> --repos
Payments` lands in Payments' root, a command run in a checkout of a catalogued repo answers
for that repo's root, and `current` decides only for what neither can place — `new` with no
repos, `list`, `catalog`, `dash` — which say so when it did.

**A work lives in one data root.** One `work.json`, one `context.md`, and two roots with
different readers, so it cannot span them: `rig new --repos a,b` refuses when a and b are
catalogued in different roots, and `rig attach` refuses a repo belonging to another root
rather than drafting its entry into this one. Two works, one per root, is the answer.

Two consequences worth holding on to:

- **One work root, shared.** A work id is unique across every data root on the machine, and
  `rig new` refuses one whose folder exists, naming the root that owns it. Renaming a folder
  another root's records point at would break that work, so the id is what gives.
- **`rig update` brings every configured root forward**, not the one in hand. The write
  refusal is per data root, so migrating only the current one leaves the others to refuse the
  next mutating command, mid-work.
- **`rig doctor` checks every configured root**, in full, each finding labelled with the
  root's name — the roots nobody looks at are the ones that rot. Its two work-root checks are
  the exception and are asked once against every root's records at once: the work root is
  shared, so a folder the current root has no record for is usually another root's live work
  rather than junk. It is also the one command that **reports a selection it cannot make**
  rather than dying on it: two roots and no `current` is a finding like any other, and every
  check that did not need a root in hand still runs. Every other command dies there, and
  should — with no root in hand there is no answer to give.

A name selects which knowledge is in hand and **nothing else**. There are no per-root flags
and no per-root defaults for ceremony — that would be the declared-track mistake rejected in
`rig next`'s design, with a config file instead of a flag.

## Stages

A work lands in its base branch **in one shot**, per repo. A **stage** is a delivery slice of
that work, carried by a branch and reviewed on its own, stacked on the work branch and merging
back down into it.

```bash
rig stage                                          # the stack, in the order the branches are stacked
rig stage feat/schema --delivers "the write path"  # declare one
rig stage feat/schema --cut                        # and make the branch, here, on this repo's stack
rig stage feat/schema --key owner/repo#7           # give the slice its own ticket
```

**A work with no stages behaves exactly as it always did** — one branch per repo, one PR each.
Stages are for a work big enough to want slicing up, and most are not.

Two things to hold on to:

- **rig does not cut the branch behind your back.** `--cut` makes it, in the repo whose
  worktree you are standing in and nowhere else, on top of whatever that repo's stack reaches.
  There is no repo list to type, because the repos a stage touches are derived from where its
  branch is found — so a branch cut on a guess would be indistinguishable from one cut on
  purpose. Cut it yourself in your editor instead and rig finds it either way.
- **The branch name is the stage's identity.** Same branch name in two repos means the same
  stage — that is the join. A stage exists only in the repos that carry its branch, so the
  chain is per repo while the stage list is per work.

**How a stage lands.** A stage's pull request merges into the work branch **with a merge
commit**; the work branch is **squashed** into the base branch at the end. The squash is what
keeps one commit per work in the base branch. The merge is what keeps the stack readable: a
squash replaces a stage's commits, so the stage above stops descending from anything and has
to be rebased — and a rebase is what breaks the chain rig reads the order from. rig never
merges anything, so this is a convention it relies on rather than enforces; a stage somebody
squashes anyway falls back to the order it was declared in.

**Stored: the branch, one line of what it delivers, and a ticket if you gave it one.**
A stage's pull request merges into the work branch, never the default branch, so a closing
keyword never fires for it and a slice's ticket cannot close itself. `rig close` closes it when
the slice landed, and comments and leaves it open when it did not. Everything else is derived — whether
it has started (does the branch exist), whether it is up for review (is there a PR), whether it
landed (did it merge), which repos carry it, and where it sits in the stack (what it was cut
from, read live). Order is **never stored**: a stored order is a second answer to a question the
branches already answer, and the two disagree the moment anything is rebased.

A stage transition is **not a gate**. Stages are reported, never stopped at.

## What now

```bash
rig next        # what is available on the current work, read off live state
```

It reads the repos, the branches, the PRs and the gates, and names what is available —
attach something, record the design gate, push, open a PR, scaffold a rollout plan, close.

Two things it will never do, and both are the point:

- **It only offers.** It never warns, never blocks, and never says you should have. Warnings
  live in `doctor`, and only for contradictions. A work that reached review with no design
  gate recorded has an *omission*, and an omission is something to offer, not to scold.
- **It speaks only when asked.** A command you run — not a hook, and never fired off the back
  of another command.

**Weight is derived, never declared.** A work earns its ceremony from what it contains: one
repo and no stages gets "build it, open the PR, close it"; three repos start being offered a
rollout plan, because that is where deploy order stops being obvious. There is no
`--track light|full` and there will not be one — a declaration made at `rig new` is a
prediction, and predictions rot.

## Staying up to date

A dim line on stderr — `rig is N commits behind … — rig update` — is addressed to you. Run
`rig update` from the installed checkout; the copy inside a work's `rig` worktree refuses,
because updating it would move the work's branch. `update` fast-forwards only, exits non-zero
when it could not do what was asked, and ends in the doctor checks.

A mutating command that dies with "run `rig update`" hit the **write refusal**: the data root is
at a newer record format than this rig (the major version *is* the record format,
`docs/adr/0002-the-major-version-is-the-record-format.md`). Read-only commands — `list`,
`status`, `catalog`, `doctor` — still answer. Mutating commands fast-forward the data root
before they read it, so a second machine never works from stale records. How the check is
measured and configured is in the README's "Staying up to date" and DESIGN.md decisions 45–49.

## The rollout plan

```bash
rig plan             # scaffold it, deploy order already rendered from the stack
rig plan --refresh   # re-render that table when the stack has moved
```

The file is **part generated and part prose**, and the split is the point.

Between the `rig:deploy-order` markers is rig's: the deploy-order table, rendered from the
stage list with live PR state, rewritten whole. **Never edit inside the markers** — the next
refresh overwrites it, which is exactly what stops that table going stale.

Everything around it is yours, and it is the part that earns the document: *why* the order is
mandatory, the rejection window between deploys, the per-tenant configuration prerequisites,
the UAT matrix, the verification queries, the rollback. Those are judgements nothing can
derive, and a refresh never touches them.

**Something has to read it back.** That is the standard this whole epic uses to decide whether
an artifact deserves to exist, and the rollout plan failed it for its entire existence — `rig
plan` wrote the file and nothing ever looked again. Now `rig next` compares the rendered table
to the live stack and offers `rig plan --refresh` when they disagree.

## Opening the pull requests

```bash
rig pr        # one PR per repo, work branch to the base it was cut from
```

The body is assembled from what the record already holds: the title, the tickets, the
**Direction** section of the context doc lifted verbatim, and the stage table rendered from the
stack. Nothing in it is retyped, which is the point — the deploy-order table stops being
hand-maintained the moment something renders it.

**Not a gate.** A command you run when the stages are in. Idempotent like everything else: a
repo that already has an open PR is reported, not duplicated.

rig opens the *work branch's* PR, never a stage's. A stage is reviewed on its own, in the repo
it touches, and rig would have to guess which of the stack you meant.

## Closing

```bash
rig list                  # flags works whose PRs are merged and whose trees are clean
rig close                 # refuses if anything is uncommitted, unpushed, or has an open PR
rig close --abandoned     # stopped, not finished: the did-it-land checks are dropped
```

`rig close` removes the worktrees and keeps `context.md`. Nothing is ever auto-deleted.

A **stage** still up for review refuses the close too, and is named like any other blocker: a
slice that never landed is unfinished business, and the work branch's own pull request cannot
say so. `--force` tears down past all of it and **records that it did** (`forcedAt`), because
forcing is a decision and a work closed over an open pull request is otherwise
indistinguishable from a bug — which is what `rig status` would call it.

**Abandoning is a different answer, not a softer close.** `--abandoned` is for a work you
stopped without finishing: an unmerged PR and unpushed commits are what that *looks like*, so
those checks go, and uncommitted changes still refuse because unsaved work is the one thing
a teardown can destroy. The ticket is told and left open — whether the problem is still worth
solving is not rig's call — and open PRs are named and left alone, because closing someone's
pull request is an outward-facing act rig does not take on its own.

Reach for it instead of `--force` all the same, and the difference is what each one records.
Neither closes a ticket it cannot honestly close: a forced close has always left the issue
open when the work branch's own pull request was still open, and a slice still up for review
is now said the same way, with the reason in the comment and `--force` named in it. What
differs is the record. `--abandoned` says the work ended unfinished, and the phase reads
`abandoned`; a forced close reads `closed`, with `forcedAt` the only sign anything was
overridden.

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues on `hugoforte/rig`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Principles

Working *on* rig: **keep it refactorable, but don't factor it early** — two similar things
are a coincidence, so wait for the third before naming the pattern. And **strong
convictions, loosely held** — decide, write the reason down, and let evidence move you.
Both are stated in full in DESIGN.md's "Principles".

### Releases

Working *on* rig rather than with it: your PR carries its own version. A required check
computes what it lands as — `feat/` branch → minor, `fix/` → patch, a `release:` label
overrides — and fails until `package.json` says it, naming the value to write. The merge
tags it and publishes notes made of the PR descriptions, so write the description as the
release note. README's "Releases" and `docs/adr/0003-the-pr-carries-its-own-version.md`.
