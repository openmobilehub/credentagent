// ap2-multistore/stores.mjs — three independent coffee stores, each a `createStorefront` with its OWN
// catalog, its OWN gate (own keys, own grants) and its OWN origin. The agent (agent.mjs, a separate
// process) compares them, gets the person's permission for the winner signed on their phone, and
// pays there; the store checks the purchase with `verifyDelegatedPurchase`.
//
//   node examples/ap2-multistore/up.mjs        # tunnels + both processes — what you want for a phone
//   node examples/ap2-multistore/stores.mjs    # local only: http://localhost:4101 … 4103 (BASE_PORT moves them)
//
// Each store's back office is at its root URL, live; http://localhost:4104 shows all three side by side.
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
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { CredentAgent, verifyDelegatedPurchase } from "@openmobilehub/credentagent-gate";
import { createFeed } from "./console/feed.mjs";

// Ports: the agent takes BASE_PORT, the stores the next three, the wall the one after (default 4100–4104).
const BASE = Number(process.env.BASE_PORT ?? 4100);

// Same three products everywhere, different prices and ratings — so there is something to compare.
const STORES = [
  {
    key: "acme", name: "Acme Coffee Co", port: BASE + 1, url: process.env.ACME_URL, accent: "#c2410c",
    products: { "house-blend": [24, 4.1], "espresso-beans": [19, 4.0], "green-tea": [9, 3.8] },
  },
  {
    key: "beanbarn", name: "BeanBarn", port: BASE + 2, url: process.env.BEANBARN_URL, accent: "#6d28d9",
    products: { "house-blend": [21, 4.4], "espresso-beans": [22, 4.2], "green-tea": [8, 4.5] },
  },
  {
    key: "roastworks", name: "RoastWorks", port: BASE + 3, url: process.env.ROASTWORKS_URL, accent: "#1d4ed8",
    // Scenario 1: Cold Brew is sold here only — one store, nothing to compare.
    products: { "house-blend": [26, 4.6], "espresso-beans": [18, 4.7], "green-tea": [11, 4.0], "cold-brew": [14, 4.8] },
  },
];
const NAMES = { "house-blend": "House Blend, 1 lb bag", "espresso-beans": "Espresso Beans, 1 lb bag", "green-tea": "Green Tea, 50 bags", "cold-brew": "Cold Brew Concentrate, 32 oz" };
const CATEGORY = { "house-blend": "Coffee", "espresso-beans": "Coffee", "green-tea": "Tea", "cold-brew": "Coffee" };
const WALL_PORT = BASE + 4;

const minor = (dollars) => Math.round(dollars * 100);
const usd = (minorUnits) => `$${(minorUnits / 100).toFixed(2)}`;
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const page = (file) => readFileSync(new URL(`./console/${file}`, import.meta.url), "utf8");
const CONSOLE = page("console.html");
const WALL = page("wall.html");
const THEME = page("theme.css");
// Config rides into a page as JSON inside <script type="application/json">; "<" is escaped so no value can close the tag.
// A replacer function, because in a replacement string "$&" and friends are patterns, not text.
const fill = (html, config) => html.replace("/*CONFIG*/", () => JSON.stringify(config).replace(/</g, "\\u003c"));

// Why a purchase was refused, in words a person reading the back office understands.
const LIMITS = {
  "checkout.allowed_merchants": "This permission was signed for another store",
  "payment.allowed_payees": "This permission was signed for another store",
  "checkout.line_items": "A product isn't on the permission the person signed",
  "payment.budget": "Over the total budget the person signed",
  "payment.amount_range": "Over the per-purchase limit the person signed",
};
const CODES = {
  price: "The cart's price doesn't match our catalog",
  "checkout-unbound": "The cart isn't one we quoted and signed",
  unbound: "The payment is for a different cart",
  payee: "The payment pays someone other than us",
  amount: "The payment doesn't add up to the cart's total",
  audience: "The agent addressed this purchase to another store",
  nonce: "Unknown or reused purchase code (replay refused)",
  expired: "The permission has expired",
  "not-yet-valid": "The permission isn't valid yet",
};
const SIGNATURES = new Set(["malformed", "root", "signature", "binding", "typ", "disclosure", "splice", "unexpected-type"]);
function explain(verdict) {
  if (verdict.code === "constraint") {
    const known = verdict.violations?.find((v) => LIMITS[v.constraint]);
    return known ? LIMITS[known.constraint] : (verdict.violations?.[0]?.detail ?? verdict.detail);
  }
  return CODES[verdict.code] ?? (SIGNATURES.has(verdict.code) ? "The signatures don't check out" : verdict.detail);
}

