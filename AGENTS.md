# rig — agent instructions

`rig` assembles cross-repo worktrees for a piece of work and keeps the durable knowledge
about that work in a **data root** — a committed checkout that holds the catalogue, the
work records and `rig.json`. Read `DESIGN.md` for why it is shaped this way; this file is
how to *use* it.

## The three roots

| | |
|---|---|
| `C:\rig` (this repo) | **The tool.** Committed, generic, public. |
| the data root | **The knowledge.** Committed, private. `catalog/`, `orgs/`, `work/`, `rig.json`. A separate checkout named in `rig.local.json` — never this one. `rig doctor` prints which. An installation may know several, by name; see "More than one data root". |
| `C:\w` (the work root) | **Disposable.** Worktrees and bare mirrors. Deleting it loses nothing. |

Never put durable prose in the work root. Never put anything that names a real org, repo or
system in this repo — that is what the data root is for. Never put machine-specific paths
or secrets in either committed repo.

## First run

Installing is the README's job: clone, `npm install -g` the clone, and `rig` is on PATH. rig
needs git 2.38 or newer.
rig never waits at a credential prompt, and no askpass program is run for it: git needs a
credential helper (`gh auth setup-git`), and an ssh key rig uses must be in an agent
(`ssh-add`). Without one, the call fails and says which (DESIGN.md decision 156).
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

A Jira ticket that belongs under an epic says so with `--parent PROJ-7`, on the preview and the
create alike (DESIGN.md decisions 145–146).

No ticket wanted at all? `rig new <id> --title "..." --no-ticket` records the decision —
`Tickets: none (declined)`, not a silent empty list. On `rig close`, every ticket gets a
comment with the PR links; GitHub tickets also close when every PR is merged. Jira tickets
never auto-transition — that stays with you (`docs/adr/0001-jira-via-twg.md`).

A key the record holds can turn out wrong: an issue transferred to another repo, or deleted and
opened again, has a new number. Correct it in the record rather than by hand:

```bash
rig ticket owner/other#12 --replaces owner/repo#7   # in the old key's place, on the work or a stage
rig ticket --remove owner/repo#7                    # off the record, wherever it is held
```

Both rewrite `work.json`, the context doc's `Tickets:` line and the generated `AGENTS.md`, and
neither tells the tracker anything: a ticket next hears from rig at `rig close`. `--remove` says
the record was wrong about a ticket. It is not the answer for a ticket this work only delivers
part of, which the record is right to name; DESIGN.md decision 124 says why.

Then run the repo interview and attach what it selects:

```bash
rig prompt select-repos     # read this and follow it
rig attach billing
rig attach orders-web
```

## Stops

A **stop** is a gate where the agent waits for the human. A work has five:

1. **The ticket decision** — `--key`, `--ticket` or `--no-ticket` at `rig new`.
2. **The repo set** — the repo interview ends by presenting the set and waiting.
3. **The design gate** — the Direction agreed, with the adversarial-review choice.
4. **The lesson review** — `rig-learn` presents its lessons and waits for "go".
5. **The user-docs edit** — `rig-docs` shows the edit and publishes only on "go".

**Only the repo set and the design gate can stop being stops.** The ticket decision already is
the human's, made on the command line. The lesson review and the user-docs edit stay stops because both
reach outside the work: skipping them would let an agent file issues on a tracker, edit the org
doc and publish the product's docs unseen. A work chooses at `rig new`,
and `rig save` changes it later:

```bash
rig new <id> --title "..." --no-ticket --stops design   # wait at the design only
rig save --stops none                                   # wait at neither, from here on
```

Absent means both, which is how every work behaved before the choice existed, so there is nothing
to ask: pass `--stops` only when the user said at the outset what to skip. Unlike the declared
track decision 67 rejected, a stop is read once, just before it fires, so a choice made early has
nothing to go stale against.

**A gate that is not a stop is still a gate.** The agent decides it and says so:
`rig attach <repo> --by-agent` (or `rig new --repos a,b --by-agent`) for the repo set, and
`rig save -m "design agreed" --designed --adversarial --by-agent` for the design. Deciding the
design alone, the agent chooses the adversarial review: it costs the agent effort and the human
nothing. `rig status` marks what the agent decided, `rig list --json` carries `stops` and
`agentDecided`, and `rig next` offers it to the human for review. The human agreeing the design
again, without `--by-agent`, clears both marks, since the repo set is in the Direction they agreed.
With the review choice the agent made, that is a confirmation: the design keeps its date, so an
adversarial review already done still stands. `rig status` always names the stops, the default
included.

**A skipped stop fires anyway once the work outgrows what the human saw**: more repos than the
human named at the start, or three repos, the weight at which `rig next` offers a rollout plan.
`rig next` says the second, before the design is recorded and after the agent recorded it alike; the first is the agent's to notice.

Stops are kept by the prompts and skills, not by rig: no command refuses because a stop was
skipped, and none waits. rig records the choice and what the agent decided.

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
   `reviewedAt`, `learnedAt`, `documentedAt`, `abandonedAt` and `closedAt`, each a decision on a date that nothing
   can observe afterwards — and, beside `designedAt`, whether the design chose an adversarial
   review; and the choices about gates: which ones the work stops at (`stops`) and which ones
   the agent decided (`agentDecided`), see "Stops". The phase (`planning` → `designing` → `building` → `reviewing` → `landing`,
   terminating in `closed` or `abandoned`) is computed from those gates and the repos,
   branches and PRs every time it is shown — see `bin/phase.mjs`. A merged PR's terminal
   facts (`number`, `url`, `openedAt`, `firstCommitAt`, `firstReviewAt`, `approvedAt`,
   `mergedAt`) are the other thing stored, recorded by `rig close` and `rig backfill` once a
   PR is `MERGED` — a terminal fact cannot go stale the way branch or PR state can, which is
   what makes storing it a different act from storing state.

   The **outcome** is the third: what changed for someone and why that is good, in a sentence
   or two a person outside the work can read, stored as `outcome: { text, at }` by
   `rig save --outcome "…"`. It is a statement made once the work landed, which nothing can
   derive later; saying it again replaces it. `rig next` offers it once every PR has merged,
   `rig close` names a work that merged everything and closes without one, and neither
   refuses. `rig list --json` carries it for whatever renders what landed.

   A repo's record carries `branches[]` — one entry per branch of this work it holds, each
   with the base it lands on and, once merged, that PR's terminal facts. A base belongs to the
   branch it was cut for, not to the repo, because a repo carries several once a work has
   stages.

   The `Status:` line in the context doc header and the generated `AGENTS.md` carries only
   the phases the record alone can prove, because nothing written into a file may depend on a
   lookup: `reviewing` and `landing` are said by `rig status`, never by a document.
