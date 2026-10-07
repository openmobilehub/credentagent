// delegated-purchase/merchant.mjs — an agent spends a permission the person signed on their phone,
// and the merchant checks it (spec 014). The agent runs as a SEPARATE PROCESS (agent.mjs).
//
//   npm run build --workspaces                              # once, if not built
//   node examples/delegated-purchase/merchant.mjs           # → spawns agent.mjs and runs one purchase
//
// The agent's key is the permission's spending power, so it must never enter the merchant's process
// (FR-5). This file imports the package ROOT only; agent.mjs imports `/agent` only. The two talk over
// IPC, and every message is public data: the agent's PUBLIC key one way, the signed permission and a
// quoted cart the other, the purchase proof back. Read the messages below — no private key crosses.
//
// The phone is SIMULATED (devSimulateWalletSignature), but the signature is real and the chain the
// agent builds on it is the AP2 wire format. What stays demo is the trust ANCHOR — the payment
// credential is self-minted, no issuer check yet (#14) — so the verdict says "presence-only-demo".
import express from "express";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { CredentAgent, devSimulateWalletSignature, toMinorUnits, verifyDelegatedPurchase } from "@openmobilehub/credentagent-gate";

const PORT = Number(process.env.PORT ?? 4031);
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const CATALOG = { coffee: { price: 4.5, category: "Beverages" }, tea: { price: 3, category: "Beverages" } };

const credentagent = new CredentAgent({ walletOrigin: ORIGIN, gateSecret: "example-gate-secret", catalog: CATALOG });
const app = express();
app.use(express.json());
credentagent.grants.serve(app);
const server = app.listen(PORT);

const step = (s) => console.log(`[merchant] ${s}`);
const agent = fork(new URL("./agent.mjs", import.meta.url));
const next = async () => (await once(agent, "message"))[0];

try {
  // 1) The agent introduces itself with its PUBLIC key. That is all the merchant ever gets of it.
  const { publicJwk } = await next();
  step(`agent's public key: x=${publicJwk.x.slice(0, 12)}… (no "d" — ${"d" in publicJwk ? "PRIVATE KEY LEAKED" : "public only"})`);

  // 2) Open a grant naming that key. The gate generates no key of its own for it.
  const grant = await credentagent.grants.create({
    merchant: "utopia", budget: 20, perSpend: 5,
    allow: { skus: ["coffee", "tea"] },
    agentKey: publicJwk,
    description: "Coffee or tea while I'm away — up to $20, $5 a purchase.",
  });
  step(`grant ${grant.id} opened → the person signs at ${grant.approveUrl}`);

  // 3) The person signs on their phone (simulated here, through the real signing endpoints).
  const oid = await (await fetch(`${ORIGIN}/credentagent/grants/${grant.id}/sign/request`)).json();
  const result = await devSimulateWalletSignature({ request: { request: oid.requests[0].data.request, dcql_query: oid.dcql_query }, origin: ORIGIN });
  await fetch(`${ORIGIN}/credentagent/grants/${grant.id}/sign/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ readerContextToken: oid.readerContextToken, result }),
  });
  const signed = await credentagent.grants.retrieve(grant.id);
  step(`signed on the phone → status=${signed.status} · trustLevel=${signed.trustLevel}`);

  // The gate cannot spend it — it holds no key to spend with.
  const door = await signed.spend({ idempotencyKey: "try-1", items: [{ sku: "coffee" }] });
  step(`grant.spend() here → ${door.code} (the agent spends it, at the merchant)`);

  // 4) Quote a cart and issue a nonce, and hand the agent the signed permission.
  // No `merchant` on the cart: signCheckout fills in this gate's own, the one the permission names.
  const cart = {
    id: "ord_1", status: "ready_for_complete", currency: "USD", links: [],
    line_items: [{ id: "li_1", item: { id: "coffee", title: "Coffee", price: 450 }, quantity: 1, totals: [{ type: "total", amount: 450 }] }],
    totals: [{ type: "total", amount: 450 }],
  };
  const nonce = randomUUID();
  agent.send({ intent: signed.mandate.intent, checkoutJwt: credentagent.ap2.signCheckout(cart), audience: ORIGIN, nonce });

  // 5) The agent's proof comes back. One call decides it; the catalog prices the cart.
  const { proof } = await next();
  const verdict = await verifyDelegatedPurchase(proof, {
    trust: "presence-only-demo",
    audience: ORIGIN,
    nonce, // single-use is yours: verifyDelegatedPurchase checks the nonce, it does not remember it
    checkoutKey: credentagent.ap2.checkoutPublicJwk,
    spent: { amount: 0, uses: 0 },
    price: (c) => c.line_items.reduce((sum, l) => sum + toMinorUnits(CATALOG[l.item.id].price, "USD") * l.quantity, 0),
  });
  step(verdict.ok ? `purchase verified ✓ · ${verdict.checkout.totals[0].amount} ${verdict.payment.payment_amount.currency} minor units · trust_level=${verdict.trust_level}` : `refused: ${verdict.code} — ${verdict.detail}`);
  process.exitCode = verdict.ok ? 0 : 1;
} finally {
  agent.kill();
  server.close();
}
