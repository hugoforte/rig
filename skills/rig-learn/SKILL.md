---
name: rig-learn
description: Review what a rig work taught before it closes, and offer each lesson a home — an attached repo, the catalogue, the org doc, or rig itself. Use when `rig next` offers the lesson review, when a work's PRs are up or merged, or when asked what a work taught or to carry its lessons forward.
---

# rig-learn

Read the story of the current work, find what it taught, and offer each lesson a home. Draft its outcome while the story is in hand. Then record the review with `rig save --learned`.

Run it while the worktrees are still on disk, before `rig close`, because a lesson for a repo has to be committed in one. `rig next` offers it once a pull request is open. After a close, only the catalogue, the org doc and the tracker are left to write to. A late review is still worth doing.

Reply as rig's `AGENTS.md`'s "Replying to the user" says. Here the TL;DR in step 3 is that opening, and the user's action item is saying **go**.

## 1. Read the story

Run `rig status` from the work folder, or `rig status --work <id>` once the work has closed and the folder is gone — with the `--data <root>` `rig close` printed, when another data root keeps a copy of the work. It names the context doc, the org doc of each org the work touches, the repos and each PR. Then read, in this order:

- `context.md`, and `handoff.md` beside it if there is one. The design, and what happened since.
- `notes.tsv` beside them, if there is one: every decision a session took along the way, each with why and a pointer at its evidence. A row whose result is `reverted`, or two rows about one thing, is a lesson looking for its home.
- Each PR's review threads: `gh pr view <n> --repo <owner/repo> --comments`, and `gh api repos/<owner/repo>/pulls/<n>/comments` for the inline ones. Findings that were fixed are the richest source.
- Each PR's checks, including failed runs that were re-run: `gh pr checks <n> --repo <owner/repo>`.
- The commit log on the work branch: `git -C <repo worktree> log --oneline <base>..HEAD`, or `gh pr view <n> --repo <owner/repo> --json commits` once the worktree is gone. Fixups, reverts and "try again" commits mark where something took more than one attempt.

- The sessions that did the work, when this machine keeps them: `rig status --transcripts` prints their paths, one a line: the sessions that ran in the work folder, ran on one of its branches, or name its folder, and no others. By the time a correction reaches a commit or a review thread it has been smoothed away; in the session it is still there.
  - **Read them through subagents**, a few files each, never in this thread: transcripts are large. Each subagent reports the user stepping in ("no, not like that"), a command tried more than once, and an assumption the agent made and later corrected, each with a short quote. Work from those findings, never the raw logs.
  - **Read no transcript the command did not print.** Another work's sessions are other work, and often private.
  - **Read only the parts about this work.** A session that started in the tool's checkout or a repo's own, and only names the work folder, may have done other work before or after. Each subagent reports only what happened in this work's folder, on its branches or about its tickets, and drops a session that only mentions the work in passing, such as in a listing.
  - When it prints nothing, carry on without them. It says on stderr where this machine would name them.

A lesson is usually hiding in *this took three attempts*, not in the design.

## 2. Keep only what the next person would otherwise rediscover

A lesson is a fact about a repo, a system or the tool that was true before this work and will be true after it. Drop anything that:

- the code, the tests or the git history already says;
- is only about this work (that belongs in `context.md`, which is kept);
- is about how the user likes to work. That goes to your own memory, not to a file others read.

## 3. Offer each lesson a home

The user should be able to answer with one word. Open with the recommendation, keep the detail below it short, and **stop for the user**. Nothing is written until they agree.

For every lesson, prefer a machine check over prose, and never add a rule to an `AGENTS.md` or `CLAUDE.md`. A check fails when it goes stale; prose does not. The org doc is the one exception, and "The org doc" below says why.

### The shape of the reply

```markdown
**TL;DR — do these:**
1. <action, in one line: what changes, where>
2. <…>
3. <…>

Outcome: <what changed for someone, and why that is good, in a sentence or two>

Say **go** for all of them, or name the numbers you want.

**Repos we touched**
- <repo>: <what changes> → <file>. <why here, in a clause>

**Catalogue**
- <repo>: <what changes> → `check` / `talks_to` / prose. <why here>

**Org doc**
- <org>: <retire / reword / add> "<the line>" → <heading>. <what in this work showed it>

**Rig in general**
- <issue title> — <one line of what it asks>. <why here>
- Philosophy: <the belief, as it should now read> → `docs/philosophy.md`. <the friction that moved it>

**Dropped:** <lesson> (<why, in a few words>); …
```