4. **Correct the catalogue in passing.** `rig attach` drafts a stub entry marked
   `DRAFT: unreviewed` for any repo it hasn't seen. Fix it while the repo is still loaded in
   your head — that is the only moment the knowledge is cheap. `rig next` offers it for the
   work in hand, through every phase in which the worktrees are still on disk, and `rig close`
   names what is still a draft on the way out. Neither refuses: prose that stays wrong destroys
   nothing. The offer is on `next` rather than on `close` because no rig command waits for a
   human — close tears the worktrees down and exits, so asking there would be asking for work on
   repos it had already deleted.

   What the work *taught* is the same kind of knowledge, asked the same way. Once a PR is open
   `rig next` offers the lesson review: the `rig-learn` skill reads the story (the context doc,
   review threads, failed checks, the commit log) and offers each lesson a home — an
   attached repo, the catalogue, the org doc, an issue on rig, or rig's philosophy page — a
   machine check before prose, and never a new rule. The org doc is the one home for prose
   every session reads, and "The org doc" below says why that is allowed. `rig save --learned` records the gate, and `rig close` names a work that never
   passed it. Neither refuses.

   The story includes the sessions that did the work, where this machine keeps them.
   `rig status --transcripts` prints their paths, one a line on stdout: the sessions whose
   workspace is the work folder or one of its worktrees, found through the patterns in
   `rig.local.json`'s `transcripts` (`rig prompt setup` has Claude Code's). rig knows no agent
   host. A pattern must place the workspace with `{slug}`, or it would read every work's
   sessions, which are private; one that does not finds nothing and is named. `rig-learn`
   reads only what the command prints, through subagents.
5. **The repo set is mutable.** Attaching a fourth repo on day two is normal.
6. **Replying to the user.** Open every reply with a **TL;DR**: a few lines with what happened or the answer, then the action items the user must take, if any — or "Nothing for you to do." Everything else follows below it, for whoever wants to read on. A skill or prompt that sets its reply's shape keeps it: its opening lines are the TL;DR, and they name the user's action items.

   The generated work `AGENTS.md` carries that paragraph word for word, under `## Replying to the user`, from a work's next mutating command on, and each skill rig ships points here, so it holds whichever agent host is running.

## The catalogue

One file per repo at `<data root>/catalog/<org>/<repo>.md`: YAML frontmatter (`repo`,
`org`, `stack`, `role`, `talks_to`, `setup`, `check`, `docs`) plus prose.

**Durable facts only.** No branch, no local path, no status — anything git or `gh` can
answer is derived live. `talks_to` is the load-bearing field: repo selection is graph
traversal over it, and `rig impact <repo>` is that traversal as a command — the repos one and
two hops away, what each end said about the relationship, which way it runs, and how far
behind each entry is.

```bash
rig impact billing        # what a change in billing reaches, and what reaches it
```

A `talks_to` item may carry a `direction` beside its `how`: `downstream` means "a change in
this repo can break that one", `upstream` is the other way, `both` is both. **Absent means
unstated, which is not the same as both ways** — rig prints the edge and declines to place it.
Either end may state it and rig reads it from whichever end is asking, so `downstream` in one
entry and `upstream` in the other are one claim agreed twice. Two entries making different
claims are a **disagreement**: reported, never resolved by picking a side, because the
disagreement is the thing worth seeing. `rig impact` offers and never blocks, and it is the only
place a disagreement is reported — `rig doctor` does not look for them.

**Two graphs, and the disagreement is the output.** Beside the declared graph `talks_to` makes,
`rig impact` reads an **observed** one out of the work records: which repos have been attached
to the same work, and how many times. It is read out of what was recorded rather than what anyone
claimed, so it cannot be wrong about what happened — but it can only ever see repos somebody has already
worked on together, so it never catches the fourth repo the first time. A pair the records keep
making with nothing in `talks_to` to explain it is the finding, and rig names the entry to
correct.

**Two commands offer the neighbours you have not attached.** `rig attach` names them once, at
the moment the repo set is being chosen, from both graphs. `rig next` offers only the declared
ones, through planning, designing and building, and goes quiet from `reviewing` on — once a
pull request is open, adding a repo is a decision already taken. Neither blocks, and neither
attaches anything for you.

`setup` is how a repo is made ready; `check` is how it is verified — its test run, its
lint, its build. Both are commands, and the catalogue never holds a result.

```bash
rig check                 # what verifies every repo in this work — printed, not run
rig check billing --run   # run billing's, in its worktree; non-zero if one fails
```

