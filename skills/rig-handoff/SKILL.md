---
name: rig-handoff
description: Compact the current conversation into a handoff document for another agent to pick up. Inside a rig work it is written into the work's record and committed; outside one it goes to the OS temp directory.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

# rig-handoff

Write a handoff document summarising the current conversation so a fresh agent can continue the work, then print the prompt that continues it.

## Where it goes

Run `rig status` from the current directory, with no `--work` flag: the work in hand is the one this conversation was standing in, and a flag would be a guess.

If it answers "not inside a work" but this conversation was about one — its folder missing on this machine, and the work done somewhere else — run `rig status --work <id>` instead. The record lives in the data root whatever state the folder is in.

**Inside a work** — `rig status` answers — write `handoff.md` beside that work's `context.md`. The `context` line of `rig status` names the file; the handoff sits in the same directory. Overwrite any `handoff.md` already there: the newest handoff is the only one the next agent wants, and the data root is git, so the old ones are one `git log` away. Then commit it:

```bash
rig save -m "handoff: <one line naming the next focus>"
```

`rig save` commits the whole data root and pushes it when it has an upstream, so the handoff is on every machine the next session might start on.

**Not inside a work** — `rig status` says so — save to the temporary directory of the user's OS, not the current workspace, and skip the commit.

## What it says

- **Suggested skills**: a section naming which skills the next agent should call the Skill tool for. Inside a work, `rig` is always one of them.
- Do not duplicate content already captured in other artifacts — the work's `context.md`, specs, plans, ADRs, issues, commits, diffs. Reference them by path or URL instead. Inside a work, the context doc is the design; the handoff is what happened since, what is half-done, and what the next agent would otherwise have to rediscover.
- Redact any sensitive information: API keys, passwords, personally identifiable information.
- If the user passed arguments, treat them as a description of what the next session will focus on and tailor the document accordingly.

## End with the prompt that continues it

The last thing in the reply is a prompt the user can paste into a fresh session, as one fenced block. Inside a work:

```text
rig restore <id>
cd <work folder, from the `path` line of any repo in rig status, one level up>
/rig Pick up the work <id>. Read <path to handoff.md> first, then continue with: <next focus>.
```

`rig restore` comes first because the next session may be on a machine that has the data root and no work folder. It rebuilds the folder from the record, and on a machine that already has it, it changes nothing. Its last line names the folder, which is where to `cd` if that machine keeps its work root somewhere else.

If any of the work lives on branches rig does not know — a stack of pull requests nobody recorded with `rig stage` — name them in the handoff. `rig restore` reports what is stacked on the branches it knows, and `--tip` checks out the top of that stack.

Outside a work, the same shape without the `cd` and the `/rig`: where the handoff was saved and what to continue with.
