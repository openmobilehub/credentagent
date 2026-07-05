---
description: "Task list for feature 005 — storefront first-class persistence (redisStorage)"
---

# Tasks: Storefront First-Class Persistence (`redisStorage`)

**Input**: Design documents from `specs/005-storefront-persistence/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/storefront-storage.api.md](contracts/storefront-storage.api.md)

**Tests**: INCLUDED. The constitution requires tests on security-critical/bypass paths (a test that still
passes with the control removed is not useful), and the spec's success criteria are test-shaped. Test tasks
are therefore not optional here.

**Organization**: Tasks are grouped by user story (US1–US4 from spec.md) so each story is an independent,
testable increment. All paths are under `packages/attestomcp-storefront/` unless noted.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 (story phases only)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Wire the optional dependency and the new export path.

- [X] T001 Add `@upstash/redis` (^1.x) as an **optional peerDependency** + a `devDependency`, with `peerDependenciesMeta: { "@upstash/redis": { optional: true } }`, in `packages/attestomcp-storefront/package.json`
- [X] T002 Add the `"./redis"` subpath to `exports` (→ `./dist/redis.d.ts` / `./dist/redis.js`) in `packages/attestomcp-storefront/package.json`
- [X] T003 Run `npm install` at repo root so `@upstash/redis` resolves for typecheck + tests

**Checkpoint**: Package can import `@upstash/redis` for build/tests; `./redis` subpath is declared.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The `StorageProvider` seam + per-slot resolution that ALL stories depend on. Backend-agnostic.

**⚠️ CRITICAL**: No user story can be completed until this phase is done.

- [X] T004 Export `CartStore` and `OrderStore` and add the `StorageProvider` interface (`{ cartStore, createdOrderStore, orderStore, verificationStore }`) in `packages/attestomcp-storefront/src/state.ts`; re-export `StorageProvider`, `CartStore`, `OrderStore` from the `./server` entry (`packages/attestomcp-storefront/src/server.ts`)
- [X] T005 Add `storage?: StorageProvider` to `StorefrontOptions` and change the four store-resolution lines in `createStorefront` to `opts.<slot> ?? opts.storage?.<slot> ?? new Memory<slot>()` (cart, createdOrder, order, verification) in `packages/attestomcp-storefront/src/server.ts` (depends on T004)

**Checkpoint**: `createStorefront` accepts a `storage` provider with per-slot precedence; in-memory default unchanged. Stories can begin.

---

## Phase 3: User Story 1 — One-line production persistence (Priority: P1) 🎯 MVP

**Goal**: `createStorefront({ storage: redisStorage({ url, token, namespace }) })` persists all four stores across instances.

**Independent Test**: Write cart/order/verification through one provider and read it back through a separately-built provider over the same backend (V2).

### Tests for User Story 1 (write first; they MUST fail before T009–T012)

- [X] T006 [US1] Add a `Map`-backed `RedisLike` fake (`get`/`set`/`del`) as a test helper in `packages/attestomcp-storefront/src/redis.test.ts`
- [X] T007 [US1] Failing cross-instance round-trip test (V2/CT-8): two `redisStorage` providers over one fake client + same namespace — write via A, read via B — for cart, created-order, completed-order, verification, in `packages/attestomcp-storefront/src/redis.test.ts`
- [X] T008 [US1] Failing per-order isolation/bypass test (V4/CT-9, Security Inv #4): prove verification for `ORD-X`, read `ORD-Y` → unverified; add a comment asserting the test must fail if the `:${orderId}` key segment is removed, in `packages/attestomcp-storefront/src/redis.test.ts`

### Implementation for User Story 1

- [X] T009 [US1] Create `packages/attestomcp-storefront/src/redis.ts`: `RedisLike` + `RedisStorageOptions` types, `keyFor(namespace, kind, id?)` helper (`${ns}:cart`, `${ns}:order:created:${id}`, `${ns}:order:completed:${id}`, `${ns}:verification:${id}`), and `RedisCartStore` implementing `CartStore` (Map↔object at the boundary)
- [X] T010 [US1] Add `RedisOrderStore<T>` (per-order-id `get`/`set`/`del`, missing → `null`) covering both the created-order and completed-order slots, in `packages/attestomcp-storefront/src/redis.ts`
- [X] T011 [US1] Add `RedisVerificationStore` — full-record `get`/`set`/`del` per order id (no internal merge; missing → `undefined`), in `packages/attestomcp-storefront/src/redis.ts`
- [X] T012 [US1] Implement `redisStorage(options): StorageProvider` — build a `Redis` client from `url`+`token` OR use an injected `client`; default `namespace = "attestomcp-storefront"`; return the four adapters — in `packages/attestomcp-storefront/src/redis.ts`
- [X] T013 [US1] Run `npm --workspace @openmobilehub/attestomcp-storefront run test`; make T007 + T008 pass

**Checkpoint**: MVP — production persistence works and is proven by round-trip + per-order isolation tests.

---

## Phase 4: User Story 2 — Zero-config in-memory stays unchanged (Priority: P2)

**Goal**: `createStorefront()` with no options is in-memory, needs no `@upstash/redis`, and errors clearly if the dep is missing when redis is actually requested.

**Independent Test**: `createStorefront()` with no options builds/serves in-memory (V1); `redisStorage({url,token})` without the dep throws an actionable error (V7).

- [X] T014 [US2] Guard test (V1/CT-1): `createStorefront()` with no options serves in-memory and its `./server` module graph does not import `@upstash/redis`, in `packages/attestomcp-storefront/src/server.test.ts`
- [X] T015 [US2] Config-error handling + tests (CT-6/CT-7/V7): `redisStorage({})` (neither `client` nor `url`+`token`) throws a clear error; when `url`+`token` are given but `@upstash/redis` cannot be loaded, throw an actionable error naming the missing optional peer dep (via an injectable loader seam so it's testable while the dep is installed) — in `packages/attestomcp-storefront/src/redis.ts` + `src/redis.test.ts`

**Checkpoint**: Lean in-memory path guaranteed; missing-dep failure is friendly.

---

## Phase 5: User Story 3 — Custom-backend escape hatch (Priority: P2)

**Goal**: An explicit injected store wins over the provider, per slot.

**Independent Test**: `createStorefront({ storage: redisStorage({ client }), orderStore: spy })` routes the completed-order write to `spy`, not the provider (V5).

- [X] T016 [US3] Override-precedence test (V5/CT-3): assert an injected `orderStore` spy receives the completed-order write while the provider's order store is untouched; also assert other slots still come from the provider, in `packages/attestomcp-storefront/src/server.test.ts`
- [X] T017 [US3] Type-export check: `import type { StorageProvider, CartStore, OrderStore }` from `@openmobilehub/attestomcp-storefront/server` compiles (escape-hatch typing), in `packages/attestomcp-storefront/src/types.test-d.ts`

**Checkpoint**: Extensibility preserved — custom/mixed backends supported and typed.

---

## Phase 6: User Story 4 — Multi-tenant namespace isolation (Priority: P3)

**Goal**: Two storefronts on one backend under different namespaces never collide.

**Independent Test**: Same fake client, namespaces `shop-a`/`shop-b`; neither read sees the other's data (V3).

- [X] T018 [US4] Namespace-isolation test (V3/CT-8): two providers over one fake client with namespaces `shop-a` and `shop-b`; write cart/order/verification through each; assert zero cross-namespace reads, in `packages/attestomcp-storefront/src/redis.test.ts`
- [X] T019 [US4] Default-namespace test: omitting `namespace` uses `"attestomcp-storefront"` and does not collide with an explicitly-namespaced provider, in `packages/attestomcp-storefront/src/redis.test.ts`

**Checkpoint**: Shared-backend multi-tenancy is safe.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T020 [P] Fail-closed test (V6/CT-11): an injected `client` whose `get`/`set` reject makes the store op reject; `createStorefront` does not fall back to in-memory, in `packages/attestomcp-storefront/src/redis.test.ts`
- [X] T021 [P] Add a concise "Production persistence" section (one `storage: redisStorage(...)` option) to `packages/attestomcp-storefront/README.md`
- [X] T022 [P] Add a spec-005 entry to the Done/In-flight log in `STATUS.md`
- [X] T023 Final gate: `npm run build` + `npm run test` (both packages) green, plus an in-memory runtime smoke of `createStorefront().listen(...)` (Constitution deploy-care)

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1: T001–T003)** → no deps; do first.
- **Foundational (P2: T004–T005)** → after Setup; **blocks all stories**.
- **US1 (P3)** → after Foundational. Delivers `redisStorage` + adapters (the MVP). US3 and US4 tests reuse `redisStorage`, so US1 must land before them.
- **US2 (P4)** → after Foundational (T014 is independent; T015 shares `redis.ts` with US1, so sequence after US1 impl).
- **US3 (P5), US4 (P6)** → after US1 (they exercise `redisStorage`).
- **Polish (P7)** → after the stories you intend to ship.

### Within US1

- Tests (T006–T008) written first and failing → then impl T009→T010→T011→T012 (all in `redis.ts`, sequential) → T013 green.

### Parallel opportunities

- Setup T001/T002 touch the same `package.json` → sequential; T003 after both.
- `redis.ts` tasks (T009–T012) are the same file → sequential; likewise `redis.test.ts` tasks (T006–T008, T018–T020) → sequential among themselves.
- Cross-file parallelizable: **T020** (`redis.test.ts`) ∥ **T021** (`README.md`) ∥ **T022** (`STATUS.md`). T014/T016 (`server.test.ts`) ∥ T017 (`types.test-d.ts`) once US1 impl exists.

---

## Implementation Strategy

### MVP first (US1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational → 3. Phase 3 US1 → **STOP & validate** round-trip + per-order isolation → shippable persistence.

### Incremental delivery

US1 (persistence) → US2 (lean/default guarantees) → US3 (escape hatch) → US4 (namespaces) → Polish. Each story is independently testable and adds value without breaking the prior ones.

---

## Notes

- **DCO**: every commit MUST carry `Signed-off-by:` (`git commit -s`) — this repo enforces it.
- **Security test bar**: T008 (per-order isolation) is the load-bearing bypass test — it MUST fail if the `:${orderId}` key segment is removed. Do not weaken it into a happy-path shape.
- **Honesty**: the storage layer only persists state; it is not a trust anchor and MUST NOT touch `trust_level` (FR-011).
- Out of scope (separate repo): updating `mcp-apps-shopping-demo` to delete its hand-written adapters.
- Total: **23 tasks** — Setup 3, Foundational 2, US1 8, US2 2, US3 2, US4 2, Polish 4.
