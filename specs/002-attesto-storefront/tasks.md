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
  the nine MCP tools + the checkout page over HTTP; the widget **renders AND is interactive** in a
  widget-capable host (incl. ChatGPT — FR-014). *Testable via `packages/attesto-storefront/src/server.test.ts`
  (in-memory transport) + a manual widget check in the Claude native app and ChatGPT.*
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

- [X] T001 Add the widget build to `packages/attesto-storefront`: add deps (`react`, `react-dom`,
      `@vitejs/plugin-react`, `vite`, `vite-plugin-singlefile`, `@modelcontextprotocol/ext-apps`); create
      `packages/attesto-storefront/vite.config.ts` (react + singlefile, input `src/ui/mcp-app.html`, outDir
      `dist/ui`); set `package.json` `build` = `vite build && tsc -p tsconfig.json`; `files` ships `dist`.
- [ ] T002 [P] Scaffold the module layout per `plan.md` in `packages/attesto-storefront/src/`: `tools.ts`,
      `catalog-tools.ts`, `checkout-page.ts`, `state.ts`, `tool-meta.ts`, `ui/` (placeholders); keep
      `index.ts` (pricing) + `server.ts`.

## Phase 2: Foundational (blocking — primitives every story needs)

- [X] T003 Move cart/order state into `packages/attesto-storefront/src/state.ts` (`cartStore` + `orderStore`,
      in-memory default, keyed per session/order — never process-global); export them.
- [X] T004 [P] Extend the catalog model in `packages/attesto-storefront/src/index.ts`: add `Review` +
      `StorefrontOptions.reviews`; keep `Product` (`minimumAge`/`category`), `SAMPLE_CATALOG`, and the
      pricing functions unchanged.
- [X] T005 Rewrite `createStorefront()` skeleton in `packages/attesto-storefront/src/server.ts` — `app`
      (`createMcpExpressApp`), `mcpServer()` factory (no tools yet), `gate(resolve)`, `listen()`, `catalog`;
      the HTTP `/mcp` route (StreamableHTTP, mirroring `app.ts`). Supersedes the v0.1 minimal storefront.

**Checkpoint**: package builds (vite + tsc); `createStorefront()` serves an empty `/mcp`.

## Phase 3: User Story 1 — the real storefront in one line (P1)

**Goal**: `createStorefront()` serves the nine tools (six UI-linked + three plain) + the checkout page over HTTP and registers
the `ui://` widget; the product-picker **renders AND works** in a widget-capable host (incl. ChatGPT).
**Independent test**: `server.test.ts` + manual.

- [X] T006 [P] [US1] Contract test (CT1): `mcpServer()` registers exactly the nine tools, in
      `packages/attesto-storefront/src/server.test.ts` (in-memory transport).
- [X] T007 [P] [US1] Contract test (CT2/CT3): `checkout` ungated ⇒ `{ orderId, checkoutUrl }`; with a stub
      gate resolver ⇒ `+ requires`; in `packages/attesto-storefront/src/server.test.ts`.
- [X] T008 [P] [US1] Contract test (CT5): the `ui://` resource is registered; the **six** UI-linked tools
      carry the tool-meta and the **three** plain tools (`get-product-details`/`get-product-reviews`/
      `get-order-status`) do NOT; in `packages/attesto-storefront/src/server.test.ts`.
- [X] T009 [P] [US1] Contract test (CT6): cart/order state is per session/order — two orders don't bleed; in
      `packages/attesto-storefront/src/server.test.ts`.
- [X] T010 [US1] Move the widget: repo-root `src/app.tsx` (+ helpers, ~574 LOC) → `packages/attesto-storefront/src/ui/`;
      `mcp-app.html` as the vite entry; build the single-file bundle to `dist/ui/`. Preserve runtime host
      detection (`chatgpt`/`mcp`/`standalone`).
- [X] T011 [US1] Move the nine tools into `packages/attesto-storefront/src/tools.ts` + `catalog-tools.ts`,
      **preserving the demo's split** — six UI-linked (`registerAppTool` via the shared tool-meta) + three
      plain (`registerTool`: `get-product-details`/`get-product-reviews`/`get-order-status`); `checkout` keeps
      Mode A and calls the injected `gate` resolver (the priced `Order` feeds it directly, no `toGateOrder`);
      register them in `mcpServer()`.
