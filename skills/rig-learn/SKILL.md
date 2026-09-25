---
name: rig-learn
description: Review what a rig work taught before it closes, and offer each lesson a home — the catalogue, an attached repo, or rig's own tracker. Use when `rig next` offers the lesson review, when a work's PRs are up or merged, or when asked what a work taught or to carry its lessons forward.
---

# rig-learn

Read the story of the current work, find what it taught, and offer each lesson a home. Then record the review with `rig save --learned`.

Run it while the worktrees are still on disk, before `rig close`, because a lesson for a repo has to be committed in one. `rig next` offers it once a pull request is open. After a close, only the catalogue and the tracker are left to write to. A late review is still worth doing.

## 1. Read the story

Run `rig status` from the work folder, or `rig status --work <id>` once the work has closed and the folder is gone. It names the context doc, the repos and each PR. Then read, in this order:

- `context.md`, and `handoff.md` beside it if there is one. The design, and what happened since.
- Each PR's review threads: `gh pr view <n> --repo <owner/repo> --comments`, and `gh api repos/<owner/repo>/pulls/<n>/comments` for the inline ones. Findings that were fixed are the richest source.
- Each PR's checks, including failed runs that were re-run: `gh pr checks <n> --repo <owner/repo>`.
- The commit log on the work branch: `git -C <repo worktree> log --oneline <base>..HEAD`, or `gh pr view <n> --repo <owner/repo> --json commits` once the worktree is gone. Fixups, reverts and "try again" commits mark where something took more than one attempt.

A lesson is usually hiding in *this took three attempts*, not in the design.

## 2. Keep only what the next person would otherwise rediscover

A lesson is a fact about a repo, a system or the tool that was true before this work and will be true after it. Drop anything that:

- the code, the tests or the git history already says;
- is only about this work (that belongs in `context.md`, which is kept);
- is about how the user likes to work. That goes to your own memory, not to a file others read.

## 3. Offer each lesson a home

The user should be able to answer with one word. Open with the recommendation, keep the detail below it short, and **stop for the user**. Nothing is written until they agree.

For every lesson, prefer a machine check over prose, and never add a rule to an `AGENTS.md` or `CLAUDE.md`. A check fails when it goes stale; prose does not.

### The shape of the reply

```markdown
**TL;DR — do these:**
1. <action, in one line: what changes, where>
2. <…>
3. <…>

Say **go** for all of them, or name the numbers you want.

**Repos we touched**
- <repo>: <what changes> → <file>. <why here, in a clause>

**Catalogue**
- <repo>: <what changes> → `check` / `talks_to` / prose. <why here>

**Rig in general**
- <issue title> — <one line of what it asks>. <why here>

**Dropped:** <lesson> (<why, in a few words>); …
```

- **The TL;DR is two or three actions, never more.** They are the lessons most worth keeping, each one a thing you would do on "go". Everything else stays in the detail, where the user can still name it.
- **Every detail line is one line.** What changes, where it lands, and why that home in a clause. If a line needs a paragraph, the lesson is not understood yet.
- **Omit empty sections**, and name what was left out under **Dropped** so the user can see it was considered.

### Which home

| Who needs it | Home | Machine check first | Prose otherwise |
| --- | --- | --- | --- |
| someone changing the repo's code | **Repos we touched** | a test or CI step | the repo's docs |
| someone planning a work that touches the repo | **Catalogue** | a command for `check`, a fix to `talks_to` | the entry's prose |
| anyone using rig, on any data root | **Rig in general** | — | an issue on rig's tracker |
| only this work | nowhere new | — | `context.md` already keeps it |

- **When rig is the repo you touched**, a fix inside its code or tests is a repo lesson; a change to how a rig command behaves is a rig lesson.
- **A lesson that fits two homes is usually two lessons.** Split it rather than writing it twice.
- **Repo lessons go in the work's last PR** while one is open. If everything has merged, a small follow-up PR carries them.
- **Correct the catalogue before appending to it.** Read the entry first (`rig catalog <repo>` names the file). A lesson that contradicts a sentence replaces it; a catalogue that only grows ends up unread.
- **Write to the data root its readers can see.** `rig use` says which root is in hand. Do not carry an employer's lesson into a personal root, or the reverse.
- **Rig's tracker is public, and filing an issue is outward-facing.** Write about rig alone: no repo names, schemas, hosts or people from a private data root. "Go" covers the issues in the TL;DR; show the title and body of any other issue before filing it.

## 4. Record it

Once the lessons have landed, or the user says there are none:

```bash
rig save -m "lessons reviewed" --learned
```

This commits the catalogue changes with the rest of the data root and records the gate. Pass `--work <id>` if the work folder is gone. `rig next` stops offering the review, and `rig close` stops naming it.
