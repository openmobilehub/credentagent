---
description: "Task list — Attesto Storefront (002)"
---

# Tasks: Attesto Storefront extraction (002)

**Input**: Design documents from `specs/002-attesto-storefront/` — `plan.md`, `spec.md`, `research.md`,
`data-model.md`, `contracts/attesto-storefront.api.md`, `quickstart.md`. Governance: `.specify/memory/constitution.md` (v1.0.0).

**Tests**: YES — TDD (Constitution: security/bypass + composition paths MUST be tested). The contract tests
in `contracts/attesto-storefront.api.md` are written FIRST.

**Organization**: by user story. Paths: package = `packages/attesto-storefront/`; demo (harness) = repo root.

## User stories (from the spec)

- **US1 (P1)**: One-line `createStorefront()` returns the real storefront — the single-file React widget +
  the nine MCP tools + the checkout page over HTTP; the widget renders in a widget-capable host. *Testable
  via `packages/attesto-storefront/src/server.test.ts` (in-memory transport) + a manual widget check.*
- **US2 (P1)**: The demo **consumes** the package (no duplicated storefront code) and behaves identically —
  full suite (242 / 1 skip) + the live deploy stay green. *Testable via `npm test` + `npm run build`.*
- **US3 (P2)**: Bring-your-own-catalog + gate injection; the priced `Order` feeds `attesto.requirements()`
  with zero glue. *Testable via `storefront-gate.test.ts` + a custom-catalog test.*

**Hard constraints (all phases)**: brownfield — the demo consumes the package and stays green; `build:packages`
(vite ui bundle **+** tsc) runs before the app build and is Vercel-safe; the caBLE ceremony (`payment-gate/`)
stays OUT (feature 003); preserve the six security invariants; HTTP transport; `npm run build` + `npm test`
(excl. `.worktrees`) green per task; DCO sign-off (`git commit -s`).

---

## Phase 1: Setup

- [ ] T001 Add the widget build to `packages/attesto-storefront`: add deps (`react`, `react-dom`,
      `@vitejs/plugin-react`, `vite`, `vite-plugin-singlefile`, `@modelcontextprotocol/ext-apps`); create
      `packages/attesto-storefront/vite.config.ts` (react + singlefile, input `src/ui/mcp-app.html`, outDir
      `dist/ui`); set `package.json` `build` = `vite build && tsc -p tsconfig.json`; `files` ships `dist`.
- [ ] T002 [P] Scaffold the module layout per `plan.md` in `packages/attesto-storefront/src/`: `tools.ts`,
      `catalog-tools.ts`, `checkout-page.ts`, `state.ts`, `ui/` (placeholders); keep `index.ts` (pricing) +
      `server.ts`.

## Phase 2: Foundational (blocking — primitives every story needs)

- [ ] T003 Move cart/order state into `packages/attesto-storefront/src/state.ts` (`cartStore` + `orderStore`,
      in-memory default, keyed per session/order — never process-global); export them.
- [ ] T004 [P] Extend the catalog model in `packages/attesto-storefront/src/index.ts`: add `Review` +
      `StorefrontOptions.reviews`; keep `Product` (`minimumAge`/`category`), `SAMPLE_CATALOG`, and the
      pricing functions unchanged.
- [ ] T005 Rewrite `createStorefront()` skeleton in `packages/attesto-storefront/src/server.ts` — `app`
      (`createMcpExpressApp`), `mcpServer()` factory (no tools yet), `gate(resolve)`, `listen()`, `catalog`;
      the HTTP `/mcp` route (StreamableHTTP, mirroring `app.ts`). Supersedes the v0.1 minimal storefront.

**Checkpoint**: package builds (vite + tsc); `createStorefront()` serves an empty `/mcp`.

## Phase 3: User Story 1 — the real storefront in one line (P1)

**Goal**: `createStorefront()` serves the nine UI-linked tools + the checkout page over HTTP and registers
the `ui://` widget; the product-picker renders in a widget-capable host. **Independent test**: `server.test.ts`.