- [X] T012 [US1] Move the checkout page: `checkout.ts` → `packages/attesto-storefront/src/checkout-page.ts`;
      serve `GET /checkout` on `store.app`; render the order + the `requires`; **link** to the ceremony
      routes (`/credential-gate/age`, passkey, dc-payment) — do NOT implement the ceremony (feature 003).
- [X] T013 [US1] Register the `ui://` widget resource in `createStorefront()` (`registerAppResource`,
      bundle-version stamping), serving the single-file bundle with mime `text/html+skybridge`.

### ChatGPT widget contract (US1, FR-014) — the widget must render AND be interactive in ChatGPT

- [X] T014 [P] [US1] Contract test (CT9, FR-014): every UI-linked tool's `_meta` carries `openai/outputTemplate`
      (== the `ui://` resource URI) **and `openai/widgetAccessible: true`** + the `openai/toolInvocation`
      status; in `packages/attesto-storefront/src/server.test.ts` (assert via `tools/list`).
- [X] T015 [US1] Implement a single canonical tool-meta builder in
      `packages/attesto-storefront/src/tool-meta.ts` that emits **both** surfaces — the MCP-Apps `ui.*` form
      **and** the `openai/*` set (`outputTemplate`, **`widgetAccessible: true`**, `toolInvocation` invoking/
      invoked) — and use it for the six UI-linked tools. (Root cause of "renders but dead in ChatGPT": the
      demo's `UI_META` set only `outputTemplate`, so `window.openai.callTool` was rejected.)
- [X] T016 [US1] Make widget-rendering tool results carry **cart-bearing `structuredContent`** — `checkout`
      returns `{ ...payload, products, cart }` (not only `{ orderId, checkoutUrl, requires }`) so a fresh
      ChatGPT widget instance hydrates the real cart instead of `emptyCart()`; decide per tool whether it
      should carry the UI meta at all. In `packages/attesto-storefront/src/tools.ts`.
- [ ] T017 [US1] Harden the ChatGPT bridge in the widget (`src/ui/`): add `data:` to the widget CSP
      `resource_domains` (the SVG image placeholder); persist/restore cart via `window.openai.setWidgetState`
      (cross-instance sync) reading globals from `openai:set_globals`; resilient host detection (re-detect/
      subscribe, not a single module-load read); an `openExternal` fallback; and surface (not swallow)
      poll/connect failures. Centralize the checkout origin so `connect_domains` and the poll URL share one config.
- [ ] T018 [US1] Verify (CT8 build): `npm run build:packages` green (the widget bundle is produced) +
      `server.test.ts` green; commit (DCO).

**Checkpoint**: US1 is a shippable MVP — `createStorefront()` is the real storefront over HTTP; manual check:
the widget renders **and is interactive** in the Claude native app AND ChatGPT.

## Phase 4: User Story 2 — the demo consumes the package (P1)

**Goal**: the demo's storefront code lives only in the package; the demo wires `createStorefront()` +
`mount()` + the gate policy + the ceremony and behaves identically. **Independent test**: `npm test` + `npm run build`.

- [ ] T019 [US2] Refactor `server.ts` to build the tools via `createStorefront({ catalog })` and inject the
      gate policy (`store.gate((order) => attesto.requirements(order, [required(age.over(21).when(hasAlcohol)),
      optional(membership.discount(10)), required(payment.in("usd"))]))`); delete the moved tool code +
      `toGateOrder` (now zero-glue).
- [ ] T020 [US2] Refactor `app.ts` to use `createStorefront(...).app`, then `attesto.mount(app)` and register
      the **ceremony** (`registerCredentialGate`/`registerPasskeyGate`/`registerDcPaymentGate`) on `store.app`;
      keep discovery (`/llms.txt`, `/.well-known/attesto.json`); the checkout page now comes from the package.
- [ ] T021 [US2] Inject the demo's catalog (`catalog.ts` products + reviews) into `createStorefront({ catalog,
      reviews })`; reconcile the demo's product/review data with the package's `Product`/`Review` model.
- [ ] T022 [US2] Remove the now-duplicated repo-root storefront code (the `src/` widget, `checkout.ts`,
      `cartStore.ts`, `orderStore.ts` — moved to the package); update the root `vite.config.ts` /
      `tsconfig.server.json` so the root build no longer builds the widget (the package does) and the build
      order stays `build:packages` → app, Vercel-safe.
- [ ] T023 [US2] Verify (CT7 demo parity): full `npm test` green (242 / 1 known skip — demo parity, no regression) + `npm run
      build` green (deploy-safe; Vercel pipeline unchanged); commit (DCO).

**Checkpoint**: the demo is a thin consumer; nothing a user sees changed; the deploy stays green.

## Phase 5: User Story 3 — bring your own catalog, gate the checkout (P2)

**Goal**: a custom catalog + an injected gate compose with zero glue.

- [ ] T024 [P] [US3] Contract test (CT3/CT4): update `storefront-gate.test.ts` to the extracted storefront —
      whiskey ⇒ age gate (minAge 21), headphones ⇒ none, payment last, priced `Order` feeds `requirements()`
      with no mapping.
- [ ] T025 [P] [US3] Contract test: `createStorefront({ catalog: customCatalog })` sells custom products and
      gates age conditionally on the custom catalog's `minimumAge`, with no package code change; in
      `packages/attesto-storefront/src/server.test.ts`.
- [ ] T026 [US3] Update `examples/storefront.mjs` to the extracted storefront (still ~8 lines; HTTP `listen`).
- [ ] T027 [US3] Verify: composition + custom-catalog + example green; commit (DCO).

**Checkpoint**: "own-the-code, catalog-injected" + zero-glue composition proven.

## Phase 6: Polish & cross-cutting

- [ ] T028 [P] Publish-readiness (FR-013): verify `packages/attesto-storefront/package.json` `exports`
      (`.` + `./server`), `files` (ships `dist` incl. the `ui/` bundle), `types`, `publishConfig: { access:
      public }`; `npm pack --dry-run` sanity; update `packages/attesto-storefront/README.md` to `createStorefront`.
- [ ] T029 [P] Docs: this `quickstart.md` + root `README.md`/`ROADMAP.md` lead with the **npm-install adopter
      flow**; document widget-renders-in-Claude/ChatGPT vs text-in-Goose, and that the caBLE gate page is
      feature 003.
- [ ] T030 [P] No-regression: the demo's `/llms.txt` + `/.well-known/attesto.json` (`attesto-discovery.ts`)
      stay accurate after the refactor (tools/shape unchanged).
- [ ] T031 [P] ChatGPT live-verification (FR-014, manual): connect the storefront to ChatGPT and walk the
      verification checklist — `tools/list` shows `widgetAccessible: true`; in-widget steppers + Checkout
      invoke (not no-op); checkout renders the real cart (not empty); `openExternal` opens the page; the
      order-status poll completes (watch for `connect-src` CSP blocks); a forced image 404 shows the `data:`
      placeholder; no sandbox console errors on mount. Record any still-broken suspect for a follow-up.
- [ ] T032 Final gate: `npm run build` green (deploy-safe, Vercel pipeline unchanged) + full `npm test` green
      (excl. `.worktrees`); confirm no served-origin change. Optionally run `/speckit-analyze`.

---

## Dependencies

- **Setup (T001–T002)** → everything.
- **Foundational (T003–T005)** → all user stories (state + catalog model + the `createStorefront` skeleton).
- **US1 (T006–T018)** → the package is the real storefront (incl. the ChatGPT widget contract); depends only
  on Foundational.
- **US2 (T019–T023)** → depends on US1 (the package must serve the tools/widget before the demo can consume them).
- **US3 (T024–T027)** → depends on US1 (the resolver/tools); independent of US2's demo refactor.
- **Polish (T028–T032)** → after the stories it documents/verifies (T031 ChatGPT verify needs US1+US2 running).

## Parallel opportunities

- US1 contract tests **T006–T009** and **T014** in parallel (same new test file, different cases — or split files).
- Foundational **T004** ‖ the test-writing.
- Polish **T028, T029, T030, T031** in parallel (package.json / docs / discovery / ChatGPT-verify — different surfaces).
- US3 **T024, T025** in parallel (composition vs custom-catalog).

## Implementation strategy

- **MVP = US1** (Phases 1–3): `createStorefront()` is the real storefront (widget + tools + page) over HTTP,
  with the contract tests **and the ChatGPT widget contract (FR-014)** so the widget renders *and works* in
  ChatGPT, not only Claude. Validate manually in both hosts.
- Then **US2** (the demo consumes it — the brownfield safety; 242 green) and **US3** (BYO catalog + composition).
- **Polish** last — but T028/T029 (publish-readiness + npm-install quickstart) are the adopter story, T031 is
  the ChatGPT live-verification, and T032 is the deploy-safety gate that must pass before "done."
- The caBLE gate page is **feature 003** (`attesto.mount()` serves `payment-gate/`) — explicitly out of scope here.
