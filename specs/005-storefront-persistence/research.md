# Phase 0 Research: Storefront First-Class Persistence

**Feature**: 005-storefront-persistence · **Date**: 2026-07-03

All items below started as decisions the spec deferred to planning. There were **no `NEEDS CLARIFICATION`
markers** in the Technical Context; these are design resolutions, each grounded in the existing code.

---

## R1 — How is the provider shaped, and how does per-slot precedence work?

**Decision**: `storage` is a `StorageProvider` object exposing the four already-constructed stores:
`{ cartStore, createdOrderStore, orderStore, verificationStore }`. `redisStorage(opts)` returns one.
`createStorefront` resolves each slot independently:

```
const cartStore = opts.cartStore ?? opts.storage?.cartStore ?? new MemoryCartStore();
```

**Rationale**: This is the smallest change to [server.ts:206](../../packages/attestomcp-storefront/src/server.ts) — the
four `opts.X ?? new MemoryX()` lines each gain one `?? opts.storage?.X` term. It gives FR-006 per-slot
precedence (explicit wins, then provider, then memory) for free, and keeps `createStorefront` ignorant of
Redis. A provider that returns *constructed stores* (not a factory of factories) is the simplest thing that
satisfies "builds all four internally."

**Alternatives considered**: (a) `storage` as a discriminated union string (`"redis"`) with credentials
alongside — rejected: pushes backend-specific fields into `StorefrontOptions` and doesn't extend to other
backends. (b) A provider with `build(slot)` methods — rejected: more surface for no gain; the four stores
are cheap to construct eagerly.

---

## R2 — How do we keep `@upstash/redis` optional and off the in-memory path?

**Decision**: Put all Redis code in a new `src/redis.ts` reached **only** via a new package export subpath
`@openmobilehub/attestomcp-storefront/redis`. Declare `@upstash/redis` as an **optional `peerDependency`**
(`peerDependenciesMeta: { "@upstash/redis": { optional: true } }`) plus a `devDependency` for typecheck and
tests. `server.ts` / `./server` import only the **type** `StorageProvider` (from `state.ts`), never
`redis.ts`, so importing the storefront server never pulls in `@upstash/redis`.

**Rationale**: Satisfies FR-002/FR-008 (lean in-memory install; dep not on the default path). A subpath
export is a cleaner isolation boundary than a lazy `import()` inside `server.ts`, and it typechecks
normally. `sideEffects: false` is already set, so bundlers tree-shake the unused subpath.

**Alternatives considered**: (a) Static `import { Redis } from "@upstash/redis"` at the top of `server.ts`
— rejected: forces the dep onto every consumer. (b) Dynamic `await import("@upstash/redis")` inside a
factory in `server.ts` — rejected: makes `createStorefront` async-tainted and is harder to typecheck than a
dedicated module. (c) Re-export `redisStorage` from `./server` — rejected: would drag the upstash import
into the server entry's module graph.

---

## R3 — Key scheme and namespace isolation

**Decision**: All keys are `${namespace}:${kind}:${id}` (cart has no id). Concretely:

| Store | Key | Value shape |
| :-- | :-- | :-- |
| cart | `${ns}:cart` | JSON object (`Record<productId, qty>`) |
| created-order | `${ns}:order:created:${orderId}` | `Order` JSON |
| completed-order | `${ns}:order:completed:${orderId}` | `CompletedOrderRecord` JSON |
| verification | `${ns}:verification:${orderId}` | `VerificationRecord` JSON |

`namespace` defaults to `"attestomcp-storefront"` when omitted (single-tenant common case). Two providers
with different namespaces over one backend cannot collide (FR-007); order/verification keys embed the order
id (FR-005, Security Inv #4).

**Rationale**: Mirrors the demo's proven `product-picker:<kind>:<id>` scheme but with a caller-controlled
namespace. Splitting `order:created` vs `order:completed` matches the two distinct `OrderStore` slots
`createStorefront` uses today ([server.ts:210-213](../../packages/attestomcp-storefront/src/server.ts)).

**Alternatives considered**: Redis hash tags / separate logical DBs per tenant — rejected: over-engineered;
a namespace prefix is sufficient and portable across Upstash plans.

---

## R4 — Serialization (Map vs JSON)

**Decision**: `@upstash/redis` serializes JSON values automatically on `get`/`set`, so orders and the
verification record store/read as-is. The **cart** is a `Map<string, number>`, which is not JSON — the cart
adapter converts on the boundary: `Object.fromEntries(map)` on write, `new Map(Object.entries(obj ?? {}))`
on read. Reads of a missing key return the correct empty value (`new Map()`, `null`, or `defaults()`).

**Rationale**: Matches the exact conversion the demo's `RedisCartStore` uses and keeps the `CartStore`
contract (`read(): Promise<Map>`) intact.

**Alternatives considered**: Store the cart as a Redis hash (`HSET`) — rejected: more calls, no benefit at
this cart size, and diverges from the single-value get/set shape of the other stores.

---

## R5 — Verification store: merge vs full-record write

**Decision**: The Redis verification adapter is a **plain per-order `get`/`set` of the full
`VerificationRecord`** — no internal read-modify-write merge. Field merging already happens at the ceremony
call site (`{ ...prev, ageVerified: true }`,
[credential-gate/routes.ts:91-95](../../packages/attestomcp-gate/src/ceremony/credential-gate/routes.ts)),
which reads then writes the whole record. The isolation guarantee is **per-order keying**, not adapter-level
merge (matches `MemoryVerificationStore` in the gate, which also just `set`s the full record).

**Rationale**: FR-009. The gate's `VerificationStore.write(orderId, record)` contract is full-record
overwrite; the adapter must match it, not the demo's `write(orderId, patch)` signature (the demo merges
internally because *its* callers pass partials — a different contract we are not adopting).

