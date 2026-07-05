# Phase 1 Data Model: Storefront First-Class Persistence

**Feature**: 005-storefront-persistence · **Date**: 2026-07-03

This feature adds **no new domain data**. It persists the four state objects `createStorefront` already
manages, and introduces two small **configuration/provider** types. Existing store contracts are reused
verbatim.

## Reused entities (unchanged — for reference)

| Entity | Contract | Shape | Source |
| :-- | :-- | :-- | :-- |
| Working cart | `CartStore` | `Map<productId, qty>` | [state.ts:7](../../packages/attestomcp-storefront/src/state.ts) |
| Created order | `OrderStore<Order>` | `Order` (id, lines, totals, createdAt) | [state.ts:25](../../packages/attestomcp-storefront/src/state.ts) · [index.ts:71](../../packages/attestomcp-storefront/src/index.ts) |
| Completed order | `OrderStore<CompletedOrderRecord>` | orderId, amount, currency, method, completedAt, … | [server.ts:116](../../packages/attestomcp-storefront/src/server.ts) |
| Verification | `VerificationStore` | `VerificationRecord` (ageVerified?, loyalty?, `[credentialId]`) | [types.ts:141](../../packages/attestomcp-gate/src/types.ts) |

**Keying rule (invariant):** the created-order, completed-order, and verification stores are keyed by
**order id**. The cart store is a single working cart per storefront instance (no id). `namespace` scopes
all four.

## New types

### `StorageProvider`

A bundle of the four constructed stores. `createStorefront` reads each slot from it when no explicit store
is injected.

| Field | Type | Notes |
| :-- | :-- | :-- |
| `cartStore` | `CartStore` | working cart |
| `createdOrderStore` | `OrderStore<Order>` | created-but-not-completed orders |
| `orderStore` | `OrderStore<CompletedOrderRecord>` | completed orders |
| `verificationStore` | `VerificationStore` | per-order proof state |

- **Relationships**: consumed by `StorefrontOptions.storage`. Produced by `redisStorage()` (and, in
  principle, any future provider).
- **Validation**: all four fields present. A provider is all-or-nothing at the type level; per-slot
  *override* is done by the consumer via explicit `StorefrontOptions.cartStore` etc., not by a partial
  provider.

### `RedisStorageOptions`

Input to the `redisStorage()` factory.

| Field | Type | Required | Default | Notes |
| :-- | :-- | :-- | :-- | :-- |
| `url` | `string` | one of `url`+`token` **or** `client` | — | Upstash REST URL |
| `token` | `string` | with `url` | — | Upstash REST token |
| `client` | `RedisLike` | alternative to `url`+`token` | — | inject a pre-built / fake client (tests, custom) |
| `namespace` | `string` | no | `"attestomcp-storefront"` | key prefix for tenant isolation |

- **Validation**: exactly one of (`url`+`token`) or `client` must be supplied. If neither, throw a clear
  error. If `url`+`token` given but `@upstash/redis` is not installed, throw an actionable error naming the
  missing peer dependency (FR-008).

### `RedisLike` (peer surface)

The minimal slice of the Upstash client the adapters use. Documents the exact contract and enables the
injectable test seam (R6).

| Method | Signature | Used by |
| :-- | :-- | :-- |
| `get` | `<T>(key: string) => Promise<T \| null>` | all reads |
| `set` | `(key: string, value: unknown) => Promise<unknown>` | all writes |
| `del` | `(key: string) => Promise<unknown>` | `clear()` on order/verification stores |

## Key schema (persisted form)

```text
${namespace}:cart                              -> { [productId]: qty }        (JSON object; Map at boundary)
${namespace}:order:created:${orderId}          -> Order                       (JSON)
${namespace}:order:completed:${orderId}        -> CompletedOrderRecord        (JSON)
${namespace}:verification:${orderId}           -> VerificationRecord          (JSON, full record)
```

Missing-key reads return the contract's empty value: cart → `new Map()`, order stores → `null`,
verification → the record's absent/`undefined` (callers already handle `undefined`).

## State transitions (unchanged by this feature)

The persistence layer does not alter any lifecycle; it only changes **where** state lives. For reference,
the existing flow the stores support:

```text
cart:         (empty) → add/set/remove items → priced at checkout
created order: createOrder(id) → written to createdOrderStore → read by checkout page / place-order
verification: ceremony proves age/loyalty → merged at call site → written (full record) per orderId
completed order: completeOrder() re-prices + enforces gates → written to orderStore → read by get-order-status
```

Swapping the backend MUST NOT change any transition or gate outcome (FR-010).
