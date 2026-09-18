# rig

A cross-repo work harness. Name a piece of work, attach the repos it touches, and rig gives you one folder with a worktree per repo, all on one shared branch. The durable knowledge about that work — which repos, why, what was decided — lives in a committed **data root**, a private git repo beside the tool, and every command that changes a work commits and pushes it at that moment.

```bash
rig new refund-double-charge --title "Refunds double-charge on retry" --key PROJ-42
rig attach billing
rig attach orders-web              # C:\w\refund-double-charge\{billing,orders-web}, branch shared
rig save -m "design agreed" --designed
rig list                           # what is open, what is safe to close
rig close
```

## Prerequisites

- Node 18 or newer, and `git`.
- `gh`, logged in (`gh auth login`). rig uses it to find repos, read PR state and open issues.
- `twg` on PATH, only for an org whose tickets live in Jira. GitHub-only setups never need it.

Windows is the first-class platform; Linux and macOS run the same code and the same tests.

## Install

```powershell
gh repo clone hugoforte/rig C:\rig
npm install -g C:\rig
rig help
```

`npm install -g` links the checkout rather than copying it, so the command always runs whatever is in `C:\rig`. That is what lets `rig update` bring it forward later. In Git Bash, Linux or macOS the same three lines work with a forward-slash path of your choosing, and `rig` is on PATH there too.

## Quick start

Ten minutes to a first work with two worktrees on disk. This path keeps everything on your machine and asks nothing about tickets; the next section adds those.

```powershell
rig init --data-root C:\rig-data --work-root C:\w --orgs your-org --tracker your-org=none --email you@example.com
rig doctor
```

`init` creates the data root as a git checkout with a first commit, writes `rig.local.json` in the tool checkout (gitignored: the paths, your identity per org), creates the work root, and sets `core.longpaths` so deep `node_modules` paths do not break. `your-org` is a GitHub org or user; `tracker … none` means no ticket system yet. Re-running `init` is safe. `doctor` should come back clean.

```powershell
rig new my-first-work --title "Trying rig"
rig attach some-repo
rig attach another-repo
rig status
```

`new` records the work in the data root and makes `C:\w\my-first-work`. Each `attach` finds the repo in your org through `gh`, clones a bare mirror once, cuts a worktree on the work's branch, and drafts a catalogue entry for a repo it has not seen. `status` shows every worktree, its branch, and how far it is from its base — all derived live, none of it written down.

The work's prose lives in one place, `C:\rig-data\work\my-first-work\context.md`. Edit it, then `rig save -m "…"` commits it; `rig save --designed` marks the design agreed. When the PRs are merged, `rig list` says so and `rig close` removes the worktrees, keeping the record.

## Next

**Tickets.** Point an org at its tracker and `rig new` insists on a ticket decision: `--key PROJ-42` or `--key owner/repo#7` records an existing one, `--ticket` creates one (`--dry-run` previews it), `--no-ticket` records that you declined. Jira briefs are fetched for you; GitHub briefs arrive on stdin.

```powershell
rig init --tracker your-org=github:your-org/planning     # or your-org=jira:PROJ
```

**Joining a team.** When a private data repo already exists, one flag replaces the org questions: its `rig.json` names the orgs and trackers, and its catalogue comes along.

```powershell
rig init --data-repo your-org/rig-data --email you@work.example
```

The same flag creates the repo when it does not exist yet, with `--orgs` and `--tracker` for the org-level half.

**Driving rig with an agent.** [AGENTS.md](./AGENTS.md) is the agent's manual, and the interviews rig expects an agent to run are printed by `rig prompt setup`, `rig prompt new-work` and `rig prompt select-repos`.

## The three roots

```
C:\rig\                    the tool — committed, generic, public
  rig.local.json           gitignored: work root, data root, identities, secrets sources

C:\rig-data\               the knowledge — committed, private; never the tool's own checkout
  rig.json                 orgs, trackers, freshness policy, record-format stamp
  catalog/<org>/<repo>.md  what each repo is, and what it talks to
  work/<id>/context.md     the only copy of a work's prose

C:\w\                      disposable, reconstructible
  .mirrors/<org>/<repo>.git
  <work-id>/<repo>/        worktrees, all on one shared branch
```

Everything committed is worth keeping. Everything under the work root can be deleted tonight. That split is the whole design; [DESIGN.md](./DESIGN.md) says why. Without `--work-root`, `init` picks `D:\w` when a D: drive exists and `~\w` otherwise.

## Staying up to date

Nothing pulls a checkout for you, so rig measures its own freshness — how far the checkout is behind its remote — and prints one dim line when it is behind. `rig doctor` fetches and reports; `rig update` fast-forwards the tool and the data root, runs pending record migrations, and never merges or rebases. The major version is the record format, so an older rig refuses to write into a data root a newer one has migrated, and still reads it — see [ADR 0002](docs/adr/0002-the-major-version-is-the-record-format.md).

## Contributing

```
node --test
```

Unit tests for the helpers and the GitHub and Jira adapters, an installation suite for freshness and updates, and one smoke test that copies the tool to a temp directory and runs it end to end with in-memory `gh` and `twg` (`RIG_FAKE_GITHUB`, `RIG_FAKE_TWG`). CI runs the same on Linux and Windows. [DESIGN.md](./DESIGN.md) holds the reasoning and the decision log, including the post-mortem of the tool this one replaced.
