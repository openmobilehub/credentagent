// Repro: a loyalty membership proved BEFORE signing is sealed into an agent-held grant's signed
// bounds, but the agent-held spend path never applies it; the store-held sibling does.
//
//   node docs/reviews/2026-10-agent-purchases/repros/agent-held-drops-discount.mjs   (from the repo root)
//
// Everything runs locally: an express server on 127.0.0.1, the simulated wallet, the real routes.
import express from "express";
import { randomUUID } from "node:crypto";
import { CredentAgent, devSimulateWalletSignature, toMinorUnits, verifyDelegatedPurchase } from "@openmobilehub/credentagent-gate";
import { AgentKey, DelegatedIntent } from "@openmobilehub/credentagent-gate/agent";

const PORT = Number(process.env.PORT ?? 4097);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CATALOG = { coffee: { price: 4.5, category: "Beverages" }, tea: { price: 3, category: "Beverages" } };

const credentagent = new CredentAgent({ walletOrigin: ORIGIN, gateSecret: "repro-gate-secret", catalog: CATALOG, loyaltyDiscountPct: 10 });
const app = express();
app.use(express.json());
credentagent.grants.serve(app);
const server = app.listen(PORT);
const log = (...a) => console.log(...a);

// The human presents a membership on the grant page (instant-demo claims path of the real route).
async function proveMembership(id) {
  const r = await fetch(`${ORIGIN}/credentagent/grants/${id}/membership/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ claims: { membership_number: "GOLD-0001" } }),
  });
  return r.json();
}
// The human signs on the phone (simulated, through the real signing endpoints).
async function sign(id) {
  const oid = await (await fetch(`${ORIGIN}/credentagent/grants/${id}/sign/request`)).json();
  const result = await devSimulateWalletSignature({ request: { request: oid.requests[0].data.request, dcql_query: oid.dcql_query }, origin: ORIGIN });
  const v = await fetch(`${ORIGIN}/credentagent/grants/${id}/sign/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ readerContextToken: oid.readerContextToken, result }),
  });
  return v.json();
}
const bounds = { merchant: "utopia", budget: 20, perSpend: 5, allow: { skus: ["coffee", "tea"] } };

