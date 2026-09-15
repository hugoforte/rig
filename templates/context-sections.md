# Context doc — the full section catalogue

`rig new` scaffolds only **Repos**, **Problem**, **Direction**, and **Status**. Everything
below is available to add to a work's `context.md` *when there is content for it* — never as
an empty stub.

This is the generalization of a 28 KB hand-written cross-repo doc that proved the shape,
inherited near-wholesale from the template a previous workspace repo extracted from it. Keep
the section order below; it reads as an argument.

---

## Repos

| Repo | Remote | Role in this work |
|------|--------|-------------------|

<!-- Name + remote, never an absolute path. Note sibling dirs to IGNORE, if any. -->

## Problem

<!-- One line, then the narrative. State scope explicitly. -->

## Direction

<!-- Why this approach; why NOT the adjacent effort. This section earns its keep:
     the best doc this template came from opens with a comparison table against its
     sibling effort, and it is the single most useful paragraph in the file. Link related docs. -->

## Target architecture

<!-- Design plus an ASCII cross-repo data-flow diagram. List what is REUSED vs new.
     The diagram is the artifact people come back for — draw it even when it feels obvious.

     pos-desktop                 orders-api                    orders bus               billing
       Return.confirm  ──HTTP──▶  POST /api/returns/…  ──▶  OrderReturned handler  ──▶  POST /api/refunds
-->

## Key data points

<!-- Tables/columns, config keys, endpoints, idempotency keys — expensive-to-rediscover
     facts. This is the section that must outlive the worktrees by years. Be specific:
     "Refund.Status (0 = pending, 1 = settled, 2 = reversed)", not "the refunds table". -->

## Open questions / design decisions

<!-- Numbered, and each one carries a LEANING plus reasoning, not just a question.
     Resolve before building. Annotate inline as they resolve:
       ✅ CONFIRMED (YYYY-MM-DD) — <evidence>
       ❌ REFUTED by data (YYYY-MM-DD) — <what the data actually said>
     Keep refuted hypotheses in place. The record of what you believed and why you
     stopped believing it is worth more than a tidy final answer. -->

1. _question_ — _leaning + reasoning_

## Sequencing & dependencies

<!-- Build/deploy ORDER across repos and WHY. Call out any hazard/rejection window
     and its mitigation. -->

Deploy order: _Repo #NN → Repo #NN → Repo #NN_

## Verification

<!-- Parity / idempotency checks, the headline "money test", read-only query snippets.
     Name the skills and their arguments. -->

## Decisions log

<!-- Date + decision + reasoning, so it doesn't get re-litigated. -->

- YYYY-MM-DD: _decision + reasoning_

## Status / Next steps

- YYYY-MM-DD: _what happened_
- PRs (deploy order matters):
  - _Repo_ #NN — _summary_ · _build/test state_
- [ ] _next step_

## Related / follow-on

<!-- Sibling efforts, rollout plans, follow-on tickets. -->

---

## Deliberately absent: a Branches table

The previous template had one. It rotted, along with `repos.json` and the README's
"Active features" table, for the same reason: a human had to remember to update it.

Branch, base, ahead/behind, and PR state are **derived** — `rig status`. Never paste them
into the doc.
