// Does the purchase stay inside what the person allowed? One test per constraint AP2 defines,
// and the rule that makes the vocabulary safe to grow: a constraint the evaluator does not know
// FAILS (spec 014, AP2 processing rule 3) — silence would be a limit nobody enforces.
import { describe, expect, it } from "vitest";
import { evaluateCheckout, evaluatePayment } from "./constraints.js";
import { mandateContentDigest } from "../digest.js";
import { VCT, type OpenCheckoutMandate, type OpenPaymentMandate, type PaymentMandate, type UcpCheckout } from "../types.js";

const cnf = { jwk: { kty: "EC" as const, crv: "P-256" as const, x: "x", y: "y" } };
const SHOP = { id: "shop.example", name: "Shop" };

const openCheckout = (constraints: OpenCheckoutMandate["constraints"]): OpenCheckoutMandate => ({ vct: VCT.openCheckout, constraints, cnf, exp: 2 ** 31 });

const coffee = { id: "r-coffee", acceptable_items: [{ id: "coffee", title: "Coffee" }], quantity: 2 };
const lineItems = { type: "checkout.line_items" as const, items: [coffee] as [typeof coffee] };

const cart = (lines: Array<[string, number]>, merchant = SHOP): UcpCheckout => ({
  id: "ord_1",
  merchant,
  line_items: lines.map(([id, quantity], i) => ({ id: `li${i}`, item: { id, title: id, price: 300 }, quantity, totals: [{ type: "total", amount: 300 * quantity }] })),
  status: "ready_for_complete",
  currency: "USD",
  totals: [{ type: "total", amount: lines.reduce((s, [, q]) => s + 300 * q, 0) }],
  links: [],
});

const checkoutOk = openCheckout([{ type: "checkout.allowed_merchants", allowed: [SHOP] }, lineItems]);

describe("checkout constraints", () => {
  it("passes a cart inside the allow-list", () => {
    expect(evaluateCheckout(checkoutOk, cart([["coffee", 2]]))).toEqual([]);
  });

  // Spec 014: "the intent cannot be replayed at a merchant it excludes".
  it("refuses a merchant outside allowed_merchants (bypass)", () => {
    const v = evaluateCheckout(checkoutOk, cart([["coffee", 1]], { id: "elsewhere.example", name: "Elsewhere" }));
    expect(v).toEqual([expect.objectContaining({ code: "constraint", constraint: "checkout.allowed_merchants" })]);
  });

  it("refuses an item no requirement accepts (bypass)", () => {
    const v = evaluateCheckout(checkoutOk, cart([["coffee", 1], ["whisky", 1]]));
    expect(v).toEqual([expect.objectContaining({ constraint: "checkout.line_items", detail: expect.stringMatching(/whisky not accepted/) })]);
  });

  it("refuses more of an item than its requirement allows (bypass)", () => {
    expect(evaluateCheckout(checkoutOk, cart([["coffee", 3]]))).toEqual([expect.objectContaining({ constraint: "checkout.line_items" })]);
  });

  it("refuses an empty cart", () => {
    expect(evaluateCheckout(checkoutOk, cart([]))).toEqual([expect.objectContaining({ constraint: "checkout.line_items" })]);
  });

  // An item two requirements accept must be assigned where capacity remains — a greedy first-fit
  // would put both teas in the first slot and refuse a cart the mandate allows.
  it("assigns shared items across requirements, not first-fit", () => {
    const either = { id: "r-any", acceptable_items: [{ id: "coffee", title: "C" }, { id: "tea", title: "T" }], quantity: 1 };
    const teaOnly = { id: "r-tea", acceptable_items: [{ id: "tea", title: "T" }], quantity: 1 };
    const open = openCheckout([{ type: "checkout.line_items", items: [either, teaOnly] }]);
    expect(evaluateCheckout(open, cart([["coffee", 1], ["tea", 1]]))).toEqual([]);
    expect(evaluateCheckout(open, cart([["tea", 2]]))).toEqual([]);
    // Tea first takes the shared slot; coffee then only fits if tea is MOVED to the tea-only one.
    expect(evaluateCheckout(open, cart([["tea", 1], ["coffee", 1]]))).toEqual([]);
    expect(evaluateCheckout(open, cart([["coffee", 2]]))).not.toEqual([]);
  });

  it("refuses an open checkout with no line_items constraint — it would bound nothing (bypass)", () => {
    expect(evaluateCheckout(openCheckout([{ type: "checkout.allowed_merchants", allowed: [SHOP] }]), cart([["coffee", 1]]))).toEqual([
      expect.objectContaining({ code: "constraint", constraint: "checkout.line_items", detail: expect.stringMatching(/must contain/) }),
    ]);
  });

  it("FAILS a constraint it does not know (bypass)", () => {
    const open = openCheckout([lineItems, { type: "checkout.shipping_country", allowed: ["US"] } as never]);
    expect(evaluateCheckout(open, cart([["coffee", 1]]))).toEqual([expect.objectContaining({ code: "unknown-constraint", constraint: "checkout.shipping_country" })]);
  });
});

