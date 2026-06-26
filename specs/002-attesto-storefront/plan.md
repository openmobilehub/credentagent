# Implementation Plan: Attesto Storefront (002)

**Branch**: `feat/attesto-gate-v0.1` (continues v0.1) | **Date**: 2026-06-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-attesto-storefront/spec.md`; governance from `.specify/memory/constitution.md` (v1.0.0)

## Summary

Extract the reference demo's storefront — the single-file React widget, the nine MCP shopping tools, the
checkout page, and the cart/order model — into `@openmobilehub/attesto-storefront`, exposed as a one-line
`createStorefront()` that serves MCP over HTTP and that Attesto mounts onto. The demo is refactored to
**consume** the package (it keeps only its entrypoints, the gate policy, and the caBLE ceremony), so the
live build/deploy and the full test suite stay green throughout — a **brownfield extraction**, exactly like
the gate (001). This delivers the rich widget UI (the "UI is just text" gap); the caBLE ceremony stays the
gate's and is feature 003.

## Technical Context

**Language/Version**: TypeScript 5.9 (NodeNext), Node ≥ 20; React 18 (widget).

**Primary Dependencies**: `@modelcontextprotocol/sdk` (MCP server + StreamableHTTP + in-memory transport),
`@modelcontextprotocol/ext-apps` (UI-linked tools / `ui://` resource), `express` (mount target), `zod`
(inputSchema), `react` + `vite` + `vite-plugin-singlefile` + `@vitejs/plugin-react` (the widget bundle).

**Storage**: Per-session cart + per-order state, in-memory by default (the package owns `cartStore` /
`orderStore`), pluggable later. Verification state is **NOT** the storefront's — it is the gate's, read
through the mounted Attesto store (`app.locals.attesto`). Orders stay stateless (encoded in the token).

**Testing**: `vitest` (scoped to the main tree; `.worktrees` excluded). MCP-layer tests drive the storefront
via the in-memory transport (`mcpServer()`), deterministic; the existing demo tests must stay green.

**Target Platform**: Node server (HTTP); the widget renders in MCP-Apps-capable hosts (Claude native app /
claude.ai / ChatGPT); no-GUI hosts surface text. Deployed on Vercel (one function), origin unchanged.

**Project Type**: Library-in-workspace (`packages/attesto-storefront`, now with a UI bundle) + its consumer
(the demo at repo root). npm workspaces; `build:packages` runs before the app build.

**Performance Goals**: Negligible server-side (small carts, no hot path). The widget bundle is a single
self-contained HTML (~current demo size). Correctness + adopter DX are the goals.

**Constraints**: MUST NOT break the live Vercel build/deploy or served origin (`mcp-apps-nine.vercel.app`);
the demo MUST consume the package with **no duplicated storefront code** and **no behavior change**; the
package build now produces a React bundle (vite) **plus** TS, in workspace order, Vercel-safe; preserve all
six security invariants; HTTP transport; DCO sign-off; the caBLE ceremony stays out (feature 003).

