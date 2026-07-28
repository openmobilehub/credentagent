// Runnable example — mount the CredentAgent gate on YOUR OWN server (not createStorefront).
//
//   npm run build --workspaces        # build the @openmobilehub/credentagent-* packages
//   node examples/bring-your-own-host.mjs
//
// createStorefront() is ONE host. The product promise is "mount on ANY app": you already
// have an Express + MCP server, your own catalog/pricing, and your own order store. You
// should NOT have to reverse-engineer the seam contract or call `completeOrder` by hand.
//
// `defineHost({...})` turns your domain pieces into the ceremony seams the gate needs and
// publishes them in ONE call — it BUILDS the shared completion for you (no `completeOrder`
// plumbing, no raw `app.locals` wiring). Then `credentagent.mount(app)` serves the
// /credentagent/* proof pages over the SAME stores, so a finished ceremony records the
// order the same way your own code reads it.
//
// HONESTY: trust_level is "presence-only-demo" — the wire crypto is real, the issuer trust
// anchor is not yet, so don't gate a real safety guarantee on it (see CLAUDE.md).
import express from "express";
import { CredentAgent, defineHost, age, payment, required } from "@openmobilehub/credentagent-gate";

const PORT = 4100;
const app = express();
app.use(express.json());

// ── YOUR domain: your catalog/pricing + your order stores (here, in-memory Maps) ──
const CATALOG = { wine: { name: "Bottle of wine", price: 21, minimumAge: 21 } };
const created = new Map(); // orderId → the order you created
const completed = new Map(); // orderId → the completed record (idempotent)

// Re-price an order's lines from YOUR catalog, server-side — the amount source of truth,
// never the token (Security invariant 2). This is your CeremonyCatalog: (items, id) → order.
function priceOrder(items, orderId) {
  const lines = items.map(({ productId, quantity }) => {
    const p = CATALOG[productId];
    return { id: productId, name: p.name, unitPrice: p.price, quantity, lineTotal: p.price * quantity, currency: "USD", ...(p.minimumAge ? { minimumAge: p.minimumAge } : {}) };
  });
  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  return { id: orderId, lines, itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal: total, discount: 0, total, currency: "USD" };
}

// ── ONCE, at startup: turn your host into the gate's seams, in three lines ─────────
const host = defineHost({
  catalog: { createOrder: (items, orderId) => priceOrder(items, orderId) },
  orderStore: { read: (orderId) => created.get(orderId) ?? null },
  records: { read: (id) => completed.get(id), write: (rec) => { completed.set(rec.orderId, rec); } }, // where completed orders go
  returnUrl: (id) => `/checkout/${id}`, // YOUR checkout route — where a rail returns the buyer after a proof
  allowEphemeralKey: true, // single-process dev; a deployment passes { signingKey: process.env.GATE_SECRET }
});
const credentagent = new CredentAgent({ walletOrigin: `http://localhost:${PORT}` });
host.publish(app); // publish YOUR seams (rails + shared completion) onto the app
credentagent.mount(app); // serve the /credentagent/* proof pages over them

// ── PER ACTION — your OWN route, gated. It calls `host.complete(...)`, so the age gate is
//    enforced HERE, server-side (Security invariant 1) — not just by a hidden button. The
//    agent drives `credentagent.requirements(...)` to the approve page to get the proof.
app.post("/checkout/:id", async (req, res) => {
  const order = priceOrder([{ productId: "wine", quantity: 1 }], req.params.id);
  created.set(order.id, order);
  const result = await host.complete({ order, mandateId: `demo-${order.id}`, amount: order.total, currency: "USD", method: "demo", gates: [{ gate: "demo", pass: true, detail: "instant demo" }] });
  res.status(result.completed ? 200 : 402).json(result);
});

// The policy the agent gets as a `requires` manifest (drives the buyer to the proof page).
const policy = [required(age.over(21)), required(payment.in("usd"))];
void policy; // (wired into your tool's response via credentagent.requirements(order, policy))

// ── Demonstrate server-side enforcement in-process (no browser needed) ────────────
const ORDER_ID = "ORDER-1";
const order = priceOrder([{ productId: "wine", quantity: 1 }], ORDER_ID);
created.set(ORDER_ID, order);

// 1) Unproven: your completion path REFUSES the age-restricted order — reason "age".
const refused = await host.complete({ order, mandateId: "m1", amount: order.total, currency: "USD", method: "demo", gates: [{ gate: "demo", pass: true, detail: "instant demo" }] });
console.log("\n— unproven age-restricted order —");
console.log("  completed:", refused.completed, "| reason:", refused.reason, "  (refused server-side, invariant 1)");

// 2) The buyer proves 21+ on the /credentagent/* page the gate mounted; the rail records it
//    in the SAME per-order store `host` owns. (Here we write it directly to simulate.)
await host.verificationStore.write(ORDER_ID, { ageVerified: true });

// 3) Proven: the same completion path now COMPLETES.
const ok = await host.complete({ order, mandateId: "m2", amount: order.total, currency: "USD", method: "demo", gates: [{ gate: "demo", pass: true, detail: "instant demo" }] });
console.log("\n— after the buyer proved 21+ —");
console.log("  completed:", ok.completed, "| recorded:", completed.has(ORDER_ID), "\n");

// In a real server you'd `app.listen(PORT)` and the buyer would open the approveUrl to prove
// on their phone; the mounted rails would write ageVerified for you. This script exits here.
process.exit(0);
