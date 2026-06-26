# Quickstart — Attesto SDK v0.1

The gate is only useful gating a real **storefront**, so this shows the two components **together**: a
storefront (a catalog + a `checkout` MCP tool + a checkout page) with the gate wrapped around its checkout.
API source of truth: [`contracts/attesto-gate.api.md`](./contracts/attesto-gate.api.md); shapes in
[`data-model.md`](./data-model.md).

## 1 · Start from a storefront

The gate wraps an MCP `checkout` tool, so you need a storefront first — two ways:

- **Fastest — the reference demo** (storefront + gate already composed): clone this repo, then
  `npm install && npm run build && PORT=3001 node dist/main.js`; add `http://localhost:3001/mcp` to Claude
  or Goose. You immediately have an agentic storefront with credential-gated checkout.
- **Your own MCP server:** bring a `checkout` tool; `@openmobilehub/attesto-storefront` supplies the
  catalog/pricing model (`priceCart` / `createOrder`). *(The full own-the-code storefront — the 9 MCP
  shopping tools + the widget — is its own component, `specs/002`, on the roadmap.)*

## 2 · Add the gate to its checkout tool

```ts
import { Attesto, age, membership, payment, required, optional } from "@openmobilehub/attesto-gate";
import { z } from "zod";

const attesto = new Attesto({ walletOrigin: "https://shop.example" });
attesto.mount(app);   // serves the wallet ceremony on your origin + owns the per-order verification store

// You decide what counts as age-restricted in your catalog — the SDK never guesses. Here the alcohol
// items carry `minimumAge: 21` (re-derived onto the order line):
const hasAlcohol = (order) => order.lines.some((l) => l.minimumAge != null);

server.registerTool(
  "checkout",
  {
    description: "Check out the cart",
    inputSchema: { items: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive() })) },
  },
  async ({ items }) => {
    const order = priceCart(items, catalog);                // your storefront prices the cart → order (stable id)
    const requires = attesto.requirements(order, [          // resolved, serializable manifest
      required(age.over(21).when(hasAlcohol)),               // 21+ — only when the cart has alcohol
      optional(membership.discount(10)),                     // 10% off if a loyalty credential is presented
      required(payment.in("usd")),                           // amount derived from the order; settles last
    ]);
    return {
      structuredContent: { orderId: order.id, checkoutUrl: yourCheckoutPage(order), requires },
      content: [{ type: "text", text: `Checkout ready: ${yourCheckoutPage(order)}` }],
    };
  },
);
```

### Or — let your coding agent wire it (no hand-coding)

Don't want to wire it yourself? Point **Claude Code** (or any coding agent) at this quickstart — or the
package's **`llms.txt`** / **`/.well-known/attesto.json`**, which **ship today** — and ask:

> *"Add Attesto to my `checkout` tool: require age 21+ when the cart has alcohol, an optional membership
> discount, and payment."*

The agent reads your `registerTool` handler, installs the package, wraps it with `requirements(...)`, calls
`mount(app)`, and adds the security-bypass test — the integration writes itself. 🔭 A dedicated
**`attesto-gate-my-tool`** skill that does this in one command is on the roadmap (v0.2); the runtime
discovery it relies on already ships.

**What happens** (the three contexts, spec §0): the handler mints the link + a `requires` manifest
(Context 1); the buyer opens it once and does age → membership discount → pay on one page (Context 2); the
agent polls `get-order-status` and confirms (Context 3). A non-alcohol cart ⇒ `requires` has no `age`
entry, so no age card.

**Add your own gate** — any credential, same policy:

```ts
import { defineCredential, dcql, gate } from "@openmobilehub/attesto-gate";

const prescription = defineCredential({
  id: "prescription",
  request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
  verify: (c) => c.rx_valid === true,
  effect: gate(),
  appliesTo: (order) => order.lines.some((l) => l.requiresRx),   // only for Rx items
  ui: { label: "Prescription", action: "Verify prescription" },
});
// …then drop `required(prescription)` into the same policy array.
```

## Prerequisites

```bash
npm install          # workspaces: links @openmobilehub/attesto-gate
```

## 1. Build stays green (brownfield constraint)

```bash
npm run build        # build:packages → typecheck → vite (ui) → tsc (server)
```

**Expected**: exits 0. `build:packages` builds `@openmobilehub/attesto-gate` before the app. (Vercel runs
the same `npm run build`, so green here ⇒ deploy-safe.)

## 2. Package unit + contract tests

```bash
npx vitest run packages/attesto-gate --exclude '**/.worktrees/**'
```

**Expected**: green, covering the 7 contract tests in `contracts/attesto-gate.api.md` — notably
serialization round-trip (no functions on the wire), conditional drop, payment-last ordering, and the
prescription `appliesTo` example.

## 3. MCP-layer bypass test (the security gate)

```bash
npx vitest run checkout-gate.test.ts --exclude '**/.worktrees/**'
```

**Expected** (in-memory MCP transport, deterministic) — consolidated Mode A: the `checkout` tool *mints the
link and surfaces the requirement*; it never completes the order (there is no MCP place/settle tool):
- **Age-restricted cart** (`oak-whiskey`) → `checkout` returns `structuredContent` with **both** a
  `checkoutUrl` **and** a `requires` that includes `{ credential: "age", effect: "gate", minAge: 21,
  approveUrl: …<this order id> }`. The `approveUrl` decodes to the **same order id**.
- **Non-alcohol cart** (`drift-mouse`) → `requires` has **no** `age` entry; a normal `checkoutUrl` is returned.
- **Enforcement is on the completion path, not the tool:** a `place-order` for the still-unverified
  age-restricted order is refused (`403`, `app.ts:81`) — and a passkey/dc-payment `/verify` likewise.

The completion-path refusal MUST still fail if the gate is removed (Constitution: a test that passes without
the control is useless). The tool returning the link is *not* a bypass — the link is inert until the buyer
verifies on the page.

## 4. Full suite (no regressions)

```bash
npm test             # vitest, scoped to the main tree (vite.config.ts excludes .worktrees)
```

**Expected**: green. (One pre-existing `app.test.ts` `/mcp`-over-HTTP concurrency flake is known and
tracked separately; the Attesto tests use the in-memory transport and are deterministic.)

## 5. End-to-end against the live demo (manual, optional)

```bash
PORT=3001 node dist/main.js          # or: add https://mcp-apps-nine.vercel.app/mcp as a connector
```

In an MCP host: *"Add the Oak Reserve Whiskey and check out."* → the agent relays the `requires` manifest
("verify age 21+ … on your phone"), the checkout page shows the **age + (membership discount) + pay** cards
in one session (Context 2), and `get-order-status` reports completion (Context 3). A headphones-only cart
checks out with **no age card**.

## Done when

- [ ] `npm run build` green (deploy-safe)
- [ ] package contract tests green (serialization / conditional / ordering / extensibility)
- [ ] `checkout-gate.test.ts` green and fails-closed without the gate
- [ ] full `npm test` green (no regressions)
- [ ] demo: alcohol → age card appears; non-alcohol → no age card