- [ ] T006 [P] [US1] Contract test (CT1): `mcpServer()` registers exactly the nine tools, in
      `packages/attesto-storefront/src/server.test.ts` (in-memory transport).
- [ ] T007 [P] [US1] Contract test (CT2/CT3): `checkout` ungated ⇒ `{ orderId, checkoutUrl }`; with a stub
      gate resolver ⇒ `+ requires`; in `packages/attesto-storefront/src/server.test.ts`.
- [ ] T008 [P] [US1] Contract test (CT5): the `ui://` resource is registered and the UI-linked tools carry
      `UI_META`, in `packages/attesto-storefront/src/server.test.ts`.
- [ ] T009 [P] [US1] Contract test (CT6): cart/order state is per session/order — two orders don't bleed; in
      `packages/attesto-storefront/src/server.test.ts`.
- [ ] T010 [US1] Move the widget: repo-root `src/app.tsx` (+ helpers, ~574 LOC) → `packages/attesto-storefront/src/ui/`;
      `mcp-app.html` as the vite entry; build the single-file bundle to `dist/ui/`. Preserve runtime host
      detection (`chatgpt`/`mcp`/`standalone`).
- [ ] T011 [US1] Move the nine tools into `packages/attesto-storefront/src/tools.ts` + `catalog-tools.ts`
      (`registerAppTool` + `UI_META`; `checkout` keeps Mode A and calls the injected `gate` resolver — the
      priced `Order` feeds it directly, no `toGateOrder`); register them in `mcpServer()`.
- [ ] T012 [US1] Move the checkout page: `checkout.ts` → `packages/attesto-storefront/src/checkout-page.ts`;
      serve `GET /checkout` on `store.app`; render the order + the `requires`; **link** to the ceremony
      routes (`/credential-gate/age`, passkey, dc-payment) — do NOT implement the ceremony (feature 003).
- [ ] T013 [US1] Register the `ui://` widget resource in `createStorefront()` (`registerAppResource`,
      bundle-version stamping) and attach `UI_META` to the UI-linked tools.
- [ ] T014 [US1] Verify: `npm run build:packages` green (the widget bundle is produced) + `server.test.ts`
      green; commit (DCO).

**Checkpoint**: US1 is a shippable MVP — `createStorefront()` is the real storefront over HTTP.

## Phase 4: User Story 2 — the demo consumes the package (P1)

**Goal**: the demo's storefront code lives only in the package; the demo wires `createStorefront()` +
`mount()` + the gate policy + the ceremony and behaves identically. **Independent test**: `npm test` + `npm run build`.

- [ ] T015 [US2] Refactor `server.ts` to build the tools via `createStorefront({ catalog })` and inject the
      gate policy (`store.gate((order) => attesto.requirements(order, [required(age.over(21).when(hasAlcohol)),
      optional(membership.discount(10)), required(payment.in("usd"))]))`); delete the moved tool code +
      `toGateOrder` (now zero-glue).
- [ ] T016 [US2] Refactor `app.ts` to use `createStorefront(...).app`, then `attesto.mount(app)` and register
      the **ceremony** (`registerCredentialGate`/`registerPasskeyGate`/`registerDcPaymentGate`) on `store.app`;
      keep discovery (`/llms.txt`, `/.well-known/attesto.json`); the checkout page now comes from the package.
