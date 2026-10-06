// ap2-multistore/stores.mjs — three independent coffee stores, each a `createStorefront` with its OWN
// catalog, its OWN gate (own keys, own grants) and its OWN origin. The agent (agent.mjs, a separate
// process) compares them, gets the person's permission for the winner signed on their phone, and
// pays there; the store checks the purchase with `verifyDelegatedPurchase`.
//
//   node examples/ap2-multistore/up.mjs        # tunnels + both processes — what you want for a phone
//   node examples/ap2-multistore/stores.mjs    # local only: http://localhost:4101 … 4103
//
// A store's merchant id IS its host (`merchantFor`), so each store needs its own origin: a permission
// the phone signs for one store names that host, and the other two refuse it. One tunnel per store.
//
// The JSON routes under /agent/* are this example's glue, not library API: the agent needs a way to
// read a catalog, open a grant naming its key, get a cart quoted and hand a proof back. Everything
// that DECIDES — the signing ceremony, the mandate chain, the verdict — is the library's.
//
// HONESTY: the phone's signature is real, but the payment credential has no issuer trust anchor yet
// (v0.2), so every verdict says trust_level "presence-only-demo". No real money moves.
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { CredentAgent, verifyDelegatedPurchase } from "@openmobilehub/credentagent-gate";

// Same three products everywhere, different prices and ratings — so there is something to compare.
const STORES = [
  {
    key: "acme", name: "Acme Coffee Co", port: 4101, url: process.env.ACME_URL,
    products: { "house-blend": [24, 4.1], "espresso-beans": [19, 4.0], "green-tea": [9, 3.8] },
  },
  {
    key: "beanbarn", name: "BeanBarn", port: 4102, url: process.env.BEANBARN_URL,
    products: { "house-blend": [21, 4.4], "espresso-beans": [22, 4.2], "green-tea": [8, 4.5] },
  },
  {
    key: "roastworks", name: "RoastWorks", port: 4103, url: process.env.ROASTWORKS_URL,
    products: { "house-blend": [26, 4.6], "espresso-beans": [18, 4.7], "green-tea": [11, 4.0] },
  },
];
const NAMES = { "house-blend": "House Blend, 1 lb bag", "espresso-beans": "Espresso Beans, 1 lb bag", "green-tea": "Green Tea, 50 bags" };
const CATEGORY = { "house-blend": "Coffee", "espresso-beans": "Coffee", "green-tea": "Tea" };

