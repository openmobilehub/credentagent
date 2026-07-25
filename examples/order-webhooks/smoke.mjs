// Smoke test for order webhooks — boots a SENDER (the gate) and a separate RECEIVER, then proves
// the real thing over real HTTP: when an order settles, the gate POSTs a SIGNED event that the
// receiver verifies with constructEvent; a forged POST is rejected. No browser, no wallet.
//
//   node examples/order-webhooks/smoke.mjs
import express from "express";
import { CredentAgent, constructEvent, generateWebhookSecret, signPayload, SIGNATURE_HEADER } from "@openmobilehub/credentagent-gate";

const secret = generateWebhookSecret(); // shared out-of-band between the two services

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "✓" : "✗"} ${label}`); if (!cond) failures++; };

// ── RECEIVER — a different service; it has only the shared secret, no gate, no stores ──
const received = [];
const receiver = express();
receiver.post("/hooks", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = constructEvent(req.body, req.get(SIGNATURE_HEADER), secret); // throws on forged/tampered/replayed
  } catch (err) {
    return res.status(400).send(`signature failed: ${err.message}`);
  }
  received.push(event);
  res.json({ received: true });
});
const rSrv = await new Promise((r) => { const s = receiver.listen(0, () => r(s)); });
const hooksUrl = `http://localhost:${rSrv.address().port}/hooks`;

// ── SENDER — the gate, configured to POST settled orders to the receiver ──
const app = express();
app.use(express.json());
const ca = new CredentAgent({ walletOrigin: "http://localhost:0", webhooks: { endpoints: [{ url: hooksUrl, secret }] } });
ca.orders.serve(app);
app.post("/ungated", async (_req, res) => res.json(await ca.orders.create({
  order: { id: "", total: 5, currency: "USD", lines: [{ id: "sticker", name: "Sticker", quantity: 1, unitPrice: 5 }] },
  policy: [],
})));
const sSrv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://localhost:${sSrv.address().port}`;
const j = async (r) => (r.headers.get("content-type")?.includes("json") ? r.json() : r.text());

try {
  // Complete an order → the gate fires a signed webhook to the receiver.
  const order = await j(await fetch(`${base}/ungated`, { method: "POST" }));
  await fetch(`${base}/credentagent/orders/${order.id}/place`, { method: "POST" });

  // Wait for the fire-and-forget delivery to land.
  for (let i = 0; i < 40 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 50));

  check("the receiver got exactly one webhook", received.length === 1);
  check("it is a verified order.settled event", received[0]?.type === "order.settled");
  check("its data.object carries the settled order", received[0]?.data?.object?.orderId === order.id);
  check("the event has a stable id to dedupe on", /^evt_/.test(received[0]?.id ?? ""));

  // A FORGED POST (attacker's secret) must be rejected by the receiver.
  const forgedBody = JSON.stringify({ id: "evt_forged", type: "order.settled", created: Math.floor(Date.now() / 1000), data: { object: { orderId: "ord_hacker" } } });
  const forgedSig = signPayload(forgedBody, "whsec_attacker_secret", Math.floor(Date.now() / 1000));
  const forgedRes = await fetch(hooksUrl, { method: "POST", headers: { "content-type": "application/json", [SIGNATURE_HEADER]: forgedSig }, body: forgedBody });
  check("a forged event (wrong secret) is rejected with 400", forgedRes.status === 400);
  check("the forged event was NOT recorded", received.length === 1);
} finally {
  sSrv.close(); rSrv.close();
}

console.log(failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
