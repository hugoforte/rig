# rig

A cross-repo work harness: name a piece of work, attach the repos it touches, and rig gives you one folder with a worktree per repo, all on one shared branch. What is durable about that work — which repos, why, what was decided — lives in a committed **data root** beside the tool, and every command that changes a work commits it at that moment.

```powershell
irm https://raw.githubusercontent.com/hugoforte/rig/main/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/hugoforte/rig/main/install.sh | sh
```

Then one command starts a work:

```powershell
rig new refund-double-charge --title "Refunds double-charge on retry" --key PROJ-42
```

From there: `rig attach billing` adds a repo, once per repo; `rig status` shows every worktree live; `rig list` says what is open and what is safe to close; `rig close` takes the worktrees away and keeps the record. Before the first work, `rig init` names the roots once — see [Setting up](#setting-up) — and `rig doctor` checks the rest for you.

## How it fits together

Three things are worth a minute before you go further: where rig puts what, how a work moves, and what the branches look like.

### The three roots

```mermaid
flowchart LR
  subgraph tool["the tool — committed, generic, public"]
    A["rig.local.json<br/>gitignored: the roots,<br/>identities, secrets sources"]
  end
  subgraph data["the data root — committed, private"]
    B["rig.json<br/>orgs, trackers,<br/>freshness policy"]
    C["catalog/org/repo.md<br/>what each repo is,<br/>and what it talks to"]
    D["work/id/context.md<br/>the only copy<br/>of the prose"]
  end
  subgraph work["the work root — disposable, reconstructible"]
    E[".mirrors/org/repo.git<br/>the bare clones<br/>worktrees are cut from"]
    F["work-id/repo/<br/>worktrees, all on<br/>one shared branch"]
  end
  tool -->|names it| data
  data -->|assembles it| work
```

Everything committed is worth keeping. Everything under the work root can be deleted tonight. That split is the whole design; [DESIGN.md](./DESIGN.md) says why, and its §3 has the layout path by path.

rig reads its config from two files and no others: `rig.json` in the data root is the org half, committed and shared (orgs, trackers, the freshness policy, the record-format stamp); `rig.local.json` beside the tool is the machine half, gitignored (the roots, identities, secrets sources, a per-machine freshness override). The data root is never the tool's own checkout — knowledge inside a public tree is one `git add` from a leak, and `rig doctor` reports that layout as not set up.

### A work's life

```mermaid
stateDiagram-v2
  direction LR
  [*] --> planning
  planning --> designing: repos attached
  designing --> building: design gate passed
  building --> reviewing: a PR is open
  reviewing --> landing: approved
  landing --> closed: rig close
  building --> abandoned: stopped without finishing
  closed --> [*]
  abandoned --> [*]
```

That is the **phase** — where a work is now. It is always derived, from the repos attached, the branches, the PRs and the gates recorded, and never stored, so it cannot go stale. Active phases are present participles and the two terminal ones are past, so the word itself tells you whether the work is still moving. Any phase can end in `abandoned`: the recorded decision to stop a work without finishing it, terminal like `closed` and deliberately distinct from it.

The only lifecycle facts written down are the **gates** that have been passed, each with its date — `designedAt`, `abandonedAt`, `closedAt` — because those are the only ones nothing can observe afterwards. A gate is a point where the agent stops for a decision, and it is also where rig commits and pushes the data root. `rig save -m "design agreed" --designed` is the one you pass by hand.

### Branches and stages

A work cuts one **work branch**, sharing a name across every attached repo, and lands in the **base branch** in one shot: one PR per repo, at the end.

```mermaid
gitGraph
  commit id: "base"
  branch work
  commit id: "work branch"
  branch stage-1
  commit id: "stage 1"
  branch stage-2
  commit id: "stage 2"
  checkout work
  merge stage-1
  merge stage-2
  checkout main
  merge work tag: "one PR per repo"
```

A **stage** is a delivery slice of a work: one coherent piece of scope, carried by a branch and reviewed on its own. Stages stack — the first on the work branch, each one after it on the stage before — and merge down into the work branch. Scope, never lifecycle: a stage is not a gate, and a work with no stages is simply one folder of worktrees on one branch.

Base is a relation, not a name for any particular branch. `rig status` reads each branch's base off its own PR, so a branch stacked on another one reads as `base main → feat/other-work` rather than still claiming `main`.

## Going deeper

- [AGENTS.md](./AGENTS.md) — for agents driving rig: the commands, the rules and the gates, in the order an agent meets them.
- [DESIGN.md](./DESIGN.md) — why it is shaped this way, with the decision log and the post-mortem of the tool this one replaced.
- [CONTEXT.md](./CONTEXT.md) — what the words mean: one definition each, with the synonyms it displaces.
- [docs/adr/](./docs/adr/) — the decisions that were hard to reverse.
- [Principles](./DESIGN.md#principles) — what the decisions have in common: keep it refactorable, don't factor it early; strong convictions, loosely held.

## Reference

Everything from here down is detail. Nothing above needs it.

### Prerequisites

- Node 18 or newer, and `git`.
- `gh`, logged in (`gh auth login`). rig uses it to find repos, read PR state and open issues.
- `twg` on PATH, only for an org whose tickets live in Jira. GitHub-only setups never need it.

No need to verify them by hand: `rig doctor` checks all of these once rig is installed. Windows is the first-class platform; Linux and macOS run the same code and the same tests.

### Install, in full

The one-line script clones rig — `C:\rig` on Windows, `~/rig` elsewhere — runs `npm install -g` on the clone, and ends with `rig help` so you can see it worked. Run it again over a checkout that already exists and it changes nothing: no fetch, no reset, no `rig update`. It never runs `rig init` — setting rig up is a deliberate step of its own. To install somewhere else, save the script instead of piping it, and pass the path: `.\install.ps1 D:\rig`, `sh install.sh /opt/rig`.

Or the three commands it runs, by hand:

```powershell
gh repo clone hugoforte/rig C:\rig
npm install -g C:\rig
rig help
```

`npm install -g` links the checkout rather than copying it, so the command always runs whatever is in `C:\rig`. That is what lets `rig update` bring it forward later. In Git Bash, Linux or macOS the same three lines work with a forward-slash path of your choosing, and `rig` is on PATH there too.

### Setting up

Ten minutes to a first work with two worktrees on disk. This path keeps everything on your machine and asks nothing about tickets.

```powershell
rig init --data-root C:\rig-data --work-root C:\w --orgs your-org --tracker your-org=none --email you@example.com
rig doctor
```

`init` creates the data root as a git checkout with a first commit, writes `rig.local.json` in the clone beside `package.json` (gitignored: the paths, your identity per org), creates the work root, and sets `core.longpaths` so deep `node_modules` paths do not break. `your-org` is a GitHub org or user; `--tracker your-org=none` means no ticket system yet. Re-running `init` is safe. `doctor` should come back clean. Without `--work-root`, `init` picks `D:\w` when a D: drive exists and `~\w` otherwise.

```powershell
rig new my-first-work --title "Trying rig"     # no prompt; a brief may be piped in
cd C:\w\my-first-work
rig attach some-repo                           # any repo in your org
rig attach another-repo
rig status
```

`new` records the work in the data root and makes `C:\w\my-first-work`. Commands that act on a work find it from the folder you are in, or take `--work my-first-work` from anywhere. Each `attach` finds the repo in your org through `gh`, clones a bare mirror once, cuts a worktree on the work's branch, and for a repo it has not seen drafts a catalogue entry, asking with a `!` that you correct it while the repo is fresh in your head. A first run can come back to that. `status` shows every worktree, its branch, and how far it is from its base — all derived live, none of it written down.

The work's prose lives in one place, `C:\rig-data\work\my-first-work\context.md`. Edit it, then `rig save -m "…"` commits it; `rig save --designed` passes the design gate. When the PRs are merged, `rig list` says so and `rig close` removes the worktrees, keeping the record.

**What now.** `rig next` answers it, by reading live state rather than a remembered plan: nothing attached yet, the design gate not recorded, commits not pushed, a branch waiting for a pull request, three repos that want a rollout plan, everything merged and ready to close. It **only ever offers** — it never warns, never blocks and never says you should have; warnings live in `rig doctor`, and only for contradictions. And it speaks only when asked: a command you run, not a hook. How much ceremony a work carries is derived from what it contains, never declared — there is no `--track`, because a declaration made at `rig new` is a prediction and predictions rot.

**Slicing a work up.** A big work is delivered in stages: `rig stage feat/schema --delivers "the write path"` declares one, and `rig stage` reads the stack back in the order the branches are actually stacked. What is stored is the branch and that one line; whether a stage has started, is up for review or has landed, which repos carry it and where it sits in the stack are all derived from the branches and the PRs every time you ask. rig does not cut the branch — you do, where branches are made — and declaring it is what joins those branches into one slice across repos. A work with no stages behaves exactly as it always did, which is most works.

**Opening the pull requests.** `rig pr` opens one per repo, work branch to the base it was cut from. The body is assembled from what the record already holds — the title, the tickets, the Direction section of the context doc lifted verbatim, and the stage table rendered from the stack — so the deploy-order table stops being something anyone types. It is not a gate, and it is idempotent: a repo that already has an open PR is reported, not duplicated.

**Stopping a work you did not finish.** `rig close --abandoned` is the honest exit. It runs the same teardown and drops only the checks that ask whether the work landed — an unmerged PR and unpushed commits are what being abandoned looks like — while uncommitted changes still refuse, because unsaved work is the one thing a teardown can destroy. The ticket is told and left open, and open PRs are named and left alone.

`RIG_LOCAL_CONFIG` names `rig.local.json` somewhere other than beside the tool — for a second installation sharing one checkout, or for a test — and a relative `dataRoot` inside it is read against that file's own directory. A key belonging to the org half is ignored in the machine file, and `rig doctor` says so. There is no override for the tool checkout: freshness and `rig update` measure the code that is running, and one that could say otherwise would point `update` at someone else's clone.

### Tickets

Point an org at its tracker and `rig new` insists on a ticket decision: `--key PROJ-42` or `--key owner/repo#7` records an existing one, `--ticket` creates one (`--dry-run` previews it), `--no-ticket` records that you declined. Jira briefs are fetched for you; GitHub briefs arrive on stdin.

```powershell
rig init --tracker your-org=github:your-org/planning     # or your-org=jira:PROJ
```

### Joining a team

When a private data repo already exists, one flag replaces the org questions: its `rig.json` names the orgs and trackers, and its catalogue comes along.

```powershell
rig init --data-repo your-org/rig-data --email you@work.example
```

The same flag creates the repo when it does not exist yet, with `--orgs` and `--tracker` for the org-level half.

### Checking a repo

A catalogue entry carries a `check` beside its `setup` — the commands that verify that repo: its test run, its lint, its build. `rig check` prints them for every repo attached to the work, and `rig check <repo> --run` runs them in that repo's worktree and exits non-zero when one fails. Printed rather than run is the default for the same reason it is for `setup`: a check in a worktree nothing has installed yet fails for a reason that is not the code's. The catalogue holds the command and never the result, so there is nothing in it that can go stale — and a repo with no `check` yet is told which file to write one in.

```powershell
rig check                    # every attached repo, printed
rig check billing --run      # run billing's
```

### Reading the works back out

`rig list` orders every work by when it was last touched, least recent first, so the last thing printed is the work in hand. `rig list --json` prints the same works as one JSON document — the records, plus the live fields a consumer cannot derive: each repo's PR with its `openedAt`, `firstReviewAt`, `approvedAt` and `mergedAt`, and the `firstCommitAt` that starts the clock. `closedAt` is when `rig close` ran, not when anything merged; measure from `firstCommitAt` to `mergedAt`. `--quick` skips every git and GitHub lookup and leaves those fields out entirely — except a merged PR that has been recorded (below), which is read straight out of `work.json` and carries `recorded: true`, live or `--quick` alike.

**Filling in the past.** A merged PR's `openedAt`, `firstCommitAt`, `firstReviewAt`, `approvedAt` and `mergedAt` are never going to be anything else, so `rig close` stores them in `work.json` as it closes, and `rig backfill [--work <id>] [--force]` fills in what closed before that field existed. After that, `rig list --json` — `--quick` included — and `rig dash` need no `gh` call for that repo ever again. Backfill only touches entries with no stored PR (`--force` refreshes what is already there), commits and pushes once at the end like every other mutating command, and prints separately what it filled and what GitHub would not answer for — nothing is cached as permanently unknown, because a rate limit is transient and a "never" written into a record is worse than asking again later.

**Showing the work.** `rig dash` renders the same payload as one self-contained HTML page — merged per week, cycle time by type, where the time went, repos per work — writes it to a temp file and opens it. Dark by default, with a light variant when the machine asks for one. It is never committed and never written to the data root: it is a rendering of state that was true a moment ago, and it says at the top when that moment was. Orgs are never summed into one figure, every statistic carries its `n`, and the page says "since rig" rather than claiming a before-and-after it has no data for. `--from payload.json` renders a capture instead of looking everything up again — and when that capture is a `--quick` one carrying backfilled PRs, the header says so ("read from the records, which cannot change") rather than claiming nothing in it is live.

```powershell
rig list --json > payload.json   # once
rig dash --from payload.json --org your-org --since 30d
```

**Driving rig with an agent.** [AGENTS.md](./AGENTS.md) is the agent's manual, and the interviews rig expects an agent to run are printed by `rig prompt setup`, `rig prompt new-work` and `rig prompt select-repos`.

### Staying up to date

Nothing pulls a checkout for you, so rig measures its own freshness — how far the checkout is behind its remote — and prints one dim line when it is behind. `rig doctor` fetches and reports; `rig update` fast-forwards the tool and the data root, runs pending record migrations, and never merges or rebases. The major version is the record format, so an older rig refuses to write into a data root a newer one has migrated, and still reads it — see [ADR 0002](docs/adr/0002-the-major-version-is-the-record-format.md).

`rig doctor` also names the release a checkout stands on, and the distance past it when it is past one:

```
· rig 1.1.0 at C:\rig (v1.1.0)
· rig 1.1.0 at C:\rig (3 past v1.1.0, abc1234)
```

### Releases

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

### Contributing

```
node --test
```

Unit tests for the helpers, the roots and config module, and the GitHub and Jira adapters, an installation suite for freshness and updates, and one smoke test that copies the tool to a temp directory and runs it end to end with its config (`RIG_LOCAL_CONFIG`) and in-memory `gh` and `twg` (`RIG_FAKE_GITHUB`, `RIG_FAKE_TWG`) in that directory too. Mirrors and worktrees are tested against real git: `RIG_FAKE_REMOTES` names a directory of bare repos, so `attach`, `detach`, `close` and `status` run on real clones, fetches and worktrees without a network. CI runs the same on Linux and Windows. [DESIGN.md](./DESIGN.md) holds the reasoning and the decision log, including the post-mortem of the tool this one replaced.