**Scale/Scope**: One package (gains the widget + 9 tools + page + state) + one consumer (the demo, slimmed)
+ the example + the composition test. ~570 widget LOC + the 9 tools (6 UI-linked + 3 plain) + checkout page
move; `payment-gate/` (~28 source files, 56 incl. tests/READMEs) does NOT move.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan complies |
|-----------|--------|------------------------|
| I. Stripe-grade, MCP-idiomatic API | ✅ PASS | `createStorefront()` is one line; returns a small handle (`app`/`mcpServer`/`gate`/`listen`/`catalog`) with visible origins — no callback grab-bag. |
| II. Three execution contexts sacred | ✅ PASS | Storefront serves Context 1 (the tools), Context 2 (the checkout page shell), Context 3 (`get-order-status`); it never performs a credential ceremony (that's the gate, 003). |
| III. Consolidated checkout | ✅ PASS | The `checkout` tool mints the link + surfaces the injected `requires` manifest (Mode A); unchanged from 001. |
| IV. Ordered, conditional policy array | ✅ PASS | The storefront doesn't define policy — it injects whatever `store.gate(resolve)` returns; the ordered array stays the gate's. |
| V. Extensible to any credential | ✅ PASS | Catalog-injected; the gate resolver is arbitrary; no storefront coupling to specific credentials. |
| VI. structuredContent is data, not policy | ✅ PASS | All tool results are serializable; the `requires` manifest is the gate's resolved data; the widget reads `toolOutput` data, not functions. |
| VII. Honesty in types; prefer simplicity | ✅ PASS | The caBLE ceremony is honestly OUT (the page *links* to routes mount() provides — feature 003); no stub sold as real. The widget is the demo's real one (extracted, not reinvented). |
| Security Requirements (6 invariants) | ✅ PASS | Amounts/age re-derived server-side (the seam); cart/order state keyed per session/order (never process-global); verification state stays the gate's per-order store; origin/nonce binding unchanged (ceremony untouched). Bypass tests stay green. |
| Workflow (spec-grounded, tested, DCO) | ✅ PASS | Brownfield; demo-consumes-package; build + full suite green per step; `git commit -s`. |

**Result: PASS — no violations.** Complexity Tracking below is empty.

## Project Structure

### Documentation (this feature)

```text
specs/002-attesto-storefront/
├── plan.md              # This file
├── research.md          # Phase 0 — extraction decisions
├── data-model.md        # Phase 1 — entities (storefront handle, tools, catalog, state, widget bundle)
├── quickstart.md        # Phase 1 — runnable validation (npm-install adopter flow + the demo)
├── contracts/
│   └── attesto-storefront.api.md   # Phase 1 — createStorefront + the 9 tools + the UI resource
└── tasks.md             # Phase 2 — /speckit-tasks (NOT created here)
```

### Source Code (repository root)

```text
packages/attesto-storefront/        # THE STOREFRONT (gains UI + tools + page + state)
├── src/
│   ├── index.ts                    # pricing model (priceCart/createOrder/SAMPLE_CATALOG) — unchanged
│   ├── server.ts                   # createStorefront(): MCP server (9 tools) over HTTP + checkout page + gate hook
│   ├── tools.ts                    # the 9 shopping tools (registerAppTool, UI-linked), moved from demo server.ts
│   ├── catalog-tools.ts            # browse / product-details / reviews (catalog-backed)
│   ├── checkout-page.ts            # the checkout page shell (moved from checkout.ts), links to ceremony routes
│   ├── state.ts                    # cartStore + orderStore (in-memory, per session/order)
│   ├── ui/                         # the React widget (moved from repo-root src/)
│   │   ├── app.tsx                 # runtime host detection preserved (Claude/ChatGPT/standalone)
│   │   └── mcp-app.html            # vite entry → single-file bundle (dist/ui/mcp-app.html)
│   └── *.test.ts
├── vite.config.ts                  # builds the widget single-file bundle
├── tsconfig.json / package.json    # build runs vite (ui) + tsc; exports "." + "./server"; ships dist (incl. ui bundle)

# Demo (repo root) — SLIMMED to a thin consumer:
server.ts        # → uses createStorefront(); registers ONLY the gate policy on the checkout tool
app.ts           # → createStorefront().app, then attesto.mount(app) + registerCredentialGate/passkey/dc-payment (ceremony, 003 territory)
main.ts          # entrypoints (stdio/http) — unchanged shape
payment-gate/    # the caBLE ceremony — STAYS in the demo (mounted on store.app); feature 003 moves it behind mount()
catalog.ts       # the demo's specific products — injected into createStorefront({ catalog }); reviews carried along
```

**Structure Decision**: Library-in-workspace consumed by the in-repo demo. The storefront package now owns
the UI bundle (a vite build alongside tsc) + the 9 tools + the checkout page + cart/order state. The demo
keeps its entrypoints, its catalog (injected), the gate policy, and `payment-gate/` (the ceremony, mounted
on `store.app`). The npm-workspaces build runs `build:packages` (vite ui + tsc) before the app — unchanged
Vercel command.

## Complexity Tracking

> No Constitution violations — nothing to justify.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
