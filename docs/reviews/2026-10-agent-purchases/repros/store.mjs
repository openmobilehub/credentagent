// store.mjs — the coffee shop (merchant). Written from README + .d.ts only.
import express from "express";
import { randomUUID } from "node:crypto";
import { CredentAgent, verifyDelegatedPurchase, toMinorUnits } from "@openmobilehub/credentagent-gate";

export const ORIGIN = "http://localhost:4200";

// Business: the catalog (dollars, the shape grants want — README:693)
const CATALOG = {
  coffee: { price: 22, category: "Drinks", name: "Coffee subscription box" },
  tea:    { price: 9.5, category: "Drinks", name: "Tea tin" },
  beans:  { price: 22, category: "Retail", name: "1lb Beans" },
};

export function createStore() {
  const app = express();
  app.use(express.json());
  const credentagent = new CredentAgent({ walletOrigin: ORIGIN, catalog: CATALOG });
  credentagent.grants.serve(app);   // approve page + /sign/request + /sign/verify (undocumented)
  credentagent.mount(app);          // publishes /.well-known/did.json (README:248)

  // PLUMBING: nonce book + spend ledger (README:392 "Two things stay yours")
  const nonces = new Map();          // nonce -> checkoutJwt it was issued with
  const ledger = new Map();          // permissionId -> { amount (minor), uses }

  // 1. open a grant naming the agent's public key
  app.post("/grants", async (req, res) => {
    const grant = await credentagent.grants.create({
      merchant: "coffee-shop", budget: 50, perSpend: 25,
      allow: { skus: ["coffee", "tea"] },
      agentKey: req.body.agentPublicJwk,
    });
    res.json({ grantId: grant.id, approveUrl: grant.approveUrl });
  });

  // 2. hand the agent the signed permission (PLUMBING route)
  app.get("/grants/:id/intent", async (req, res) => {
    const g = await credentagent.grants.retrieve(req.params.id);
    if (!g || g.status !== "authorized" || !g.mandate?.intent) return res.status(409).json({ status: g?.status });
    res.json(g.mandate.intent);
  });

  // 3. quote a cart — PLUMBING: build a UCP Checkout by hand, dollars -> minor units
  const priceMinor = (lines) => lines.reduce((s, l) => s + toMinorUnits(CATALOG[l.item.id].price, "USD") * l.quantity, 0);
  app.post("/quote", (req, res) => {
    const unknown = req.body.items.find((i) => !CATALOG[i.sku]);
    if (unknown) return res.status(400).json({ error: `unknown sku ${unknown.sku}` });
    const line_items = req.body.items.map((i, n) => {
      const unit = toMinorUnits(CATALOG[i.sku].price, "USD"), qty = i.qty ?? 1;
      return { id: `li_${n}`, item: { id: i.sku, title: CATALOG[i.sku].name, price: unit }, quantity: qty,
               totals: [{ type: "subtotal", amount: unit * qty }, { type: "total", amount: unit * qty }] };
    });
    const total = line_items.reduce((s, l) => s + l.item.price * l.quantity, 0);
    const checkoutJwt = credentagent.ap2.signCheckout({
      id: `chk_${randomUUID()}`, line_items, status: "ready_for_complete", currency: "USD",
      totals: [{ type: "subtotal", amount: total }, { type: "total", amount: total }], links: [],
    });
    const nonce = randomUUID();
    nonces.set(nonce, checkoutJwt);
    res.json({ checkoutJwt, nonce, audience: ORIGIN });
  });

  // 4. verify a purchase
  app.post("/purchase", async (req, res) => {
    const { proof, nonce } = req.body;
    if (!nonces.delete(nonce) && !process.env.FORGET_NONCE) return res.status(409).json({ ok: false, code: "nonce-unknown-or-used" }); // consume FIRST
    const verdict = await verifyDelegatedPurchase(proof, {
      trust: "presence-only-demo",
      audience: ORIGIN,
      nonce,
      checkoutKey: credentagent.ap2.checkoutPublicJwk,
      spent: async (pid) => { const row = ledger.get(pid) ?? { amount: 0, uses: 0 }; await new Promise((r) => setTimeout(r, Number(process.env.DB_MS ?? 0))); return row; },
      price: (cart) => priceMinor(cart.line_items),
    });
    if (!verdict.ok) return res.status(402).json({ ok: false, code: verdict.code, violations: verdict.violations, detail: verdict.detail });
    const prev = ledger.get(verdict.permissionId) ?? { amount: 0, uses: 0 };
    ledger.set(verdict.permissionId, { amount: prev.amount + verdict.payment.payment_amount.amount, uses: prev.uses + 1 });
    res.json({ ok: true, paid: verdict.payment.payment_amount, spentSoFar: ledger.get(verdict.permissionId), trust: verdict.trust_level });
  });

  return app;
}
