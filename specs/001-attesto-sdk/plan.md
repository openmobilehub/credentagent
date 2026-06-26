# Implementation Plan: Attesto SDK v0.1

**Branch**: `feat/attesto-gate-v0.1` | **Date**: 2026-06-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-attesto-sdk/spec.md`; governance from `.specify/memory/constitution.md` (v1.0.0)

## Summary

Refactor the existing `@openmobilehub/attesto-gate` package and wire the demo's MCP `checkout` tool to the
spec's API: a configure-once client (`new Attesto({ walletOrigin })`), `attesto.mount(app)` (mounts the
`/credential-gate/*` ceremony + owns the per-order verification store), and `attesto.requirements(order,
policy)` returning a serializable manifest. The policy is one ordered array of `required(...)`/`optional(...)`
over typed builders (`age.over(21)`, `membership.discount(10)`, `payment.in("usd")`) with conditionality via
`.when((order)=>boolean)`, extensible via `defineCredential(...)`. This is a **brownfield extraction** from
the working reference server — the demo is the integration harness, and the live Vercel build/deploy must
stay green.

## Technical Context

**Language/Version**: TypeScript 5.9 (NodeNext modules), Node ≥ 20

**Primary Dependencies**: `@modelcontextprotocol/sdk` (MCP server + in-memory transport for tests),
`express` (mount target), `zod` (tool inputSchema). Package itself: **zero runtime deps** (pure TS).

**Storage**: Per-order verification state — `MemoryVerificationStore` default (in-process), pluggable
Redis (Upstash) for serverless; keyed by order id. No DB for orders (stateless, encoded in the token).

**Testing**: `vitest` (scoped to the main tree — `vite.config.ts` excludes `.worktrees/**`). MCP-layer
tests drive the tool via the in-memory transport (deterministic); security-bypass tests required.

**Target Platform**: Node server (stdio + HTTP); deployed on Vercel (one serverless function). Widget
(`src/`) is the React MCP App; out of scope for this package beyond being the Context-3 poller.

**Project Type**: Library (`packages/attesto-gate`) + its consumer (the demo MCP server at repo root).
npm workspaces; `build:packages` runs before the app build.

**Performance Goals**: Negligible — `requirements()` is a synchronous policy resolution over a small cart;
no hot path. Correctness and DX are the goals, not throughput.

**Constraints**: MUST NOT break the live Vercel build/deploy or served origin (`mcp-apps-nine.vercel.app`);
`requires` MUST be plain JSON (functions never cross the wire); preserve all six security invariants;
consolidated (Mode A) only; DCO sign-off; presence-only trust (real verifier deferred).

**Scale/Scope**: One package + one consumer call site (`server.ts` checkout tool) + the mounted ceremony.
3 built-in credentials + the `defineCredential` extension point + 1 worked custom example (prescription).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | How this plan complies |
|-----------|--------|------------------------|
| I. Stripe-grade, MCP-idiomatic API | ✅ PASS | `new Attesto({...})` + declarative `requirements(order, policy)`; examples show inline `inputSchema`; no injected callbacks (predicates are explicit `.when()`). |
| II. Three execution contexts sacred | ✅ PASS | Package only serves Context 1 (`requirements()`) + Context 2 (`mount()` ceremony). Never performs a phone ceremony in the handler. |
| III. Consolidated checkout | ✅ PASS | `requirements()` returns link-side manifest; Mode B not built. |
| IV. Ordered, conditional policy array | ✅ PASS | Policy is an ordered array; payment-last invariant in the resolver; `.when()` / `appliesTo` carry conditionality; amount derived from the order. |
| V. Extensible to any credential | ✅ PASS | `defineCredential` + `gate()/discount()/authorize()`; built-ins are pre-defined credentials; by-object use. |
| VI. structuredContent is data, not policy | ✅ PASS | `requirements()` resolves functions server-side and emits a flat manifest; a contract test asserts `JSON.stringify` round-trips with no functions. |
| VII. Honesty in types; prefer simplicity | ✅ PASS | `enforcedAt` / `trust_level` are fields on `VerificationManifestEntry` (data-model + contract CT8), not prose; presence-only fenced; real verifier deferred. |
| Security Requirements (6 invariants) | ✅ PASS | Enforcement stays on every completion path (unchanged web routes + the tool envelope); amounts re-derived; per-order store; explicit positive claims (`verify.ts` unchanged); origin/nonce binding unchanged. Bypass tests required. |
| Workflow (spec-grounded, tested, DCO) | ✅ PASS | Artifacts cite real code; bypass + build verification per task; `git commit -s`. |

**Result: PASS — no violations.** Complexity Tracking below is empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-attesto-sdk/
├── plan.md              # This file
├── research.md          # Phase 0 — design decisions
├── data-model.md        # Phase 1 — entities (client, policy, credential, manifest, store)
├── quickstart.md        # Phase 1 — runnable validation (build + bypass test + demo)
├── contracts/
│   └── attesto-gate.api.md   # Phase 1 — the public API surface (the contract)
└── tasks.md             # Phase 2 — /speckit-tasks (NOT created here)
```

### Source Code (repository root)

```text
packages/attesto-gate/          # THE LIBRARY (refactor target)
├── src/
│   ├── index.ts                # public surface: Attesto, age/membership/payment, required/optional,
│   │                           #   defineCredential, dcql, gate/discount/authorize, types
│   ├── client.ts               # Attesto class: constructor, mount(), requirements()
│   ├── credentials.ts          # built-in builders + defineCredential + .when()/appliesTo resolution
│   ├── manifest.ts             # requirements() resolver → serializable manifest (code→data boundary)
│   ├── envelope.ts             # verification_required (kept; used by Mode B / roadmap + tests)
│   └── *.test.ts               # unit tests (resolver, builders, serialization)
└── package.json / tsconfig.json

# Demo MCP server (the consumer + integration harness) — repo root, UNCHANGED layout:
server.ts                       # checkout tool → consumes attesto.requirements(order, policy)
checkout.ts catalog.ts          # order/pricing (GateOrder source: lines carry category/minimumAge)
app.ts main.ts                  # express app; attesto.mount(app) wires /credential-gate/*
payment-gate/credential-gate/   # the real ceremony the package's mount() will own/wrap
verificationStore.ts            # becomes the default store's backing
checkout-gate.test.ts           # MCP-layer bypass test (age-restricted cart → manifest, not a link)
```

**Structure Decision**: Library-in-workspace (`packages/attesto-gate`) consumed by the in-repo demo
server, which doubles as the integration harness (Constitution: storefront = harness for v0.1). No new
top-level projects; the existing npm-workspaces build (`build:packages` → app) is preserved so Vercel is
unaffected.

## Complexity Tracking

> No Constitution violations — nothing to justify.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