// ── payment ───────────────────────────────────────────────────────────────

const openC = checkoutOk;
const REF = mandateContentDigest(openC as never);
const openPayment = (constraints: OpenPaymentMandate["constraints"], extra: Partial<OpenPaymentMandate> = {}): OpenPaymentMandate => ({
  vct: VCT.openPayment,
  constraints: [{ type: "payment.reference", conditional_transaction_id: REF }, ...constraints],
  cnf,
  exp: 2 ** 31,
  ...extra,
});
const closed = (over: Partial<PaymentMandate> = {}): PaymentMandate => ({
  vct: VCT.payment,
  transaction_id: "tx",
  payee: SHOP,
  payment_amount: { amount: 600, currency: "USD" },
  payment_instrument: { id: "pi_1", type: "card" },
  ...over,
});
const ctx = (over: Partial<Parameters<typeof evaluatePayment>[2]> = {}) => ({ openCheckout: openC, spent: { amount: 0, uses: 0 }, ...over });

describe("payment constraints", () => {
  const range = { type: "payment.amount_range" as const, currency: "USD", max: 5000 };
  const budget = { type: "payment.budget" as const, currency: "USD", max: 20_000 };

  it("passes a payment inside every limit", () => {
    expect(evaluatePayment(openPayment([range, budget, { type: "payment.allowed_payees", allowed: [SHOP] }]), closed(), ctx())).toEqual([]);
  });

  // Spec 014: "the closed mandate cannot exceed the open one".
  it("refuses a payment above amount_range.max (bypass)", () => {
    expect(evaluatePayment(openPayment([range]), closed({ payment_amount: { amount: 5001, currency: "USD" } }), ctx())).toEqual([
      expect.objectContaining({ constraint: "payment.amount_range", detail: expect.stringMatching(/5001.*5000/) }),
    ]);
  });

  it("refuses a payment below amount_range.min, or in another currency (bypass)", () => {
    expect(evaluatePayment(openPayment([{ ...range, min: 700 }]), closed(), ctx())).toEqual([expect.objectContaining({ constraint: "payment.amount_range" })]);
    expect(evaluatePayment(openPayment([range]), closed({ payment_amount: { amount: 600, currency: "EUR" } }), ctx())).toEqual([
      expect.objectContaining({ constraint: "payment.amount_range", detail: expect.stringMatching(/currency/i) }),
    ]);
  });

  it("refuses a payment that would take cumulative spend past the budget (bypass)", () => {
    expect(evaluatePayment(openPayment([budget]), closed(), ctx({ spent: { amount: 19_500, uses: 3 } }))).toEqual([
      expect.objectContaining({ constraint: "payment.budget", detail: expect.stringMatching(/20100.*20000/) }),
    ]);
  });

  // Decision 1: budget and recurrence are stateful. No usage given ⇒ no way to check ⇒ refused.
  it("refuses a budget it cannot evaluate because no usage was supplied (bypass)", () => {
    expect(evaluatePayment(openPayment([budget]), closed(), ctx({ spent: undefined }))).toEqual([
      expect.objectContaining({ constraint: "payment.budget", detail: expect.stringMatching(/spent/) }),
    ]);
  });

  it("refuses a payee outside allowed_payees (bypass)", () => {
    expect(evaluatePayment(openPayment([{ type: "payment.allowed_payees", allowed: [SHOP] }]), closed({ payee: { id: "evil.example", name: "Evil" } }), ctx())).toEqual([
      expect.objectContaining({ constraint: "payment.allowed_payees" }),
    ]);
  });

  // payment.reference is what ties this payment authority to ITS checkout authority. A payment
  // chain presented beside another grant's checkout chain names the wrong digest.
  it("refuses a payment.reference that names another open checkout (bypass)", () => {
    const otherCheckout = openCheckout([{ type: "checkout.allowed_merchants", allowed: [{ id: "x", name: "X" }] }, lineItems]);
    expect(evaluatePayment(openPayment([]), closed(), ctx({ openCheckout: otherCheckout }))).toEqual([expect.objectContaining({ constraint: "payment.reference" })]);
  });

  it("refuses an open payment with no payment.reference (bypass)", () => {
    const unbound = { ...openPayment([range]), constraints: [range] };
    expect(evaluatePayment(unbound, closed(), ctx())).toEqual([expect.objectContaining({ constraint: "payment.reference", detail: expect.stringMatching(/must contain/) })]);
  });

  it("refuses an instrument or PISP outside its allow-list (bypass)", () => {
    expect(evaluatePayment(openPayment([{ type: "payment.allowed_payment_instruments", allowed: [{ id: "pi_2", type: "card" }] }]), closed(), ctx())).toEqual([
      expect.objectContaining({ constraint: "payment.allowed_payment_instruments" }),
    ]);
    const pisp = { legal_name: "P Ltd", brand_name: "P", domain_name: "p.example" };
    expect(evaluatePayment(openPayment([{ type: "payment.allowed_pisps", allowed: [pisp] }]), closed(), ctx())).toEqual([expect.objectContaining({ constraint: "payment.allowed_pisps" })]);
    expect(evaluatePayment(openPayment([{ type: "payment.allowed_pisps", allowed: [pisp] }]), closed({ pisp }), ctx())).toEqual([]);
  });

  it("refuses an execution date outside its window (bypass)", () => {
    const window = { type: "payment.execution_date" as const, not_before: "2026-10-01", not_after: "2026-10-31" };
    const now = { nowMs: Date.parse("2026-09-30T12:00:00Z") };
    expect(evaluatePayment(openPayment([window]), closed({ execution_date: "2026-11-02" }), ctx(now))).toEqual([expect.objectContaining({ constraint: "payment.execution_date" })]);
    expect(evaluatePayment(openPayment([window]), closed({ execution_date: "2026-10-15" }), ctx(now))).toEqual([]);
  });

  it("REFUSES a backdated execution date — it runs now, not inside the window it names (bypass, #242)", () => {
    const window = { type: "payment.execution_date" as const, not_after: "2026-11-30T00:00:00Z" };
    const dec5 = { nowMs: Date.parse("2026-12-05T12:00:00Z") };
    expect(evaluatePayment(openPayment([window]), closed({ execution_date: "2026-11-30T00:00:00Z" }), ctx(dec5))).toEqual([
      expect.objectContaining({ constraint: "payment.execution_date", detail: expect.stringMatching(/in the past/) }),
    ]);
    // Within the minute of clock tolerance is not "the past"; a future date inside the window is a scheduled payment.
    const nov10 = Date.parse("2026-11-10T12:00:00Z");
    expect(evaluatePayment(openPayment([window]), closed({ execution_date: new Date(nov10 - 30_000).toISOString() }), ctx({ nowMs: nov10 }))).toEqual([]);
    expect(evaluatePayment(openPayment([window]), closed({ execution_date: "2026-11-15T00:00:00Z" }), ctx({ nowMs: nov10 }))).toEqual([]);
  });

  it("REFUSES a window bound that is not a date — it would silently drop out (bypass, #242)", () => {
    const now = { nowMs: Date.parse("2026-10-10T12:00:00Z") };
    for (const window of [
      { type: "payment.execution_date" as const, not_before: "2026-10-01", not_after: "2026-13-45" },
      { type: "payment.execution_date" as const, not_before: "someday" },
    ]) {
      expect(evaluatePayment(openPayment([window]), closed(), ctx(now))).toEqual([
        expect.objectContaining({ constraint: "payment.execution_date", detail: expect.stringMatching(/not a pair of dates/) }),
      ]);
    }
  });

  it("REFUSES a payment that omits its date to escape the window — no date means now (bypass, #236)", () => {
    const window = { type: "payment.execution_date" as const, not_before: "2026-11-01", not_after: "2026-11-30" };
    const before = Date.parse("2026-10-10T12:00:00Z");
    const after = Date.parse("2026-12-05T12:00:00Z");
    expect(evaluatePayment(openPayment([window]), closed(), ctx({ nowMs: before }))).toEqual([
      expect.objectContaining({ constraint: "payment.execution_date", detail: expect.stringMatching(/before 2026-11-01/) }),
    ]);
    expect(evaluatePayment(openPayment([window]), closed(), ctx({ nowMs: after }))).toEqual([
      expect.objectContaining({ constraint: "payment.execution_date", detail: expect.stringMatching(/after 2026-11-30/) }),
    ]);
    expect(evaluatePayment(openPayment([window]), closed(), ctx({ nowMs: Date.parse("2026-11-15T12:00:00Z") }))).toEqual([]);
  });

  it("refuses once agent_recurrence's max_occurrences is used up, and demands its companions (bypass)", () => {
    const recur = { type: "payment.agent_recurrence" as const, frequency: "ON_DEMAND" as const, max_occurrences: 3 };
    expect(evaluatePayment(openPayment([recur, range, budget]), closed(), ctx({ spent: { amount: 0, uses: 2 } }))).toEqual([]);
    expect(evaluatePayment(openPayment([recur, range, budget]), closed(), ctx({ spent: { amount: 0, uses: 3 } }))).toEqual([
      expect.objectContaining({ constraint: "payment.agent_recurrence" }),
    ]);
    expect(evaluatePayment(openPayment([recur]), closed(), ctx())).toEqual([
      expect.objectContaining({ constraint: "payment.agent_recurrence", detail: expect.stringMatching(/amount_range/) }),
      expect.objectContaining({ constraint: "payment.agent_recurrence", detail: expect.stringMatching(/budget/) }),
    ]);
  });

  it("REFUSES a recurrence cadence it does not enforce — \"WEEKLY, 4 times\" is not 4 in a minute (bypass, #242)", () => {
    for (const frequency of ["WEEKLY", "MONTHLY", "DAILY"] as const) {
      // With the count to spare, and without one: the cadence alone refuses.
      for (const recur of [{ type: "payment.agent_recurrence" as const, frequency, max_occurrences: 4 }, { type: "payment.agent_recurrence" as const, frequency }]) {
        expect(evaluatePayment(openPayment([recur, range, budget]), closed(), ctx({ spent: { amount: 0, uses: 0 } }))).toEqual([
          expect.objectContaining({ constraint: "payment.agent_recurrence", detail: expect.stringMatching(new RegExp(`frequency ${frequency} is not enforced`)) }),
        ]);
      }
    }
  });

  // Spec 014: "open claims are preserved". What the person fixed, the agent cannot change.
  it("refuses a closed mandate that changes a claim the open one fixed (bypass)", () => {
    const fixed = openPayment([], { payment_amount: { amount: 600, currency: "USD" }, payee: SHOP });
    expect(evaluatePayment(fixed, closed(), ctx())).toEqual([]);
    expect(evaluatePayment(fixed, closed({ payment_amount: { amount: 599, currency: "USD" } }), ctx())).toEqual([expect.objectContaining({ code: "preset", detail: expect.stringMatching(/payment_amount/) })]);
    expect(evaluatePayment(fixed, closed({ payee: { id: "evil.example", name: "Shop" } }), ctx())).toEqual([expect.objectContaining({ code: "preset", detail: expect.stringMatching(/payee/) })]);
  });

  it("FAILS a constraint it does not know (bypass)", () => {
    expect(evaluatePayment(openPayment([{ type: "payment.velocity", max_per_hour: 1 } as never]), closed(), ctx())).toEqual([
      expect.objectContaining({ code: "unknown-constraint", constraint: "payment.velocity" }),
    ]);
  });
});