**A pass is recorded, pinned to the patch.** What passed at one diff cannot be seen afterwards —
a re-run says what passes now — so `rig check --run` records each repo that passes on the work
branch's record as `verified`: the branch it ran on, the head, where it leaves the base, a
patch-id for the diff between them (whitespace counts, and no one's diff settings shape it), and
the date, all read before the run, so what the run itself writes is not taken for what it proved. That makes `rig check --run` a mutating command: it
commits and pushes the data root like `rig save`, and `rig check` without `--run` writes
nothing. A failure clears the pass. A pass with uncommitted changes is not recorded, since they are in no
patch, nor one on a detached HEAD, which is in no PR. A worktree not on this machine is not run,
and a check that never started is no verdict: neither clears what was recorded. A stopped work
refuses `--run`. `rig status` reads the pass against the diff the repo carries now:
**verified** while the same branch carries the same patch-id, whatever happened to the head,
**stale** once the diff changed, **not verified** with none or with a pass for another branch,
and **not compared** when the worktree is not on this machine. `rig next` offers the run for a repo with work on it
and no pass at its diff, and `rig pr` names such a repo, or one whose pass was recorded on a stage rather than the work branch, and opens the PR anyway. A pass is for the patch, not the base: a base that moved since is not compared, so when a PR's checks fail with `rig next` naming a moved base, the pass is a claim to run again.

Neither is run behind your back: `rig attach` prints the setup commands and `--setup` opts
in, `rig check` prints the check commands and `--run` opts in. A command that cannot
succeed yet — a test run in a worktree nothing has installed — is worse run than shown. A
repo whose `check` is empty is named, with the file to write one in; write it while the
repo is still loaded in your head (rule 4).

`docs` is where the repo's user documentation lives: a path in the repo, or a page elsewhere
such as Confluence. rig knows a docs target and never edits one; the generated work file lists
it beside `check`. Once every PR has merged, `rig next` offers the `rig-docs` skill for a work
whose repos have a target, naming any attached repo with none and the file to say it in, and
`rig save -m "user docs updated" --documented` records the gate. `rig close` names a work
closing without it, as it names the lesson review. Nothing refuses without it.

A work keeps its **QA evidence** in `qa.md` beside `context.md`: the steps walked on a deployed
environment and what was seen. `rig status` names it. The user-docs edit and the digest read it,
because it is the nearest record of how a user meets the change.

## The org doc

One file per org at `<data root>/orgs/<org>.md`. It says what the org is for, so a work stops starting with the human explaining it again. Its frontmatter holds only `org`, then prose under any of these four headings, each written exactly so:

```markdown
## What we're trying to accomplish
## What hurts now
## What we believe
## Whose call it is
```

**Every work reads it.** The generated work `AGENTS.md` inlines the doc of each org its repos belong to, from that work's next mutating command on, and `rig status` names each one, or says there is none and where it would go.

**Absent means no constraints**, and so does a doc with nothing under its frontmatter. Nothing blocks on one, and only the lesson review asks for one: `rig-learn` asks one optional question in an org that has no doc, and writes the answer under the first heading.

**The lesson review keeps it true.** In an org with a doc, `rig-learn` reads the work's story against it and proposes edits like any other lesson: retire a "What hurts now" line the work resolved, reword a belief it had to bend, add what it taught, correcting before appending. It is the one place the review writes prose that every session reads, which its rule against new rules would otherwise forbid. It is allowed because the doc is the org speaking about itself rather than rig inventing a rule, and because every review prunes it; a belief that could be checked is offered as a check instead.

## Writing a context doc

`rig new` scaffolds four sections. Add more from `templates/context-sections.md` **only when
you have content for them**. Empty stubs are how the last attempt ended up with a dead
"Cross-Repo Contracts" table containing one blank row.

**The four are checked; the rest are not.** `rig save` checks the doc against
`templates/context.md` and prints each problem as `path:line: problem`, so an editor opens it
where it is, and `rig doctor` lists them under the work: a scaffolded heading lost or renamed, the
four out of order, and — once the design gate has passed — a placeholder of the template's still
standing (`_TODO_`, `_next step_`, an unfilled `{{FIELD}}`, an empty table row). Before the gate,
placeholders are what a doc being written looks like. Code — a fenced block, an inline span — and
comments are not read as either. A section from `context-sections.md` is never required. Neither
command refuses; in doctor a lost or moved heading counts among the things to look at, and a
placeholder is a chore it says without counting. The headings are the template's, so renaming one
in `templates/context.md` is a change to every open doc.

Two habits worth keeping from the docs this inherits:

- **Inline epistemic markers.** `✅ CONFIRMED (2026-06-12)` / `❌ REFUTED by data (2026-06-12)`
  with the evidence. Leave refuted hypotheses in place — the record of what you believed and
  why you stopped is worth more than a tidy answer.
- **"Key data points"** — column semantics, config keys, idempotency keys. The
  expensive-to-rediscover facts. This is the section that must still be useful in two years.

**End the design gate with `rig save --designed --adversarial` (or `--no-adversarial`).** Every rig command that changes a work
(`new`, `ticket`, `attach`, `detach`, `restore`, `plan`, `save`, `note`, `close`, `backfill`, `check --run`) ends by committing the whole
data root and pushing it when it has an upstream — one line says which commit and whether
the push landed; a push that fails warns and never dies. But the context doc is edited by
you, not by rig, so when the Direction section is agreed, run:

```bash
rig save -m "design agreed" --designed --adversarial   # records the design gate, commits, pushes
rig save -m "design agreed" --designed --no-adversarial   # the same, declining the adversarial review
rig save -m "refuted the sync hypothesis" # any later edit made outside rig
rig save --title "What it turned out to be" # the title was wrong
```

**The design gate decides the adversarial review.** `--designed` refuses without `--adversarial`
or `--no-adversarial`, the way `rig new` refuses without a ticket decision: whether a work's pull
requests get a reviewer told to find what is wrong is a call about risk, made with the design in
hand, and nothing can derive it. Agreeing the design again records the choice again. A work
designed before the choice existed has none, and is offered no adversarial review
(DESIGN.md decision 168).

Nothing asks first, and nothing runs on a timer: knowledge is committed at the moments it
was just agreed, with the catalogue corrections you made in passing swept up alongside.

**Two sessions, one data root.** Every work on the machine shares the data root, so a mutating
command holds a lock on it (`rig.lock`, in the data root's git dir, never committed) while it
fast-forwards at the start and while it commits and pushes at the end — never for the rest of
the command. A second command that finds it held waits up to 30 seconds, then says which
command and work hold it: at the start it stops before doing anything, so run it again — with
several roots, only for the root it commits into, or one that may hold the work it is about
(DESIGN.md decision 192); at the end what it wrote waits in the tree for the next command, or `rig save` once the other
finishes. A lock left by a session that was killed is taken over, and rig says whose it was.
Read-only commands never wait. The lock does not change the sweep: the second of two queued
commits still carries whatever hand edits are in the tree (DESIGN.md decisions 160–162).

**The notes are every decision taken along the way.** The context doc's sections keep what
shaped the design, edited into the order that reads best. The smaller decisions a long or
unattended session takes — why an approach was dropped, which check proved a step, what was
reverted — go in the work's `notes.tsv`, one row each, with `rig note`:

```bash
rig note "Dropped the cache layer" --why "it hid a stale read" --evidence abc1234,bin/cache.mjs:40 --result reverted
```

A row is `at`, `stage`, `note`, `why`, `evidence` and `result`, one line a cell. The evidence is
a pointer a reviewer can open — a SHA, a PR, `file:line`, a path or a URL, several split by
commas — and never prose: a word with no `/`, `\`, `:` or `.` in it, such as "done", is refused, and so is a
pointer with a space, which is written `%20`. `rig note` refuses a row without one. A note that
begins with a dash goes after `--`. Rows are appended and never read
to be written, so the hundredth costs what the first did, and the data root is committed.
`rig status` names the file; the lesson review and a pickup read it.

**The title is prose, and correctable the same way.** `rig save --title` rewrites it in
`work.json`, the context doc's `# <id> — <title>` heading and the generated `AGENTS.md`. It never
touches the branch, which was named from the first title and which the stack is read from, or
the id, which names the folder and the record. An open pull request takes the new title with
`rig pr --refresh`.

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
`RIG_DATA_ROOT`, **the work it is about** (named by `--work` or `rig restore <id>`, else the
work folder it runs in), **the repo it is about** (named by `--repos`, then a data root's own
checkout, then the repo checkout it runs in), then `current`. The middle two are the ones that
matter: the root that holds a work's record is the root for that work, and a repo's catalogue entry — drafted by `rig attach` the
first time it saw that repo — names the root that repo belongs to. A checkout's repo is
matched by org as well as name, because same-named repos in different orgs are normal. So
`rig new <id> --repos Payments` lands in Payments' root, a command run in a checkout of a
catalogued repo answers for that repo's root, a command run in a data root's own checkout
answers for that root, and `current` decides only for what none of them can place — `new`
with no repos, `list`, `catalog`, `dash` — which say so when it did.

**A work lives in one data root.** One `work.json`, one `context.md`, and two roots with
different readers, so it cannot span them: `rig new --repos a,b` refuses when a and b are
catalogued in different roots, and `rig attach` refuses a repo belonging to another root
rather than drafting its entry into this one. Two works, one per root, is the answer.

Two consequences worth holding on to:

- **One work root, shared.** A work id is unique across every data root on the machine, and
  `rig new` refuses one another root holds or whose folder exists, naming the root that owns it. Renaming a folder
  another root's records point at would break that work, so the id is what gives.
- **`rig update` brings every configured root forward**, not the one in hand. The write
  refusal is per data root, so migrating only the current one leaves the others to refuse the
  next mutating command, mid-work. It needs no root in hand to do that, so two roots and no
  `current` do not stop it; the doctor checks it ends in say that selection, once.
- **A work held by two roots resolves to the one that holds it open**: a work moved between
  roots leaves its first copy behind closed. Two open copies, or two closed and none open, is
  a pick rig will not make — the command names the roots and asks for `--data`, and `rig
  doctor` names a record held by two roots (DESIGN.md decisions 188–191).
- **`rig doctor` checks every configured root**, in full, each finding labelled with the
  root's name — the roots nobody looks at are the ones that rot. Its two work-root checks are
  the exception and are asked once against every root's records at once: the work root is
  shared, so a folder the current root has no record for is usually another root's live work
  rather than junk. It is also the one command that **reports a selection it cannot make**
  rather than dying on it: two roots and no `current` is a finding like any other, and every
  check that did not need a root in hand still runs. `list`, `status`, `catalog` and `next`
  die there, and should — each answers a question about a root's *contents*, and with none
  in hand there is no answer to give, only a misleading empty one. `rig use` is the
  exception that makes the finding actionable: it reads the registry directly, so the
  selection you are told to fix is always fixable.

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
rig stage feat/schema --dropped "not worth it"     # withdraw it from the plan, with the reason
rig stage feat/schema --replaced-by feat/shape     # it was done under another stage instead
rig stage feat/schema --planned                    # put a withdrawn stage back in the plan
rig stage --link                                   # register the open stage PRs as a GitHub stack
rig stage --land                                   # merge them into the work branch, never further
rig stage feat/schema --land                       # that stage and the ones below it
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

**Push a work or stage branch by name**: `git push origin <branch>`. Never a bare `git push`: a
work branch's upstream is its base, so git refuses one under its default `push.default=simple`
and pushes the work onto the base under `upstream` or `tracking`. And never `-u`, which moves
the upstream off the base that `rig status` measures ahead and behind against (DESIGN.md
decisions 110 and 159).

**How a stage lands.** A stage's pull request merges into the work branch **with a merge
commit**; the work branch is **squashed** into the base branch at the end. The squash is what
keeps one commit per work in the base branch. The merge is what keeps the stack readable: a
squash replaces a stage's commits, so the stage above stops descending from anything and has
to be rebased — and a rebase is what breaks the chain rig reads the order from. A stage landed
with `rig stage --land` always merges; one merged by hand can still be squashed, and falls back
to the order it was declared in. `rig next` names the stages above a squash, which still carry
the commits it replaced, and offers the commands that replay only their own commits and
force-push them, when the squash is the stage as it stood.

**Anything may merge into a work branch; nothing merges out of one but the human.** `rig stage
--land` merges the stages still to land into the work branch, and `rig stage <branch> --land`
that stage and the ones below it. Two or more open stage PRs in a repo land as GitHub's atomic
stack merge, `gh stack merge <PR> --merge`, linked first when they are not one stack yet; one
lands with `gh pr merge --merge`. The lowest PR in each repo must be based on the work branch,
and the work branch's own PR is never touched. Every repo is checked before any repo merges, so
a refusal found then lands nothing: a stage with no open PR, stages that are not one chain, a
repo whose stacks GitHub will not list, a work branch with a merge queue, and a stage PR that is
a draft, conflicts, has checks not passed, has changes requested or needs an approval, or has a
review someone asked for and not given — a human reviewing a stage makes its merge theirs, where
a code owner's automatic request does not. Each repo's PRs are asked again just before it merges,
so one that changed since — a push, a check failing — stops the landing there, and the repos
already merged stay merged, which the command names. `rig next` offers it
once every stage still to land is up for review, and the command says what is not ready. It
writes nothing into the record. An agent lands the stack itself once each stage has passed its
review, and hands the work over at the work branch's PR; it stops at a stage instead when that
stage's review raised a design question.

**A GitHub stack.** GitHub shows stacked PRs as unrelated until they are registered as a stack.
`rig stage --link` registers, in each repo, the open stage PRs that form a chain on the work
branch, with `gh stack link`, by PR URL and `--base <work branch>`, so it never creates or pushes
a branch. Run again after a stage is added, it grows the same stack; `rig next` offers it while
the open stage PRs are not one. Without the `gh stack` extension, or with one too old to `link`,
it says so and carries on: the base branches already carry the stack. A stack records no merge
method, so the one said where it is made is the convention for merging it by hand: a merge
commit, all at once (`gh stack merge <n> --merge`, which rewrites no head) or bottom-up;
`rig stage --land` merges it that way. `rig close` never
unstacks: GitHub keeps a merged stack as a closed record after its branches go.

**Stored: the branch, one line of what it delivers, and a ticket if you gave it one.**
A stage's pull request merges into the work branch, never the default branch, so a closing
keyword never fires for it and a slice's ticket cannot close itself. `rig close` closes it when
the slice landed, and comments and leaves it open when it did not. A ticket that is also the
work's, or that two slices carry, gets one comment, and closes only when every role it holds
would close it. Everything else is derived — whether
it has started (does the branch exist), whether it is up for review (is there a PR), whether it
landed (did it merge), which repos carry it, and where it sits in the stack (what it was cut
from, read live). Order is **never stored**: a stored order is a second answer to a question the
branches already answer, and the two disagree the moment anything is rebased.

**A plan that changed is not a plan that stalled.** Declaring a stage is a decision rig records,
and so is withdrawing one: `--dropped "why"` records `droppedAt` and the reason, and
`--replaced-by <stage>` records `replacedAt` and the declared stage that did the work. Neither
deletes the stage, for the reason a work keeps `abandonedAt`: the plan a work started from is what
a reader wants a year later. `rig stage`, `rig next` and the stage table in the PR body and the
rollout plan say dropped or replaced, never "not started", and `rig next` never offers one as the
next stage. Only a stage with no pull request open or merged can be withdrawn, and a withdrawn
stage's own ticket is told why at `rig close` and left open. A withdrawal is undone with `--planned`,
which puts the stage back as though it had never been withdrawn; the commit says so.

A stage transition is **not a gate**. Stages are reported, never stopped at.

**Attempts.** When it is not clear how a stage should be built, try it more than one way at once. This works on the work branch too, which is what a work with no stages does:

```bash
rig attempt feat/schema --n 3                  # cut three attempts here: feat/schema@1..3, in billing@1..3
rig attempt feat/schema                        # compare them: commits, diff and checks, a line a repo
rig attempt feat/schema --run                  # run each repo's checks in each, and keep each pass
rig attempt feat/schema --keep 2 --why "…"     # fast-forward feat/schema to attempt 2, discard the rest
rig attempt feat/schema --dropped "why"        # keep none of them
```

- **Cut where you stand, joined by name.** `--n` cuts in the repo whose worktree you are standing in, as `--cut` does. Run it in each repo the stage touches. `feat/schema@2` in two repos is one attempt. Each attempt is a whole checkout in `<repo>@<n>`, beside the repo's own folder, so it can be handed to an agent of its own.
- **Where the attempts start.** They are cut from the branch's tip, or, for a stage nobody has started, from what `--cut` would cut it from.
- **Limits on cutting.**
  - `--n` takes from two to nine.
  - A repo holds one open set at a time, because `<repo>@<n>` does not say which branch it is an attempt at.
  - A new attempt never takes over a `<branch>@<n>` an earlier set left behind.
  - `rig check --run` refuses inside an attempt's folder; `rig attempt --run` checks attempts.
- **Kept by a fast-forward, never a rewrite.** `--keep` checks every repo that carries the winner before any repo moves. It refuses when the branch has moved since the attempts were cut, and when an attempt holds uncommitted changes. `--force` discards those changes in the attempts that lost, never in the winner.
- **After `--keep`.** The branch moves in every repo that carries the winner, and an unstarted stage's branch is made there. The other folders and their branches are discarded. A copy someone pushed is named and left on the remote. The winner's pass becomes the repo's while its diff is unchanged. Nothing is pushed.
- **What is recorded.** The record (`attempts` in `work.json`) keeps that the set existed, how many attempts were cut in each repo, the check passes while it is open, and how it ended. The reason goes in `notes.tsv`, with every attempt's head as evidence, since the losers' branches are deleted.
- **An open set is a decision nobody has made yet.**
  - `rig close` refuses while one is open, and `--abandoned` still refuses uncommitted changes in an attempt. A close forced or abandoned past an open set records the set as dropped with the work.
  - `--dropped` works on a stage withdrawn from the plan and on a closed work, so a set can always be ended. Nothing else does: a withdrawn stage is landed by no PR.
  - `--keep` and `--dropped` refuse while an attempt's folder is off its branch, such as mid-rebase, and while another worktree has an attempt's branch checked out.
  - A set ended on another machine leaves its folders here on their branches; `rig close` and `rig tidy` remove them, refusing only over what is uncommitted in them.
- **A stage nobody has started** has no branch to have moved, so `--keep` checks the stage below it instead and refuses when that has moved since the cut.
- **Two machines.** `--n` and `--keep` fetch first. Attempts are cut from the newer of the branch's two copies, and a keep takes an attempt's remote copy where it is ahead.
  - `rig detach` refuses a repo that carries an open set, here or in the mirror.
  - `rig restore` puts an attempt back only from a branch that exists, and never cuts one again.
  - `rig doctor` treats an open set's folders as the work's own, not as strays.
  - `rig status` names each open set.
  - `rig next` says how far an open set has got, and offers the comparison once every attempt has commits.
- **Not a gate, and no phase.** A stage with an open set is a stage that has not landed.

**The frontier.** The lowest stage still to land is the only stage that matters until it lands,
so `rig next` leads with it and names the live stages stacked above it as waiting on it, rather
than offering each one. A stage whose place in the order is a guess, or whose PR GitHub would
not say anything about, is not called waiting.

## What now

```bash
rig next        # what is available on the current work, read off live state
```

It reads the repos, the branches, the PRs and the gates, and names what is available —
pick up a handoff, attach something, record the design gate, run the checks, push, open a PR,
work through its review threads, the adversarial review, hand the PR over, scaffold a rollout
plan, review what the work taught, say its outcome, close.

Two things it will never do, and both are the point:

- **It only offers.** It never warns, never blocks, and never says you should have. Warnings
  live in `doctor`, for contradictions and for what has drifted. A work that reached review with no design
  gate recorded has an *omission*, and an omission is something to offer, not to scold.
- **It speaks only when asked.** A command you run — not a hook, and never fired off the back
  of another command.

**Weight is derived, never declared.** A work earns its ceremony from what it contains: one
repo and no stages gets "build it, open the PR, close it"; three repos start being offered a
rollout plan, because that is where deploy order stops being obvious. There is no
`--track light|full` and there will not be one — a declaration made at `rig new` is a
prediction, and predictions rot.

## Another machine

```bash
rig restore <id>          # put back every worktree the record lists and this machine lacks
rig restore <id> --tip    # and check out the top of a PR stack the record does not know
```

The record is portable and the work root is not: a second machine that clones the data root has every work and none of their folders. `rig restore` rebuilds one from the record — each missing worktree on the top of its repo's stack (the highest declared stage the repo carries whose PR has not merged, or the work branch), the identity and secrets `attach` would give it, and the generated files beside them. `rig next` offers it while a worktree that could come back is missing, `rig doctor` names it beside a missing folder, and `rig attach <repo>` on a recorded repo whose worktree is gone does the same for that one repo.

**A restore is not an attach, and writes nothing down.** `work.json` is byte-identical afterwards and nothing is committed. **It never recreates a branch**: one that the remote and the mirror have both lost — never pushed, or deleted with its closed PR — is named with its PR's state and left alone. Branches stacked on top that the record does not know are named in order; `rig stage <branch>` records them, and `--tip` checks out the top of the stack when it is one line. rig never picks between the branches of a fork.

**A close on one machine leaves the folder on the others.** `rig close` tears down the machine it runs on and stamps `closedAt` into the record, and that is all the other machines hear. `rig doctor` names a closed work whose folder is still here; `rig tidy` clears every one, and `rig close` on such a work clears that one, which `rig next` offers when it is asked about one. Only this machine's copy goes — the worktrees, the folder and the mirror's copies of branches that landed — and nothing leaves the machine: no record change, no ticket comment, no remote branch deleted. Work that may exist only here — uncommitted changes, commits no branch or remote holds, and files in the work folder that are not one of its repos — refuses the close and makes `tidy` skip that work and name it; `tidy` never forces, `rig close --force` does. Doctor reports and never clears, so it stays the command you can always run. A closed record is no leftover while another data root holds an open record of the same id: the folder is that work's, and doctor names the two copies instead.

A handoff is addressed the same way. When a work has a `handoff.md`, `rig status` names it on the data root's remote, where the next machine can read it, and gives this machine's path only when there is no remote. The `rig-handoff` skill's continue prompt is that URL, `rig restore <id>` and the work id: nothing in it belongs to the machine that wrote it. Before it writes the handoff, the skill pushes the work's branches and checks that each landed.

**Picking one up trusts it.** `rig prompt pickup` is the other half: read the handoff, the context doc and `rig status` — its stops line says what the human chose to be asked, and its checks lines what passed at the patch each repo carries — compare what was planned with what happened, check once only what the next step stands on, and name the resume point before starting. It runs no verify-from-scratch pass on top of the trail; the trail was written so none would be needed. `rig next` offers it while the handoff was committed after the last commit on any of the work's branches here, first, since it may answer everything else, and stops on the pickup's first commit.

## Staying up to date

A dim line on stderr — `rig is N commits behind … — rig update` — is addressed to you. Run
`rig update` from the installed checkout; the copy inside a work's `rig` worktree refuses,
because updating it would move the work's branch. `update` fast-forwards only, exits non-zero
when it could not do what was asked, and ends in the doctor checks.

To run a work's own rig — the worktree's `bin/rig.mjs`, to try a change before it is released —
borrow the installation's machine file: `RIG_LOCAL_CONFIG=<installed rig>/rig.local.json node
<worktree>/bin/rig.mjs …`. Without it that copy knows no data roots, and every command but
`help`, `prompt`, `init` and `doctor` refuses and says so (DESIGN.md decision 158).

A mutating command that dies with "run `rig update`" hit the **write refusal**: the data root is
at a newer record format than this rig (the major version *is* the record format,
`docs/adr/0002-the-major-version-is-the-record-format.md`). Read-only commands — `list`,
`status`, `catalog`, `doctor` — still answer. Mutating commands fast-forward the data root
before they read it, so a second machine never works from stale records — every configured root
when there are several, before the root is chosen, since a work moved on the other machine has
moved only in what it pushed, and an id taken there must be seen before `rig new` takes it here.
A root whose remote is out of reach is said and worked from as it is, and asked again after
fifteen minutes. A data root whose
branch tracks an upstream it has not fetched yet, such as a clone of an empty remote that
another machine has since pushed to, is fetched too, rather than read as local only. How the
check is measured and configured is in the README's "Staying up to date" and DESIGN.md decisions 45–49.

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
rig pr            # one PR per repo, work branch to the base it was cut from
rig pr --refresh  # rewrite each open PR's title and body from the record as it stands
```

The body is assembled from what the record already holds: the title, the tickets, the
**Pull request** section of the context doc lifted as written, and the stage table rendered from
the stack. Nothing in it is retyped, which is the point — the deploy-order table stops being
hand-maintained the moment something renders it.

**What it delivers, not how it was built.** The Direction is the design agreed at the gate,
written for whoever builds it; by the time the PR opens it reads as instructions to the
implementer, and on a repo that publishes PR descriptions as release notes, as rig does, that is
what ships. So the context doc carries a second text, the optional `## Pull request` section
from `templates/context-sections.md`: what the work delivers, for the reviewer — a Summary with
the smallest view of the change, before-and-after Evidence, and the Merge Danger, a one-way or
two-way door and its blast radius. Write it once the build is done, with the agent host's
PR-body skill if it has one. Its `###` headings are raised to `##` as it is lifted, outside code
fences, so they head the body. A doc without one has the Direction lifted, under `## Direction`,
as it always had, and `rig next` asks for the section beside its offer to open the PR. Never both: two
accounts of one work, written at different times, would disagree where a reviewer reads first.

**What it says in public.** The lifted section goes into a body anyone who can read the repo
reads, so write it for them. The `Context doc:` link is written only where the repo is **no more
visible than the data root** — public above internal above private, and a data root with no
remote counts as private — because it names the private repo, and GitHub keeps a body's edit
history. A visibility GitHub would not say leaves the link out, with one dim line saying so, and
a data root hosted anywhere but GitHub is never linked.
The same rule holds for `rig close`'s comments on GitHub tickets and for the issue `rig new
--ticket` opens; Jira comments keep the link. In a work of **one** repo, each of the work's own
GitHub tickets in that repo gets a `Fixes` line, since merging that PR is the work landing; every
other ticket is named on the `Tickets:` line and closed by `rig close`.

**It says which release the PR asks for.** On a repo that releases the way rig does, by a bump
each PR names (it carries a `release:` label), `rig pr` prints the bump beside the PR it opens
or finds open, with the reason: the branch prefix, or the `release:` label that overrides it.
`rig next` says the same beside its offer to open the PR, while a label can still change it. A
repo with no `release:` label is told nothing, because there the prefix is not how it releases.

**It says whether the base moved.** Before opening each repo's PR, `rig pr` fetches that repo
and says how many commits the base has that the work branch lacks, and, if a merge of the two
would conflict, in which files, with the command to merge the base in. Then it opens the PR
anyway: a report, never a stop.

**Not a gate.** A command you run when the stages are in. Idempotent like everything else: a
repo that already has an open PR is reported, not duplicated.

**The PR is kept true.** A work's scope moves while its PR is open: a ticket folded in, the
Direction rewritten after a trial run, the title corrected, a stage dropped. `rig pr --refresh`
rewrites each open PR's title and body with exactly what `rig pr` would open it with now, and
leaves one that already says it alone. A repo with no open PR is told so; a refresh never opens
one. `rig next` compares each open PR with that text and offers the refresh when they differ,
the way it offers `rig plan --refresh`. The whole title and body are rig's, so an edit made on
GitHub is lost to the next refresh: put what should last in the context doc.

rig opens the *work branch's* PR, never a stage's. A stage is reviewed on its own, in the repo
it touches, and rig would have to guess which of the stack you meant.

A worktree is often still on the last stage when every stage is in, and that stage's branch is
gone from GitHub. `rig pr` names a worktree on a landed stage, and `rig next` does once every
stage is in, each with the commands that move it to the work branch. Neither runs them.

## Reviewing the pull request

Once the work branch's PR is open, `rig next` walks it through three steps, each offered only
once the one before it is done:

1. **The review already on it.** While the PR has unresolved review threads, `rig next` says how
   many and offers to work through them: action what is worth actioning, reply to every thread,
   resolve them. Read off GitHub each time, never stored; a count GitHub will not give holds
   up the steps after it rather than reading as zero.
2. **The adversarial review**, when the design chose one: a reviewer told to find what is wrong
   with the PR, fixing what it finds and pushing. GitHub cannot say one happened, so
   `rig save -m "adversarial review" --reviewed` records `reviewedAt`. A design agreed again
   after it asks for another, and `--reviewed` is refused before the design gate and beside
   `--designed`.
3. **The hand-over.** With the design gate passed, every thread resolved, the adversarial
   review done or declined, the PR's checks green (or none set up), nothing uncommitted or
   unpushed, no stage still to come, no sibling PR closed without merging and the PR body
   matching the record, `rig next` says the PR is ready for a human reviewer. Checks that are
   failing, or have not reported, are named on their own, so the wait is never silent. It names no command: who reviews is the
   human's call, and rig takes no outward-facing step on its own.

   A failing check is the PR's to fix, and `rig next` names the base beside it when the base has
   moved past the branch: for a failing PR only, it fetches the repo, quietly and never as a
   first clone, and counts against the PR's live base, as `rig pr` does. A moved base is a
   possible cause, never the cause — a **stale base** fails code the diff never touched, which
   no fresh run fixes and merging the base in does — so the offer says so, with
   `git merge origin/<base>` when the worktree is on the work branch. A fetch that fails gives
   no count, and nothing is said. The rest of the triage — one fresh run for a flaky failure,
   the same failure twice is not flaky — is the `rig` skill's.

rig names each step and says nothing about how it is done; an agent host maps them to its own
skills. Only the work branch's PR is asked about, never a stage's.

## Closing

```bash
rig list                  # flags works whose PRs are merged and whose trees are clean
rig close                 # refuses if anything is uncommitted, unpushed, has an open PR, is an open
                          # set of attempts, or is in the work folder without being rig's
rig close                 # on a work already closed elsewhere: clears this machine's copy only
rig close --abandoned     # stopped, not finished: the did-it-land checks are dropped
```

`rig close` removes the worktrees and keeps `context.md`. When every PR merged, it also deletes
the work's branches — the work branch and each stage that landed — from the mirror and the
remote, but only a copy holding nothing its PR did not merge; a branch pushed to after the
merge is kept and named. When the mirror lacks the commit a PR merged, the close fetches it
first; if that fails, the copy is kept with the reason. A stage GitHub rewrote while merging
its stack one PR at a time holds the same patches under new shas, so a copy the PR's head does
not contain is compared by patch and by content: it goes when everything on it landed, and is
kept otherwise, naming the first commit that did not. A close forced past a blocker, or
abandoned, deletes no branch. Nothing else is ever auto-deleted.

**A session still at work is named, not refused on.** A clean worktree a live session is about
to write into looks exactly like an abandoned one. So before `rig close`, `rig detach` or
`rig tidy` takes a worktree away, it names each session whose transcript was written there, or
in the work folder, in the last two hours — found the way the lesson review finds them, through
`rig.local.json`'s `transcripts` — and carries on: only that session can say whether it is
done, and it is said at the teardown because rig speaks unasked nowhere earlier. Tell the user
which session was named, in so many words. The session running the command is left out where
`transcriptSession` names the variable carrying its id; without it, one named may be this one,
and the close says so. A session started in a subfolder of a worktree is not found, and a pattern
refused as too wide is named, so silence is never read as no session. `rig list` does not look,
and says "(sessions not checked)" beside a work it would call safe to close, on a machine that
could have.

A **stage** still up for review refuses the close too, and is named like any other blocker: a
slice that never landed is unfinished business, and the work branch's own pull request cannot
say so. So does a stage or a repo whose pull request GitHub would not say anything about —
gh signed out, rate limited or offline — since it may be one still open. `--force` tears down
past all of it and **records that it did** (`forcedAt`), because
forcing is a decision and a work closed over an open pull request is otherwise
indistinguishable from a bug — which is what `rig status` would call it.

So does anything in the work folder that rig did not put there: a folder of your own notes, or a
folder named for an attempt that is not on that attempt's branch. The close deletes the folder
whole, and those would go with it, so the refusal names each one; move it out of the work folder,
or `--force` past it (decision 210).

**Abandoning is a different answer, not a softer close.** `--abandoned` is for a work you
stopped without finishing: an unmerged PR and unpushed commits are what that *looks like*, so
those checks go, and uncommitted changes and the work folder's strays still refuse because
unsaved work is the one thing a teardown can destroy. An open set of attempts is no refusal: it
is recorded as dropped with the work. The ticket is told and left open — whether the problem is still worth
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

### Skills rig ships

`skills/rig` finds rig and routes into it; `skills/rig-handoff` writes a session's handoff into
the work's record; `skills/rig-learn` runs the lesson review before a close, and drafts the
work's outcome; `skills/rig-digest` explains what landed, from `rig list --json`, at the
altitude asked for, and drafts outcomes for landed works with none; `skills/rig-docs` keeps the
user docs true once a work has landed. All are shipped, never linked: whatever manages a
machine symlinks `skills/*` into its agent hosts' skills directories. Every skill but the entry
point is prefixed `rig-`, and `test/skills.test.mjs` holds the shape a host's linker relies on.

### Issue tracker

Issues are tracked as GitHub Issues on `hugoforte/rig`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Principles

Working *on* rig: **keep it refactorable, but don't factor it early** — two similar things
are a coincidence, so wait for the third before naming the pattern. And **strong
convictions, loosely held** — decide, write the reason down, and let evidence move you.
Both are stated in full in DESIGN.md's "Principles".

Adding a decision to DESIGN.md's log means filling its **Enforced by** cell: the test that
would fail if the decision stopped holding — a path, then that test's own title, or a journey's step as `<scenario> › <step>` — or `—` when
nothing checks it. `test/design.test.mjs` resolves what you write and fails on a reference that
has been renamed or deleted, so a rename is caught on the pull request that made it. An empty
cell is a legitimate answer and the gaps are meant to be visible; naming a test that merely
passes nearby is worse than leaving it empty.

### Releases

Working *on* rig rather than with it: **never write a version number.** Your PR names a bump —
`feat/` branch → minor, `fix/` → patch, a `release:` label overrides — and the required check
asks only whether it names one. The merge collects the PRs since the previous tag, takes the
strongest bump among them, tags the commit, and publishes notes made of the PR descriptions, so
write the description as the release note. `package.json` reads `0.0.0-development` and is not a version.
`main` still requires a branch to be up to date before it merges, so with several PRs open you
will be asked to update yours and wait for its checks again. A merge queue is the way out of that
and this repository does not have one *yet* — GitHub gates them to organization-owned repositories
and this one belongs to a user account. That is a fact about where rig lives rather than a
permanent one: a free organization lifts it at no cost, and moving there is agreed but not done
(hugoforte/rig#114). Until it is, expect to rebase. README's "Releases",
`docs/adr/0004-the-pr-carries-a-bump-not-a-version.md` and
`docs/adr/0005-a-merge-queue-replaces-the-up-to-date-rule.md`.
