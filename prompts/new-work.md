# Prompt: start a work with its ticket

You are starting a piece of cross-repo work. `rig new` **refuses** on any data root with a
live tracker unless you pass one of `--key`, `--ticket`, or `--no-ticket` — the ticket
decision must be explicit, not left as an empty list nobody chose.

## Which tracker

`rig.json` maps each org to a tracker: `github` (with a `repo`), `jira` (with a `project`,
and per-org create defaults — `type`, `fields`, `board`), `linear` (with a `team`, the
prefix of its issue keys, needed only to create one), or none. `rig doctor` prints the
mapping. The org's tracker decides where a ticket is fetched from and told, never the key's
shape: `PROJ-42` is a Jira key and a Linear key alike. `--org` is only needed when more
than one org has a live tracker: a `--key` resolves its tracker from the key's prefix
automatically, but `--ticket` on its own does not. If `rig new` refuses for exactly this reason ("several orgs have trackers —
pass --org"), **ask the user which org** rather than guessing; it is a fast question and
a wrong guess creates the ticket in the wrong tracker.

## You already have a key

Fetch its title and description yourself only for a GitHub key (`owner/repo#7`) — pipe
them in. A Jira or Linear key (`PROJ-42`) rig fetches itself, from the tracker the org keeps:

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
brief's first paragraph plus a link to the context doc (see "The ticket body" below), so
there is rarely much to adjust.

**Tracker is Jira:**

```
<brief> | rig new <id> --title "<title>" --ticket --org <org> --dry-run
```

Prints the resolved project, type, summary, assignee, every field (sprint resolved through
the org's active sprint, named fields like `components` resolved to their ids), and last
the description in full — the exact markdown the create sends, indented by four spaces.
Present this table. The user confirms, or gives overrides as
`--field name=value,name2=value2` — comma-separated `name=value` pairs; a value that
itself contains a comma (multiple components, say) isn't expressible this way, so change
`rig.json`'s default for that field instead.

If the ticket belongs under an epic, add `--parent <epic key>` to both commands; the preview
shows it as a `parent` line. It is never a `--field` or a `rig.json` default.

**Then, once confirmed, the same command without `--dry-run`** creates it for real, in one
shot:

```
<brief> | rig new <id> --title "<title>" --ticket --org <org> [--field k=v,...] [--parent <epic key>]
```

**Tracker is Linear:**

```
<brief> | rig new <id> --title "<title>" --ticket --org <org> --dry-run
```

Prints the team, the title and the description in full, as Jira's preview does. It needs
the org's `team` in `rig.json`; `--field` and `--parent` are ignored. Without a Linear API
key the create fails and names where one goes (`LINEAR_API_KEY`, or `rig.local.json`'s
`linear.keyFile`); never ask the user for the key in chat.

**No tracker for this org, or a genuine spike that should have no ticket:** confirm with
the user that no ticket is wanted, then:

```
rig new <id> --title "<title>" --no-ticket
```

This records the decision (`Tickets: none (declined)` in the context doc) — distinct from
a work nobody decided about, which `rig new` no longer allows to happen silently.

## The ticket body

Same shape on every tracker; rig writes exactly this, so match it if you ever open one by
hand:

> <the brief>
>
> The design lives in the work record: <link to `work/<id>/context.md` on the default branch>
>
> Opened by `rig new <id> --ticket`.

What differs is how much brief goes in. **GitHub** gets the first paragraph only: the
issue is a pointer and the context doc is one click away for the same reader. **Jira** and
**Linear** get the whole brief, as markdown: their readers may have no access to the data
root the link points at, so the ticket has to stand on its own.

## After

Bind the chat to the work, as `AGENTS.md`'s "Binding the chat" says.

Continue with the repo interview: `rig prompt select-repos`.

Once the repos are attached, name the problem the work addresses. The work's orgs are
its repos' orgs, and `rig status` names each one's org doc or says it has none. Read the
headings each doc has, "What hurts now" and "What we're trying to accomplish" among
them, and tell the user which stated problem this work addresses. When it addresses
none, say so plainly and let the user decide; it is still theirs to do. An org with no
doc has nothing to name.

Then read the earlier works the generated `AGENTS.md` lists under each repo, the ones
whose title bears on this work, before the Direction is written: their context docs and
notes hold what was decided on these repos and why. When an earlier decision bears on this
work, say in the Direction whether it keeps or reverses it; when none does, say nothing.

Once the Direction section
of the context doc is agreed with the user, end that gate with
`rig save -m "design agreed" --designed --adversarial` (or `--no-adversarial`) — rig commits
the data root after its own commands, but the context doc is yours to edit, so this is how
those edits get committed. Ask the user whether the work's PRs get an adversarial review; the
gate refuses without the answer.

The repo set and the design gate are stops a work may skip, when the user said so at the
outset: pass `--stops` to `rig new`. `AGENTS.md`'s "Stops" lists them and says how the agent
records what it decided in their place.

When the work is done, `rig close` comments on every ticket with the PR links, in the tracker
its org keeps. GitHub tickets also close when every PR is merged. Jira and Linear tickets never
auto-close or transition: move it yourself once the comment lands. A ticket whose org tracks
in none is passed over in one line.
