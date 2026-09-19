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
  with per-org defaults from `rig.json` resolved first (below).
- **Fetch** (`rig new --key KTLO-42`): `twg jira workitem get` supplies the summary and
  description, so the agent no longer has to fetch and pipe the brief itself for a
  Jira-tracked org. Piped stdin and `--title` still win when given.
- **Write back on close**: a comment carrying the PR links and merge state, matching the
  content of GitHub's write-back. Unlike GitHub, rig **never transitions a Jira ticket**
  — moving it (e.g. KTLO's two hops through "To Do" and "Start working" to reach "In
  Progress") is org workflow, not rig's, and stays with the agent.

Per-org ticket config (`project`, `type`, `fields`, `board`) lives in `rig.json` in the
data root, the same place `tracker.<org>.repo` already lives for GitHub — org facts,
private, never hardcoded in this repo. There is no `rig init` flag for it (`--tracker`
only sets `kind`/`project`); an agent (or a human) adds it directly to `rig.json`, the
same way a catalogue entry gets corrected by hand. Field ids (`customfield_10058` for
Story Points, say) are **discovered** through `twg jira workitem field
create-metadata`, never pasted into `rig.json` or this codebase from a one-off
inspection — the KTLO ids the `rig-workflow-gates` context doc records are a fixture
for that org's data root, not a shortcut for this one.

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
- **Known risk, flagged rather than hidden**: the JSON shapes `bin/jira.mjs` parses
  (`getIssue`, `createIssue`, `fieldMetadata`, `activeSprintId`) were built against
  `twg --help` and the `--agent-fields` example (`data.items.key`), not a live call —
  no ticket was created or fetched against a real site while building this, to avoid
  touching production Jira data without asking first. Each parser fails loudly with the
  raw output when its guess is wrong (`could not read summary/description from twg's
  JSON: ...`), so a bad shape surfaces on the first real `--ticket` or `--key` use
  rather than silently misreading a ticket. Verify against one real response before
  relying on this in anger, and fix the parser in `bin/jira.mjs` if it's wrong — the
  in-memory adapter and its tests are unaffected either way.
- Org resolution for a Jira fetch (`rig new --key KTLO-42`) is by project-prefix match
  against `rig.json`'s configured orgs (`orgForJiraKey`); an unconfigured project is
  silently not fetched (the old piped-brief flow still works). `--ticket`'s org
  resolution is unchanged from PR 1's `trackerFor` — explicit `--org`, else the only
  live tracker, else a refusal naming `--org`.
