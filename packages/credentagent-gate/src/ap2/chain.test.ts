import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { resolveSigningKey } from "./keys.js";
import { Ap2Issuer, presentWithKeyBinding } from "./issue.js";
import { verifyChain, type MandateChain } from "./chain.js";
import { checkoutFromOrder, merchantFor, paymentConstraintsFromGrant, checkoutConstraintsFromGrant } from "./from-gate.js";
import { amountFrom } from "./money.js";
import { digestToken } from "./sdjwt.js";
import type { CeremonyOrder } from "../ceremony/types.js";

const ORIGIN = "https://shop.example";
const MERCHANT = merchantFor(ORIGIN, "Shop");

const order = (over: Partial<CeremonyOrder> = {}): CeremonyOrder => ({
  id: "ord_1",
  lines: [{ id: "wine", unitPrice: 19.99, quantity: 2, lineTotal: 39.98, minimumAge: 21 }],
  subtotal: 39.98,
  discount: 0,
  total: 39.98,
  currency: "usd",
  ...over,
});

// ONE key for the whole file, on purpose. A splice between two chains signed by DIFFERENT
// keys is refused at the signature, which would make every binding test below pass without
// its binding check ever running. Sharing the key makes each splice a genuinely
// well-signed forgery — the threat the bindings actually exist to stop.
const KEY = await resolveSigningKey(ORIGIN);
const ISSUER = new Ap2Issuer(KEY);

async function chainFor(o: CeremonyOrder, opts: { payAmount?: number } = {}) {
  const key = KEY;
  const ap2 = ISSUER;
  const checkout = checkoutFromOrder(o, MERCHANT);
  const co = await ap2.checkout({ checkout });
  const pay = await ap2.payment({
    transactionId: co.checkoutHash,
    payee: MERCHANT,
    amount: amountFrom(opts.payAmount ?? o.total, o.currency),
    instrument: { type: "card", network: "visa" },
  });
  return { key, ap2, co, chain: { checkout: co.token, payment: pay.token } as MandateChain };
}

