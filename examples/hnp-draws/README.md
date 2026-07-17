# `hnp-draws/` — the human-not-present "doorman" in action (005 seams, preview)

Watch the [PR #41](https://github.com/openmobilehub/credentagent/pull/41) HNP seams decide, with **no web
page and no phone** — a self-contained script that pre-approves a spending limit (an Intent Mandate) via the
**`DelegatedGate`** facade, then has the agent draw good + bad purchases against it, printing what the gate
allows and refuses.

## Run it

```bash
npm run build:packages          # build the two @openmobilehub/credentagent-* packages
node examples/hnp-draws/demo.mjs
```

## What you see

```
🎫  Pre-approved: coffee at blue-bottle, up to $30/order ($100 total). Off to sleep. 😴

  ✅  1 coffee                   $18   approved — $82 of $100 left
  ✅  another coffee (new id)    $18   approved — $64 of $100 left
  ✅  retry c1 (same key — safe) $18   approved — $64 of $100 left   (idempotent: same result, charged once)
  ⛔  3 coffees at once          $54   refused — over-cap   ($54 > $30/order)
  ⛔  coffee — different store   $18   refused — out-of-scope
  ⛔  wine — age-restricted      $20   refused — step-up   (age is never delegable)
  ⛔  1 coffee — after revoke    $18   refused — revoked
```

## What it proves

- **The gate is the doorman, not the agent.** Every draw is re-checked server-side in `completeOrder` —
  bounds (`checkDraw`), revocation, and an **atomic single-use** consume — so a producer reaching the seam
  directly is still fully checked (invariant 1). Refusals are **typed data** (a `code` per failure), not prose.
- **One pre-approval = one purchase.** Reusing a transaction id is refused; two racing draws yield exactly one
  completion.
- **Age is non-delegable.** An age-restricted line always steps up to a live ceremony — a grant can never
  complete it.
- **Revocation is immediate + fail-closed.** Revoke, and the next draw is refused; an unreachable revocation
  store refuses too (never fail-open).

## Honest limits

The wire crypto is **real** (ES256 over the canonical draw; content-addressed `intentId`), but v0.1 has **no
issuer/DeviceKey trust anchor and no per-draw proof-of-possession** — the grant is a bearer instrument,
demo-fenced (`presence: "delegated-demo"`, `trust_level: "server-issued-demo"`), and **no real money moves**.
The user ceremony that seals the bounds on a phone, the HTTP intent rail, and the wallet server that provide a
*real* control are later increments (spec.md Out of Scope). This script is that flow's logic, minus the web.
