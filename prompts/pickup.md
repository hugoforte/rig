# Prompt: pick up a work from its handoff

You are picking up a work another session left. It wrote down what it did so that you would not have to do it again: **the trail is authoritative.** Read it; do not redo it.

## 1. Read the trail

Bring the trail up to date first, so you read the last session's and not an older one:

1. `rig restore <id>`, even where the work's folder is already here: it fast-forwards the data root, so the handoff and the record are the ones the last session pushed, and changes nothing else where the folder is in place.
2. In each worktree, bring the branch `rig status` names up to what was pushed: `git fetch origin`, then `git merge --ff-only origin/<branch>`. One that will not fast-forward means this machine has commits the last session never saw: stop and ask the user, and never force.

Then `rig status` from the work folder, and read, in this order:

- `handoff.md`, in the folder beside the file the `context` line names (the `handoff` line is its address for another machine). What the last session did, what is half-done, and what it was about to do.
- `context.md`. The design, and the decisions that bind every next step.
- `notes.tsv` beside it, if `rig status` names one: each decision the last session took along the way, why, and a pointer at the evidence. Open the pointer a next step depends on, rather than redoing what the row says was done.
- `rig status` itself: the phase and gates, the **stops** line (what the human chose to be asked, and what the agent was trusted to decide), and each repo's **checks** line (whether its checks passed at the patch it carries now).
- `rig stage` for a work with stages, and the branch log against the base in each worktree: `git -C <worktree> log --oneline <base>..HEAD`.

Do not run a "verify from scratch" pass on top of this: no second repro, no re-reading of the whole diff to check the handoff was right, no re-run of the checks. A repo whose `checks` line says **verified** passed at the diff it carries; that is the evidence, recorded so that you need not make it again.

## 2. Compare what was planned with what happened

- **Planned**: the Direction in `context.md`, and its stages.
- **Done**: the commits, the stages that landed, the PRs.
- **Half-done**: what the handoff says is in flight.

Name the resume point in one line.

## 3. Check what you inherit, once

Check only the claims the next step stands on, against the real thing, and only once: a test the handoff says passes and the next change relies on, say. A repo whose checks line says **stale** or **not verified** is one such claim: `rig check <repo> --run` answers it and records the pass. So is a **verified** one whose PR's checks are failing while `rig next` names a moved base: a pass is for the patch, and the base it ran against has changed. Everything else the trail says, take as said.

## 4. Reply, then start

Before doing anything else, reply with:

- **Where the last session stopped**, in a sentence.
- **What you inherited**, and what you checked of it.
- **What you redid**, which should be nothing; if it is not, say why.
- **The resume point**, and the first step you are about to take.

Then start: a pickup is no stop, since the human who left the handoff has said what comes next. Your first commit on the work is the pickup having begun, and `rig next` stops offering it.
