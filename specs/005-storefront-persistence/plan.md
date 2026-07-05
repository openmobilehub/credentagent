# Implementation Plan: Storefront First-Class Persistence (`redisStorage`)

**Branch**: `005-storefront-persistence` | **Date**: 2026-07-03 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-storefront-persistence/spec.md`

## Summary

Add a first-class `storage` option to `createStorefront()` plus a `redisStorage({ url, token, namespace })` provider that builds all four persistent stores (cart, created-order, completed-order, verification) internally, so consumers stop hand-writing Redis adapters. In-memory stays the zero-config default; explicit per-slot store injection still wins. `@upstash/redis` is an **optional peer dependency** isolated behind a dedicated `./redis` subpath export so the in-memory path never loads it. Testability comes from a small injectable Redis-like seam (a `get`/`set`/`del` client) so vitest exercises round-trip, namespace isolation, and override precedence without a live server.

## Technical Context

**Language/Version**: TypeScript, Node ≥ 20, ESM (matches both workspace packages).

**Primary Dependencies**: existing — `@modelcontextprotocol/sdk`, `express`, `zod`, `@openmobilehub/attestomcp-gate`. **New**: `@upstash/redis` (^1.x) as an **optional `peerDependency`** (+ `devDependency` for typecheck/tests), never a runtime `dependency`.

**Storage**: Upstash-compatible Redis over REST (`@upstash/redis`) for the persistent path; in-process `Map` for the default. The library reuses the existing store contracts (`CartStore`, `OrderStore<T>`, `VerificationStore`) — it does not define new ones.

**Testing**: `vitest` (per-package). Redis adapters are tested against an injectable `RedisLike` fake (a single `Map`-backed `get`/`set`/`del`), so "two instances over one backend" (round-trip) and "two namespaces over one backend" (isolation) are deterministic and offline. The security-bypass test (per-order isolation) MUST fail if per-order keying is removed.

**Target Platform**: Node serverless (multi-instance, e.g. Vercel) for the persistent path; local Node / tests for in-memory.

**Project Type**: Library (npm workspace package `@openmobilehub/attestomcp-storefront`).

**Performance Goals**: No added latency or dependency load on the in-memory path. Persistent store ops are single O(1) `get`/`set`/`del` per call (same shape as the demo's hand-rolled adapters).

**Constraints**: (1) `@upstash/redis` MUST NOT be imported on the in-memory code path — isolate it behind the `./redis` subpath. (2) No new **required** option; the current zero-config quickstart compiles and runs unchanged. (3) Fail-closed on backend errors (no silent in-memory fallback). (4) DCO sign-off on every commit.

**Scale/Scope**: Small — one provider factory, three thin Redis adapters, a `StorageProvider` type, a handful of new type exports, per-slot resolution wiring in `createStorefront`, and one new test file. No changes to the gate package's runtime.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

Instantiated against the AttestoMCP SDK Constitution (Principles I–VII + Security Requirements):

| Gate | Assessment |
| :-- | :-- |
| **I. Stripe-grade, MCP-idiomatic API** | ✅ One declarative option (`storage: redisStorage({ url, token, namespace })`), configured once, all values visible on the call site. No injected-callback grab-bags. |
| **II. Three execution contexts sacred** | ✅ Orthogonal — persistence stores the state the existing tool/page/poll contexts already read; it does not add a ceremony to the tool handler. |
| **III. Consolidated checkout flow** | ✅ Unaffected. |
| **IV. One ordered conditional policy array / amount server-derived** | ✅ Reinforced by FR-010: amounts/flags are re-derived server-side from the catalog regardless of backend; persistence is never an amount source of truth. |
| **V. Extensible to any credential** | ✅ Reinforced by FR-009: the verification record round-trips **in full** (custom credential fields included), so custom credentials keep working under persistence. |
| **VI. structuredContent is data** | ✅ Unaffected. |
| **VII. Honesty in types; prefer simplicity** | ✅ FR-011: storage is not a trust anchor; no `trust_level` change. Simplicity: reuse existing interfaces, one provider, defer TTL / other backends. |
| **Security — per-order state (Inv #4)** | ✅ **The gate this feature touches.** FR-005 keys order + verification state per order id; `namespace` isolates tenants; SC-006 bypass test proves no cross-order bleed and fails if per-order keying is removed. |
| **Security — never trust token / discounts reconcile / positive claims / origin+replay** | ✅ All unchanged; the storage layer only persists what the existing server-side checks compute. |
| **Dev workflow & quality gates** | ✅ Spec cites real code (file/line); bypass test required; `npm run build` green + runtime smoke before "done"; DCO. |

**Result: PASS — no violations.** Complexity Tracking is therefore empty.

## Project Structure

### Documentation (this feature)

```text
specs/005-storefront-persistence/
├── plan.md              # This file
├── spec.md              # Feature spec (/speckit-specify)
├── research.md          # Phase 0 output (this command)
├── data-model.md        # Phase 1 output (this command)
├── quickstart.md        # Phase 1 output (this command)
├── contracts/
│   └── storefront-storage.api.md   # Phase 1 output — public API contract
├── checklists/
│   └── requirements.md  # Spec quality checklist (/speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/attestomcp-storefront/
├── package.json              # + @upstash/redis as optional peerDependency (+ devDependency);
│                             #   + "./redis" subpath in "exports"; + peerDependenciesMeta.optional
├── src/
│   ├── server.ts             # createStorefront: per-slot resolution
│   │                         #   explicit store ?? opts.storage?.<slot> ?? new Memory<slot>()
│   │                         #   + add `storage?: StorageProvider` to StorefrontOptions
│   ├── state.ts              # existing CartStore / OrderStore<T> — EXPORT them + StorageProvider type
│   ├── redis.ts              # NEW — redisStorage() factory + RedisCartStore / RedisOrderStore<T> /
│   │                         #   RedisVerificationStore + RedisLike seam. Only module importing @upstash/redis.
│   ├── redis.test.ts         # NEW — round-trip, namespace isolation, override precedence,
│   │                         #   per-order bypass (fails if keying removed), in-memory-default guard
│   └── index.ts              # (unchanged) pure model barrel — stays free of server/redis imports
└── README.md                 # + a short "Production persistence" section (one option)
```

**Structure Decision**: Single npm workspace package (`packages/attestomcp-storefront`). The new persistence code lands entirely in that package as a self-contained `redis.ts` module reached only via the new `./redis` subpath export — mirroring how the repo isolates optional concerns. `server.ts` gains only type-level knowledge of `StorageProvider` (no `@upstash/redis` import), preserving the lean in-memory path. The gate package is untouched (it already exports `VerificationStore` / `MemoryVerificationStore`).

## Complexity Tracking

> No Constitution Check violations — this section is intentionally empty.
