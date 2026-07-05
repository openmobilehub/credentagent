# Feature Specification: Storefront First-Class Persistence (`redisStorage`)

**Feature Branch**: `005-storefront-persistence`

**Created**: 2026-07-03

**Status**: Draft

**Input**: GitHub issue [#27](https://github.com/openmobilehub/attestomcp/issues/27) (part of epic #29) — "createStorefront: first-class persistence (redis option) so consumers don't hand-write store adapters". Labels: `enhancement`, `dx`.

## Overview

`createStorefront()` (from `@openmobilehub/attestomcp-storefront`) stands up a runnable MCP shopping server around four pieces of mutable state: the working **cart**, **created-but-not-completed orders**, **completed orders**, and per-order **verification** state (age proven / loyalty applied). Today each of these defaults to an **in-memory** store. In-memory is correct for local dev and the quickstart, but a real deployment runs on **multiple instances** (serverless / Vercel): a cart added on instance A is invisible to the checkout that lands on instance B, so real adopters must supply **shared persistence**.

The library already lets a consumer inject each store, but it ships **only the interfaces and the in-memory classes** — not a persistent implementation. So every production adopter hand-writes the same Redis glue. The reference demo proves the cost: it hand-rolls near-identical adapter classes (one per store), each also **re-declaring the store interface and the in-memory class the library already exports** — roughly 150 lines that every adopter re-implements.

This feature makes persistence a **first-class, one-option** concern: a consumer passes a single `storage` provider and all four persistent stores are built internally, so no one hand-writes a store adapter again — while in-memory stays the zero-config default and explicit store injection remains available as an escape hatch.

## User Scenarios & Testing *(mandatory)*

The "user" of this feature is a **developer** consuming `@openmobilehub/attestomcp-storefront`.

### User Story 1 - One-line production persistence (Priority: P1)

A developer deploying the storefront to a multi-instance/serverless host wants cart, order, and verification state to survive across instances by adding **one option**, without writing any store code.

**Why this priority**: This is the entire point of the issue — it removes the ~150 lines of hand-written adapters that make "using AttestoMCP" look far harder than the quickstart suggests. Delivered alone, it is a complete, valuable improvement.

**Independent Test**: Construct a storefront with `createStorefront({ storage: <redis provider> })`, write cart/order/verification state through one storefront instance, then read it back through a **separately constructed** storefront instance pointed at the same backend, and confirm the state is present and identical.

**Acceptance Scenarios**:

1. **Given** a redis-backed storage provider built from connection credentials, **When** a developer passes it as `createStorefront({ storage })`, **Then** the cart, created-order, completed-order, and verification stores are all backed by that provider with no further wiring.
2. **Given** state written by one storefront instance, **When** a second instance built with the same provider reads that key, **Then** it returns the same state (cross-instance round-trip).
3. **Given** an order whose age gate was proven on instance A, **When** completion runs on instance B, **Then** the persisted verification record is read back and the gate is satisfied from shared state.

---

### User Story 2 - Zero-config in-memory stays unchanged (Priority: P2)

A developer running locally, in tests, or following the minimal quickstart calls `createStorefront()` with no storage option and gets the current in-memory behavior — with no new required options and no obligation to install a persistence dependency.

**Why this priority**: Protects the headline quickstart and the lean dependency footprint. The feature must be additive, never a migration.

**Independent Test**: Call `createStorefront()` with no arguments in an environment where the persistence dependency is **not installed**; confirm it builds, runs, and passes the existing suite unchanged.

**Acceptance Scenarios**:

1. **Given** no `storage` option and no explicit stores, **When** `createStorefront()` is called, **Then** all four stores are in-memory (current behavior).
2. **Given** a consumer that only uses in-memory, **When** they install and build the package, **Then** the optional persistence dependency is not required to be present.

---

### User Story 3 - Custom-backend escape hatch (Priority: P2)

A developer with a non-Redis backend (or bespoke store) injects an explicit store for one or more slots; those injected stores take precedence over whatever the `storage` provider would have supplied.

**Why this priority**: Preserves the existing extensibility contract so the new convenience never becomes a ceiling. Per-slot precedence lets a developer mix (e.g. redis for orders, a custom cart store).

**Independent Test**: Construct `createStorefront({ storage: <redis provider>, orderStore: <spy store> })`; drive an order completion; assert the **spy** store received the write and the redis-provided order store did not.

**Acceptance Scenarios**:

1. **Given** both a `storage` provider and an explicit `verificationStore`, **When** the storefront reads/writes verification state, **Then** the explicit store is used and the provider's verification store is ignored.
2. **Given** an explicit store for one slot only, **When** the storefront runs, **Then** that one slot uses the explicit store and the other three use the provider.

---

### User Story 4 - Multi-tenant namespace isolation (Priority: P3)

A developer runs two storefronts against a single shared backend and gives each a distinct `namespace`, so their keys never collide.

**Why this priority**: Common in shared/hosted setups; cheap to provide once the provider exists. Lower priority because a single-tenant deployment works without it.

**Independent Test**: Build two providers with the same credentials but different namespaces; write the same logical key through each; confirm neither read sees the other's value.

**Acceptance Scenarios**:

1. **Given** two providers with namespaces `shop-a` and `shop-b` on one backend, **When** each writes a cart/order/verification entry, **Then** reads through one namespace never return the other's data.

---

### Edge Cases

- **Both a provider and an explicit store for the same slot** → the explicit store wins for that slot (per-slot precedence, US3); the provider still supplies the other slots.
- **Persistence dependency not installed but the redis provider is invoked** → fail with a clear, actionable error naming the missing dependency (not a silent fallback to in-memory, which would mask a broken production deployment).
- **Backend unreachable / errors at runtime** → the error surfaces to the caller of the store operation; the storefront MUST NOT silently degrade to in-memory (which would reintroduce the cross-instance bug the feature exists to fix).
- **`namespace` omitted** → a single default namespace is used (single-tenant is the common case).
- **Verification record with custom credential fields** (beyond age/loyalty) → the full record round-trips so a completion re-reads exactly what the ceremony wrote.
- **Order token tampering** is unaffected: amounts/flags are still re-derived server-side from the catalog regardless of backend — persistence never becomes an amount source of truth.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `createStorefront` MUST accept an optional `storage` provider that supplies all four persistent stores — cart, created-order, completed-order, and verification — with no additional per-store wiring.
- **FR-002**: With no `storage` option and no explicit stores, `createStorefront` MUST use the existing in-memory stores. No new **required** option may be introduced; the current zero-config quickstart MUST work byte-for-byte unchanged.
- **FR-003**: The system MUST provide a redis storage provider constructible from connection credentials (URL + token) and an optional `namespace`, compatible with the Upstash `@upstash/redis` client family named in the issue.
- **FR-004**: State written through one storefront instance MUST be readable, identical, through a separately constructed instance pointed at the same backend and namespace (cross-instance round-trip) for all four stores.
- **FR-005**: Order and verification state MUST be keyed per order id and MUST NOT be process-global; verification proven for one order MUST NOT mark any other order verified (Constitution — *Per-order state*; Security Invariant #4).
- **FR-006**: An explicit per-slot store injection (`cartStore`, `createdOrderStore`, `orderStore`, `verificationStore`) MUST take precedence over the store the `storage` provider would supply for that same slot, independently per slot.
- **FR-007**: The `namespace` MUST isolate keys such that multiple storefronts sharing one backend never read or overwrite each other's state.
- **FR-008**: The persistence dependency MUST be optional/peer — a consumer using only in-memory MUST NOT be required to install it, and it MUST NOT be pulled into the in-memory code path. Invoking the redis provider when the dependency is absent MUST fail with a clear, actionable error.
- **FR-009**: The verification store MUST round-trip the **full** `VerificationRecord` (age, loyalty, and any custom credential fields). Field merging is performed by the ceremony at the call site before write, so the persistence adapter is a plain per-order read/write of the full record and MUST NOT drop sibling fields.
- **FR-010**: Gate/enforcement outcomes MUST be identical regardless of storage backend. Swapping in redis MUST NOT change which orders complete; all server-side re-derivation (amounts, age/loyalty checks) is unchanged.
- **FR-011**: The storage layer persists state only; it MUST NOT become a trust anchor or alter `trust_level`. No security invariant may be weakened by the choice of backend (Constitution — Security Requirements; Honesty fencing).
- **FR-012**: A runtime backend failure MUST surface to the caller; the storefront MUST NOT silently fall back to in-memory on a persistence error.

### Key Entities *(include if feature involves data)*

- **Storage provider**: A factory (`redisStorage({ url, token, namespace })` is the first implementation) that produces the four persistent stores from a single set of connection settings. Designed so future backends can be added behind the same `storage` seam.
- **Cart store**: The storefront's single working cart (product id → quantity). Not keyed per order in current behavior; `namespace` still isolates it between storefronts.
- **Created-order store**: Orders that have been created but not yet completed (read by the checkout page + place-order), keyed by **order id**.
- **Completed-order store**: Completed-order records (read by `get-order-status` and the order-status poll), keyed by **order id**.
- **Verification store**: Per-order proof state (age proven / loyalty applied / custom credential results), keyed by **order id**; the record round-trips in full.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer enables cross-instance persistence by adding exactly **one** option (`storage`) to `createStorefront`, with zero other code changes.
- **SC-002**: A consuming project can **delete all of its hand-written store adapter classes** (the reference demo's ~150 lines across its adapters) and replace them with the single `storage` option, with no behavior change.
- **SC-003**: The existing zero-config path is unchanged: current usage compiles, the current test suite passes, and no new dependency is required to be installed for in-memory users.
- **SC-004**: For every one of the four stores, state written on one instance is read back correctly on a separate instance **100%** of the time in the persistence round-trip test.
- **SC-005**: Two storefronts sharing one backend under different namespaces show **zero** key collisions across cart, order, and verification writes.
- **SC-006**: Verification proven for one order marks **only** that order verified — a bypass test proves a second order is never satisfied by the first order's state, and that test **fails if per-order keying is removed**.
- **SC-007**: An explicit injected store overrides the provider's store for that slot **100%** of the time, verified by a test asserting the injected store receives the traffic.

## Assumptions

- **Redis flavor**: The provider targets an Upstash `@upstash/redis`-compatible REST client, as named in the issue. Other backends are not in scope for this feature but the `storage` seam is designed to accommodate them later.
- **Explicit credentials**: `redisStorage` receives `url`/`token` explicitly from the caller (the consumer sources them from its own environment). Environment-variable auto-detection (e.g. the demo's `KV_REST_API_*` / `UPSTASH_*` probing) is a consumer concern and out of scope here.
- **Cart scope**: The cart store remains the storefront's single working cart (matching current `CartStore` behavior, which has no order id), not a per-order structure. Per-order isolation applies to the order and verification stores.
- **Verification merge location**: Field merging stays at the ceremony call site (`{ ...prev, ageVerified: true }`), so the persistence adapter is a full-record get/set — the isolation guarantee is per-order keying, not internal merge.
- **No key expiry in v1**: Persisted keys have no TTL by default; retention/expiry is a future concern (defer complexity — Constitution Principle VII).
- **Fail-closed on backend errors**: Consistent with FR-012, a persistence error is surfaced rather than masked by an in-memory fallback.

## Dependencies

- `@upstash/redis` (or a compatible client) as an **optional/peer** dependency of `@openmobilehub/attestomcp-storefront`.
- The existing store contracts in the gate + storefront packages (`CartStore`, `OrderStore<T>`, `VerificationStore`, `VerificationRecord`) — reused, not redefined.

## Out of Scope

- Updating the reference demo (`mcp-apps-shopping-demo`) to delete its hand-written adapters — tracked separately as the demo slim-down (scope A), in a different repository.
- Environment-variable auto-detection of Redis credentials.
- Additional storage backends beyond the Upstash-compatible Redis provider.
- Key expiry / TTL / retention policy.
