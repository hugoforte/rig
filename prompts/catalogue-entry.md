# Prompt: fill in a catalogue entry

You are correcting a catalogue entry, usually one `rig attach` drafted for a repo it had not seen. What an entry is — its fields, durable facts only, and how `setup` and `check` are written — is `AGENTS.md`'s "The catalogue"; read it there. This is how to fill one in well: from the repo's own evidence, while it is still loaded in your head, and **never fabricate**. An entry that says less and is true is worth more than one that reads well and is a guess.

`rig catalog <repo>` prints the entry and names its file. Edit that file.

## 1. Read the evidence, cheapest first

Read what the repo says about itself, not its source code. Reading code to fill an entry is how an afternoon goes, and an entry the repo's own description cannot fill is a finding, not a reason to read more.

- **Manifests and layout.** `package.json`, `go.mod`, `*.csproj`, `pyproject.toml`, `Cargo.toml`, `Gemfile`, a `Dockerfile` and the like, their lockfiles, and the top two levels of folders.
- **How it is built and verified.** The CI workflows (`.github/workflows/`), `scripts/`, a `Makefile`, the manifest's scripts. What CI runs is the strongest evidence of how the repo is verified.
- **What it is for.** The README, `docs/`, ADRs, CONTRIBUTING, and `gh repo view <org>/<repo> --json description`.
- **What it talks to.** `rig catalog --verbose` for the repos already catalogued, and `rig impact <repo>` for what they say about this one. Then search the manifests and config, not the code, for their names, their packages and their hosts.
- **What happened to it.** The git log, for the next section.

## 2. Fill each field from what you read

- `repo` and `org` are rig's; leave them.
- `stack`: what the manifests show, in the words a person in the org would use.
- `role`: one line, in the org's terms, saying what the repo is for rather than how it is built. "Owns invoices and refunds" beats "a Node service".
- `talks_to`: only a relationship something in the repo shows, each with a one-line `how` saying what passes between them. Give a `direction` only when the evidence says which way a change breaks: absent means unstated, which is not the same as both ways. Where the other end's entry already makes a claim, agree with it or say why not.
- `setup`: how a fresh worktree is made ready, taken from the README or CI's install step.
- `check`: what verifies a change, taken from CI. Run it in the worktree (`rig check <repo> --run`) when that is cheap: a command you ran is confirmed, and one you only read in a workflow is not.
- `docs`: where the user documentation lives, a path in the repo or a page elsewhere, only where one exists.
- The prose: a short paragraph on what the repo is and how a person meets it, then `## Facts worth not rediscovering`.

## 3. The git log gives turning points, never a changelog

A line under `## Facts worth not rediscovering` is something the next agent would otherwise rediscover expensively: a revert and why it was needed, a migration left half done, a module renamed or moved, a dependency pinned after it broke, a test that fails on one machine. Each line cites what it rests on: a sha, a PR, a file. "Added CSV export in v2" is a changelog line and does not belong; the log already has it.

Places to look:

```bash
git log --oneline -50
git log -i --grep='revert\|pin\|workaround\|flaky'
git log --diff-filter=D --stat --oneline     # what was removed, and with what
```

A repo with little history, or none, has no facts yet. Write none: the lesson review adds them as works find them.

## 4. Mark what the evidence does not support

Whatever you could not confirm is written with what you know, and marked, in one of two forms exactly as here, since rig reads them:

- In the frontmatter, a YAML comment on a line of its own, directly above the field it marks: `# unconfirmed: read from CI, not run here` above `check:`. Never at the end of a value's line, where it would become part of the value.
- In the prose, after the sentence: `❓ UNCONFIRMED: <what would settle it>`.

A field with no evidence at all keeps the stub's `TODO` rather than a guess. Once something is confirmed — you ran it, or the user said so — take the marker off, or write `✅ CONFIRMED (<date>)` with the evidence, as `AGENTS.md`'s "Writing a context doc" does.

A repo with no README and no history (a new one) gets its `role` from the work's brief, marked, and its `check` left empty, which `rig check` already names.

## 5. Then

**Keep `DRAFT: unreviewed` while any unconfirmed marker is left in the entry**, and remove that comment only once none is. rig counts a marker as a draft too, so `rig next` keeps offering the correction until the human has confirmed what the evidence could not.

Put each unconfirmed item in your reply's TL;DR as one of the user's action items (`AGENTS.md`'s "Replying to the user"): one question each, answerable in a word, such as "Is `npm test` what verifies billing, or is there an integration suite CI does not run?". **Do not wait for the answers.** Carry on with the work, and fold an answer into the entry whenever it comes.

The next rig command that changes the work commits the entry with the rest of the data root; `rig save -m "catalogue: <repo>"` commits it now.

An entry that is not a draft is corrected the same way, and corrected before it is appended to: a fact that contradicts a sentence replaces the sentence.
