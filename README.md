# rig

A cross-repo work harness. Name a piece of work, attach the repos it touches, and rig gives you one folder with a worktree per repo, all on one shared branch. The durable knowledge about that work — which repos, why, what was decided — lives in a committed **data root**, a private git repo beside the tool, and every command that changes a work commits it at that moment, pushing when the data root has a remote.

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

No need to verify them by hand: `rig doctor` checks all of these once rig is installed. Windows is the first-class platform; Linux and macOS run the same code and the same tests.

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

`init` creates the data root as a git checkout with a first commit, writes `rig.local.json` in the clone beside `package.json` (gitignored: the paths, your identity per org), creates the work root, and sets `core.longpaths` so deep `node_modules` paths do not break. `your-org` is a GitHub org or user; `--tracker your-org=none` means no ticket system yet. Re-running `init` is safe. `doctor` should come back clean.

```powershell
rig new my-first-work --title "Trying rig"     # no prompt; a brief may be piped in
cd C:\w\my-first-work
rig attach some-repo                           # any repo in your org
rig attach another-repo
rig status
```

`new` records the work in the data root and makes `C:\w\my-first-work`. Commands that act on a work find it from the folder you are in, or take `--work my-first-work` from anywhere. Each `attach` finds the repo in your org through `gh`, clones a bare mirror once, cuts a worktree on the work's branch, and for a repo it has not seen drafts a catalogue entry, asking with a `!` that you correct it while the repo is fresh in your head. A first run can come back to that. `status` shows every worktree, its branch, and how far it is from its base — all derived live, none of it written down.

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

**Reading the works back out.** `rig list` orders every work by when it was last touched, least recent first, so the last thing printed is the work in hand. `rig list --json` prints the same works as one JSON document — the records, plus the live fields a consumer cannot derive: each repo's PR with its `openedAt`, `firstReviewAt`, `approvedAt` and `mergedAt`, and the `firstCommitAt` that starts the clock. `closedAt` is when `rig close` ran, not when anything merged; measure from `firstCommitAt` to `mergedAt`. `--quick` skips every git and GitHub lookup and leaves those fields out entirely.

**Showing the work.** `rig dash` renders the same payload as one self-contained HTML page — merged per week, cycle time by type, where the time went, repos per work — writes it to a temp file and opens it. Dark by default, with a light variant when the machine asks for one. It is never committed and never written to the data root: it is a rendering of state that was true a moment ago, and it says at the top when that moment was. Orgs are never summed into one figure, every statistic carries its `n`, and the page says "since rig" rather than claiming a before-and-after it has no data for. `--from payload.json` renders a capture instead of looking everything up again.

```powershell
rig list --json > payload.json   # once
rig dash --from payload.json --org your-org --since 30d
```

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

rig reads its config from those two files and no others: `rig.json` in the data root is the org half, committed and shared (orgs, trackers, the freshness policy, the record-format stamp); `rig.local.json` beside the tool is the machine half, gitignored (the roots, identities, secrets sources, a per-machine freshness override). A key of the org half's is ignored in the machine file, and `rig doctor` says so. `RIG_LOCAL_CONFIG` names `rig.local.json` somewhere other than beside the tool — for a second installation sharing one checkout, or for a test — and a relative `dataRoot` inside it is read against that file's own directory. There is no override for the tool checkout: freshness and `rig update` measure the code that is running, and one that could say otherwise would point `update` at someone else's clone.

## Staying up to date

Nothing pulls a checkout for you, so rig measures its own freshness — how far the checkout is behind its remote — and prints one dim line when it is behind. `rig doctor` fetches and reports; `rig update` fast-forwards the tool and the data root, runs pending record migrations, and never merges or rebases. The major version is the record format, so an older rig refuses to write into a data root a newer one has migrated, and still reads it — see [ADR 0002](docs/adr/0002-the-major-version-is-the-record-format.md).

`rig doctor` also names the release a checkout stands on, and the distance past it when it is past one:

```
· rig 1.1.0 at C:\rig (v1.1.0)
· rig 1.1.0 at C:\rig (3 past v1.1.0, abc1234)
```

## Releases

Every merge to `main` is a release, or says why it is not. The version is decided on the pull request, not after it: a required check computes what the PR lands as and fails until `package.json` says so, naming the value to write. The merge then tags that commit and publishes the notes, which are the descriptions of the pull requests since the previous tag.

| the PR | the bump |
|---|---|
| a `feat/…` branch — what `rig new --type feat` writes | minor |
| a `fix/…` branch | patch |
| a `release:minor`, `release:patch` or `release:none` label | overrides the branch |
| a migration added to `MIGRATIONS` | `MAJOR.0.0`, whatever the PR asked for |

The major is never asked for; it is the record format ([ADR 0002](docs/adr/0002-the-major-version-is-the-record-format.md)). Why the bump lives in the PR rather than in a bot commit on `main` is [ADR 0003](docs/adr/0003-the-pr-carries-its-own-version.md).

```
node bin/release.mjs check --tag v1.0.0 --branch feat/x --labels release:none
```

## Contributing

```
node --test
```

Unit tests for the helpers, the roots and config module, and the GitHub and Jira adapters, an installation suite for freshness and updates, and one smoke test that copies the tool to a temp directory and runs it end to end with its config (`RIG_LOCAL_CONFIG`) and in-memory `gh` and `twg` (`RIG_FAKE_GITHUB`, `RIG_FAKE_TWG`) in that directory too. Mirrors and worktrees are tested against real git: `RIG_FAKE_REMOTES` names a directory of bare repos, so `attach`, `detach`, `close` and `status` run on real clones, fetches and worktrees without a network. CI runs the same on Linux and Windows. [DESIGN.md](./DESIGN.md) holds the reasoning and the decision log, including the post-mortem of the tool this one replaced.
