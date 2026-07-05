# Quickstart / Validation Guide: Storefront Persistence

**Feature**: 005-storefront-persistence · **Date**: 2026-07-03

How to use the feature and how to prove it works. Full type/behavior detail lives in
[contracts/storefront-storage.api.md](contracts/storefront-storage.api.md) and [data-model.md](data-model.md).

## Usage

### Zero-config (unchanged) — in-memory

```ts
import { createStorefront } from "@openmobilehub/attestomcp-storefront/server";

const store = createStorefront();            // in-memory; no @upstash/redis needed
```

### Production — one option

```ts
import { createStorefront } from "@openmobilehub/attestomcp-storefront/server";
import { redisStorage } from "@openmobilehub/attestomcp-storefront/redis";

const store = createStorefront({
  storage: redisStorage({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
    namespace: "my-shop",                    // isolates keys if multiple shops share one Redis
  }),
});
```

### Escape hatch — mix a custom store

```ts
const store = createStorefront({
  storage: redisStorage({ url, token }),     // cart + orders on Redis
  verificationStore: myCustomStore,          // …but verification on your own backend (wins for that slot)
});
```

## Prerequisites

- Node ≥ 20, the workspace built (`npm run build` at repo root).
- For the **persistent** path only: `@upstash/redis` installed (optional peer dep) and Upstash creds.
- Tests need **neither** — they inject a `Map`-backed fake client.

## Validation scenarios

Run from `packages/attestomcp-storefront`. These map 1:1 to the spec's success criteria.

### V1 — In-memory default still works (SC-003 / FR-002)

```bash
npm run test
```

**Expected**: the full existing suite passes unchanged; a new test asserts `createStorefront()` with no
options builds and serves with `@upstash/redis` absent from the in-memory import graph.

### V2 — Cross-instance round-trip (SC-004 / FR-004)

Build **two** `redisStorage` providers over one shared fake client + same namespace; write cart, created
order, completed order, and verification through provider A; read each back through provider B.

**Expected**: every value read through B equals what A wrote (all four stores).

### V3 — Namespace isolation (SC-005 / FR-007)

Two providers over the same fake client, namespaces `shop-a` and `shop-b`; write the same logical entries
through each.

**Expected**: reads through `shop-a` never return `shop-b`'s data, and vice versa.

### V4 — Per-order isolation / no cross-order bleed (SC-006 / FR-005, Security Inv #4)

Prove verification for order `ORD-X`; read verification for order `ORD-Y`.

**Expected**: `ORD-Y` reads as unverified. **Control test**: removing the `:${orderId}` segment from the
verification key MUST make this test fail (a test that still passes with per-order keying removed is not a
useful test — Constitution / CLAUDE.md).

### V5 — Injected store overrides the provider (SC-007 / FR-006)

`createStorefront({ storage: redisStorage({ client }), orderStore: spyStore })`; drive an order completion.

**Expected**: `spyStore` receives the completed-order write; the provider's order store does not.

### V6 — Fail-closed on backend error (FR-012)

Inject a `client` whose `get`/`set` reject; perform a store op.

**Expected**: the op rejects (error surfaces); `createStorefront` does not silently fall back to in-memory.

### V7 — Missing peer dep error (FR-008 / CT-7)

Call `redisStorage({ url, token })` in an environment where `@upstash/redis` cannot be resolved.

**Expected**: a clear, actionable error naming the missing optional peer dependency (not a generic
module-not-found).

## Build / smoke gate (before "done")

```bash
npm run build        # typecheck + build both packages — must be green
npm run test         # both packages — must be green
```

Per the constitution's deploy-care gate, also run a runtime smoke of the in-memory path
(`createStorefront().listen(...)`) to confirm the added `storage` wiring did not regress startup.
