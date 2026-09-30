# 0001: Jira via `twg`, not the agent

## Status

Accepted, 2026-09-16. Supersedes DESIGN.md decision log entries 29 ("Agent fetches Jira;
`rig` shells to `gh`; no credentials in `rig`") and 33 (`rig new --ticket` opens GitHub
issues via `gh`; Jira tickets stay with the agent").

## Context

Decision 29 held that rig authenticates to nothing but git and never talks to Jira: the
agent fetches ticket prose with its own tooling and pipes it in. In practice this made
the ticket decision easy to skip — a work could go without a ticket on a Jira-tracked org with
nothing stopping it (see the Problem section of the `rig-workflow-gates` context doc) —
and left rig unable to do for Jira what it already does for GitHub: open a ticket, read
one back, and comment at close.

`twg` — the Teamwork Graph CLI already used for Jira, Confluence and other Atlassian
work from this machine — reads its site and auth from its own config
(`%APPDATA%\twg\auth.conf`), the same way `gh` does for GitHub. Shelling out to it costs
rig nothing it doesn't already pay for `gh`, and keeps DESIGN.md decision 1 (zero
dependencies) intact: no SDK, no stored credentials, one more CLI on PATH.

## Decision

`twg` is rig's Jira client, named in code and handled the same way as `gh`: `bin/jira.mjs`
is `bin/github.mjs`'s counterpart — one interface (`present`, `getIssue`, `createIssue`,
`commentIssue`, `fieldMetadata`, `projectComponents`, `activeSprintId`), a `twgViaCli` adapter that shells to
`twg`, and a `twgInMemory` adapter for tests. "twg not found" is handled like "gh not
found" — `init` and `doctor` warn, nothing dies.

Not configurable. One implementation, no seam for a second Jira client to plug into — the
same call `bin/github.mjs` made in PR 1: an adapter only earns its seam when a second one
actually exists, and here that second adapter is the in-memory test double, not an
alternative Jira client.

rig does three things with Jira, matching what it already does for GitHub:

- **Create** (`rig new --ticket` on a Jira-tracked org): `twg jira workitem create`,
  with per-org defaults from `rig.json` resolved first (below). `--parent PROJ-7` files it
  under an epic through twg's own `--parent`, never as a resolved field (DESIGN.md
  decisions 145–146).
- **Fetch** (`rig new --key KTLO-42`): `twg jira workitem get` supplies the summary and
  description, so the agent no longer has to fetch and pipe the brief itself for a
  Jira-tracked org. Piped stdin and `--title` still win when given.
