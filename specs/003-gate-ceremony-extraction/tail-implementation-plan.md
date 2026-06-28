# 003 Tail — "demo consumes mount()" implementation plan

**Date:** 2026-06-28
**Status:** plan (needs maintainer decisions before execution — see "Decisions")
**Remaining tasks:** T014, T019, T023 (demo consumes `mount()`), T025 (payment-gate → shims), T027–T029.

## Why this wasn't executed unattended

The package-composition half of 003 is **done and live**: `createStorefront()` + `attesto.mount(store.app)`
+ `store.gate(...)` serves the full ceremony (verified end-to-end on the preview alias). The remaining tail —
making the **committed root demo** a thin consumer of `mount()` and collapsing `payment-gate/` to shims — is
**not a mechanical change**. It is entangled enough that doing it unattended would break the suite (violating
the "green at every commit" rule). The entanglements:

1. **Transport mismatch.** The demo carries the order as an **unsigned token** (`encodeOrder`/`decodeOrder`,
   `checkout.ts:65,69`); the package resolves an order **by id from a store** (`resolveOrder`, `mount.ts:148`).
   A demo-on-`mount()` must adopt one transport.
2. **Route naming.** The demo serves `/payment-gate/*` + `/credential-gate/*`; the package serves `/attesto/*`.
   ~3 demo test files (`app.test.ts`, `checkout.test.ts`, `checkout-gate.test.ts`) plus the ~28 `payment-gate/**`
   test files pin the demo routes/pages.
3. **UX divergence.** The demo's `payment-gate/*/page.ts` are the *original* pages; the package's are the
   restyled (teal, settling bar, completion handoff) pages. Collapsing to shims (T025) adopts the package UX —
   good (one implementation) — but changes demo page strings that demo tests assert.
4. **Prod surface.** The committed entrypoint serves the **production demo** at `mcp-apps-nine.vercel.app`
   (per CLAUDE.md). Cutting it over to the composition is a real prod change that must be a deliberate,
   reviewed deploy — never an unattended one.

## Decisions needed (maintainer)

- **D-A — Order transport.** Make the demo a true `createStorefront()` + `mount()` consumer (inherits id+store
  transport, exactly like the preview entrypoint `api/index.ts` swap), **or** teach the package's `resolveOrder`
  a token-decode path so the demo keeps `encodeOrder`. **Recommendation:** the former — the demo *becomes* the
  composition (one transport, one implementation); the token retires with the demo's bespoke routes.
- **D-B — Routes.** Accept the demo's routes moving to `/attesto/*` (retarget the ~3 app/checkout test files +
  the discovery manifest `attesto-discovery.ts`), **or** add `/payment-gate/*` → `/attesto/*` back-compat
  aliases. **Recommendation:** move to `/attesto/*`; aliases are tech debt for a demo.
- **D-C — `payment-gate/` (T025).** Collapse each module to a thin re-export of the package
  (`export * from "@openmobilehub/attesto-gate/..."`), **or** delete outright once nothing imports it.
  `rm`/`git rm` is sandbox-blocked here, so deletion is a steered step. **Recommendation:** delete; the
  package is the single source. The ~28 `payment-gate/**` tests are then **superseded** by the package's own
  tests (which already cover the same crypto/gates, restyled) — remove them rather than retarget.
- **D-D — End state.** Cleanest: **the committed `api/index.ts` becomes the composition permanently** (the
  preview *is* the demo), `app.ts`'s bespoke demo routes + `payment-gate/` retire, and the prod alias
  `mcp-apps-nine` is cut over in a deliberate reviewed deploy. Confirm this is the target before executing.

## Recommended sequencing (smallest green steps)

1. **Land the composition entrypoint as a committed, non-default file** (e.g. `api/storefront.ts`) so the
   preview stops needing the deploy-time swap (the recipe currently reconstructs it each deploy). Prod stays
   the demo. *Low risk, green, reversible.* (Optional but removes the swap toil.)
2. **D-A/D-B cutover (behind the decision):** point the committed entrypoint at the composition; retarget
   `app.test.ts` / `checkout.test.ts` / `checkout-gate.test.ts` / `instant-demo-honesty.test.ts` /
   `attesto-discovery.test.ts` to the `/attesto/*` routes + id transport. Run full suite; fix until green.
3. **T025 (D-C):** delete `payment-gate/**` (source + the ~28 tests) once `app.ts` no longer imports it;
   confirm no dead imports; the package tests are the replacement coverage. Full suite green.
4. **T027:** re-point the preview alias from the now-committed entrypoint (no swap); smoke the serverless
   instance-split (options→verify, place-order→poll) on `attesto-storefront.vercel.app`.
5. **Prod cutover (separate, explicit, reviewed):** deploy the composition to `mcp-apps-nine` **only** with
   maintainer sign-off. This is the one step that touches the production demo origin.
6. **T028/T029:** reconcile the 002 quickstart `mount()` comment, document the no-GUI/Goose host limitation,
   final green gate (no new skips; every bypass test fails with its control removed).

## Test-impact inventory

| Surface | Disposition |
| :-- | :-- |
| `app.test.ts`, `checkout.test.ts`, `checkout-gate.test.ts`, `instant-demo-honesty.test.ts`, `attesto-discovery.test.ts` | **retarget** to `/attesto/*` + id transport (or delete if the demo fully becomes the storefront's tests) |
| `payment-gate/**/*.test.ts` (~28) | **superseded** by the package's `packages/attesto-gate/**` tests → delete with the source (D-C) |
| `packages/attesto-*/**` tests | unchanged — already the source of truth |
| `storefront-gate.test.ts` | unchanged — already drives the composed `mount()` path |

## Risk register

- **Prod demo regression** (`mcp-apps-nine`) — mitigated by making the cutover a separate, explicit, reviewed
  deploy (step 5), never bundled with the refactor.
- **Lost coverage** when deleting `payment-gate/**` tests — mitigated by confirming the package tests cover each
  deleted assertion (crypto round-trips, gate bypasses, honesty) before removal.
- **Token-bound external links** — any doc/QR pointing at `/credential-gate/*` or an `encodeOrder` token breaks
  on cutover; grep + update before step 5.
