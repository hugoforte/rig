# rig — agent instructions

`rig` assembles cross-repo worktrees for a piece of work and keeps the durable knowledge
about that work in a **data root** — a committed checkout that holds the catalogue, the
work records and `rig.json`. Read `DESIGN.md` for why it is shaped this way; this file is
how to *use* it.

## The three roots

| | |
|---|---|
| `D:\rig` (this repo) | **The tool.** Committed, generic, public. |
| the data root | **The knowledge.** Committed, private. `catalog/`, `work/`, `rig.json`. A separate checkout named by `dataRoot` in `rig.local.json` — never this one. `rig doctor` prints which. |
| `D:\w` | **Disposable.** Worktrees and bare mirrors. Deleting it loses nothing. |

Never put durable prose in `D:\w`. Never put anything that names a real org, repo or
system in this repo — that is what the data root is for. Never put machine-specific paths
or secrets in either committed repo.

## First run

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

```bash
rig new PROJ-42-refund-double-charge --title "Refunds double-charge on retry" --key PROJ-42
```

The brief is read from stdin. **You fetch the Jira prose** — with whatever Atlassian tooling
you have — and pipe it in. `rig` authenticates to nothing but git; it will never call Jira.

```bash
<your jira fetch> | rig new PROJ-42-refund-double-charge --title "..." --key PROJ-42
```

No ticket yet? Where the org's tracker is GitHub (`rig.json`), rig creates it for you —
thin body, link to the context doc — and records the key:

```bash
<brief> | rig new refund-double-charge --title "..." --ticket
```

Where the tracker is Jira, you create the ticket and pass `--key`. `rig prompt new-work`
is the full procedure. On `rig close`, GitHub tickets get a comment with the PR links and
are closed when every PR is merged.

Then run the repo interview and attach what it selects:

```bash
rig prompt select-repos     # read this and follow it
rig attach billing
rig attach orders-web
```

## Rules that matter

1. **Never `git worktree add` inside `D:\w`.** Use `rig attach`. rig owns that tree and
   `rig doctor` fails on strays. Outside `D:\w` — your old clone directory, say — do
   whatever you like; rig neither models nor touches it.
2. **Never edit a generated file.** `D:\w\<work>\AGENTS.md` is regenerated on every mutating
   command. The context doc in `<data root>/work/<id>/context.md` is the only place prose
   lives.
3. **Never write derived state into a doc.** Branch, base, ahead/behind, PR state — all of
   it comes from `rig status`. The previous attempt at this tool died of hand-maintained
   tables going stale.
4. **Correct the catalogue in passing.** `rig attach` drafts a stub entry marked
   `DRAFT: unreviewed` for any repo it hasn't seen. Fix it while the repo is still loaded in
   your head — that is the only moment the knowledge is cheap.
5. **The repo set is mutable.** Attaching a fourth repo on day two is normal.

## The catalogue

One file per repo at `<data root>/catalog/<org>/<repo>.md`: YAML frontmatter (`repo`,
`org`, `stack`, `role`, `talks_to`, `setup`) plus prose.

**Durable facts only.** No branch, no local path, no status — anything git or `gh` can
answer is derived live. `talks_to` is the load-bearing field: repo selection is graph
traversal over it.

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

## Closing

```bash
rig list      # flags works whose PRs are merged and whose trees are clean
rig close     # refuses if anything is uncommitted, unpushed, or has an open PR
```

`rig close` removes the worktrees and keeps `context.md`. Nothing is ever auto-deleted.

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues on `hugoforte/rig`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
