# `orders-checkout/` — a checkout an agent can drive, in a few lines

An AI agent wants to buy a bottle of wine for you. Wine is age-restricted, so the purchase
can't just go through — you have to prove you're 21+ and pay. This example is the smallest
real thing that makes that safe: the agent starts the order and gets a **link**; you open the
link, prove your age, and pay; the order settles.

The whole checkout is wired in **one call** — `credentagent.orders.serve(app)`. There's no
store to assemble and no completion logic to hand-write; the library owns the ceremony. Note
what runs **when**: `serve()` and `on()` run **once at startup**; `orders.create()` runs **per
purchase**, inside a request handler.

```js
import express from "express";
import { CredentAgent, age, payment, required } from "@openmobilehub/credentagent-gate";

const app = express();
app.use(express.json());
const credentagent = new CredentAgent({ walletOrigin: "http://localhost:4000" });

// ── once, at startup ──────────────────────────────────────────
credentagent.orders.serve(app);                              // wire the whole checkout onto your app
credentagent.on("order.settled", ({ id }) => fulfill(id));   // subscribe once — fires when it's paid

// ── per purchase — a request handler that runs on each buy ────
app.post("/buy-wine", async (_req, res) => {
  const { approveUrl } = await credentagent.orders.create({
    order:  { id: "", total: 21, currency: "USD", lines: [{ id: "wine", name: "Bottle of wine", quantity: 1, unitPrice: 21, minimumAge: 21 }] },
    policy: [required(age.over(21)), required(payment.in("usd"))],
  });
  res.json({ approveUrl });                                  // hand this link to the human
});
```

> **Serverless caveat:** `on("order.settled")` is an in-process event — it fits a long-lived server
> like this example. On serverless (Vercel, Lambda), fulfill from `orders.retrieve(id)` over
> injected shared stores instead; a real signed webhook is tracked in
> [#101](https://github.com/openmobilehub/credentagent/issues/101).

## Run it

```bash
npm run build                              # build the two @openmobilehub/credentagent-* packages
node examples/orders-checkout/server.mjs   # → http://localhost:4000
```

Then:

1. `curl -X POST http://localhost:4000/buy-wine` → `{ id, approveUrl }`
2. Open the `approveUrl` in a browser → the checkout page (prove age + pay; on your phone for the real wallet ceremony).
3. `curl http://localhost:4000/orders/<id>` → `{ ok: true }` once it settles — or just listen for `order.settled`.

## Prove it (no browser needed)

```bash
node examples/orders-checkout/smoke.mjs
```

The smoke test drives the built package over HTTP and asserts the two things that matter:

- A **gated** order (age + payment) renders a checkout page but **cannot** be completed by a
  direct POST to the instant-demo path — it's refused (403) and stays pending. Skipping the
  gate is refused on the server, not just hidden in the page.
- An **ungated** order completes via the demo path → `order.settled` fires → `retrieve` is ok,
  with the amount re-derived server-side.

## What's real, and what isn't yet

- **Real:** the order lifecycle (`create` → link → checkout → `order.settled`), the server-side
  amount + age re-derivation (the total is never trusted from the link), and the fail-closed
  rule that a gated order only completes through the wallet ceremony.
- **Demo-only:** `trust_level` is `"presence-only-demo"`. The wire crypto is real, but there's
  no issuer / device-signature trust anchor yet — a self-crafted credential would pass. Don't
  gate anything needing a real safety guarantee on it until issuer-verified trust lands.
- The **instant-demo "Complete purchase"** button exists only for ungated orders (so the flow
  is clickable without a wallet); a real age/payment order always goes through the phone.
