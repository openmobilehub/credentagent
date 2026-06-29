// Cart ↔ Payment reconciliation — the cross-mandate agreement check + its enforcement on
// the shared completion seam. A signed ap2.CartMandate and a signed ap2.PaymentMandate
// must tell ONE story (same order, consistent currency, cart total == catalog-re-derived
// total == bound payment amount) before an order completes. These are BYPASS tests: each
// pins a control that, removed, lets a signed cart and a signed payment DISAGREE on amount
// and still complete — the exact under-charge invariant 3 forbids. (Tamper/expiry of the
// Cart Mandate itself is the layer BELOW this — verifyCartMandate — pinned in
// cartMandate.test.ts; reconciliation runs on top of a cart that already verified.)
import { describe, it, expect } from "vitest";
import { reconcileCartPayment } from "./reconciliation.js";
import { issueCartMandate, type CartMandate, type CartMandateLine } from "./cartMandate.js";
import { completeOrder, type CompletedRecord, type CompletionContext } from "./completion.js";
import { MemoryVerificationStore } from "../store.js";
import type { CeremonyCatalog, CompletionInput } from "./types.js";

const SECRET = "reconciliation-test-secret";
const round2 = (n: number) => Math.round(n * 100) / 100;

const PRODUCTS: Record<string, { price: number; minimumAge?: number }> = {
  widget: { price: 10 },
  gizmo: { price: 25 },
};

