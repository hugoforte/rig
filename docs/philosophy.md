# What rig believes

rig grew out of frictions, one at a time, and this page says what those frictions taught. [The timeline](./timeline.md) is the evidence; [DESIGN.md](../DESIGN.md) holds the decisions. This is what the decisions have in common, written so that someone deciding whether and how to use rig can read it in five minutes, and so that the next decision can be checked against it.

It is a living document. A principle here is a strong conviction, loosely held: when a friction changes one, the old wording is struck through with the friction that killed it, never deleted. The last section says how it grows.

## The one idea

The scarce resource in agentic engineering is human attention per accepted change. It is spent three times: choosing what to work on, gathering enough context to execute, and accepting the result. Code got cheap; those three did not. rig exists to spend less of that attention, and it must never spend any of it on rig.

Everything below is one idea about how to do that.

## The principles

### 1. Friction is the roadmap

Every capacity rig has was a felt problem first, never an imagined one. The predecessor tool was designed in one sitting from a workflow nobody had lived, and it was never adopted (DESIGN.md §1.1). rig's entry point is worktrees because worktrees were set up by hand 51 times and a context doc only five, so the doc is scaffolded on the way in rather than asked for (§1.2). Each phase in the timeline is named by the capacity it added, and each capacity has a friction behind it.

The rule that follows: a feature without a friction to cite waits. Ideas are recorded, on the tracker or here, and they earn their place when the friction arrives.

### 2. Trivial to start, deep to master

A great game brings you in with one move and reveals its depth as you go. rig should feel the same. Install is one command. `rig new` asks one decision, the ticket. `rig attach` asks nothing new. Nothing is required up front that the first work does not need. The further in you get, the more rig knows about your repos, your org and your works, and the more it can offer: stages, impact, a rollout plan, a restore on a second machine, a lesson loop at close.

The rule that follows: any new question rig asks must say when it can be skipped, and "you don't have to do this now" is the default, not the exception.

### 3. Guide where you are

`rig next` offers; it never warns and never stops (decision 66). It reads the live state and names what is available from here. Warnings belong to `rig doctor`, which is asked for. A catalogue correction is offered from `next`, not demanded by `close` (decision 92). The lesson review is a gate that is offered, not enforced (decision 105).

The game analogy has a second half: mastery at this level before the next. rig should favour making the current level solid, a repo that runs locally, a catalogue entry a human has reviewed, over offering the next capability. Guidance that runs ahead of where you are is noise.

### 4. Attention is the budget

The human's attention is what rig conserves, so every surface is measured by how much of it it costs. A close never re-asks GitHub what a merged PR did, because the terminal facts were recorded the first time. rig-learn leads with a TL;DR the user can answer with one word (#177), and every lesson line is one line. The demo page makes the case for rig out of a data root so nobody has to make it by hand.

The rule that follows: a feature that saves the agent effort but costs the human a question has the sign wrong.

### 5. Facts in code, judgement in prompts

`bin/` answers what is true: which branch sits on which, whether a PR is open, which repos a change reaches. `prompts/` and `skills/` answer what to do about it, given those facts. The rollout plan's deploy order is generated; its prose is not (decision 73). The phase of a work is derived; only the gates are stored (decision 64).

The seam is deliberate. Code changes with a release and is tested; a prompt changes with an edit and is judged. Judgement that is put into code ossifies before it is understood, and facts left to a prompt drift.

### 6. Evidence over declaration, and dated

A claim rig can prove, it proves, and it records when. A claim it cannot, it marks: a catalogue entry drafted at attach says `DRAFT: unreviewed` until a human corrects it. Weight is derived from what a work contains, never declared (decision 67). The catalogue has a freshness of its own, measured against the mirror and reported without a verdict (decision 93). A reader says what it measured (decision 78).

The rule that follows: anything that must be hand-maintained to stay true will rot (§1.2), so derive it on read, or date it so its staleness is visible.

### 7. Everything accretes

Knowledge enters rig at the moment it is fresh, never through a form filled in up front. A catalogue entry is drafted when a repo is attached and corrected when a work touches it. A lesson is offered a home at close, when the work that taught it is still on disk. A decision is logged when it is made, with its rejected alternatives.

The rule that follows: the question is never "what should we write down about this repo?" but "what did this work just teach about it?"

### 8. Keep it refactorable; don't factor it early

The rule of three, stated as a pair. A seam you can move later is worth more than an abstraction guessed at now, so two similar things are a coincidence and the third names the pattern. What "refactorable" buys is the right to wait: pure modules where the logic is hard, one seam per external system, and no caller composing three steps that one operation should own.

### 9. Strong convictions, loosely held

Decide, write the reason down, then let evidence move you. A superseded decision is struck through and names what replaced it; a refuted hypothesis stays with its date and its evidence. Decision 86 chose a merge queue; decision 89 recorded that GitHub would not give this repository one, and the up-to-date rule stayed. A position with no reason attached cannot be argued out of, and an opinion nobody recorded cannot be corrected.

## What rig asks of an org

rig will ask an org the same questions it answers about itself here, and nothing it would not answer. What are you trying to accomplish? What hurts now? What do you believe about how work should be done? Who decides? An org's answers live in its own data root, they are read by every work, and they grow the same way this page does: from what the works teach, one optional question at close.

## How this page grows

By hand, when a friction changes a belief. And from the lesson loop: rig-learn offers rig's tracker as a home for a lesson about rig in general; a lesson that changed a belief rather than reported a bug belongs here instead. The bar for a new principle is a friction to cite. The bar for removing one is the same.