- **Write back on close**: a comment carrying the PR links and merge state, matching the
  content of GitHub's write-back. Unlike GitHub, rig **never transitions a Jira ticket**
  — moving it (e.g. KTLO's two hops through "To Do" and "Start working" to reach "In
  Progress") is org workflow, not rig's, and stays with the agent.

Everything rig sends Jira as prose — the create's description, the close comment — is
**markdown**, declared as such (`--description-format markdown`, `--body-format
markdown`). twg's own default for both is HTML, which would collapse a brief's blank lines
into one run-on paragraph and eat anything angle-bracketed, so the format is fixed in
`bin/jira.mjs` rather than being a parameter: rig writes markdown and nothing else, and no
ADF is ever built here. That the create carries the format is also why a Jira ticket gets
its full description in **one** call (hugoforte/rig#54).

System fields go on the same call. An earlier twg's create dropped them, which is what
hugoforte/rig#53 was opened for; twg 1.3's create resolves each `--field` against Jira's
own create-screen metadata, system fields included, and shapes the value for Jira — a
component name or id becomes `{ id }`. It reads each value as JSON first, so a lone id sent
bare arrives as a number and is never shaped. `bin/jira.mjs` therefore sends a list as JSON
(`components=["10001"]`), so that no REST passthrough or second create path should be
needed (DESIGN.md decision 147). One live create on 2026-09-30, into a project that requires
Components, proved it: the ticket arrived with its component and under its parent.

A Jira description is the **whole** brief plus the context-doc link, where a GitHub issue
body is the brief's first paragraph plus the same link. Not an inconsistency: the GitHub
issue and the context doc are read by the same person, one click apart (DESIGN.md §7.1),
while a Jira ticket is read by a team that may have no access to the private data root the
link points at — so it has to stand on its own. Jira's own description limit is 32,767
characters and rig does not police it; a brief that long is not a thing `rig new` is
handed, and twg's error surfaces loudly if one ever is.

Per-org ticket config (`project`, `type`, `fields`, `board`) lives in `rig.json` in the
data root, the same place `tracker.<org>.repo` already lives for GitHub — org facts,
private, never hardcoded in this repo. There is no `rig init` flag for it (`--tracker`
only sets `kind`/`project`); an agent (or a human) adds it directly to `rig.json`, the
same way a catalogue entry gets corrected by hand. Field ids (`customfield_10058` for
Story Points, say) are **discovered** through `twg jira workitem field
create-metadata`, never pasted into `rig.json` or this codebase from a one-off
inspection — the KTLO ids the `rig-workflow-gates` context doc records are a fixture
for that org's data root, not a shortcut for this one. A single-value field takes a scalar
there, and a list only where Jira wants several: a one-item list reaches twg as a list.

That holds for **custom** fields. `field create-metadata` turned out to return custom
fields only (hugoforte/rig#45), so Jira's **system** fields — `components`, `labels`,
`priority`, `versions`, `fixVersions` — cannot be discovered from it at all. They are a
fixed list in `bin/rig.mjs` (`JIRA_SYSTEM_FIELDS`), which is not a hardcoded *site* fact:
a system field's id is its Jira name, the same on every site. Their allowed values still
come from the site — components from `projectComponents`, the REST passthrough
`twg api jira:/rest/api/3/project/<KEY>/components`. A name in neither place still dies.

`rig new --ticket --dry-run` resolves and prints the create defaults (including a
`sprint: "active"` resolved through the org's board, and named fields like `components`
resolved to their ids) without creating anything, so confirm-before-create lives in the
prompt while rig itself stays single-shot (DESIGN.md decision 13).

## Consequences

- The ticket-decision gate (`rig new` refusing without `--key`/`--ticket`/`--no-ticket`)
  can now be satisfied end-to-end on a Jira org, not just GitHub.
- `prompts/new-work.md`'s old "rig does not talk to Jira, create the ticket yourself"
  instructions are out of date as of this ADR; see its rewrite in the same PR.
  `docs/agents/issue-tracker.md` is unaffected — it documents how *this repo's own*
  issues are tracked (GitHub), not how rig talks to a user's tracker.
- **Verified against real answers, twg 1.3.3, 2026-09-30** (hugoforte/rig#260). The
  JSON shapes `bin/jira.mjs` parses were first built against `twg --help` and the
  `--agent-fields` example, not a live call, on the theory that each parser failing loudly
  with the raw output would surface a wrong guess on first use. That held for reads and
  not for writes: the first live create failed to read its key **after** the ticket
  existed, so the natural retry made a duplicate. It also missed a guess that read wrong
  without failing: `activeSprintId` looked for a `sprints` list twg never sends, and
  answered "no active sprint" on a board that had one. Every parser (`getIssue`,
  `createIssue`, `fieldMetadata`, `activeSprintId`, `projectComponents`) has now been
  checked against a real twg 1.3.3 answer, `createIssue` through a real create and the
  rest through read-only calls, and each has a canned test of that shape. One answer is
  inferred rather than seen: a sprint snapshot of a board with no active sprint, since
  every board tried had one. What that changed is DESIGN.md decisions 148–150.
- **twg answers some commands differently under an agent.** With `CLAUDECODE`,
  `AI_AGENT` or a similar variable set, twg 1.3 replaces the JSON of some `-o json`
  commands (`workitem get` among them) with a YAML summary on stdout and writes the JSON
  to a temp file. rig passes `--output-summary none` on every `-o json` call, so what it
  parses does not depend on who ran it (DESIGN.md decision 149). `twg api`, behind
  `projectComponents`, takes no `-o` and passes the REST answer through unwrapped.
- Org resolution for a Jira fetch (`rig new --key KTLO-42`) is by project-prefix match
  against `rig.json`'s configured orgs (`orgForJiraKey`); an unconfigured project is
  silently not fetched (the old piped-brief flow still works). `--ticket`'s org
  resolution is unchanged from PR 1's `trackerFor` — explicit `--org`, else the only
  live tracker, else a refusal naming `--org`.
