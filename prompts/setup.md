# Prompt: set rig up on this machine

You are configuring rig for the first time on a machine, or for an org. rig hardcodes
nothing about orgs, trackers or people. The first question decides the rest: **where does
the knowledge live?** Explore, present what you found, confirm, then write.

## Step 1: Explore

Facts, not questions for the user:

- `node <root>/bin/rig.mjs doctor` — what is configured, what it says is missing
- `gh auth status`; `gh api user --jq .login`; `gh api user/orgs --jq '.[].login'`
- **Probe for an existing data repo**: for the user and each org, `gh repo view <owner>/rig-data --json name`.
  `rig-data` is the convention; a hit means the knowledge already exists and this machine
  should join it.
- `git config --global user.email` — the current default identity
- Is `dataRoot` already set in `~/.rig/rig.local.json` (or, on an installation made before
  that was where it lived, in `<root>/rig.local.json`)? If so, and it holds a `rig.json`
  with orgs, this is a **change** (adding an org, fixing a tracker), not a setup: say so
  and only ask about the change.

## Step 2: Ask — the first section decides which others apply

Lead each with the recommended answer so the user can accept it in a word.

**A. Where does the knowledge live?**

- **Join an existing private data repo** — recommended whenever step 1 found one, and
  the right answer for a second machine or a teammate. Its `rig.json` already names the
  orgs and trackers; its catalogue is already there. Nothing org-level gets asked.
- **Create a new private data repo** — `owner/rig-data`, under an org when a team will
  share it, under the user otherwise. rig creates it and makes its first commit.
- **Local only** — a directory beside the tool, `git init`ed, no remote. Fine for a solo
  trial; it can be pushed to a private repo later.

The tool checkout itself is never the data root: with the tool public, knowledge inside
its tree is one `git add` from a leak. `doctor` reports that layout as not set up.

**B. Orgs** — *create and local only.* Which GitHub orgs (or users) does work span?
Propose the ones `gh` can see that look like work.

**C. Tracker, per org** — *create and local only.* GitHub Issues (`owner/repo` that holds
them), Jira (project key, upper case; rig reaches Jira through `twg`, which must be on PATH), or none.

**D. Identity** — every path. The commit email for org repos, per machine. A personal org
keeps the global default.

**E. Work root** — every path. `D:\w` (or `%USERPROFILE%\w`) unless there is a reason.

## Step 3: Confirm and write

One command, one line. Join:

```
node <root>/bin/rig.mjs init --data-repo acme/rig-data --email you@acme.example [--work-root D:\w]
```

Create (the repo does not exist yet — the same flag creates it) or local:

```
node <root>/bin/rig.mjs init --data-repo acme/rig-data --orgs acme,acme-labs --tracker acme=jira:PROJ,acme-labs=github:acme-labs/platform --email you@acme.example
node <root>/bin/rig.mjs init --data-root ..\rig-data --orgs acme --tracker acme=none --email you@acme.example
```

`--data-repo` clones or creates beside the tool and sets `dataRoot`; `--orgs` adds to and
`--tracker` merges into `rig.json` in the data root; `--email`, `--work-root` and
`--data-root` write `rig.local.json`, filling only what is missing when it exists. Then
`rig doctor` must come back clean — it also reports whether the data root has anything
uncommitted or unpushed.

## Step 4: Check the org-level half landed

`init` commits `rig.json` into the data root itself (`rig init: rig.json`), stamped with the
record format it wrote (`writtenBy`), and pushes it when the data root has an upstream; the
last line it prints says which. After **join**,
nothing to commit. Nothing to do by hand unless that line warned.

Re-run this prompt to add an org or change a tracker: `--orgs` adds (never removes),
`--tracker` replaces only the orgs it names, `rig.local.json` gains only what it lacks.
To drop an org, edit `rig.json` by hand.