describe("a well-formed chain", () => {
  it("verifies, and reports the amount it re-derived rather than the one it was told", async () => {
    const { key, chain } = await chainFor(order());
    const r = await verifyChain(chain, { publicJwk: key.publicJwk, expectedTotal: amountFrom(39.98, "usd") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.amount).toEqual({ amount: 3998, currency: "USD" });
    expect(r.checkout.line_items[0].quantity).toBe(2);
  });

  it("verifies a legitimately discounted cart on the same path", async () => {
    const { key, chain } = await chainFor(order({ discount: 4, total: 35.98 }));
    const r = await verifyChain(chain, { publicJwk: key.publicJwk, expectedTotal: amountFrom(35.98, "usd") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.amount).toEqual({ amount: 3598, currency: "USD" });
  });
});

describe("invariant 3 — line sum, cart total and signed amount must agree", () => {
  // The control: `amountsEqual(payment_amount, rederived)`. Delete it and a correctly
  // signed mandate can authorize one cent for a $39.98 cart.
  it("refuses a payment signed for less than the cart (bypass)", async () => {
    const { key, chain } = await chainFor(order(), { payAmount: 0.01 });
    const r = await verifyChain(chain, { publicJwk: key.publicJwk });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("amount-mismatch");
  });

  // The control: `rederiveTotal` vs `totalOf`. A cart claiming a total its own lines do not
  // add up to is how an arbitrary "discount" gets smuggled in.
  it("refuses a cart whose stated total is not its line sum minus its discount (bypass)", async () => {
    const { key, chain } = await chainFor(order({ discount: 0, total: 0.01 }), { payAmount: 0.01 });
    const r = await verifyChain(chain, { publicJwk: key.publicJwk });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("total-tampered");
  });

  // The control: the `expectedTotal` comparison — the catalog, not the mandate, prices.
  it("refuses an internally-consistent chain that disagrees with the catalog (bypass)", async () => {
    const { key, chain } = await chainFor(order({ lines: [{ id: "wine", unitPrice: 1, quantity: 1, lineTotal: 1 }], subtotal: 1, total: 1 }));
    const r = await verifyChain(chain, { publicJwk: key.publicJwk, expectedTotal: amountFrom(39.98, "usd") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("amount-mismatch");
  });
});

describe("cross-order replay", () => {
  // The control: `transaction_id === digest(checkout_jwt)`. Delete it and a payment
  // authorized for a cheap order settles an expensive one.
  it("refuses a payment mandate lifted from another order (bypass)", async () => {
    const cheap = await chainFor(order({ lines: [{ id: "cork", unitPrice: 1, quantity: 1, lineTotal: 1 }], subtotal: 1, total: 1, id: "ord_cheap" }));
    const expensive = await chainFor(order());
    const spliced: MandateChain = { checkout: expensive.chain.checkout, payment: cheap.chain.payment };
    const r = await verifyChain(spliced, { publicJwk: expensive.key.publicJwk });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("transaction-mismatch");
  });
});

describe("delegated spend — the grant's own authority", () => {
  async function holder() {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
    return { privateKey: pair.privateKey, cnf: { jwk: { kty: "EC" as const, crv: "P-256" as const, x: jwk.x!, y: jwk.y! } } };
  }

  async function delegatedChain(perSpend: number, spendTotal: number) {
    const o = order({ lines: [{ id: "wine", unitPrice: spendTotal, quantity: 1, lineTotal: spendTotal }], subtotal: spendTotal, total: spendTotal });
    const { key, ap2, chain } = await chainFor(o);
    const h = await holder();
    const bounds = { merchant: "Shop", budget: 500, perSpend, currency: "usd", skus: ["wine"] };
    const exp = Math.floor(Date.now() / 1000) + 3600;

    const openCo = await ap2.openCheckout({ constraints: checkoutConstraintsFromGrant(bounds, ORIGIN), cnf: h.cnf, exp });
    const openCoPresented = await presentWithKeyBinding({ token: openCo.token, holderKey: h.privateKey, aud: ORIGIN, nonce: "n-1" });
    const openPay = await ap2.openPayment({
      constraints: paymentConstraintsFromGrant(bounds, ORIGIN, digestToken(openCoPresented)),
      cnf: h.cnf,
      exp,
    });
    const openPayPresented = await presentWithKeyBinding({ token: openPay.token, holderKey: h.privateKey, aud: ORIGIN, nonce: "n-1" });

    return { key, chain: { ...chain, openCheckout: openCoPresented, openPayment: openPayPresented } as MandateChain, o };
  }

  it("verifies a spend inside the grant's per-purchase ceiling", async () => {
    const { key, chain } = await delegatedChain(100, 40);
    const r = await verifyChain(chain, { publicJwk: key.publicJwk, audience: ORIGIN, nonce: "n-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.delegated?.openPayment.vct).toBe("mandate.payment.open.1");
  });

  // The control: `rederived.amount > range.max`. Delete it and a $40 grant buys a $400 item.
  it("refuses a spend over the grant's per-purchase ceiling (bypass)", async () => {
    const { key, chain } = await delegatedChain(40, 400);
    const r = await verifyChain(chain, { publicJwk: key.publicJwk, audience: ORIGIN, nonce: "n-1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("over-per-spend");
  });

  // The control: `payment.reference` must name THIS open checkout. Delete it and a payment
  // authority from one grant spends against another grant's item scope.
  it("refuses an open payment mandate bound to a different open checkout (bypass)", async () => {
    const a = await delegatedChain(100, 40);
    const b = await delegatedChain(100, 40);
    const spliced: MandateChain = { ...a.chain, openCheckout: b.chain.openCheckout };
    const r = await verifyChain(spliced, { publicJwk: a.key.publicJwk, audience: ORIGIN, nonce: "n-1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("grant-unbound");
  });

  // The control: key binding on the open mandates. A delegated chain presented without the
  // holder's proof must not settle.
  it("refuses a delegated chain whose key binding is not checked (bypass)", async () => {
    const { key, chain } = await delegatedChain(100, 40);
    const r = await verifyChain(chain, { publicJwk: key.publicJwk });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("key-binding");
  });
});
