// repro.mjs — what units does the gate's SIGNED open payment mandate put in payment.budget.max
// and payment.amount_range.max?  Run from the repo root:
//
//   node docs/reviews/2026-10-agent-purchases/repros/budget-units/repro.mjs
//
// Drives the real grant flow (examples/delegated-purchase/merchant.mjs, minus the IPC): a $50 budget,
// $20 per purchase; the phone signature is simulated through the real /sign endpoints. Then decodes
// the signed open payment mandate straight off the wire (base64url disclosure, no library helper),
// prints the two constraints, and writes the mandate to out/open_payment.json for repro.py, which
// runs the AP2 reference SDK's own evaluators on it.
//
// Also asks the gate's OWN verifier the budget question, to show what unit the gate itself means.
import express from "express";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CredentAgent, devSimulateWalletSignature, toMinorUnits, verifyDelegatedPurchase } from "@openmobilehub/credentagent-gate";
import { AgentKey, DelegatedIntent } from "@openmobilehub/credentagent-gate/agent";

const HERE = new URL(".", import.meta.url).pathname;
const BUDGET_USD = 50;
const PER_SPEND_USD = 20;
const CATALOG = { coffee: { price: 4.5, category: "Beverages" } };

const app = express();
app.use(express.json());
const server = app.listen(0);
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const credentagent = new CredentAgent({ walletOrigin: ORIGIN, gateSecret: "repro-secret", catalog: CATALOG });
credentagent.grants.serve(app);

try {
  const agentKey = AgentKey.generate();
  const grant = await credentagent.grants.create({
    merchant: "utopia", budget: BUDGET_USD, perSpend: PER_SPEND_USD,
    allow: { skus: ["coffee"] }, agentKey: agentKey.publicJwk,
    description: `Coffee — up to $${BUDGET_USD}, $${PER_SPEND_USD} a purchase.`,
  });
  const oid = await (await fetch(`${ORIGIN}/credentagent/grants/${grant.id}/sign/request`)).json();
  const result = await devSimulateWalletSignature({ request: { request: oid.requests[0].data.request, dcql_query: oid.dcql_query }, origin: ORIGIN });
  const v = await fetch(`${ORIGIN}/credentagent/grants/${grant.id}/sign/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ readerContextToken: oid.readerContextToken, result }),
  });
  if (!v.ok) throw new Error(`sign/verify ${v.status}: ${await v.text()}`);
  const signed = await credentagent.grants.retrieve(grant.id);
  console.log(`grant created with budget=$${BUDGET_USD} perSpend=$${PER_SPEND_USD} → status=${signed.status}`);

  // ── Decode the signed permission's disclosures by hand (base64url JSON [salt, value]). ──
  const decoded = signed.mandate.intent.disclosures.map((d) => JSON.parse(Buffer.from(d, "base64url").toString("utf8"))[1]);
  const openPayment = decoded.find((m) => m && m.vct === "mandate.payment.open.1");
  if (!openPayment) throw new Error("no open payment mandate in the signed permission");
  const pick = (t) => openPayment.constraints.find((c) => c.type === t);
  console.log("\nSigned open payment mandate (as on the wire):");
  console.log("  " + JSON.stringify(pick("payment.amount_range")));
  console.log("  " + JSON.stringify(pick("payment.budget")));
  console.log(`  → budget.max ${pick("payment.budget").max} for a $${BUDGET_USD} budget: ${pick("payment.budget").max === BUDGET_USD * 100 ? "MINOR units (cents)" : "major units"}`);
  console.log(`  → amount_range.max ${pick("payment.amount_range").max} for $${PER_SPEND_USD}: ${pick("payment.amount_range").max === PER_SPEND_USD * 100 ? "MINOR units (cents)" : "major units"}`);

  mkdirSync(`${HERE}out`, { recursive: true });
  writeFileSync(`${HERE}out/open_payment.json`, JSON.stringify(openPayment, null, 2));

  // ── The gate's OWN verifier: is budget.max cents to it? $49 already spent + a $4.50 coffee. ──
  const spendOnce = async (spentCents) => {
    const cart = {
      id: `ord_${spentCents}`, status: "ready_for_complete", currency: "USD", links: [],
      line_items: [{ id: "li_1", item: { id: "coffee", title: "Coffee", price: 450 }, quantity: 1, totals: [{ type: "total", amount: 450 }] }],
      totals: [{ type: "total", amount: 450 }],
    };
    const nonce = randomUUID();
    const proof = await DelegatedIntent.fromWalletPresentation(signed.mandate.intent).spend({
      agentKey, checkoutJwt: credentagent.ap2.signCheckout(cart),
      instrument: { id: "demo-instrument-0001", type: "card" }, audience: ORIGIN, nonce,
    });
    return verifyDelegatedPurchase(proof, {
      trust: "presence-only-demo", audience: ORIGIN, nonce,
      checkoutKey: credentagent.ap2.checkoutPublicJwk,
      spent: { amount: spentCents, uses: 1 },
      price: (c) => c.line_items.reduce((s, l) => s + toMinorUnits(CATALOG[l.item.id].price, "USD") * l.quantity, 0),
    });
  };
  console.log("\nGate's own verifyDelegatedPurchase (reads budget.max as cents):");
  for (const spent of [0, 4900]) {
    const r = await spendOnce(spent);
    console.log(`  spent=${spent}¢ + 450¢ coffee → ${r.ok ? "ACCEPTED" : `REFUSED (${r.code}: ${r.detail})`}`);
  }
  console.log(`\nwrote ${HERE}out/open_payment.json — now run repro.py`);
} finally {
  server.close();
}
