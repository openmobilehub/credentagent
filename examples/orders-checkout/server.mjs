// Runnable example — a checkout an AI agent can drive, built on the real credentagent.orders API.
//
//   node examples/orders-checkout/server.mjs      # boots on http://localhost:4000
//   node examples/orders-checkout/smoke.mjs       # drives the whole flow + asserts (no browser)
//
// The whole checkout is wired in ONE call — `credentagent.orders.serve(app)`. There is no
// store to assemble, no completion context to hand-build: the library owns the ceremony.
// An agent calls POST /buy-wine, gets back an `approveUrl`, and hands that link to the human;
// the human proves their age + pays on the checkout page; the order settles.
import express from "express";
import { CredentAgent, age, payment, required } from "@openmobilehub/credentagent-gate";

const PORT = 4000;
const app = express();
app.use(express.json());

// Configure once. `orders.serve(app)` wires the ceremony rails, the checkout page at each
// order's approveUrl, and completion — a finished ceremony fires `order.settled`.
const credentagent = new CredentAgent({ walletOrigin: `http://localhost:${PORT}` });
credentagent.orders.serve(app);
credentagent.on("order.settled", ({ id }) => console.log(`✓ order.settled: ${id} — fulfill it now`));

// What an agent calls to start a purchase that needs consent. It gets back a link to hand
// to the human; the amount + age gate are re-derived server-side, never trusted from a token.
app.post("/buy-wine", (_req, res) => {
  const { id, approveUrl } = credentagent.orders.create({
    order: { id: "", total: 21, currency: "USD", lines: [{ id: "wine", name: "Bottle of wine", quantity: 1, unitPrice: 21, minimumAge: 21 }] },
    policy: [required(age.over(21)), required(payment.in("usd"))],
  });
  res.json({ id, approveUrl });
});

// What the agent polls (or better: subscribe to `order.settled` above and skip polling).
app.get("/orders/:id", async (req, res) => res.json(await credentagent.orders.retrieve(req.params.id)));

app.listen(PORT, () => {
  console.log(`orders-checkout example on http://localhost:${PORT}`);
  console.log(`  1) POST /buy-wine                → { id, approveUrl }`);
  console.log(`  2) open the approveUrl in a browser → prove age + pay (on your phone for a real ceremony)`);
  console.log(`  3) GET  /orders/:id              → { ok: true } once it settles`);
});
