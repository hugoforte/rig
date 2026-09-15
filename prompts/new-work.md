# Prompt: start a work with its ticket

You are starting a piece of cross-repo work. Every work should have a ticket in the org's
tracker, and the ticket should exist *before* `rig new`, because `rig new` records the key
and derives the branch from it.

## Which tracker

`rig.json` maps each org to a tracker: `github` (with a `repo`), `jira` (with a `project`),
or none. `rig doctor` prints the mapping.

## Branches

**The user gives you a ticket key** (`PROJ-42`, `owner/repo#7`): fetch its title and
description with your tooling, and pass both on:

```
<description> | rig new <id> --title "<title>" --key <KEY>
```

**No ticket yet, tracker is GitHub:** let rig create it. The brief's first paragraph becomes
the issue body, plus a link to the context doc. Nothing else goes in the issue: the issue is
the ticket, the context doc is the design.

```
<brief> | rig new <id> --title "<title>" --ticket [--org <org>]
```

`--org` is only needed when more than one org has a tracker configured.

**No ticket yet, tracker is Jira:** rig does not talk to Jira. Create the ticket with your
Jira tooling — title, a one-paragraph description — then run the `--key` form above with
the new key.

**No tracker for the org, or a spike that should not have a ticket:** plain `rig new`; the
record shows `Tickets: _none_`. That is a valid state, not a gap to fill.

## The ticket body

One paragraph, and the link. Rig writes exactly this for GitHub; write the same for Jira:

> <one paragraph: the problem, in the words of the brief>
>
> The design lives in the work record: <link to `work/<id>/context.md` on the default branch>

## After

Continue with the repo interview: `rig prompt select-repos`. When the work is done,
`rig close` comments on GitHub tickets with the PR links, and closes them when every PR is
merged. Jira tickets are yours to transition.
