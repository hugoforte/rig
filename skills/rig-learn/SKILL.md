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

Present the lessons under the four headings below, in this order, and **stop for the user**. Nothing is written until they agree. A heading with nothing under it says "nothing" rather than disappearing, so the user can see it was asked.

For every lesson, prefer a machine check over prose, and never add a rule to an `AGENTS.md` or `CLAUDE.md`. A check fails when it goes stale; prose does not.

### Repos we touched: updates needed there

One entry per attached repo, for anyone working *in* it. A test that pins the behaviour that surprised us, a CI step that would have failed sooner, or, failing both, a line in the repo's own docs. Name the file each one lands in.

- **It goes in the work's last PR** while one is open, next to the code that taught it. If everything has merged, a small follow-up PR carries it.

### Rig catalogue: potential updates for the repos we touched

One entry per attached repo, for anyone working *across* it. Read the entry first (`rig catalog <repo>` names the file), then propose the change against what it says now:

- a command for its `check` list: the verification this work had to discover;
- a correction or addition to `talks_to`: a neighbour the work found, or a stated direction that turned out wrong;
- a sentence of prose, replacing the one it contradicts. A catalogue that only grows ends up unread.

Write to the data root its readers can see. `rig use` says which root is in hand, and a work lives in exactly one: do not carry an employer's lesson into a personal root, or the reverse.

### Why each update goes where it goes

One line per lesson above: why that home, and why not the others. The test is who has to see it, and when:

| Who needs it | Home |
| --- | --- |
| someone changing the repo's code | the repo: a test or CI step, then its docs |
| someone planning a work that touches the repo | the catalogue: `check`, `talks_to`, prose |
| anyone using rig, on any data root | rig's tracker |
| only this work | nowhere new: `context.md` already keeps it |

A lesson that seems to fit two homes usually is two lessons. Split it rather than writing it twice.

### Rig updates in general

What the work taught about rig itself: a command that got in the way, a gap it had no answer for, a doc that said the wrong thing. Each one is a proposed issue on rig's tracker, shown as its title and body.

- **Filing an issue is outward-facing, and rig's tracker is public.** Write the issue about rig alone: no repo names, schemas, hosts or people from a private data root. Wait for a yes on each.

Scale the review to the work. A one-repo, one-PR work may have one line under each heading. A work with stages across several repos gets the full walk.

## 4. Record it

Once the lessons have landed, or the user says there are none:

```bash
rig save -m "lessons reviewed" --learned
```

This commits the catalogue changes with the rest of the data root and records the gate. Pass `--work <id>` if the work folder is gone. `rig next` stops offering the review, and `rig close` stops naming it.
