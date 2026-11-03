# Quickstart — Attesto Storefront (002)

Validates the storefront extraction: a one-line `createStorefront()` that returns the demo's real storefront
(rich widget + 9 tools + checkout page) and that Attesto mounts onto. API source of truth:
[`contracts/credentagent-storefront.api.md`](./contracts/credentagent-storefront.api.md); shapes in
[`data-model.md`](./data-model.md).

## Adopt in your project (the real flow — from npm)

> **Pending publish.** Works once the `@openmobilehub` scope is reserved and the packages are published
> (`npm publish --access public`, a release step). Until then, use the clone path below.

```bash
npm install @openmobilehub/attesto-storefront @openmobilehub/attesto-gate
```

```ts
import { createStorefront } from "@openmobilehub/attesto-storefront/server";
import { Attesto, age, membership, payment, required, optional } from "@openmobilehub/attesto-gate";

const store = createStorefront();                 // the whole storefront — widget + 9 tools + checkout page
const attesto = new Attesto();
attesto.mount(store.app);                          // Attesto mounts onto it (ceremony routes — feature 003)
store.gate((order) => attesto.requirements(order, [
  required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
  optional(membership.discount(10)),
  required(payment.in("usd")),
]));
const { url } = await store.listen(3005);          // → http://localhost:3005/mcp
```

Add `http://localhost:3005/mcp` to a **widget-capable host** (Claude native app / claude.ai / ChatGPT) →
the **native product-picker renders** (browse the grid, adjust quantities, check out). In a no-GUI host
(Goose, terminal) the tools surface as text — a documented host limitation.

## Run the demo / contribute (from a clone)

```bash
git clone … && cd mcp-apps-shopping-demo
npm install                # workspaces: links @openmobilehub/attesto-*
npm run build              # build:packages (vite ui bundle + tsc) → typecheck → app
PORT=3001 DEMO_MODE=1 node dist/main.js     # → http://localhost:3001/mcp
```

The demo now **consumes** the package (no duplicated storefront code) and behaves identically.

## Validation

### 1. Build (deploy-safe)

```bash
npm run build
```

**Expected**: exits 0; `build:packages` produces the package's TS output **and** the single-file widget
bundle (`packages/attesto-storefront/dist/ui/mcp-app.html`) **before** the app build. Vercel runs the same
`npm run build`, so green ⇒ deploy-safe.

### 2. Package + composition tests

```bash
npx vitest run packages/attesto-storefront storefront-gate.test.ts --exclude '**/.worktrees/**'
```

**Expected**: green — the nine tools registered; `checkout` ungated → plain link / gated → `requires` (age
gate, payment last); the priced `Order` feeds `requirements()` with zero glue; the `ui://` resource present;
state per order/session (no bleed). (Contract tests in [`contracts/`](./contracts/credentagent-storefront.api.md).)

### 3. Demo parity (no regression)

```bash
npm test
```

**Expected**: the full suite stays green (currently 242 / 1 known skip) — the demo consuming the package
behaves identically.

### 4. Widget renders (manual)

Connect `http://localhost:3001/mcp` (demo) or `http://localhost:3005/mcp` (your storefront) to the **Claude
native app**: *"show me what you sell"* → the product grid renders natively (not text); *"add the whiskey
and check out"* → the agent surfaces age 21+ + the checkout card.

## Done when

- [ ] `npm run build` green; the widget bundle is produced before the app build (deploy-safe)
- [ ] package + composition tests green (9 tools / gated+ungated / zero-glue / ui resource / per-order state)
- [ ] full `npm test` green — demo parity (no regression)
- [ ] widget renders natively in a widget-capable host; text fallback in a no-GUI host
- [ ] `createStorefront()` + `attesto.mount()` + `store.gate()` works in ≤ 10 adopter lines