const minor = (dollars) => Math.round(dollars * 100);
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function startStore({ key, name, port, url, products }) {
  const origin = (url ?? `http://localhost:${port}`).replace(/\/$/, "");
  const host = new URL(origin).host;
  const me = { id: host, name: key, origin }; // how a grant names this store: merchantFor(origin, key)

  const catalog = Object.entries(products).map(([id, [price, rating]]) => ({
    id, name: NAMES[id], price, currency: "USD", image: "", category: CATEGORY[id],
    description: `${NAMES[id]} — rated ${rating}★ at ${name}.`, rating,
  }));
  const bySku = new Map(catalog.map((p) => [p.id, p]));

  const credentagent = new CredentAgent({
    walletOrigin: origin,
    catalog: Object.fromEntries(catalog.map((p) => [p.id, { price: p.price, category: p.category, name: p.name }])),
  });
  const store = createStorefront({ baseUrl: origin, catalog });
  credentagent.grants.serve(store.app); // approveUrl → the phone signing ceremony (spec 012)

  const nonces = new Map(); // nonce → grantId; single-use, consumed at /purchase (invariant 6)
  const spent = new Map(); // permission root → { amount, uses } in minor units — what THIS store has charged under it
  const orders = [];
  const json = express.json({ limit: "1mb" });

  store.app.get("/agent/catalog", (_req, res) => {
    res.json({ store: name, merchant: me, products: catalog.map(({ id, name, price, rating }) => ({ id, name, price, currency: "USD", rating })) });
  });

  // Open a grant naming the AGENT's public key. The gate generates no key for it and refuses a private one.
  store.app.post("/agent/grants", json, async (req, res) => {
    const { agentKey, skus, budget, perSpend, description } = req.body ?? {};
    try {
      const unknown = (skus ?? []).filter((s) => !bySku.has(s));
      if (!skus?.length || unknown.length) return res.status(400).json({ error: `unknown or missing skus: ${unknown.join(", ") || "none given"}` });
      const g = await credentagent.grants.create({ merchant: key, budget, perSpend, allow: { skus }, agentKey, description });
      res.json({ grantId: g.id, approveUrl: g.approveUrl, status: g.status });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // The agent polls this; once the phone has signed, the signed permission is public data it can carry.
  store.app.get("/agent/grants/:id", async (req, res) => {
    const g = await credentagent.grants.retrieve(req.params.id);
    if (!g) return res.status(404).json({ error: "no such grant" });
    res.json({ status: g.status, trustLevel: g.trustLevel, ...(g.mandate?.intent ? { intent: g.mandate.intent } : {}) });
  });

  // Quote a cart priced from THIS store's catalog, sign it with the store's checkout key, issue a nonce.
  store.app.post("/agent/quote", json, (req, res) => {
    const { grantId, items } = req.body ?? {};
    if (!items?.length || items.some((i) => !bySku.has(i.sku))) return res.status(400).json({ error: "every item needs a sku from this store's catalog" });
    const line_items = items.map((i, n) => {
      const p = bySku.get(i.sku);
      const quantity = i.quantity ?? 1;
      return { id: `li_${n + 1}`, item: { id: p.id, title: p.name, price: minor(p.price) }, quantity, totals: [{ type: "total", amount: minor(p.price) * quantity }] };
    });
    const total = line_items.reduce((s, l) => s + l.totals[0].amount, 0);
    const cart = { id: `ord_${randomUUID().slice(0, 8)}`, merchant: me, status: "ready_for_complete", currency: "USD", links: [], line_items, totals: [{ type: "total", amount: total }] };
    const nonce = randomUUID();
    nonces.set(nonce, grantId);
    res.json({ checkoutJwt: credentagent.ap2.signCheckout(cart), payee: me, amount: { amount: total, currency: "USD" }, audience: origin, nonce });
  });

  // One call decides. The catalog re-prices the cart (invariant 2); the nonce is used once (invariant 6).
  store.app.post("/agent/purchase", json, async (req, res) => {
    const { proof, nonce } = req.body ?? {};
    if (!nonces.has(nonce)) return res.status(400).json({ ok: false, code: "nonce", detail: "unknown or already-used nonce" });
    nonces.delete(nonce);
    // Key the running total by the permission itself (the chain's root, which the verdict checks), never
    // by an id the agent sends — a fresh id must not reset what has been spent under the same permission.
    const root = typeof proof?.payment === "string" ? createHash("sha256").update(proof.payment.split("~")[0]).digest("hex") : "";
    const before = spent.get(root) ?? { amount: 0, uses: 0 };
    const verdict = await verifyDelegatedPurchase(proof, {
      audience: origin,
      nonce,
      checkoutKey: credentagent.ap2.checkoutPublicJwk,
      spent: before,
      price: (c) => c.line_items.reduce((sum, l) => sum + minor(bySku.get(l.item.id)?.price ?? NaN) * l.quantity, 0),
    });
    if (!verdict.ok) {
      console.log(`  [${key}] purchase REFUSED: ${verdict.code} — ${verdict.detail}`);
      return res.status(402).json(verdict);
    }
    const amount = verdict.payment.payment_amount.amount;
    spent.set(root, { amount: before.amount + amount, uses: before.uses + 1 });
    const order = {
      id: verdict.checkout.id, store: name, at: new Date().toISOString(), amount, currency: "USD",
      items: verdict.checkout.line_items.map((l) => `${l.quantity} × ${l.item.title}`),
      trust_level: verdict.trust_level,
    };
    orders.push(order);
    console.log(`  [${key}] purchase VERIFIED ✓ ${order.id} · $${(amount / 100).toFixed(2)} · ${verdict.trust_level}`);
    res.json({ ok: true, order, receiptUrl: `${origin}/agent/orders/${order.id}` });
  });

  // What the person opens to see the result.
  store.app.get("/agent/orders/:id", (req, res) => {
    const o = orders.find((x) => x.id === req.params.id);
    if (!o) return res.status(404).send("No such order.");
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(name)} — receipt</title>
<body style="font-family:system-ui;max-width:32rem;margin:2rem auto;padding:0 16px">
<h1>${escape(name)}</h1><p>Order <b>${escape(o.id)}</b> · ${escape(o.at)}</p>
<ul>${o.items.map((i) => `<li>${escape(i)}</li>`).join("")}</ul>
<p><b>Total: $${(o.amount / 100).toFixed(2)}</b></p>
<p>✓ Verified here: your phone-signed permission, the agent's signature, this store's signed cart, and our own price.</p>
<p style="color:#a15c00">trust_level: ${escape(o.trust_level)} — the signatures are real; the payment credential has no issuer trust anchor yet, and no real money moved.</p>`);
  });

  await store.listen(port);
  console.log(`  ${name.padEnd(15)} ${origin}   (local :${port}, merchant id ${host})`);
  return origin;
}

console.log("\nap2-multistore — three stores:");
const origins = [];
for (const s of STORES) origins.push(await startStore(s));
console.log(`\nStart the agent with:  STORES=${origins.join(",")} node examples/ap2-multistore/agent.mjs\n`);