- **The TL;DR is two or three actions, never more.** They are the lessons most worth keeping, each one a thing you would do on "go". Everything else stays in the detail, where the user can still name it.
- **The outcome line is the work's outcome**, drafted from the story, the sessions included: what changed for someone and why that is good, in words a person outside the work can read, on one line, with no backticks or `$`. Leave it out when `rig status` already shows an outcome, or while a PR is still to merge. A bare "go" records it with the lessons; an answer naming numbers records it only if it also says "outcome". The user may correct it in their answer.
- **Every detail line is one line.** What changes, where it lands, and why that home in a clause. If a line needs a paragraph, the lesson is not understood yet.
- **Omit empty sections**, and name what was left out under **Dropped** so the user can see it was considered.

### Which home

| Who needs it | Home | Machine check first | Prose otherwise |
| --- | --- | --- | --- |
| someone changing the repo's code | **Repos we touched** | a test or CI step | the repo's docs |
| someone planning a work that touches the repo | **Catalogue** | a command for `check`, a fix to `talks_to` | the entry's prose |
| every work in the org | **Org doc** | a test in the repo, or a `check` in the catalogue, when the belief can be checked | the org doc, under its heading |
| anyone using rig, on any data root | **Rig in general** | — | an issue on rig's tracker |
| anyone deciding how rig should work | **Rig in general**, as philosophy | — | `docs/philosophy.md` |
| only this work | nowhere new | — | `context.md` already keeps it |

- **When rig is the repo you touched**, a fix inside its code or tests is a repo lesson; a change to how a rig command behaves is a rig lesson.
- **A lesson that fits two homes is usually two lessons.** Split it rather than writing it twice.
- **Repo lessons go in the work's last PR** while one is open. If everything has merged, a small follow-up PR carries them.
- **Correct the catalogue before appending to it.** Read the entry first (`rig catalog <repo>` names the file). A lesson that contradicts a sentence replaces it; a catalogue that only grows ends up unread.
- **Write to the data root its readers can see.** `rig use` says which root is in hand. Do not carry an employer's lesson into a personal root, or the reverse.
- **Rig's tracker is public, and filing an issue is outward-facing.** Write about rig alone: no repo names, schemas, hosts or people from a private data root. "Go" covers the issues in the TL;DR; show the title and body of any other issue before filing it.
- **Philosophy is for beliefs about rig the tool**, never about the repos a work used. A lesson that changes how rig should work, rather than reporting a bug, goes there instead of the tracker. With rig attached, the edit goes in the work's rig PR; without it, it becomes an issue on rig titled "Philosophy: …" carrying the proposed wording. A dropped principle is struck through with the friction that killed it, never deleted. The page is public, so the tracker's rule applies.

### The org doc

`rig status` lists each org the work touches, with its doc, or `no org doc` and the path where one would go.

The doc is inlined into every generated work `AGENTS.md`, so it is the one place this skill writes prose that every session reads. That is allowed because it is the org speaking about itself rather than a rule rig invents, and because every review corrects it. Keep it true and keep it short.

**An org with a doc.** Read it against the story, and propose edits as lessons under **Org doc**:

- retire a "What hurts now" line this work resolved;
- reword a belief the work had to bend;
- add what the work taught about the org, under the heading rig's `AGENTS.md` ("The org doc") names for it.

Correct it before appending to it, as with the catalogue: an edit that contradicts a line replaces it. When a belief could be checked, offer the check under **Repos we touched** or **Catalogue** instead of the line. Then put one line right after "Say **go**…", for what only the user knows:

> Optional: did this work confirm, contradict or add to anything in `<org>`'s org doc? A bare **go** skips it.

**An org with no doc.** Put one line right after "Say **go**…", naming every such org:

> Optional: in one sentence, what is `<org>` trying to accomplish? A bare **go** skips it.

If the user answers, write their answer for each org at the path `rig status` gave, in their words, and nothing more:

```markdown
---
org: <org>
---

## What we're trying to accomplish

<the answer>
```

Later reviews fill the other headings. A skip writes nothing, and the next review in that org asks again.

## 4. Record it

Once the lessons have landed, or the user says there are none:

```bash
rig save -m "lessons reviewed" --learned --outcome '…'
```

The agreed outcome goes in single quotes in place of `…`, which rig refuses as an outcome. Leave `--outcome` off when none was offered or the user did not agree it.

This commits the catalogue changes and any org doc edits with the rest of the data root, and records the gate. Pass `--work <id>` if the work folder is gone, and `--data <root>` where `rig close` named one. `rig next` stops offering the review, and `rig close` stops naming it.