const catalog: CeremonyCatalog = {
  createOrder(items, orderId, opts) {
    const lines = items.map((it) => {
      const p = PRODUCTS[it.productId] ?? { price: 0 };
      return {
        id: it.productId,
        name: it.productId,
        unitPrice: p.price,
        currency: "USD",
        quantity: it.quantity,
        lineTotal: p.price * it.quantity,
        ...(p.minimumAge ? { minimumAge: p.minimumAge } : {}),
      };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const discount = opts?.loyaltyApplied ? round2(subtotal * 0.1) : 0;
    const total = round2(subtotal - discount);
    return { id: orderId, lines, itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal, discount, total, currency: "USD", createdAt: new Date().toISOString() };
  },
};

// ── Unit: the agreement function in isolation (each control = one line) ───────────
const WIDGET_LINE: CartMandateLine = { id: "widget", quantity: 2, unitPrice: 10, lineTotal: 20 };
function cart(orderId: string, over: { lines?: CartMandateLine[]; currency?: string; total: number }): CartMandate {
  return issueCartMandate({ orderId, lines: over.lines ?? [WIDGET_LINE], currency: over.currency ?? "USD", total: over.total }, SECRET);
}

describe("reconcileCartPayment — the cross-mandate agreement (unit)", () => {
  it("agrees when order, currency, and amount (cart == re-derived == payment) all match", () => {
    const v = reconcileCartPayment(cart("ORD-1", { total: 20 }), { amount: 20, currency: "USD", orderId: "ORD-1" }, 20);
    expect(v.ok).toBe(true);
  });

  it("BYPASS: refuses when the cart's sealed total ≠ the bound payment amount (reason 'amount')", () => {
    const v = reconcileCartPayment(cart("ORD-1", { total: 20 }), { amount: 15, currency: "USD", orderId: "ORD-1" }, 20);
    expect(v).toMatchObject({ ok: false, reason: "amount" });
  });

  it("BYPASS (invariant 2): refuses when the cart total ≠ the catalog-RE-DERIVED total, even if cart == payment (reason 'amount')", () => {
    // cart.total and payment.amount agree on 20, but the catalog re-derives 18 — the token
    // pair cannot out-vote the catalog. Re-derivation stays the price authority.
    const v = reconcileCartPayment(cart("ORD-1", { total: 20 }), { amount: 20, currency: "USD", orderId: "ORD-1" }, 18);
    expect(v).toMatchObject({ ok: false, reason: "amount" });
  });

  it("BYPASS: refuses a currency mismatch between the signed cart and the signed payment (reason 'currency')", () => {
    const v = reconcileCartPayment(cart("ORD-1", { currency: "EUR", total: 20 }), { amount: 20, currency: "USD", orderId: "ORD-1" }, 20);
    expect(v).toMatchObject({ ok: false, reason: "currency" });
  });

  it("BYPASS: refuses an order-id / subject mismatch — a cart swapped onto another order's payment (reason 'order-id')", () => {
    const v = reconcileCartPayment(cart("ORD-1", { total: 20 }), { amount: 20, currency: "USD", orderId: "ORD-2" }, 20);
    expect(v).toMatchObject({ ok: false, reason: "order-id" });
  });

  it("a membership-discounted cart agrees: line sum (20) − discount (2) = total (18) = signed amount", () => {
    // Lines still sum to 20 gross; the discounted total 18 must equal both the re-derived
    // total and the bound payment amount — the discount reconciles, it doesn't unbind.
    const v = reconcileCartPayment(cart("ORD-1", { total: 18 }), { amount: 18, currency: "USD", orderId: "ORD-1" }, 18);
    expect(v.ok).toBe(true);
  });
});

// ── Integration: enforced on completeOrder, after verify + re-price ───────────────
type Harness = {
  ctx: CompletionContext;
  records: Map<string, CompletedRecord>;
  store: MemoryVerificationStore;
  input: (over: Partial<CompletionInput>) => CompletionInput;
};

function harness(): Harness {
  const records = new Map<string, CompletedRecord>();
  const store = new MemoryVerificationStore();
  const ctx: CompletionContext = {
    catalog,
    verificationStore: store,
    records: { read: async (id) => records.get(id), write: async (rec) => void records.set(rec.orderId, rec) },
    signingKey: SECRET,
  };
  const base = (): CompletionInput => {
    const order = catalog.createOrder([{ productId: "widget", quantity: 2 }], "ORD-R");
    return { order, mandateId: "m1", amount: order.total, currency: order.currency, method: "test", gates: [{ gate: "g", pass: true, detail: "" }] };
  };
  return { ctx, records, store, input: (over) => ({ ...base(), ...over }) };
}

// A cart mandate over a freshly-priced order — the valid baseline the bypass tests mutate.
function mandateFor(orderId: string, items: { productId: string; quantity: number }[], opts: { loyaltyApplied?: boolean; currency?: string; total?: number } = {}): CartMandate {
  const order = catalog.createOrder(items, orderId, { loyaltyApplied: opts.loyaltyApplied });
  return issueCartMandate(
    {
      orderId,
      lines: order.lines.map((l) => ({ id: l.id, quantity: l.quantity, unitPrice: l.unitPrice ?? 0, lineTotal: l.lineTotal, ...(l.minimumAge ? { minimumAge: l.minimumAge } : {}) })),
      currency: opts.currency ?? order.currency,
      total: opts.total ?? order.total,
    },
    SECRET,
  );
}

describe("reconcileCartPayment — enforced on completeOrder (cross-mandate bypass)", () => {
  it("a cart + payment that AGREE complete (the reconciled happy path)", async () => {
    const h = harness();
    const res = await completeOrder(h.input({ cartMandate: mandateFor("ORD-R", [{ productId: "widget", quantity: 2 }]) }), h.ctx);
    expect(res.completed).toBe(true);
    expect(h.records.get("ORD-R")?.amount).toBe(20);
  });

  it("BYPASS: a cart sealed for X with a payment bound to Y≠X is refused (reason 'reconcile'), records nothing", async () => {
    const h = harness();
    // Cart Mandate is internally valid — correctly signed for ITS claimed total of 15 — and
    // the order/payment both say 20, which re-prices fine (20 === 20). Only the cross-mandate
    // reconciliation catches that the signed cart and the signed payment disagree on amount.
    const skewed = mandateFor("ORD-R", [{ productId: "widget", quantity: 2 }], { total: 15 });
    const res = await completeOrder(h.input({ cartMandate: skewed }), h.ctx);
    expect(res).toMatchObject({ completed: false, reason: "reconcile" });
    expect(h.records.size).toBe(0);
  });

  it("BYPASS: a currency-divergent cart vs payment is refused (reason 'reconcile')", async () => {
    const h = harness();
    // Validly signed over EUR, but the order/payment settle in USD — re-price passes (20),
    // reconciliation refuses the currency divergence.
    const eur = mandateFor("ORD-R", [{ productId: "widget", quantity: 2 }], { currency: "EUR" });
    const res = await completeOrder(h.input({ cartMandate: eur }), h.ctx);
    expect(res).toMatchObject({ completed: false, reason: "reconcile" });
    expect(h.records.size).toBe(0);
  });

  it("a membership-discounted order reconciles across the path and completes (line sum = total = signed amount)", async () => {
    const h = harness();
    await h.store.write("ORD-R", { loyalty: { applied: true, membershipNumber: "M-1" } }); // this order opted into the discount
    const order = catalog.createOrder([{ productId: "widget", quantity: 2 }], "ORD-R", { loyaltyApplied: true }); // total 18
    const discountedCart = mandateFor("ORD-R", [{ productId: "widget", quantity: 2 }], { loyaltyApplied: true }); // sealed 18
    const res = await completeOrder({ order, mandateId: "m", amount: order.total, currency: order.currency, method: "test", gates: [{ gate: "g", pass: true, detail: "" }], cartMandate: discountedCart }, h.ctx);
    expect(res.completed).toBe(true);
    expect(order.total).toBe(18);
    expect(h.records.get("ORD-R")?.amount).toBe(18);
  });

  it("BYPASS (invariant 3): a cart sealed UNDISCOUNTED against a discounted payment is refused (reason 'reconcile')", async () => {
    const h = harness();
    await h.store.write("ORD-R", { loyalty: { applied: true, membershipNumber: "M-1" } }); // re-prices to 18
    const order = catalog.createOrder([{ productId: "widget", quantity: 2 }], "ORD-R", { loyaltyApplied: true }); // total 18
    const undiscountedCart = mandateFor("ORD-R", [{ productId: "widget", quantity: 2 }]); // sealed at the gross 20
    const res = await completeOrder({ order, mandateId: "m", amount: order.total, currency: order.currency, method: "test", gates: [{ gate: "g", pass: true, detail: "" }], cartMandate: undiscountedCart }, h.ctx);
    expect(res).toMatchObject({ completed: false, reason: "reconcile" });
    expect(h.records.size).toBe(0);
  });
});
