# Feature Specification: Attesto Storefront — package the demo's storefront as a one-line module

**Feature Branch**: `feat/attesto-gate-v0.1` (continues v0.1; brownfield, demo-consumes-package)

**Created**: 2026-06-26

**Status**: Draft

**Input**: Extract the reference demo's real storefront (the rich React widget + the 9 MCP shopping tools +
the checkout page + cart/order state) into `@openmobilehub/attesto-storefront` so an adopter gets it in one
line — `createStorefront()` — and Attesto mounts onto it. Supersedes the minimal hand-written
`createStorefront()` (plain tools + stub page). The FIDO caBLE ceremony is **out of scope** (feature 003).

## Why

Testing the v0.1 minimal storefront in Goose surfaced two gaps: **(1)** the UI is just text — there is no
widget; **(2)** the checkout page is a bare stub. The reference demo already *has* a great storefront — a
single-file React product-picker, nine shopping tools, and a real checkout page. Rather than hand-roll a
basic one, **package the demo's storefront**. This feature delivers gap #1 (the rich widget). Gap #2 (the
real caBLE gate page) is the complementary ceremony extraction, **feature 003** (`attesto.mount()` serves
`payment-gate/`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A developer stands up the real storefront in one line (Priority: P1)

A developer adds an agentic storefront to their project by importing `@openmobilehub/attesto-storefront`,
calling `createStorefront()`, and serving it over HTTP. In a widget-capable host (Claude native app /
claude.ai / ChatGPT) they get the **rich product-picker widget**, the nine shopping tools, and a checkout
page — without writing or configuring any of it. They never see the storefront internals.

**Why this priority**: This is the headline value and the direct fix for "the UI is just text." It is the
reason to extract at all — a one-line, full-fidelity storefront.

**Independent Test**: Run `createStorefront().listen(port)`, add the `/mcp` URL to the Claude native app,
and confirm the product grid renders (not plain text) and browse → cart → checkout works.

**Acceptance Scenarios**:

1. **Given** an empty project that depends on the package, **When** the developer calls `createStorefront()`
   and `listen(3005)`, **Then** an MCP server is served over HTTP at `/mcp` with the nine shopping tools and
   the widget UI resource registered.
2. **Given** the storefront is connected to a widget-capable host, **When** the agent calls `browse-products`
   or `checkout`, **Then** the host renders the native widget (the product grid / checkout card), not text.
3. **Given** a no-GUI host (Goose, terminal), **When** the same tools are called, **Then** the tool results
   surface as text — a documented host limitation, not a failure.
4. **Given** the storefront is connected to **ChatGPT**, **When** the buyer uses the widget, **Then** the
   in-widget actions work (quantity steppers and the **Checkout** button invoke their tools — not silently
   no-op) and the checkout render shows the **actual cart** (not an empty one). (FR-014.)

---

### User Story 2 - The demo keeps working by consuming the package (Priority: P1)

The reference demo is refactored so its storefront logic lives in the package and the demo **consumes**
`@openmobilehub/attesto-storefront` (the demo becomes a thin host: entrypoints + the gate policy + the
ceremony). The demo behaves identically; nothing a user sees changes.

**Why this priority**: This is the load-bearing brownfield constraint. The live deploy and the full test
suite must stay green throughout, exactly as the gate extraction (001) did. Without it the extraction is
unsafe to ship.

**Independent Test**: After the refactor, `npm run build` and the full test suite pass unchanged, and the
deployed connector behaves identically to before.

**Acceptance Scenarios**:

1. **Given** the storefront has moved into the package, **When** the demo is built and run, **Then** the
   demo imports the storefront from the package (no duplicated storefront code) and all nine tools behave
   identically.
2. **Given** the existing test suite (currently 242 passing / 1 known skip), **When** it runs after the
   refactor, **Then** 100% still pass.
3. **Given** the npm-workspaces build, **When** `npm run build` runs, **Then** the package builds both its
   TypeScript output and the single-file widget bundle before the app build, and the result is deploy-safe
   (Vercel runs the same `npm run build`).

---

### User Story 3 - Bring your own catalog, gate the checkout (Priority: P2)

An adopter passes their own catalog and injects a credential gate. The storefront's priced order feeds
`attesto.requirements()` with **zero glue**, and the checkout tool surfaces the resulting `requires`
manifest.

**Why this priority**: Proves the "own-the-code, catalog-injected" promise and the clean composition with
`@openmobilehub/attesto-gate` — the reason the two packages are separate.

**Independent Test**: `createStorefront({ catalog })` + `store.gate((order) => attesto.requirements(order,
policy))`; an age-restricted item surfaces the age gate, a non-restricted cart does not — asserted over the
in-memory transport.

**Acceptance Scenarios**:

1. **Given** a custom catalog, **When** `createStorefront({ catalog })` is called, **Then** the storefront
   sells those products with no package code change.
2. **Given** a gate is injected via `store.gate(...)`, **When** the cart has an age-restricted item, **Then**
   `checkout` returns a `requires` manifest carrying the age gate; an un-gated storefront returns a plain
   link.
3. **Given** the storefront's priced `Order`, **When** it is passed to `attesto.requirements(order, policy)`,
   **Then** it is accepted directly (the line carries `minimumAge` — the seam from 001) with no
   `toGateOrder` mapping.

---

### Edge Cases

- **No-GUI host**: a host without MCP Apps UI (Goose, terminal) renders tool output as text. Documented;
  the storefront still functions (browse/checkout/status work).
- **Widget bundle absent** (build not run): the server still starts and the tools work; the UI resource
  degrades gracefully (the host shows text) rather than crashing.
- **Empty cart checkout** / **unknown product ids**: handled as today (empty cart → an error result; unknown
  ids collected, not thrown).
- **Custom catalog with no age-restricted items**: checkout never surfaces an age gate.
- **Storefront used WITHOUT `attesto.mount()`**: the checkout page renders the order + requirements, but the
  ceremony "verify" links resolve only once `mount()` provides them (feature 003) — the standalone page is
  informational until then.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The package MUST expose `createStorefront(opts?)` returning a storefront handle exposing, at
  minimum: the Express `app` (the `mount()` target), an `mcpServer()` factory (for in-memory tests), a
  `gate(resolve)` injector, `listen(port)`, and the resolved `catalog`.
- **FR-002**: `createStorefront` MUST serve the MCP server over HTTP at `/mcp` and register the **nine**
  shopping tools (`browse-products`, `add-to-cart`, `set-quantity`, `remove-from-cart`, `get-cart`,
  `get-product-details`, `get-product-reviews`, `checkout`, `get-order-status`).
- **FR-003**: The package MUST ship the **single-file React widget** and register it as the UI resource so a
  widget-capable host renders the native product-picker; runtime host detection (Claude / ChatGPT /
  standalone) MUST be preserved.
- **FR-004**: When a gate is registered via `store.gate(resolve)`, `checkout` MUST include the resolved
  `requires` manifest in its result; with no gate it MUST return a plain checkout link.
- **FR-005**: The storefront's priced `Order` MUST feed `attesto.requirements()` with no mapping — each line
  carries `minimumAge` (and `category`), the seam established in feature 001.
- **FR-006**: The catalog MUST be injectable (bring your own products); `SAMPLE_CATALOG` is the default.
- **FR-007**: The checkout page MUST render the order and the required credentials and **link** to the
  ceremony routes that `attesto.mount()` provides; the page MUST NOT itself implement the ceremony (that is
  feature 003).
- **FR-008**: The reference demo MUST be refactored to **consume** the package — no duplicated storefront
  code — and behave identically (no user-visible change).
- **FR-009**: The package build MUST produce both the TypeScript output and the widget bundle, within the
  npm-workspaces build order (`build:packages` before the app build), and stay Vercel-safe.
- **FR-010**: The six CLAUDE.md security invariants MUST be preserved — amounts and age re-derived
  server-side, per-order verification/cart state keyed by order/session (never process-global), explicit
  positive claims, origin/nonce binding unchanged.
- **FR-011**: The FIDO caBLE ceremony (`payment-gate/`) MUST remain out of this package; it is served by
  `attesto.mount()` in feature 003. This feature delivers the widget (gap #1), not the caBLE page (gap #2).
- **FR-012**: `examples/storefront.mjs` and `storefront-gate.test.ts` MUST be updated to the extracted
  storefront and stay green; every commit DCO-signed.
- **FR-013**: The package MUST be **publish-ready** for the npm registry — correct `exports` (incl. the
  `./server` subpath and the shipped widget bundle), `files`, `types`, and `publishConfig` — so an adopter
  installs `@openmobilehub/attesto-gate` + `@openmobilehub/attesto-storefront` from npm in their **own**
  project (not a clone). The **final quickstart MUST present the npm-install path as the primary adopter
  flow**; the clone + workspace `npm install` path is for running this demo / contributing only. (The actual
  `npm publish` + `@openmobilehub` scope reservation is a release action, OUT of code scope.)
- **FR-014**: The widget MUST render **and be interactive in ChatGPT**, not only the Claude native app.
  Concretely (diagnosed against the current demo, which renders but is interactively dead):
  - The package MUST emit the full ChatGPT widget contract on UI-linked tools — `openai/outputTemplate`
    **and `openai/widgetAccessible: true`** (which authorizes `window.openai.callTool`) plus the
    `openai/toolInvocation` status — via a single canonical tool-meta builder (the demo's `UI_META` sets
    only `outputTemplate`, so in-widget steppers and the **Checkout button silently no-op**).
  - Widget-rendering tool results MUST carry **cart-bearing `structuredContent`** — the `checkout` result
    must include `products`/`cart`, not only `{ orderId, checkoutUrl, requires }`, so a fresh ChatGPT widget
    instance does not render an **empty cart**.
  - The widget CSP MUST allow the `data:` image placeholder; the ChatGPT bridge MUST persist/restore cart
    via `setWidgetState` (cross-instance) and read globals via `openai:set_globals`.
  - SUSPECTED, verify live in ChatGPT: `openExternal` method name, `detectHost` injection timing,
    `connect_domains` vs the order-status poll origin, the `set_globals` event-name dependency.

### Key Entities *(include if feature involves data)*

- **Storefront** (the `createStorefront` handle): `app`, `mcpServer()`, `gate(resolve)`, `listen(port)`,
  `catalog`. The unit an adopter composes with `Attesto`.
- **Catalog / Product**: injected products (id, name, price, category, optional `minimumAge`).
- **PricedCart / Order**: the cart→priced→order model; `Order` lines carry `minimumAge`/`category` so they
  are gate-ready.
- **Widget bundle**: the single-file `mcp-app.html` the package ships and registers as the UI resource.
- **GateResolver**: the injected `(order) => requires | undefined` function — the seam where Attesto mounts on.
- **Cart / Order / Verification state**: per session/order, never process-global.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer stands up the storefront and connects it to an MCP host with **≤ 10 lines** of
  their own code and in **under 5 minutes**.
- **SC-002**: In a widget-capable host, the **native product-picker renders** (not text) for browse and
  checkout.
- **SC-003**: After the demo is refactored to consume the package, **100%** of the existing tests pass
  (currently 242 / 1 known skip) and the live deploy stays green.
- **SC-004**: The storefront's order feeds the gate with **zero** mapping/glue lines.
- **SC-005**: An adopter swaps in a **custom catalog** with **no** package code change.
- **SC-006**: The reference demo's storefront code is **not duplicated** — it lives once, in the package.

## Assumptions

- The rich widget renders only in hosts supporting MCP Apps UI (Claude native app / claude.ai / ChatGPT);
  no-GUI hosts (Goose, terminal) surface text. This is accepted and documented, not a defect.
- The package builds the widget itself (vite + single-file plugin) as part of `build:packages`; the bundle
  is not hand-committed.
- The FIDO caBLE ceremony is **feature 003**; this feature's checkout page links to the routes `mount()`
  will serve. The full verify-and-complete loop needs 003 (or the demo, which already has the ceremony).
- Work continues on `feat/attesto-gate-v0.1` (brownfield); the demo consumes the package — do not branch
  off `main` and lose the 001 work.
- Transport is HTTP (StreamableHTTP `/mcp`), per the stated preference; stdio is not required.
- Cart/order/verification state is owned internally by the storefront (in-memory by default, pluggable
  later), keyed per session/order.
- Governance: Constitution v1.0.0.
