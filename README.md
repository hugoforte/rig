# rig

A cross-repo work harness. Describe a piece of work; `rig` decides which repos are involved,
assembles a worktree for each in one folder on a shared branch, and keeps the durable
knowledge about that work in a committed data root — this checkout, or a private repo.

```bash
rig new PROJ-42-refund-double-charge --title "Refunds double-charge on retry"
rig new refund-double-charge --title "…" --ticket   # no ticket yet: rig opens the GitHub issue
rig prompt select-repos          # the interview; an agent runs this
rig attach billing
rig attach orders-web
rig save -m "design agreed" --designed   # the context doc is yours to edit; this commits it
rig list                         # what's open, what's safe to close
rig close
```

Every command that changes a work commits the data root and pushes it, so the knowledge
is versioned at the moment it was agreed, not when someone remembers.

## Install

Needs Node 18+, `git`, and an authenticated `gh` (`gh auth login`) — `gh` is how rig resolves org repos, reads PR state and opens issues. An org tracked in Jira also needs `twg` on PATH, authenticated to that site; GitHub-only setups don't need it.

With the [dotfiles](https://github.com/hugoforte/dotfiles) profile loaded, one command clones and initialises:

```powershell
rig-install                                  # D:\rig, or %USERPROFILE%\rig without a D: drive
rig-install -Path C:\src\rig                 # anywhere else; sets RIG_ROOT so `rig` finds it
rig-install -DataRepo owner/rig-data         # also clone a private data repo and point dataRoot at it
```

By hand:

```powershell
gh repo clone hugoforte/rig D:\rig
node D:\rig\bin\rig.mjs init --data-repo owner/rig-data --email you@work.example   # join it, or create it if it doesn't exist
```

`init --data-repo` clones the private data repo beside the tool (creating it, with a first commit, when it does not exist yet) and points `dataRoot` at it. `init` also writes `rig.local.json` (gitignored: work root, data root, org identities, secrets sources), creates the work and mirror roots, sets `core.longpaths`, and prints whatever is still left to fill in. Re-running it is safe.

**First time for this org, or not sure?** Run the setup interview — `rig prompt setup` — with any agent. Its first question is where the knowledge lives: join an existing data repo (nothing else to ask), create one, or keep it local. The tool checkout itself is never the data root.

`rig` as a bare command is the dotfiles PowerShell function. In Git Bash — which is what Claude Code's Bash tool runs — use `node D:/rig/bin/rig.mjs <command>`.

Zero dependencies — Node 18+ and `git`, plus `gh` for PR state and org resolution and, for a Jira-tracked org, `twg` for ticket create/fetch/write-back.

## Tests

```
node --test
```

Unit tests for the pure helpers and for the GitHub and Jira modules' adapters, and one smoke test that copies the tool to a temp directory and runs it end to end against temp roots with the in-memory GitHub and Jira adapters (`RIG_FAKE_GITHUB`, `RIG_FAKE_TWG`) in place of `gh` and `twg`. CI runs the same on Linux and Windows.

## Layout

```
D:\rig\                    the tool — committed, generic
  bin/rig.mjs  bin/github.mjs  bin/jira.mjs  bin/cli.mjs  bin/errors.mjs  prompts/  templates/
  rig.local.json           gitignored: work root, data root, identities, secrets sources

D:\rig-data\               the knowledge — committed, private; never the tool's own checkout
  rig.json                 orgs and their trackers
  catalog/<org>/<repo>.md  what each repo is, and what it talks to
  work/<id>/context.md     the only copy of a work's prose

D:\w\                      disposable, reconstructible
  .mirrors/<org>/<repo>.git
  <work-id>/<repo>/        worktrees, all on one shared branch
```

Everything committed is worth keeping. Everything in `D:\w` can be deleted tonight. That
split is the whole design — see [DESIGN.md](./DESIGN.md), and [AGENTS.md](./AGENTS.md) for
how agents drive it.

## Why not the previous one

A previous coordination repo did most of this in June 2026 and was never adopted. It
had no worktree story, so the useful part of the workflow grew outside it; and its docs,
branch tables, and repo manifest all needed hand-maintenance, so they went stale within
days. `rig` puts worktree assembly at the entry point and derives everything derivable.
DESIGN.md §1 has the full post-mortem.