**Alternatives considered**: Re-implement the demo's internal merge — rejected: wrong contract for this
library and would double-merge.

---

## R6 — Testability without a live Redis

**Decision**: `redisStorage` accepts **either** `{ url, token, namespace }` (constructs `new Redis(...)`
internally) **or** an injected `{ client, namespace }` where `client` satisfies a minimal
`RedisLike = { get, set, del }`. Tests pass a single `Map`-backed fake `client`; building **two** providers
over the **same** fake client simulates two serverless instances sharing one backend.

**Rationale**: Enables deterministic, offline tests for every acceptance criterion:
- **Round-trip (SC-004)**: two providers, same client + namespace → write on A, read on B.
- **Namespace isolation (SC-005)**: two providers, same client, different namespaces → no cross-read.
- **Per-order bypass (SC-006)**: verify order X, read order Y → not verified; delete the `:${orderId}`
  segment from the key and the test must start failing.
- **Override precedence (SC-007)**: `createStorefront({ storage, orderStore: spy })` → spy gets the write.
- **In-memory default (FR-002)**: `createStorefront()` with no options and upstash absent → still works.

`RedisLike` also documents the exact Upstash surface used (three methods), making the peer contract explicit.

**Alternatives considered**: `@upstash/redis`'s own mock / a live test container — rejected: adds a network
/ infra dependency to unit tests and hides the tiny surface actually used.

---

## R7 — Failure behavior when the backend is unreachable

**Decision**: Fail-closed. A `get`/`set`/`del` rejection propagates to the caller (the store method
rejects); `createStorefront` does **not** catch it and fall back to in-memory.

**Rationale**: FR-012. A silent in-memory fallback on a multi-instance deploy reintroduces exactly the
cross-instance bug this feature removes, and would do so invisibly. Surfacing the error is the safer,
more debuggable default.

**Alternatives considered**: Fallback-to-memory with a warning — rejected: masks production breakage and
violates the intent of opting into persistence.

---

## R8 — New type exports required

**Decision**: Export `CartStore`, `OrderStore`, `StorageProvider`, and `RedisStorageOptions` from the
package. `CartStore` / `OrderStore` live in `state.ts` today but are **not** currently re-exported
([server.ts](../../packages/attestomcp-storefront/src/server.ts) imports them without re-export), so
consumers can only rely on structural typing. `VerificationStore` is already exported by the gate.

**Rationale**: For a first-class API a consumer should be able to `import type { StorageProvider }` and,
for the escape hatch, `import type { CartStore, OrderStore }`. Small additive export surface, no behavior
change.

**Alternatives considered**: Leave types unexported (structural only) — rejected: undercuts the
"first-class, Stripe-grade" goal (Principle I) and the escape-hatch story (US3).

---

## Summary of decisions

| # | Decision |
| :-- | :-- |
| R1 | `StorageProvider` = the four constructed stores; per-slot resolution `explicit ?? storage ?? memory`. |
| R2 | Redis code in `src/redis.ts` behind a `./redis` subpath; `@upstash/redis` optional peer dep. |
| R3 | Keys `${namespace}:${kind}:${id}`; namespace default `attestomcp-storefront`; order/verification carry order id. |
| R4 | Auto-JSON via upstash; cart converts `Map`↔object at the boundary. |
| R5 | Verification adapter = full-record get/set (merge stays at the ceremony call site). |
| R6 | Injectable `RedisLike` (`get`/`set`/`del`) seam for deterministic offline tests. |
| R7 | Fail-closed on backend errors; no silent in-memory fallback. |
| R8 | Export `CartStore`, `OrderStore`, `StorageProvider`, `RedisStorageOptions`. |
