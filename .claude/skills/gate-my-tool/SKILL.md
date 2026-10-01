---
name: gate-my-tool
description: Use when an existing MCP server has a tool that completes a consequential action — a checkout, a place-order, an access grant — without consent, and it must be gated with CredentAgent ("gate my checkout tool", "require an age/payment credential before this tool completes"). Do NOT use for adding a new ceremony rail inside the gate package (use add-ceremony-rail) or for storefront/pricing work.
---

# Gate an MCP tool with CredentAgent

One run of this skill turns an ungated `registerTool` handler into a gated one and
leaves behind the proof: **(1)** the tool returns an approve link + `requires`
manifest instead of completing, **(2)** completion happens only through the mounted
`/credentagent/*` ceremony, **(3)** a bypass test pins it. Do all three — a gated
tool without its bypass test is not done.

## Step 0 — find the tool and its completion path

- Locate the `registerTool` handler that **settles/fulfills** (writes the order,
  charges, grants access). That write is what moves behind the gate.
- Find the Express-shaped `app` the server runs on. If the MCP server has no HTTP
  app (stdio-only), create one — the ceremony pages need an origin to live on.
- **Pick the wiring** (default to `orders`):

| Host shape | Wiring |
| :-- | :-- |
| The tool can hand the order lifecycle to the gate (most servers) | `credentagent.orders` — serve once, `create()` per purchase |
| Host already owns catalog + order stores + its own checkout route | `defineHost(...)` + `host.complete(...)` — see `examples/bring-your-own-host.mjs` |

## Steps (orders wiring)

1. `npm install @openmobilehub/credentagent-gate` (ESM, Node ≥ 20).
2. **Once, at startup** — configure, serve, subscribe:

```js
import { CredentAgent, age, payment, required } from "@openmobilehub/credentagent-gate";

const credentagent = new CredentAgent({ walletOrigin: PUBLIC_ORIGIN }); // http://localhost:PORT in dev
credentagent.orders.serve(app);                      // ceremony rails + each order's approve page
credentagent.on("order.settled", ({ id }) => fulfill(id)); // fulfillment moves HERE, after proof
```

3. **Rewrite the tool handler** — it mints the link and reports requirements; it
   never completes and never runs a ceremony (there is no phone in the loop):

```js
// BEFORE (ungated): the handler settles immediately
fulfilled.set(order.id, { ...order, settled: true });
return { structuredContent: { orderId: order.id, settled: true } };

// AFTER (gated): price server-side from YOUR catalog (never client input), then open a gated order
const order = priceOrder(items, "");                 // { id, total, currency, lines[] } — a GateOrder; empty id → the gate mints one
const { id, approveUrl, manifest } = await credentagent.orders.create({
  order,
  policy: [
    required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
    required(payment.in("usd")),                     // amount derived from the order; settles last
  ],
});
return { structuredContent: { orderId: id, approveUrl, requires: manifest } };
```

   Derive the policy from what the tool sells: `minimumAge` lines → `age.over(n)`
   with the threshold **matching the product's restriction**; money moving →
   `payment.in(currency)`; anything else → `defineCredential(...)`.
4. **Add the poll tool** (MCP has no server→client push): a `get-order-status` tool
   that returns `await credentagent.orders.retrieve(orderId)` — the one typed door
   (`ok` / `pending + approveUrl` / `code`). The agent polls; it never proves.
5. **Write the bypass test.** REQUIRED SUB-SKILL: use write-bypass-test. The attack:
   call the gated tool for a restricted item and attempt no ceremony. Assert
   precisely: the tool result has **no** settled/fulfilled flag, `retrieve(id)`
   returns `{ ok: false, pending: true }`, and the host's fulfillment store is
   empty. Then **prove it load-bearing**: revert the handler to the ungated write,
   confirm the test goes red, restore.
6. **Verify:** host's tests green; bypass test present and proven red-when-removed;
   for a deployment, `credentagent.doctor()` at boot (stable `GATE_SECRET`, public
   `walletOrigin`, shared stores).

## Honesty — say what the gate is

`trust_level` is `"presence-only-demo"`: the wire crypto is real, but there is no
issuer/device trust anchor yet, so a self-crafted credential would pass. Never
describe the gated tool as a real safety control in the host's docs; it enforces
disclosure and binding, not trust.

## Red flags — stop if you catch yourself thinking:

| Thought | Reality |
| :-- | :-- |
| "The tool can complete and ALSO return the approve link." | Then the link proves nothing. The settling write moves behind `order.settled` / `retrieve`. |
| "I'll price the order from the tool's input arguments." | Client input is hand-editable. Re-derive from the host's catalog server-side (invariant 2). |
| "The agent can run the ceremony itself." | The tool mints the link; the human proves on the page; the agent polls. Three contexts, never conflated. |
| "Happy-path test passes, ship it." | A test that passes with the gate removed proves nothing. Prove red-when-removed. |
| "This makes the server safe for real age checks." | `presence-only-demo` — a flow demo, not a safety control. Say so. |
