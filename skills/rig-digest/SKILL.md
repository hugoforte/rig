---
name: rig-digest
description: Explain what a rig data root's works landed and why it was worth doing — for a work, a repo, an org or a period — at the altitude asked for, grouped by theme, every claim linked to the work or pull request it rests on. Use when asked what landed, to catch up on or explain a stretch of work to someone, for a digest or a plain-words summary of merged PRs, or to draft outcomes for landed works that have none.
---

# rig-digest

Write the explanation of what landed, from the records rig already keeps. rig calls no model, so the prose is yours; the facts are rig's. Nothing you write is stored: the digest goes to the chat or a temp file, and the only thing this skill ever records is an outcome the user said **go** to.

## 1. Pin the scope, the reader and the altitude

- **Scope**: one work, a repo, an org, or a period (`since 2026-09-01`, "this month"). With none given, take the last 30 days.
- **Reader**: the person who did the work, catching up, unless the user names someone else. A teammate, a manager and a customer want different words for the same facts.
- **Altitude**: a paragraph, a page, or the full account. With none given, a page.

Ask only when the request leaves the scope open and the last 30 days would plainly be wrong. Say the defaults you took in the first line of the answer.

**One data root per digest.** `rig use` says which is in hand, and `--data <name>` reads another. Personal, public and employer knowledge have different readers, so a request spanning two roots gets two digests, never one.

## 2. Read the facts

```bash
rig list --json --quick
```

`--quick` is enough for landed work: `rig close` stores each merged PR's terminal facts, and the payload reads them back. A work has **landed** when every repo's `pr.state` is `MERGED` and `abandonedAt` is null; its landing date is the latest `pr.mergedAt`. An abandoned work landed nothing to explain, even when a slice of it merged, and `rig save --outcome` refuses it. Narrow by `repos[].org`, `repos[].repo`, the landing date or the `id`.

Per work, read `outcome.text` (null when nobody said it), `title`, `tickets`, each `repos[].pr.url`, and each stage's PR under `repos[].branches[].pr`. Then, only as far as the altitude needs:

- **The org doc** of each org in scope, at `<data root>/orgs/<org>.md` (`rig doctor` names the data root). Its goals and the problems it names are the themes, already written down.
- **A ticket's parent**, when tickets in scope share an epic: `gh issue view` on GitHub, the `twg` skill on Jira.
- **A work's context doc**, at `<data root>/work/<id>/context.md`, for a work the reader needs depth on: its Problem and Direction say why it was done.
- **A PR's body**, `gh pr view <url> --json body`, for what changed in one repo.

## 3. Group by theme

A hundred works are six things. Choose the themes now, from the org doc's goals and problems and the tickets' parents, and put each landed work under the one it served. A work that serves none goes under **Also**, which should stay short; a long **Also** means a theme is missing.

Never write a theme down anywhere rig keeps. Nothing above the work is stored: a stored theme points at org-doc lines the lesson review rewrites, and a stored summary is a hand-maintained table that goes stale.

## 4. Write it

- **Lead with what changed for the reader**, not with what was done to the code. The outcome is the source sentence; reword it for the reader, never beyond what it says.
- **A work with no outcome** is described from its title, context doc and PR body, and marked so: *(no outcome recorded)*. Never pass a draft off as a recorded outcome. Section 5 offers to record one.
- **Link every claim** to the work's pull request, or to its ticket when it has several PRs. The reader drills down from the link, so a claim with none is one they have to take on trust.
- **Only the payload's numbers.** Counts and dates come from `rig list --json`; cycle times and throughput are `rig dash`'s, so point to it rather than recomputing them.

By altitude:

| Altitude | Shape |
| --- | --- |
| A paragraph | One sentence per theme, each with its strongest one or two links |
| A page | A heading per theme: two or three sentences on what changed, then its works as one-line linked bullets, newest first |
| The full account | The page, plus each work's outcome, why it was done (from its context doc) and every PR |

**Where it goes.** A paragraph or a page goes in the chat. Anything longer goes to a file in the OS temp directory, with the path given. Never write it into the data root or a repo, and never post it: handing it to someone is the user's act.

## 5. Draft the missing outcomes

When landed works in scope have no outcome, offer to draft them. This is the same act `rig-learn` does for one work, done in bulk for the works that closed before outcomes existed.

For each, read the context doc's Problem and Direction and the PR bodies, then write one line: what changed for someone and why that is good, in words a person outside the work can read. One line, because `rig save` refuses a line break.

Show them in batches of about ten, and **stop for the user**:

```markdown
1. `<work id>` — <draft outcome>
2. …

Say **go** to record all of them, or name the numbers to record.
```

Record each one agreed:

```bash
rig save --work <id> --outcome "<the outcome>"
```

Add `--data <name>` when the work is in another data root. Each save commits and pushes the data root; a second save replaces an outcome, so a correction is the same command.
