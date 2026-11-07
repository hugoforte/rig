---
name: rig-pr-page
description: Write a linked reading page for a big pull request, so a reviewer can click through the change instead of reading it top to bottom. Use when `rig next` or `rig pr` offers a reading page, when one needs rebuilding because the PR's head moved past it, or when asked for a reading page for any PR, a colleague's by its URL included.
---

# rig-pr-page

A reading page is one self-contained HTML file for one pull request: its parts and how they connect, how it behaves before and after, what was decided, what is tested, what is at risk, what is open, and every changed file. Everything links both ways, each thing lists what mentions it, browser back works, and a citation opens the exact line at the head. It is a companion to the PR body, and an offer rather than a gate.

You write the judgement: a source file. `build.mjs` and `check.mjs`, beside this file, do the mechanics, and `rig page` publishes.

Reply as rig's `AGENTS.md`'s "Replying to the user" says: the page's URL and the user's action items first.

## 1. Ask rig what this PR is

From the work folder, for the work branch's PR and each open stage PR:

```bash
rig page --json
```

For a PR outside any work, from anywhere:

```bash
rig page https://github.com/<org>/<repo>/pull/<n> --json
```

It answers with one entry a PR: the PR (`url`, `head`, `base`, `branch`), its `size` against its `threshold`, `site`, `why`, `page` (one already recorded), `stale`, and `source`, the file to write. Take the entry for the PR at hand, and write one page per PR.

- **`site` is null: stop.** `why` is the reason there is nowhere to publish, and it says what to change where something can be. Tell the user that one line and write no page: a page goes only to the data root's site, and rig turns no Pages site on for itself.
- **`warning` is set:** the site is public. Tell the user that line before you write anything. Where `site.needsPublicFlag` is true the code is not public, so stop and ask, as step 6 says.
- **`source` is null:** there is no work to keep it with, or the data root is wider than the code. Keep the source in a temporary folder of your own, outside the data root and the work folder.
- **A `source` that exists:** this is a rebuild. Update it for what changed since `page.head`.
- **A branch with no PR yet:** a page is addressed by its PR's number, so open the PR first and write the page before asking for a review.

## 2. Read the change

**Outside a work,** bring the PR's head into a worktree of its own, outside rig's work root (`gh pr checkout <n> --worktree <path>`); that path is `--repo-dir` below.

