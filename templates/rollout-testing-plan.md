# {{KEYS}} — {{TITLE}}: Rollout & Testing Plan

Deploy and test plan. See `context.md` for the design.

> State what must already be live for this to apply — a prerequisite effort, a config
> rollout, a migration. If there is a dependency on another initiative's rollout plan,
> link it here.

## The PRs (deploy order)

{{DEPLOY_ORDER}}

## Why deploy order is mandatory

<!-- One bullet per PR: what it adds that the others depend on, and what breaks if
     the order is violated. If the order is NOT mandatory, delete this section and
     say so explicitly in the table — a reader will assume it matters otherwise. -->

- **#NN first** — _what it adds; what breaks if skipped_.
- **#NN second** — _dependency_.
- **#NN last** — _dependency / fallback_.

### ⚠️ The rejection window (plan around this)

<!-- The period between deploys where the OLD path fails because the NEW validation is
     already live. This section exists because it is the thing that causes real incidents.
     Delete it only if you have actually checked there is no such window. -->

_What goes wrong between deploys, and the numbered mitigation._

## Configuration prerequisites (per tenant)

| Key | Needed for | Notes |
|-----|-----------|-------|
| | | _mint per tenant; verify before cutover_ |

<!-- Plus migrations, new payment types, keys to mint, billers to confirm. -->

## UAT validation

<!-- How to exercise the full chain on realistic data; setup steps; which read-only
     query skills to point at it. -->

### Test matrix

**A. _Component / PR_**

- A1 _scenario_ → _expected_.

**B. _next component_**

- B1 _scenario_ → _expected_.

**End-to-end — the headline scenario**

- _The money test: the real-world failure this fixes, verified end to end._

### UAT sign-off gate

_The concrete conditions that must all hold: which tests pass, which invariant is verified,
error queues clean._

## Production rollout (per-tenant)

1. **P0** — prerequisites (config, migrations verified).
2. **P1 — deploy _PR_**; verify _health check_.
3. **P2 — deploy _PR_**; verify.
4. **P3 — run _sweep/backfill_**; verify reconciliation.
5. **P4** — roll out per remaining tenant.

<!-- Note data corrections that auto-heal will NOT cover (hand to finance, etc.). -->

## Verification queries

_Read-only snippets that confirm parity — source vs target amounts, mismatch counts.
Name the skills and their arguments._

## Rollback

| Component | Rollback | Blast radius |
|-----------|----------|--------------|
| | | _data harm? per-tenant? additive migration?_ |

## Monitoring & sign-off

_Post-deploy metrics (error rates, queue depth, reconciliation = 0), and the final
"a fresh production action flows end-to-end correctly" check._

## Open risks

- **_risk_ (highest):** _why; which test gates it_.

## Status

- {{DATE}}: plan drafted.