async function startStore({ key, name, port, url, accent, products }) {
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
  const feed = createFeed();
  const grantIds = new Set(); // grants THIS store opened — the only ones its back office reports on
  const opened = new Set();

  // ── the back office: the page, its theme, its live stream ──────────────────
  const consoleConfig = { name, accent, merchantId: host, catalog: catalog.map(({ name, price, rating }) => ({ name, price, rating })) };
  store.app.get("/", (_req, res) => res.type("html").send(fill(CONSOLE, consoleConfig)));
  store.app.get("/console/theme.css", (_req, res) => res.type("css").send(THEME));
  store.app.get("/console/events", (req, res) => feed.stream(req, res));
  store.app.get("/console/history", (_req, res) => res.json(feed.history()));

  // The person opening the signing link on their phone — noted before the library's page serves it.
  store.app.get("/credentagent/grants/:id", (req, _res, next) => {
    const id = req.params.id;
    if (grantIds.has(id) && !opened.has(id)) {
      opened.add(id);
      feed.emit("permission.opened", { grantId: id });
    }
    next();
  });
  credentagent.grants.serve(store.app); // approveUrl → the phone signing ceremony (spec 012)

  // The gate has no "signed" callback, so the back office notes it the first time ANY read sees the grant
  // settled: its own once-a-second read, or the agent fetching the signed permission — which it must do
  // before it can buy, so "signed" always lands in the feed ahead of the purchase.
  const settled = new Set();
  function noteSettled(id, g) {
    if (!g || g.status === "pending" || settled.has(id) || !grantIds.has(id)) return;
    settled.add(id);
    if (g.status === "authorized") feed.emit("permission.signed", { grantId: id, trustLevel: g.trustLevel });
    else feed.emit("permission.denied", { grantId: id, status: g.status });
  }
  function watchGrant(id) {
    const until = Date.now() + 15 * 60_000;
    const timer = setInterval(async () => {
      noteSettled(id, await credentagent.grants.retrieve(id));
      if (settled.has(id) || Date.now() > until) clearInterval(timer);
    }, 1000);
    timer.unref();
  }

  const nonces = new Map(); // nonce → grantId; single-use, consumed at /purchase (invariant 6)
  const spent = new Map(); // permission root → { amount, uses } in minor units — what THIS store has charged under it
  const orders = [];
  const json = express.json({ limit: "1mb" });

  store.app.get("/agent/catalog", (_req, res) => {
    feed.emit("catalog.read");
    res.json({ store: name, merchant: me, products: catalog.map(({ id, name, price, rating }) => ({ id, name, price, currency: "USD", rating })) });
  });

  // Open a grant naming the AGENT's public key. The gate generates no key for it and refuses a private one.
  store.app.post("/agent/grants", json, async (req, res) => {
    const { agentKey, skus, budget, perSpend, description } = req.body ?? {};
    try {
      const unknown = (skus ?? []).filter((s) => !bySku.has(s));
      if (!skus?.length || unknown.length) return res.status(400).json({ error: `unknown or missing skus: ${unknown.join(", ") || "none given"}` });
      // Scenario 2(a): never ask the person to sign a permission nothing can be bought with. If every product
      // costs more than the per-purchase limit, refuse now — at the phone it would be a signature for nothing.
      const cheapest = skus.map((s) => bySku.get(s)).reduce((a, b) => (b.price < a.price ? b : a));
      if (cheapest.price > perSpend) {
        const reason = `${cheapest.name} costs $${cheapest.price.toFixed(2)}, above the $${Number(perSpend).toFixed(2)} per-purchase limit`;
        feed.emit("permission.refused", { products: skus.map((s) => bySku.get(s).name), reason });
        return res.status(400).json({ error: `No product in this permission can be bought within its limit: ${reason}.` });
      }
      const g = await credentagent.grants.create({ merchant: key, budget, perSpend, allow: { skus }, agentKey, description });
      grantIds.add(g.id);
      feed.emit("permission.requested", {
        grantId: g.id, products: skus.map((s) => bySku.get(s).name), budget: minor(budget), perSpend: minor(perSpend),
        agentKeyX: String(agentKey?.x ?? "").slice(0, 10),
      });
      watchGrant(g.id);
      res.json({ grantId: g.id, approveUrl: g.approveUrl, status: g.status, store: name, merchantId: host, products: skus.map((s) => bySku.get(s).name) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // The agent polls this; once the phone has signed, the signed permission is public data it can carry.
  store.app.get("/agent/grants/:id", async (req, res) => {
    const g = await credentagent.grants.retrieve(req.params.id);
    if (!g) return res.status(404).json({ error: "no such grant" });
    noteSettled(req.params.id, g);
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
    feed.emit("cart.quoted", { cartId: cart.id, items: line_items.map((l) => `${l.quantity} × ${l.item.title}`), total });
    res.json({ store: name, checkoutJwt: credentagent.ap2.signCheckout(cart), payee: me, amount: { amount: total, currency: "USD" }, audience: origin, nonce });
  });

  // One call decides. The catalog re-prices the cart (invariant 2); the nonce is used once (invariant 6).
  store.app.post("/agent/purchase", json, async (req, res) => {
    const { proof, nonce } = req.body ?? {};
    if (!nonces.has(nonce)) {
      feed.emit("purchase.refused", { code: "nonce", reason: CODES.nonce });
      return res.status(400).json({ ok: false, store: name, code: "nonce", reason: CODES.nonce, detail: "unknown or already-used nonce" });
    }
    nonces.delete(nonce);
    // Key the running total by the permission itself (the chain's root, which the verdict checks), never
    // by an id the agent sends — a fresh id must not reset what has been spent under the same permission.
    const root = typeof proof?.payment === "string" ? createHash("sha256").update(proof.payment.split("~")[0]).digest("hex") : "";
    const before = spent.get(root) ?? { amount: 0, uses: 0 };
    const verdict = await verifyDelegatedPurchase(proof, {
      // Said out loud, as the library requires: the demo's payment credential has no issuer trust anchor
      // yet (#14), so this verifies presence and binding, not that a bank stands behind the card.
      trust: "presence-only-demo",
      audience: origin,
      nonce,
      checkoutKey: credentagent.ap2.checkoutPublicJwk,
      spent: before,
      price: (c) => c.line_items.reduce((sum, l) => sum + minor(bySku.get(l.item.id)?.price ?? NaN) * l.quantity, 0),
    });
    if (!verdict.ok) {
      console.log(`  [${key}] purchase REFUSED: ${verdict.code} — ${verdict.detail}`);
      const reason = explain(verdict);
      feed.emit("purchase.refused", { code: verdict.code, reason });
      return res.status(402).json({ ...verdict, store: name, reason });
    }
    const amount = verdict.payment.payment_amount.amount;
    spent.set(root, { amount: before.amount + amount, uses: before.uses + 1 });
    // What verifyDelegatedPurchase just checked — each line is a refusal code it would have returned instead.
    const budget = verdict.open.payment.constraints.find((c) => c.type === "payment.budget");
    const cap = verdict.open.payment.constraints.find((c) => c.type === "payment.amount_range");
    const checks = [
      "The permission's wallet signature verifies",
      "The agent signed with the key that permission names",
      "The cart is the one we quoted and signed",
      "The permission allows this store",
      `Within the signed limits: ${usd(before.amount + amount)}${budget ? ` of ${usd(budget.max)}` : ""}${cap ? `, max ${usd(cap.max)} a purchase` : ""}`,
      `Our catalog prices it at ${usd(amount)}`,
      "Fresh purchase code, addressed to us (no replay)",
    ];
    const order = {
      id: verdict.checkout.id, store: name, at: new Date().toISOString(), amount, currency: "USD",
      items: verdict.checkout.line_items.map((l) => `${l.quantity} × ${l.item.title}`),
      trust_level: verdict.trust_level, checks,
    };
    orders.push(order);
    feed.emit("purchase.verified", { orderId: order.id, items: order.items, amount, checks, permission: root.slice(0, 8) });
    console.log(`  [${key}] purchase VERIFIED ✓ ${order.id} · ${usd(amount)} · ${verdict.trust_level}`);
    res.json({ ok: true, order, receiptUrl: `${origin}/agent/orders/${order.id}` });
  });

  // What the person opens to see the result.
  store.app.get("/agent/orders/:id", (req, res) => {
    const o = orders.find((x) => x.id === req.params.id);
    if (!o) return res.status(404).send("No such order.");
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(name)} — receipt</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&family=Fira+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="../../console/theme.css">
<style>main{max-width:34rem;margin:0 auto;padding:16px;display:grid;gap:14px}.card{padding:16px}ul{margin:0;padding-left:20px}
.checks{list-style:none;padding:0;display:grid;gap:4px;font-size:14px}.checks li{display:flex;gap:6px}.checks li::before{content:"✓";color:var(--ok);font-weight:600;flex:none}
.total{display:flex;justify-content:space-between;font-size:20px;font-weight:600;border-top:1px solid var(--border);padding-top:10px;margin-top:10px}</style>
</head><body style="--accent:${escape(accent)}">
<header class="brand"><div class="mark" aria-hidden="true">${escape(name[0])}</div><div class="who"><h1>${escape(name)}</h1><p class="mono muted">order ${escape(o.id)} · ${escape(new Date(o.at).toLocaleString("en-US"))}</p></div><span class="pill ok"><span class="dot"></span>Verified</span></header>
<main>
<section class="card"><h2>Your order</h2><ul>${o.items.map((i) => `<li>${escape(i)}</li>`).join("")}</ul><p class="total"><span>Total</span><span>${usd(o.amount)}</span></p></section>
<section class="card"><h2>What ${escape(name)} verified before accepting it</h2><ul class="checks">${o.checks.map((c) => `<li>${escape(c)}</li>`).join("")}</ul></section>
<p class="notice" style="border-radius:var(--radius)">Demo: trust_level ${escape(o.trust_level)}. The signatures are real; the payment credential has no issuer trust anchor yet, and no real money moved.</p>
</main></body></html>`);
  });

  await store.listen(port);
  console.log(`  ${name.padEnd(15)} ${origin}   (local :${port}, merchant id ${host})`);
  return { name, port, origin };
}

console.log("\nap2-multistore — three stores:");
const started = [];
for (const s of STORES) started.push(await startStore(s));

// The wall: all three back offices side by side, for the screen next to the chat. Local only.
const wall = express();
wall.get("/", (_req, res) => res.type("html").send(fill(WALL, started.map(({ name, port }) => ({ name, url: `http://localhost:${port}/` })))));
wall.listen(WALL_PORT, "127.0.0.1", () => console.log(`\n  Store wall (all three back offices, live) → http://localhost:${WALL_PORT}`));
if (!process.env.ACME_URL) console.log(`\nStart the agent with:  STORES=${started.map((s) => s.origin).join(",")} node examples/ap2-multistore/agent.mjs\n`);