try {
  // ── A) STORE-HELD sibling: device-signed, the gate holds the delegate key ──────────────────
  log("== A) store-held (device-signed, gate-held key) ==");
  const gA = await credentagent.grants.create({ ...bounds });
  log("membership verify:", JSON.stringify(await proveMembership(gA.id)).slice(0, 120));
  log("sign/verify:", JSON.stringify(await sign(gA.id)));
  const sA = await credentagent.grants.retrieve(gA.id);
  log("status:", sA.status, "| membershipProof:", JSON.stringify(sA.membershipProof));
  const spendA = await sA.spend({ idempotencyKey: "a-1", items: [{ sku: "coffee" }] });
  log("grant.spend(coffee) →", JSON.stringify(spendA));

  // ── B) AGENT-HELD: same bounds, same membership, agent brings its own key ─────────────────
  log("\n== B) agent-held (agentKey) ==");
  const agentKey = AgentKey.generate();
  const gB = await credentagent.grants.create({ ...bounds, agentKey: agentKey.publicJwk });
  const pageB = await (await fetch(`${ORIGIN}/credentagent/grants/${gB.id}`)).text();
  log("approve page offers membership step on agent-held grant?", pageB.includes(`/credentagent/grants/${gB.id}/membership`),
    "| promises discount on every agent purchase?", /off every purchase your agent makes/.test(pageB));
  log("membership verify:", JSON.stringify(await proveMembership(gB.id)).slice(0, 120));
  log("sign/verify:", JSON.stringify(await sign(gB.id)));
  const sB = await credentagent.grants.retrieve(gB.id);
  log("status:", sB.status, "| membershipProof:", JSON.stringify(sB.membershipProof));
  log("boundsHash (covers membershipProof):", sB.mandate.boundsHash);
  const pageB2 = await (await fetch(`${ORIGIN}/credentagent/grants/${gB.id}`)).text();
  log("approve page after signing shows 'Membership applied'?", /Membership applied|Loyalty discount/.test(pageB2));
  const mandatesJson = JSON.stringify(sB.mandate.mandates);
  log("signed AP2 mandates mention membership/discount?", /membership|discount|loyalty/i.test(mandatesJson));
  const permission = DelegatedIntent.fromWalletPresentation(sB.mandate.intent);
  log("agent's openPayment constraints:", JSON.stringify(permission.openPayment.constraints));
  log("gate grant.spend →", JSON.stringify(await sB.spend({ idempotencyKey: "b-0", items: [{ sku: "coffee" }] })));

  // B1: merchant quotes the cart exactly as examples/delegated-purchase/merchant.mjs does.
  const fullCart = {
    id: "ord_full", status: "ready_for_complete", currency: "USD", links: [],
    line_items: [{ id: "li_1", item: { id: "coffee", title: "Coffee", price: 450 }, quantity: 1, totals: [{ type: "total", amount: 450 }] }],
    totals: [{ type: "total", amount: 450 }],
  };
  const examplePrice = (c) => c.line_items.reduce((sum, l) => sum + toMinorUnits(CATALOG[l.item.id].price, "USD") * l.quantity, 0);
  async function purchase(cart, price) {
    const nonce = randomUUID();
    const proof = await permission.spend({ agentKey, checkoutJwt: credentagent.ap2.signCheckout(cart), instrument: { id: "demo-instrument-0001", type: "card" }, audience: ORIGIN, nonce });
    return verifyDelegatedPurchase(proof, { trust: "presence-only-demo", audience: ORIGIN, nonce, checkoutKey: credentagent.ap2.checkoutPublicJwk, spent: { amount: 0, uses: 0 }, price });
  }
  const vFull = await purchase(fullCart, examplePrice);
  log("B1 full-price cart (example's price fn) →", vFull.ok ? `ok, payment_amount=${JSON.stringify(vFull.payment.payment_amount)}` : `refused ${vFull.code}: ${vFull.detail}`);
  if (vFull.ok) log("   verdict mentions membership/discount?", /membership|discount|loyalty/i.test(JSON.stringify({ open: vFull.open, payment: vFull.payment })));

  // B2: merchant tries to honour the sealed 10% — a discounted cart priced by the same catalog fn.
  const discCart = {
    id: "ord_disc", status: "ready_for_complete", currency: "USD", links: [],
    line_items: [{ id: "li_1", item: { id: "coffee", title: "Coffee", price: 450 }, quantity: 1, totals: [{ type: "total", amount: 450 }] }],
    totals: [{ type: "subtotal", amount: 450 }, { type: "discount", amount: 45 }, { type: "total", amount: 405 }],
  };
  const vDisc = await purchase(discCart, examplePrice);
  log("B2 discounted cart (example's price fn) →", vDisc.ok ? `ok, payment_amount=${JSON.stringify(vDisc.payment.payment_amount)}` : `refused ${vDisc.code}: ${vDisc.detail}`);

  // B3: only if the merchant hand-wires the rate from the grant record (no API links proof → grant).
  const pct = sB.membershipProof.discountPct;
  const handWired = (c) => { const s = examplePrice(c); return s - Math.round((s * pct) / 100); };
  const vHand = await purchase(discCart, handWired);
  log("B3 discounted cart + hand-wired discount price fn →", vHand.ok ? `ok, payment_amount=${JSON.stringify(vHand.payment.payment_amount)}` : `refused ${vHand.code}: ${vHand.detail}`);

  log("\n== Verdict ==");
  const storeCents = spendA.ok ? Math.round(spendA.amount * 100) : null;
  const agentCents = vFull.ok ? vFull.payment.payment_amount.amount : null;
  log(`store-held charges ${storeCents} cents; agent-held verifies at ${agentCents} cents for the same coffee under the same sealed 10% membership`);
  log(storeCents !== agentCents ? "MISMATCH — agent-held path does not apply the sealed discount" : "match");
} finally {
  server.close();
}
