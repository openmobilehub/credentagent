// ⚠ PROTOTYPE — a validation demo, NOT the shipping library API. It graduates into the
//   real credentagent.orders.* / credentagent.grants.* API in #97 (the demo is rewired to it).
// grants.mjs — a RUNNABLE prototype of the v10 `grants.*` surface (#92 / spec 008),
// the human-NOT-present half, over the REAL DelegatedGate engine.
//
// grants.create → authorize (the Intent Mandate is produced) → grant.spend loop
// (budget / perSpend enforcement, remaining, idempotent replay) → grant.revoke.
//
// REAL: DelegatedGate.preApprove/spend/revoke — the bounds check, the single-use ledger,
// the revocation, the dev-sealed Intent Mandate (sealIntent) are the actual engine.
// FACADE polish demonstrating the v10 design: usd() Money, { ok | code } door, idempotent
// replay ({ ok:true, replayed:true }), split reason codes (per-spend vs budget), mandateBundle.
// HONEST: today preApprove seals the intent SERVER-side (presence "delegated-demo",
// trust "server-issued-demo"); the human-signs-on-the-phone ceremony is the roadmap (#71).

import { DelegatedGate, issueCartMandate } from "@openmobilehub/credentagent-gate";

const SIGNING_KEY = "grants-proto-secret";
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

// Engine RefusalCode → the v10 door's `code` (spec 008).
const REASON_MAP = {
  "over-cap": "per-spend-exceeded",   // per-draw ceiling (TS12 max_amount)
  "over-total": "budget-exceeded",    // cumulative budget (TS12 total_amount)
  "revoked": "revoked",
  "consumed": "revoked",
  "out-of-scope": "wrong-merchant",
  "expired": "expired",
};

export function usd(minor) {
  return Object.freeze({
    currency: "usd", _minor: minor,
    lt(o) { return minor < o._minor; }, gte(o) { return minor >= o._minor; }, eq(o) { return minor === o._minor; },
    serialize() { return { amount: minor, currency: "usd" }; },
    toString() { return `$${(minor / 100).toFixed(2)}`; },
  });
}
usd.dollars = (d) => usd(Math.round(d * 100));
usd.cents = (c) => usd(c);

export class GrantsProto {
  constructor({ catalog }) {
    this.catalogMinor = catalog;                         // { sku: minorUnits }
    this.gate = new DelegatedGate({ catalog });          // the REAL delegated engine
    this._grants = new Map();
  }

  // grants.create({ merchant, budget, perSpend, policy }) — authorize once; the Intent Mandate is produced.
  async create({ merchant, budget, perSpend, policy = [], description }) {
    const dg = await this.gate.preApprove({
      merchant,
      perOrder: perSpend._minor,
      total: budget._minor,
      description: description ?? `Up to ${budget} at ${merchant}, ${perSpend}/purchase`,
    });
    const intentMandate = {
      type: "ap2.IntentMandate",
      intentId: dg.id,
      presence: dg.presence,                             // "delegated-demo"
      trustLevel: dg.trustLevel,                         // "server-issued-demo"
      bounds: { merchant, perSpend: perSpend.serialize(), budget: budget.serialize(), policy: policy.map((p) => p.credential?.id ?? p.id ?? "credential") },
      serialize() { return b64u({ ...this, serialize: undefined }); },
    };
    const rec = { id: dg.id, dg, merchant, budget, perSpend, status: "authorized", intentMandate, cache: new Map() };
    this._grants.set(dg.id, rec);
    return this._view(rec);
  }

  // grants.retrieve(id) — rehydrate the grant handle.
  retrieve(id) {
    const rec = this._grants.get(id);
    return rec ? this._view(rec) : null;
  }

  _view(rec) {
    return {
      id: rec.id,
      status: rec.status,
      approveUrl: `about:blank#authorize-${rec.id}`,      // roadmap: the wallet ceremony that key-signs the intent
      intentMandate: rec.intentMandate,
      budget: rec.budget.serialize(),
      perSpend: rec.perSpend.serialize(),
      spend: (purchase) => this._spend(rec, purchase),
      revoke: () => this._revoke(rec),
    };
  }

  async _spend(rec, { idempotencyKey, items }) {
    if (rec.cache.has(idempotencyKey)) return { ...rec.cache.get(idempotencyKey), replayed: true };   // v10 idempotent replay
    const { sku, qty = 1 } = items[0];
    const r = await rec.dg.spend({ idempotencyKey, item: sku, quantity: qty });
    let door;
    if (r.ok) {
      door = {
        ok: true,
        amount: usd(r.amount).serialize(),
        remaining: usd(r.remaining).serialize(),
        replayed: false,
        authorization: "delegated",
        trustLevel: "presence-only-demo",
        mandateBundle: this._bundle(rec, sku, qty, r.amount),
      };
    } else {
      // Map the engine's RefusalCode → the v10 door's `code` vocabulary. The engine already
      // distinguishes the two caps: "over-cap" = the per-draw (per-spend) ceiling, "over-total"
      // = the cumulative budget.
      const code = REASON_MAP[r.reason] ?? r.reason;
      door = { ok: false, code, remaining: usd(r.remaining).serialize(), retryable: r.retryable, trustLevel: "presence-only-demo" };
    }
    rec.cache.set(idempotencyKey, door);
    return door;
  }

  async _revoke(rec) {
    await rec.dg.revoke();
    rec.status = "revoked";
    return { revoked: true, status: "revoked" };
  }

  _bundle(rec, sku, qty, amountMinor) {
    // A CartMandateLine is { id, quantity, unitPrice, lineTotal } — so a recipient can reconcile the
    // signed mandate to the priced purchase (Codex P1). Price from the catalog, never the caller.
    const unitPrice = this.catalogMinor[sku] ?? Math.round(amountMinor / qty);
    const line = { id: sku, quantity: qty, unitPrice, lineTotal: unitPrice * qty };
    const cart = issueCartMandate(
      { orderId: `${rec.id}-${sku}-${rec.cache.size}`, lines: [line], currency: "usd", total: amountMinor },
      SIGNING_KEY,
    );
    const pay = {
      type: "ap2.PaymentMandate", amount: { amount: amountMinor, currency: "usd" },
      presenceMode: "human_not_present", authorization: "delegated", cart: cart.id,
      intentId: rec.id, trust_level: "presence-only-demo",
    };
    return {
      intentMandate: { type: rec.intentMandate.type, intentId: rec.intentMandate.intentId, trustLevel: rec.intentMandate.trustLevel },
      cartMandate: { type: cart.type, id: cart.id, total: cart.total, trust_level: cart.trust_level, serialized: b64u(cart) },
      paymentMandate: { ...pay, serialized: b64u(pay) },
      trustLevel: "presence-only-demo",
    };
  }
}
