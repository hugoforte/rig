# Prompt: select the repos for a work

You are choosing which repositories a piece of cross-repo work will touch.

## Inputs

1. The work's title and brief (given to you by the user or fetched from Jira).
2. The catalogue index — run:

   ```
   rig catalog              # one line per repo: name, org, role
   rig catalog --verbose    # also prints talks_to edges
   ```

   Pull the full body of an entry only when you need it:

   ```
   rig catalog <repo>
   ```

## Hard rules

**Use the catalogue only. Do not read repo source code, and do not clone anything to
look around.** This is deliberate. Reading code would make the interview slow and
expensive, and — worse — it would paper over a thin catalogue, so the pain that drives
you to improve the catalogue never arrives. If the catalogue can't answer the question,
that is a finding: say so, and say which entry needs work.

**Traverse `talks_to` explicitly.** For every repo you select, look at its `talks_to`
neighbours and state, for each one, whether it is in scope and why. Cross-repo work is
graph traversal; the repo you forget is almost always one hop from a repo you remembered.

**Err inclusive.** The failure that costs real time is a *missing* repo discovered on day
two, not a spare worktree. When genuinely unsure, include it and say why you're unsure.

## Output

Three parts, in this order.

### 1. Selected

A ranked list. One line of reasoning each — what this repo contributes to *this* work,
not what the repo is in general.

```
1. billing       — owns Invoice/Refund; the retry logic that double-charges lives here
2. orders-api    — emits the OrderReturned event that triggers the refund
3. orders-web    — the returns screen where the customer sees the duplicate charge
```

### 2. Considered and excluded

Every repo you looked at and rejected, with the reason. This list is what lets the user
catch your miss in one glance — it is not optional, and "nothing else was relevant" is
not an acceptable value for it.

```
- pos-desktop    — takes in-store returns, but those never reach the online refund path
- warehouse      — reads return state but has no write path into billing
```

### 3. If this turns out to touch X

One or two lines naming the repos that would come into scope under a specific, plausible
turn the investigation could take. This is how day-two discoveries get anticipated.

```
If the duplicate turns out to originate in the in-store returns sync rather than the
online path, pos-desktop comes in scope.
```

## Then

Present the three parts and **stop**. The user confirms or edits the set. Only after that:

```
rig attach <repo>        # one per selected repo, or --repos a,b,c on rig new
```

The repo set is mutable — attaching a fourth repo on day two is normal and expected, not
a sign the interview failed.