Read the whole diff (`git diff <merge-base> <head>` in the repo's worktree), its commits, the PR body and the ticket. Read until you can say what each changed file is for. The test: you could tell someone what breaks if this PR is reverted.

**Write for everyone who can read the repo, as for the PR body** (`AGENTS.md`'s "What it says in public"). Even on a private site, what it holds is about code others read, and a page outlives the choice of who reads the site. The page may state only what the diff, the commits, the PR body and a ticket in the same repo already state. The context doc, the notes, other works and private systems inform you and stay out of the page.

## 3. Write the source

One markdown file. Frontmatter, a summary, then entities:

```markdown
---
title: Retries that survive a restart
start: flow/restart, part/queue, risk/replay
---

One short paragraph: what this PR does and why. It may use [[part/journal|links]].

# part/queue: The retry queue
group: Sending
status: changed
uses: journal, clock
files: src/queue.py
aka: RetryQueue, retry queue
sub: Holds what could not be sent yet

Prose, with [[flow/restart]] and {{src/queue.py:12 ~ def enqueue}}.
```

**Kinds.** Write whichever the PR has; a tab with nothing in it is not shown.

| Kind | Tab | What it is | Its keys |
|---|---|---|---|
| `part` | Map | A module or component the PR touches | `status` (`new`, `changed`, `removed`, `unchanged`), `uses` (its connections), `files`, `group` |
| `flow` | Behaviour | How it behaves, told as things happening | `@before`, `@step`, `@after` lines |
| `decision` | Decisions | What was chosen over what, and why | |
| `test` | Tests | What holds the change to its word | |
| `risk` | Risks | What could go wrong, and what then | `pill` (say, `medium`) |
| `open` | Open items | What is not settled at this commit | |
| `word` | Words | A term a reader has to know | |
| `file/<path>` | Files | A note on a changed file | |

Any kind takes `sub`, a one-line description, and `aka`, terms whose first mention in each entity becomes a link. Every changed file gets a `file/` entity from the diff, and every changed markdown file its sections as `sec/<path>#<slug>`, so link them: `[[file/src/queue.py]]`, `[[sec/docs/ops.md#restarting]]`.

**The shape follows the PR:**

- **A code PR** leads with `part`s and `uses`, then a `flow` for each behaviour that changed, with what it did before. Then `test`s and `risk`s.
- **A docs PR** leads with its `sec` entities, which come by themselves. Add `decision`s, `open` items and `word`s, and a `flow` where the document describes something happening.

**Markup.** Paragraphs, lists, tables, code fences, `**bold**`, `` `code` ``, `[text](https://…)`, and:

- `[[kind/id]]` or `[[kind/id|label]]`: a link on the page.
- `{{path:line ~ text}}`: a citation. `text` must be on that line at the head, which is what lets a rebuild catch a line that moved. `{{base:path:line ~ text}}` cites the base, for what the PR removes.
- `@step Title`, then its paragraph, numbers the steps of a `flow`.
- `@before text`, `@after text` and `@note text` are callouts.

**The bar:** the source is written when every changed file is mentioned by something, grouped as one `part` where the changes are mechanical, every `part`'s connections are in `uses`, every behaviour change has a `flow`, and what is unsettled is an `open` item rather than prose. The build lists any file nothing mentions, and the page marks it "not discussed".

## 4. Build it

```bash
node <this skill's folder>/build.mjs <source> --out <tmp>/dist.html --pr <pr.url> --head <pr.head> --base <pr.base> --branch <pr.branch> --repo-dir <worktree>
```

`--repo-dir` must be a checkout of the PR's repo: the build compares its origin, and `rig page --publish` refuses a page whose head is not a commit of that repo. Keep `dist.html` outside the data root and the work folder. A failed build lists every dead link, moved or out-of-range citation, duplicate id and connection to nothing. Fix the source until it builds, and read each `note:` it prints.

## 5. Click through it

```bash
node <this skill's folder>/check.mjs <tmp>/dist.html --shots <tmp>/shots
```

It opens every tab, follows links, goes back and forward, searches, and tries a phone's width. Done when it ends `all good`. Then look at the map and a walkthrough among the screenshots, since the checker cannot tell you the page reads well. With no Chrome it exits 2: tell the user the page was not clicked through.

## 6. Publish and link it

Only when the user asked for the page or `rig next` offered it on a work you are carrying out:

```bash
rig page --publish <tmp>/dist.html
```

`--publish` finds the PR from the page, judges the data root's site again at the write, writes one path on its `gh-pages` branch, and records the page's URL and head on that PR's branch. A site can take a minute to serve a new file.

**`--public` is the person's word, for one page, and never yours.** On a public site, a page of public code goes up with a warning. A page of code that is not public is refused, because a published page cannot be taken back from the internet, and `--public` is what lets it through. Pass it only when the user has told you to publish this page publicly, having seen the warning. A standing delegation, a stop being off or an earlier page is no such word. Without it, report the refusal and leave the page unpublished.

Then the link:

- **The work branch's PR:** `rig pr --refresh` puts it in the body.
- **A stage PR:** `--publish` has already put it in a marked region at the top of the body, and left the rest as written.
- **A PR outside any work:** `rig page <url> --publish <tmp>/dist.html`. It records nothing, writes nothing to the PR, and prints the link. Give the user that line to post: posting it is theirs.
- **`--publish` printed "may not carry that link", on either route:** the site's address may name the data root in a more visible PR. Give the user the line and say so; whether to post it is theirs.

The page is a snapshot of one commit, and says so with a link to what has changed since. When the PR's head moves, `rig next` says so; a rebuild starts again from step 1.
