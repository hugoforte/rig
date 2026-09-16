# Prompt: start a work with its ticket

You are starting a piece of cross-repo work. `rig new` **refuses** on any data root with a
live tracker unless you pass one of `--key`, `--ticket`, or `--no-ticket` — the ticket
decision must be explicit, not left as an empty list nobody chose.

## Which tracker

`rig.json` maps each org to a tracker: `github` (with a `repo`), `jira` (with a `project`,
and per-org create defaults — `type`, `fields`, `board`), or none. `rig doctor` prints the
mapping. `--org` is only needed when more than one org has a live tracker: a Jira `--key`
resolves its org from the key's project prefix automatically, but `--ticket` on its own
does not. If `rig new` refuses for exactly this reason ("several orgs have trackers —
pass --org"), **ask the user which org** rather than guessing; it is a fast question and
a wrong guess creates the ticket in the wrong tracker.

## You already have a key

Fetch its title and description yourself only for a GitHub key (`owner/repo#7`) — pipe
them in. A Jira key (`PROJ-42`) rig fetches itself:

```
<description> | rig new <id> --title "<title>" --key owner/repo#7
rig new <id> --key PROJ-42                       # no pipe needed; rig fetches the brief
```

Override what rig fetched by passing `--title`/piping a brief anyway — an explicit value
always wins over the fetched one.

## No key yet: present the defaults, then stop

Do not create a ticket on the strength of a guess. Resolve what `rig new --ticket` would
do, present it, and **stop for the user's decision** — same shape as the repo-selection
interview (`rig prompt select-repos`).

**Tracker is GitHub:**

```
<brief> | rig new <id> --title "<title>" --ticket --org <org> --dry-run
```

Prints the issue title and thin body it would open. Present it; the ticket is just the
brief's first paragraph plus a link to the context doc, so there is rarely much to adjust.

**Tracker is Jira:**

```
<brief> | rig new <id> --title "<title>" --ticket --org <org> --dry-run
```

Prints the resolved project, type, summary, description, assignee, and every field
(sprint resolved through the org's active sprint, named fields like `components` resolved
to their ids). Present this table. The user confirms, or gives overrides as
`--field name=value,name2=value2` — comma-separated `name=value` pairs; a value that
itself contains a comma (multiple components, say) isn't expressible this way, so change
`rig.json`'s default for that field instead.

**Then, once confirmed, the same command without `--dry-run`** creates it for real, in one
shot:

```
<brief> | rig new <id> --title "<title>" --ticket --org <org> [--field k=v,...]
```

**No tracker for this org, or a genuine spike that should have no ticket:** confirm with
the user that no ticket is wanted, then:

```
rig new <id> --title "<title>" --no-ticket
```

This records the decision (`Tickets: none (declined)` in the context doc) — distinct from
a work nobody decided about, which `rig new` no longer allows to happen silently.

## The GitHub ticket body

One paragraph, and the link. Rig writes exactly this; match it if you ever open one by
hand:

> <one paragraph: the problem, in the words of the brief>
>
> The design lives in the work record: <link to `work/<id>/context.md` on the default branch>

## After

Continue with the repo interview: `rig prompt select-repos`. When the work is done,
`rig close` comments on every ticket with the PR links. GitHub tickets also close when
every PR is merged. Jira tickets never auto-close or transition — move it yourself once
the comment lands.
