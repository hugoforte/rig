# Prompt: pick up a work from its handoff

You are picking up a work another session left. It wrote down what it did so that you would not have to do it again: **the trail is authoritative.** Read it; do not redo it.

## 1. Read the trail

Run `rig restore <id>` if the work's folder is not on this machine, then `rig status` from the work folder. Then read, in this order:

- `handoff.md`, at the address the `handoff` line of `rig status` gives. What the last session did, what is half-done, and what it was about to do.
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

Check only the claims the next step stands on, against the real thing, and only once: a test the handoff says passes and the next change relies on, say. A repo whose checks line says **stale** or **not verified** is one such claim: `rig check <repo> --run` answers it and records the pass. Everything else the trail says, take as said.

## 4. Reply, then start

Before doing anything else, reply with:

- **Where the last session stopped**, in a sentence.
- **What you inherited**, and what you checked of it.
- **What you redid**, which should be nothing; if it is not, say why.
- **The resume point**, and the first step you are about to take.

Then start. Your first commit is the pickup having begun, and `rig next` stops offering it.
