# Getting started

Attesto is **the consent layer for AI agents**: before a consequential MCP tool
completes — a payment, an age gate, an access grant — the agent must prove a
**verifiable credential** from the user's phone wallet. Identity leads; payments
is just one application. `age.over(21)`, a loyalty membership, a prescription, and
`payment.in("usd")` are all credentials in the same ordered policy.

This page stands up a credential-gated agentic storefront in about ten lines and
connects it to an MCP host. Two npm packages compose with zero glue:

- **[`@openmobilehub/attesto-gate`](https://www.npmjs.com/package/@openmobilehub/attesto-gate)** — the Gate.
  `new Attesto()`, `attesto.mount(app)`, the policy builders (`age` / `membership` /
  `payment` / `defineCredential`), and the real `/attesto/*` ceremony rails.
- **[`@openmobilehub/attesto-storefront`](https://www.npmjs.com/package/@openmobilehub/attesto-storefront)** — a runnable
  MCP shopping server, catalog-injected. `createStorefront()` ships the cart →
  priced-cart → order model, the shopping tools, the widget bundle, and a checkout
  page, and publishes the ceremony seams the Gate mounts onto.

> **Honest status (v0.1).** `trust_level` is `"presence-only-demo"`. The *wire*
> cryptography is real — WebAuthn on the passkey rail; OpenID4VP JWE/ECDH-ES decrypt
> with nonce binding; HPKE; ISO-mdoc parse — but there is **no issuer / device-signature
> trust anchor yet**, and the AP2-shaped mandate is dev-signed (integrity hash), not
> key-signed. A self-crafted mdoc would pass the credential rail. **This is a flow
> demonstration, not a real safety control — never present a presence-only gate as
> one.** Issuer-verified trust (`trust_level: "issuer-verified"`) is the v0.2 line.

## Requirements

- **Node.js ≥ 20** (both packages are ESM and ship their own types).

## Install

```bash
npm install @openmobilehub/attesto-gate @openmobilehub/attesto-storefront
```

Both packages are Apache-2.0 and ESM. `@openmobilehub/attesto-storefront` has two
entry points: `.` (the pure pricing/order model, dependency-light) and `./server`
(the runnable MCP server, which brings in `@modelcontextprotocol/sdk` + `express`).

## Quickstart — a credential-gated storefront in ~10 lines

`createStorefront()` stands up the real MCP server (the shopping tools, a widget
resource, a checkout page) over HTTP at `/mcp`, and publishes ceremony seams on
`store.app.locals.attesto`. `new Attesto().mount(store.app)` reads those seams and
wires the real `/attesto/*` ceremony rails onto the same server. `store.gate()`
resolves your policy on every `checkout` call.

```ts
import { createStorefront } from "@openmobilehub/attesto-storefront/server";
import { Attesto, age, membership, payment, required, optional } from "@openmobilehub/attesto-gate";

const store = createStorefront();                  // the whole storefront — one line
const attesto = new Attesto();                     // zero-config (defaults to http://localhost:3000)
attesto.mount(store.app);                          // wires the real /attesto/* ceremony rails

store.gate((order) =>                              // resolved on every checkout (payment settles LAST)
  attesto.requirements(order, [
    required(age.over(21).when((order) => order.lines.some((l) => l.minimumAge != null))),
    optional(membership.discount(10)),              // 10% off if a loyalty credential is presented
    required(payment.in("usd")),                    // amount derived from the order; settles last
  ]),
);

const { url } = await store.listen(3005);          // → http://localhost:3005/mcp
console.log(`Attesto-gated storefront running → ${url}`);
```

What each line does:

- `createStorefront()` — the storefront, catalog-injected. With no `catalog` passed
  it serves a built-in `SAMPLE_CATALOG` that includes one 21+ item (whiskey) so it
  demos itself. The return value is `{ app, catalog, gate, listen, mcpServer }`.
- `new Attesto()` — the Gate client, zero-config. For a deployment, pass your public
  origin: `new Attesto({ walletOrigin: "https://shop.example" })`.
- `attesto.mount(store.app)` — wires the `/attesto/*` ceremony routes (passkey,
  credential, dc-payment) onto the storefront's Express app.
- `store.gate((order) => …)` — registers your policy resolver. It runs on every
  `checkout` call and returns the `requires` manifest the agent and widget read back.
- `attesto.requirements(order, policy)` — the **code→data boundary**: it runs your
  `.when()` / `appliesTo` predicates **server-side**, sorts `payment` last, and emits a
  flat, JSON-safe manifest. No functions cross the wire.
- `required(c)` / `optional(c)` — wrap each credential to build the ordered policy
  array. `.when((order) => boolean)` attaches a call-site conditional that receives the
  **whole order** (id, total, currency, lines).
- `store.listen(3005)` — starts HTTP and returns `{ url, port }`; the MCP endpoint is
  at `/mcp`.

The product's `minimumAge` is the single field that ties the two packages together:
the storefront re-derives it onto each priced line, so a storefront `Order` feeds
`attesto.requirements()` directly — no mapping. The gate's amount is **re-derived
server-side from the catalog**, never trusted from the order token.

> **Stable challenge key.** A dev server uses an ephemeral per-process challenge key,
> so restarting it invalidates in-flight ceremonies. Set `GATE_SECRET` (passed as
> `createStorefront({ signingKey: process.env.GATE_SECRET })`) for a stable key across
> restarts — the runnable [examples](#runnable-examples) wire this for you.

## Run it

Until the packages are published, build them from the reference monorepo and run an
example:

```bash
npm install
npm run build:packages          # build the two @openmobilehub/attesto-* packages
node examples/storefront.mjs    # → http://localhost:3005/mcp
```

Once the packages are on npm, your own project just needs the install above and
`node your-server.mjs`.

## Add it to an MCP host

The storefront is a **Streamable HTTP** MCP server at `http://localhost:3005/mcp`.
Add that URL as a remote MCP connector in any host:

- **Goose** — `goose configure` → **Add Extension** → **Remote Extension (Streamable
  HTTP)** → URL `http://localhost:3005/mcp`.
- **Claude / ChatGPT** — add it as a remote MCP / custom connector pointing at
  `http://localhost:3005/mcp`. (For hosts that only accept a public HTTPS endpoint,
  deploy the server and pass your origin to `new Attesto({ walletOrigin: "https://…" })`.)

Then drive the flow from chat:

- *"What do you sell?"* → lists the catalog (whiskey is 21+, headphones aren't).
- *"Add the Oak Reserve Whiskey and check out"* → the agent surfaces the **age 21+**
  requirement (plus the optional membership discount and payment) and a checkout link.
- *"Add the Aurora headphones and check out"* → **no age gate** — the `.when()`
  predicate sees no `minimumAge` line and is false.

Open the checkout link to complete the gates end-to-end on the `/attesto/*` page —
prove age → present membership → authorize payment — recorded so the agent's
`get-order-status` poll reflects the (discounted) confirmation.

## How the flow is split (the three execution contexts)

The split is load-bearing — Attesto enforces it, and conflating the contexts is the
documented root cause of confusion. v0.1 is consolidated **Mode A**:

1. **Tool — mints the link + reports requirements.** Your `checkout` handler runs once
   when checkout is requested. There is no phone in the loop, so it runs **no ceremony**
   — it calls `attesto.requirements(order, policy)` and returns
   `{ orderId, checkoutUrl, requires }`.
2. **Page — runs the gates.** The buyer opens the link and completes every verification
   and payment in one browser session, on the `/attesto/*` routes `mount()` serves.
3. **Poll — reports completion.** The agent polls (MCP has no server→client push) and
   reports the result. It never performs the ceremony itself.

Every gate is also **enforced server-side on the completion path** — hiding a button is
not enforcement.

## Next steps

### Gate any action with any credential

The built-in `age` / `membership` / `payment` gates are merely *pre-defined*
credentials. Define your own inline with `defineCredential({ id, request, verify,
effect, appliesTo?, ui })` — no registration step — and drop it into the **same**
ordered policy array:

```ts
import { defineCredential, dcql, gate, required } from "@openmobilehub/attesto-gate";

const prescription = defineCredential({
  id: "prescription",
  request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }), // what to ask the wallet
  verify: (claims) => claims.rx_valid === true,                               // explicit positive claim
  effect: gate(),                                                             // gate() | discount({ percent }) | authorize()
  appliesTo: (order) => order.lines.some((l) => l.category === "Pharmacy"),   // ONLY for pharmacy lines
  ui: { label: "Prescription", action: "Verify prescription" },
});

store.gate((order) =>
  attesto.requirements(order, [
    required(prescription),                     // custom gate — conditional via appliesTo
    required(age.over(21).when(hasAlcohol)),    // built-ins drop into the SAME array
    optional(membership.discount(10)),
    required(payment.in("usd")),                // amount derived from the order; settles last
  ]),
);
```

`requirements()` fully resolves the custom gate into the manifest (`appliesTo`,
`effect`, `ui.label`, a per-order approve link). One honest limit: the mounted phone
ceremony only knows the built-in `age` / `membership` kinds in v0.1, so a custom
credential's own `request` / `verify` / `ui.action` is not executed by the ceremony
page yet — completing an arbitrary custom credential on the phone is roadmap.

### Settle payment on-chain

The gate **authorizes** payment; **settlement is a seam you inject**.
`createStorefront({ settle })` threads an optional `settle(order)` into the gate's
shared `completeOrder`: after the payment gates pass, `settle` runs and its record
rides along on the receipt and in `get-order-status`. Settlement is fail-closed — if
`settle` throws, nothing is recorded and the cart stays intact (a flaky chain never
marks an order paid), and the amount is always re-derived server-side from the order,
never trusted from the client.

## Runnable examples

All three live in [`examples/`](https://github.com/openmobilehub/mcp-apps-shopping-demo/tree/main/examples)
in the reference repo (`npm run build:packages` first, then `node examples/<file>`):

| Example | What it shows | Port |
| :-- | :-- | :-- |
| [`storefront.mjs`](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/examples/storefront.mjs) | The ~8-line credential-gated storefront above (age + membership + payment). | 3005 |
| [`custom-credential.mjs`](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/examples/custom-credential.mjs) | A custom `prescription` gate via `defineCredential`, composed alongside the built-ins. | 3006 |
| [`with-x402-settlement.mjs`](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/examples/with-x402-settlement.mjs) | On-chain settlement through the fail-closed `settle` seam (mock by default; real Hedera/x402 wiring shown commented). | 3007 |

## Learn more

- Package READMEs:
  [`@openmobilehub/attesto-gate`](https://www.npmjs.com/package/@openmobilehub/attesto-gate) ·
  [`@openmobilehub/attesto-storefront`](https://www.npmjs.com/package/@openmobilehub/attesto-storefront)
- The reference demo (full fail-closed wallet ceremony, on-chain settlement):
  [openmobilehub/mcp-apps-shopping-demo](https://github.com/openmobilehub/mcp-apps-shopping-demo)

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).