- [ ] T017 [US2] Inject the demo's catalog (`catalog.ts` products + reviews) into `createStorefront({ catalog,
      reviews })`; reconcile the demo's product/review data with the package's `Product`/`Review` model.
- [ ] T018 [US2] Remove the now-duplicated repo-root storefront code (the `src/` widget, `checkout.ts`,
      `cartStore.ts`, `orderStore.ts` — moved to the package); update the root `vite.config.ts` /
      `tsconfig.server.json` so the root build no longer builds the widget (the package does) and the build
      order stays `build:packages` → app, Vercel-safe.
- [ ] T019 [US2] Verify: full `npm test` green (242 / 1 known skip — demo parity, no regression) + `npm run
      build` green (deploy-safe; Vercel pipeline unchanged); commit (DCO).

**Checkpoint**: the demo is a thin consumer; nothing a user sees changed; the deploy stays green.

## Phase 5: User Story 3 — bring your own catalog, gate the checkout (P2)

**Goal**: a custom catalog + an injected gate compose with zero glue.

- [ ] T020 [P] [US3] Contract test (CT3/CT4): update `storefront-gate.test.ts` to the extracted storefront —
      whiskey ⇒ age gate (minAge 21), headphones ⇒ none, payment last, priced `Order` feeds `requirements()`
      with no mapping.
- [ ] T021 [P] [US3] Contract test: `createStorefront({ catalog: customCatalog })` sells custom products and
      gates age conditionally on the custom catalog's `minimumAge`, with no package code change; in
      `packages/attesto-storefront/src/server.test.ts`.
- [ ] T022 [US3] Update `examples/storefront.mjs` to the extracted storefront (still ~8 lines; HTTP `listen`).
- [ ] T023 [US3] Verify: composition + custom-catalog + example green; commit (DCO).

**Checkpoint**: "own-the-code, catalog-injected" + zero-glue composition proven.

## Phase 6: Polish & cross-cutting

- [ ] T024 [P] Publish-readiness (FR-013): verify `packages/attesto-storefront/package.json` `exports`
      (`.` + `./server`), `files` (ships `dist` incl. the `ui/` bundle), `types`, `publishConfig: { access:
      public }`; `npm pack --dry-run` sanity; update `packages/attesto-storefront/README.md` to `createStorefront`.
- [ ] T025 [P] Docs: this `quickstart.md` + root `README.md`/`ROADMAP.md` lead with the **npm-install adopter
      flow**; document widget-renders-in-Claude/ChatGPT vs text-in-Goose, and that the caBLE gate page is
      feature 003.
- [ ] T026 [P] No-regression: the demo's `/llms.txt` + `/.well-known/attesto.json` (`attesto-discovery.ts`)
      stay accurate after the refactor (tools/shape unchanged).
- [ ] T027 Final gate: `npm run build` green (deploy-safe, Vercel pipeline unchanged) + full `npm test` green
      (excl. `.worktrees`); confirm no served-origin change. Optionally run `/speckit-analyze`.

---

## Dependencies

- **Setup (T001–T002)** → everything.
- **Foundational (T003–T005)** → all user stories (state + catalog model + the `createStorefront` skeleton).
- **US1 (T006–T014)** → the package is the real storefront; depends only on Foundational.
- **US2 (T015–T019)** → depends on US1 (the package must serve the tools/widget before the demo can consume them).
- **US3 (T020–T023)** → depends on US1 (the resolver/tools); independent of US2's demo refactor.
- **Polish (T024–T027)** → after the stories it documents/verifies.

## Parallel opportunities

- US1 contract tests **T006–T009** in parallel (same new test file, different cases — or split files).
- Foundational **T004** ‖ the test-writing.
- Polish **T024, T025, T026** in parallel (package.json / docs / discovery — different files).
- US3 **T020, T021** in parallel (composition vs custom-catalog).

## Implementation strategy

- **MVP = US1** (Phases 1–3): `createStorefront()` is the real storefront (widget + tools + page) over HTTP,
  with the contract tests. Validate the widget renders in the Claude native app.
- Then **US2** (the demo consumes it — the brownfield safety; 242 green) and **US3** (BYO catalog + composition).
- **Polish** last — but T024/T025 (publish-readiness + npm-install quickstart) are the adopter story, and
  T027 is the deploy-safety gate that must pass before "done."
- The caBLE gate page is **feature 003** (`attesto.mount()` serves `payment-gate/`) — explicitly out of scope here.
