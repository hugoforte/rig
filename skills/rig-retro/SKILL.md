---
name: rig-retro
description: Look back over a period — a month by default — for what keeps going wrong across works, check whether last period's fixes held, and offer each recurring struggle a home. Personal over every agent session on this machine; company over every work's recorded struggles in a data root. Use when `rig next` offers last month's retro, or when asked for a retro, what we keep struggling with, or whether a fix held.
---

# rig-retro

Find the **recurring** struggles of a period — the same correction in five sessions, the same command retried in every repo, the same assumption put right again and again — which no single work's lesson review can see. Then check whether last period's fixes held, offer each struggle a home, and record what was read as struggle rows. Raw sessions never leave the machine; what is kept is the rows, redacted.

Reply as rig's `AGENTS.md`'s "Replying to the user" says. Here the TL;DR in step 4 is that opening, and the user's action item is saying **go**.

## 1. Pin the retro

- **Kind.** *Personal* reads every session on this machine, the ones in no work included. *Company* reads the struggle rows every work in one data root already holds, from every person and machine. With none named, personal.
- **Period.** A calendar month, the last one by default: `--since <first day> --until <first day of the next>`.
- **The root.** Personal: the user's own root, the one whose `rig.json` says `"personal": true` and which has a `retro/` folder; `rig doctor` names each root's path. With none, ask the user which root is theirs alone, and **stop for the answer**: a period's rows go there, and rig refuses them in a root that does not say it is one person's. Once they name it, add `"personal": true` to that root's `rig.json`; the first row commits it. Company: the root the user names; `rig use` lists them.

Say the kind, the period and the root in the first line of the answer.

## 2. What last period said

The previous period's rows are the fixes to check.

- Personal: every file in `<root>/retro/<last month>/`, one per machine, so the other machines' retros count.
- Company: the rows of every `<root>/work/*/struggles.tsv` whose `at` falls in the last period.

A row whose `fix` is not `none` is a fix someone meant to make. Keep its struggle and its fix kind; step 3 says whether it held.

## 3. Read this period

### Personal

```bash
rig sessions --since <first day> --until <first day of the next>
```

One session a line: start, reader, id, `main` or `subagent`, the works it belongs to (`-` for none), path. A session with a `read` row in a work's struggles file (`rig status --work <id>` names it) or in this period's `retro/<month>/` files was read already, by another review or machine: skip it.

**Read the rest through subagents**, about twenty sessions each, never in this thread. Each subagent runs `rig sessions --extract <path>` for each session in its batch, reads the redacted extract, and reports in its reply (a subagent may not be able to write files) one line per struggle:

```text
<session id> · <kind> · <what kept going wrong, one line> · "<quote, 200 characters or fewer>" · <works, or ->
```

The kinds are `correction` (the user stepping in), `repeat` (a command or approach tried again and again), `assumption` (something the agent took as true and had to put right), `denial`, `error` and `limit`. A session with nothing to report gets no line, and is still a session read. Count only what the extract shows. A subagent's own sessions are batched with their parent's.

### Company

Read every `<root>/work/*/struggles.tsv` row whose `at` falls in the period. No subagents: the rows are already the findings. Sessions that belong to no work are in nobody's personal root here, and are left out on purpose.

## 4. Group, check, offer

**Group by theme.** A struggle is **recurring** when it shows up in two sessions or more; the rest go under **Once**, which stays short. A theme carries how many sessions and works it was in, the strongest quote, and the kind of fix it wants.

**Check each fix from step 2**: **held** when the theme does not come back this period, or only before the fix landed; **broke** when it comes back after; say which, with the session that shows it.

Offer each recurring struggle a home as `rig-learn` does — a machine check before prose, never a new rule in an `AGENTS.md` — and **stop for the user**:

```markdown
**TL;DR — do these:**
1. <fix, in one line: what changes, where>
2. <…>

Say **go** for all of them, or name the numbers you want.

**Last period's fixes**
- <struggle> → <fix>: held / broke (<session, when>)

**Recurring**
- <theme>: <n> sessions, <works or "no work"> — "<quote>" → <fix kind>: <what, where>

**Once:** <struggle> (<session>); …

**Rows to record** (on go)
- <session>: <kind> — <struggle> — "<quote>" → <work id or the period>
```

- **Two or three fixes in the TL;DR**, the struggles that cost the most.
- **Every quote is shown before it is recorded.** rig redacts what it recognises as a secret; leave out anything else private, such as a person's name or a customer's.
- A fix to rig itself goes on rig's public tracker: write about rig alone, as `rig-learn` says.

## 5. Record it

On "go", one `rig struggle` per row, the text in single quotes. A struggle in a work's session goes on that work's record; one in a session in no work goes on the period's. Then every session read, struggles or none, gets a `read` row on the period's:

```bash
rig struggle '…' --kind <kind> --session <id> --host <reader> --quote '…' --fix <kind> --work <id>
rig struggle '…' --kind <kind> --session <id> --host <reader> --quote '…' --fix <kind> --period <YYYY-MM> --data <root>
rig struggle --kind read --session <id> --host <reader> --period <YYYY-MM> --data <root>
```

The reader is the second column of `rig sessions`. The period's `read` rows are how the next retro, on this machine or another, and `rig next` know the month was read. Then make the fixes the user said **go** to.

The report itself goes to the chat, or to a file in the OS temp directory when it runs long — never into a data root or a repo.
