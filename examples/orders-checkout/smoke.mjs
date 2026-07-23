// Smoke test for the orders-checkout example — drives the REAL built package over HTTP and
// asserts, so CI (and you) can prove the checkout works end-to-end without a browser or wallet.
//
//   node examples/orders-checkout/smoke.mjs
//
// It covers the two security-critical shapes:
//   • a GATED order (age + payment) renders a checkout page but CANNOT be completed by a
//     direct POST to the instant-demo path — it is refused (403) and stays pending;
//   • an UNGATED order completes via the demo path → order.settled fires → retrieve is ok.
import express from "express";
import { CredentAgent, age, payment, required } from "@openmobilehub/credentagent-gate";

const app = express();
app.use(express.json());

const settled = [];
const ca = new CredentAgent({ walletOrigin: "http://localhost:0" });
ca.orders.serve(app);
ca.on("order.settled", ({ id }) => settled.push(id));

// Two create endpoints — a gated one (a $21 wine) and an ungated one (a $5 sticker) — plus
// retrieve. Amounts are dollars, matching what the checkout page renders.
app.post("/gated", async (_req, res) => res.json(await ca.orders.create({
  order: { id: "", total: 21, currency: "USD", lines: [{ id: "wine", name: "Wine", quantity: 1, unitPrice: 21, minimumAge: 21 }] },
  policy: [required(age.over(21)), required(payment.in("usd"))],
})));
app.post("/ungated", async (_req, res) => res.json(await ca.orders.create({
  order: { id: "", total: 5, currency: "USD", lines: [{ id: "sticker", name: "Sticker", quantity: 1, unitPrice: 5 }] },
  policy: [],
})));
app.get("/orders/:id", async (req, res) => res.json(await ca.orders.retrieve(req.params.id)));

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "✓" : "✗"} ${label}`); if (!cond) failures++; };

const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
const base = `http://localhost:${server.address().port}`;
const j = async (r) => ({ status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() });

try {
  // ── Gated order: rendered, but never completable from the instant-demo path ──
  const gated = (await j(await fetch(`${base}/gated`, { method: "POST" }))).body;
  check("gated create returns an id + approveUrl on this origin", gated.id?.startsWith("ord_") && gated.approveUrl.includes(gated.id));

  const page = await j(await fetch(`${base}/credentagent/orders/${gated.id}`));
  check("gated checkout page renders (200) and shows the item", page.status === 200 && page.body.includes("Wine"));

  const placeGated = await j(await fetch(`${base}/credentagent/orders/${gated.id}/place`, { method: "POST" }));
  check("gated order is REFUSED on the instant-demo place path (403)", placeGated.status === 403);

  const gatedAfter = (await j(await fetch(`${base}/orders/${gated.id}`))).body;
  check("gated order stays PENDING after the refused place (never ok unverified)", gatedAfter.ok === false && gatedAfter.pending === true);

  // ── Ungated order: completes end-to-end via the demo path ──
  const ungated = (await j(await fetch(`${base}/ungated`, { method: "POST" }))).body;
  const placeUngated = await j(await fetch(`${base}/credentagent/orders/${ungated.id}/place`, { method: "POST" }));
  check("ungated order completes on the demo place path (200)", placeUngated.status === 200);
  check("order.settled fired exactly once for the ungated order", settled.length === 1 && settled[0] === ungated.id);

  const placeAgain = await j(await fetch(`${base}/credentagent/orders/${ungated.id}/place`, { method: "POST" }));
  check("a duplicate place POST is acknowledged but does NOT re-fire order.settled", placeAgain.status === 200 && settled.length === 1);

  const ungatedAfter = (await j(await fetch(`${base}/orders/${ungated.id}`))).body;
  check("ungated order retrieves as ok with the server-derived amount ($5)", ungatedAfter.ok === true && ungatedAfter.completion?.amount === 5);
} finally {
  server.close();
}

console.log(failures === 0 ? "\nALL SMOKE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
