---
name: rig
description: Cross-repo work harness. Use when a ticket or task spans more than one repo, when asked to set up worktrees for a piece of work, when standing in a rig work folder, when picking up a handoff, or when asked what work is open or to close one.
---

# rig

`rig` assembles one git worktree per repo for a piece of **work**, all on one shared branch, and keeps that work's durable knowledge in a **data root** — a committed checkout holding the repo catalogue, the work records and `rig.json`.

rig documents itself, and this skill ships with it. It finds rig and routes you inside it, and restates nothing on purpose: `rig doctor`, `rig help` and `AGENTS.md` are always the current answer, and this file is not.

## Step 1: Find rig

`rig <command>` works in every shell on a set-up machine: the npm global install is a link to the checkout, so one `rig update` moves the command. Confirm with `command -v rig`. If it is missing, the checkout is at `RIG_ROOT`, else `C:\rig` or `~/rig`, and `node <root>/bin/rig.mjs <command>` runs it from there.

**No checkout at all:** the README's one-command install — `install.sh` on a POSIX shell, `install.ps1` on PowerShell — clones the tool and installs it globally. It needs Node 18+, `git` and `npm`; `gh` must be authenticated before a private repo can be mirrored. Everything after the clone is `rig prompt setup`'s to ask; do not guess the data root, the email or the orgs.

## Step 2: Orient

```bash
rig doctor
```

One command, and the only place to learn any of it: the version and record format, the work root, every data root this machine knows with its tracker and identity, and every finding. Read it before acting. Nothing about this machine's layout is written into this skill, because the answer differs per machine and `doctor` always has the current one.

`doctor` saying **not set up** means there is no data root with a `rig.json`. Run `rig prompt setup`.

## Step 3: Read the instructions

Read `<root>/AGENTS.md` in full. It is the single source of truth for how rig works — the three roots, the commands, the catalogue, the context doc, the rules. Continue only once you have read it. `rig help` lists every command with its flags.

## Step 4: Route

| The request | Start here |
|---|---|
| Start a piece of work | `rig prompt new-work`, then `rig prompt select-repos` |
| Which repos does it touch | `rig prompt select-repos` |
| First run on this machine | `rig prompt setup` |
| Standing in a work, what now | `rig next` |
| Picking up a work someone else left | `rig status`; a `handoff.md` beside its `context.md` is the previous session's account — read it first |
| Where has this work got to | `rig status` |
| What is open, what can close | `rig list` |
| Slice the work into reviewable parts | `rig stage` |
| Put it up for review | `rig pr` |
| Deploy order, rollout, UAT | `rig plan`, `rig plan --refresh` |
| How is a repo verified | `rig check [--run]` |
| Context doc edited by hand | `rig save -m "…"` |
| Design agreed with the user | `rig save -m "design agreed" --designed` |
| What did this work teach | the `rig-learn` skill, then `rig save -m "lessons reviewed" --learned` |
| Leaving a work for another session | the `rig-handoff` skill |
| Finished | `rig close` |
| Stopped without finishing | `rig close --abandoned` |
| A command died with "run `rig update`" | `rig update`, from the installed checkout |
| Whose knowledge is in hand | `rig use` |

**Stop for the user at three points**, and `rig new` enforces the first by refusing without it: the ticket decision (`--key`, `--ticket` or `--no-ticket`), the repo set, and the design gate. Each `rig prompt` ends by stopping; do not run past it.

**More than one data root is normal** — personal, public and employer knowledge have different readers. A work lives in exactly one, and `rig new --repos a,b` refuses repos catalogued in different roots. `rig use` says which is in hand.

## Two rules before you have read `AGENTS.md`

- **Never `git worktree add` inside the work root.** `rig attach` adds repos; rig owns that tree and `rig doctor` fails on strays. Outside it, do as you like.
- **Never edit a generated file.** Every `AGENTS.md` under the work root is rewritten on each mutating command, as is `demo/index.html`. Prose lives in the work's `context.md`, which is the only copy.
