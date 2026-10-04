---
name: rig-docs
description: Keep a product's user documentation true once a rig work has landed — read the current page, the work's context doc, outcome and QA evidence, draft an edit for the product's users, and publish it only on the user's go. Use when `rig next` offers the user-docs edit, when a work's PRs have merged and it was verified where it was deployed, or when asked to update the user docs for a work.
---

# rig-docs

Edit the user documentation so it says how the product works now. The docs are the present, for someone who never saw the work; the digest is the history. They live with the product, in a repo's docs or a Confluence page, and rig does not own the page: this skill edits it there.

Run it once every pull request has merged and the work was seen working where it was deployed. Docs written before that describe what was meant to ship.

## 1. Find the targets

Run `rig status` from the work folder, or `rig status --work <id>` once it is closed, for the work's repos. Each repo's docs target is the `docs` field of its catalogue entry, which `rig catalog <repo>` prints: a path in the repo, or a page URL. While the work is open, `rig next` names them too.

A repo with no target is one whose entry says `docs: []`, or that has no entry. Ask the user where its docs live, if anywhere, and offer to write the answer into `docs:` in that entry: it is a catalogue correction, committed with `rig save`. A repo whose users read nothing is a fine answer; leave `docs: []`.

## 2. Read

- **The current page, in full, first.** A path: read it as the base branch has it now, which the work's merge put there, with `git -C <worktree> fetch origin` and then `git -C <worktree> show origin/<base>:<path>`; once the worktree is gone, `gh api repos/<owner>/<repo>/contents/<path>?ref=<base> -H "Accept: application/vnd.github.raw"`. A Confluence page: read it through the `twg` skill. You are editing what is there, so you need all of it.
- **The context doc**, `context.md`: the Problem says who this was for, the Direction what changed.
- **The outcome**, which `rig status` shows: what changed for someone, in one line.
- **The QA evidence**, `qa.md` beside the context doc when there is one, which `rig status` names: the steps walked on a deployed environment and what was seen. It is the closest thing to how a user meets the change. Without one, ask the user what they checked and where, and offer to write their answer to `qa.md` before you go on.

## 3. Draft the edit

- **Edit rather than append.** Change the sentence that is now wrong, and add a section only for something with no home on the page. A page that only grows ends up describing three versions at once.
- **Write for the product's users, not its developers.** What they can do now, and how. No branch, PR, ticket, class or table names.
- **Match the page.** Its headings, its terms, its voice. A new term that the product's UI shows is fine; one from the code is not.
- **Keep it to this work.** Wrong things nearby that the work did not touch go in the report as follow-ups, not into this edit.

Show the edit as a diff, or as before-and-after for each section changed, with one line on why each change is there. Then **stop for the user**. Publishing is outward-facing, so nothing is written until they say **go**.

## 4. Publish on "go"

- **A path in a repo**: everything has merged by now, so the edit is a small work of its own. Start it with `rig prompt new-work`, which asks the ticket question, and put the edit in that work's PR. Never cut a branch by hand in this work's worktree: rig owns that tree, and the merged branch is deleted at the close.
- **A Confluence page**: update it through the `twg` skill, and give the user the page's link.

Then record it:

```bash
rig save -m "user docs updated" --documented
```

Add `--work <id>` once the work folder is gone. `rig next` stops offering the edit. A user who says the docs need nothing for this work records the same gate: the question was asked and answered.
