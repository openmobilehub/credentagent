// The RECEIVER — a service that does NOT run the gate. It has only the shared secret and verifies
// each webhook with one call. Run it in one terminal, then run sender.mjs in another.
//
//   CREDENTAGENT_WHSEC=whsec_demo node examples/order-webhooks/receiver.mjs   # → http://localhost:4100
import express from "express";
import { constructEvent, SIGNATURE_HEADER } from "@openmobilehub/credentagent-gate";

const PORT = 4100;
const SECRET = process.env.CREDENTAGENT_WHSEC ?? "whsec_demo_run_both_with_this_secret";
const seen = new Set(); // idempotency ledger — delivery is at-least-once (use a durable store in prod)

const app = express();
// The signature is over the RAW bytes, so read the raw body (not parsed JSON) — the Stripe rule.
app.post("/hooks", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = constructEvent(req.body, req.get(SIGNATURE_HEADER), SECRET);
  } catch (err) {
    console.log(`✗ rejected: ${err.message}`); // forged / tampered / replayed
    return res.status(400).send(`webhook signature failed: ${err.message}`);
  }
  if (seen.has(event.id)) { console.log(`↩ duplicate ${event.id} — ignored`); return res.json({ received: true }); }
  seen.add(event.id);
  if (event.type === "order.settled") {
    const o = event.data.object;
    console.log(`✓ ${event.id} — order.settled: ${o.orderId} · ${o.amount} ${o.currency} · ${o.method ?? "?"} — fulfilling now`);
  }
  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`receiver on http://localhost:${PORT}  (verifying with secret ${SECRET.slice(0, 12)}…)`);
  console.log(`waiting for order.settled events from sender.mjs…`);
});
