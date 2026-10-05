import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { resolveSigningKey } from "./keys.js";
import { Ap2Issuer, presentWithKeyBinding } from "./issue.js";
import { openCheckoutPayload, peekVct, verifyMandate } from "./verify.js";
import { digestToken } from "./sdjwt.js";
import { amountFrom, toMinorUnits } from "./money.js";
import { VCT, type CheckoutMandate, type OpenPaymentMandate, type PaymentMandate, type UcpCheckout } from "./types.js";

const ORIGIN = "https://shop.example";

const checkout: UcpCheckout = {
  id: "ord_1",
  merchant: { id: "shop.example", name: "Shop", origin: ORIGIN },
  line_items: [
    {
      id: "li_1",
      item: { id: "wine", title: "Wine", price: toMinorUnits(19.99, "usd"), minimum_age: 21 },
      quantity: 1,
      totals: [{ type: "total", amount: toMinorUnits(19.99, "usd") }],
    },
  ],
  status: "ready_for_complete",
  currency: "USD",
  totals: [{ type: "subtotal", amount: toMinorUnits(19.99, "usd") }, { type: "total", amount: toMinorUnits(19.99, "usd") }],
  links: [],
};

async function issuer() {
  const key = await resolveSigningKey(ORIGIN);
  return { key, ap2: new Ap2Issuer(key) };
}

describe("checkout mandate", () => {
  it("round-trips, and the wrapped cart is readable only through its binding", async () => {
    const { key, ap2 } = await issuer();
    const issued = await ap2.checkout({ checkout });

    expect(peekVct(issued.token)).toBe(VCT.checkout);
    const v = await verifyMandate<CheckoutMandate>(issued.token, { publicJwk: key.publicJwk, expect: VCT.checkout });
    expect(v.ok).toBe(true);
    if (!v.ok) return;

    const opened = await openCheckoutPayload(v.mandate, key.publicJwk, (t) => digestToken(t));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.checkout.line_items[0].totals).toEqual([{ type: "total", amount: 1999 }]);
  });

  // The control: `checkout_hash` is what binds the wrapper to the cart. Swap the cart for
  // a cheaper one and the hash must stop matching. Delete the hash comparison in
  // openCheckoutPayload and this test passes — which is why it is here.
  it("refuses a swapped cart whose digest no longer matches (bypass)", async () => {
    const { key, ap2 } = await issuer();
    const issued = await ap2.checkout({ checkout });
    const cheaper = await ap2.checkout({
      checkout: { ...checkout, totals: [{ type: "total", amount: toMinorUnits(0.01, "usd") }] },
    });

    const v = await verifyMandate<CheckoutMandate>(issued.token, { publicJwk: key.publicJwk, expect: VCT.checkout });
    expect(v.ok).toBe(true);
    if (!v.ok) return;

    const tampered = { ...v.mandate, checkout_jwt: cheaper.checkoutJwt };
    const opened = await openCheckoutPayload(tampered, key.publicJwk, (t) => digestToken(t));
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.code).toBe("checkout-unbound");
  });
});

describe("payment mandate", () => {
  it("binds to its checkout by transaction_id", async () => {
    const { key, ap2 } = await issuer();
    const co = await ap2.checkout({ checkout });
    const pay = await ap2.payment({
      transactionId: co.checkoutHash,
      payee: { id: "shop.example", name: "Shop" },
      amount: amountFrom(19.99, "usd"),
      instrument: { id: "pi_1", type: "card", description: "Visa ···4242" },
      riskData: { ceremony: "webauthn.assertion", userVerified: true },
    });

    const v = await verifyMandate<PaymentMandate>(pay.token, { publicJwk: key.publicJwk, expect: VCT.payment });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.mandate.transaction_id).toBe(co.checkoutHash);
    expect(v.mandate.payment_amount).toEqual({ amount: 1999, currency: "USD" });
    // Ceremony evidence rides as risk_data — it is NOT the signature.
    expect(v.mandate.risk_data).toMatchObject({ ceremony: "webauthn.assertion" });
  });

  it("refuses a mandate signed by another key (bypass)", async () => {
    const { ap2 } = await issuer();
    const other = await resolveSigningKey(ORIGIN);
    const pay = await ap2.payment({
      transactionId: "tx",
      payee: { id: "shop.example", name: "Shop" },
      amount: amountFrom(1, "usd"),
      instrument: { id: "pi_1", type: "card" },
    });
    const v = await verifyMandate(pay.token, { publicJwk: other.publicJwk });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("signature");
  });

  it("refuses an expired mandate (bypass)", async () => {
    const { key, ap2 } = await issuer();
    const pay = await ap2.payment({
      transactionId: "tx",
      payee: { id: "shop.example", name: "Shop" },
      amount: amountFrom(1, "usd"),
      instrument: { id: "pi_1", type: "card" },
      ttlMs: 1000,
    });
    const v = await verifyMandate(pay.token, { publicJwk: key.publicJwk, nowMs: Date.now() + 60_000 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("expired");
  });

  it("refuses the wrong mandate type (bypass)", async () => {
    const { key, ap2 } = await issuer();
    const co = await ap2.checkout({ checkout });
    const v = await verifyMandate(co.token, { publicJwk: key.publicJwk, expect: VCT.payment });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("unexpected-type");
  });
});

describe("open mandates and key binding", () => {
  function holder() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    return { privateKey, cnf: { jwk: { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y } } };
  }

  it("requires the constraint AP2 says it must contain", async () => {
    const { ap2 } = await issuer();
    const h = holder();
    await expect(ap2.openCheckout({ constraints: [], cnf: h.cnf, exp: 2 ** 31 })).rejects.toThrow(/checkout\.line_items/);
    await expect(ap2.openPayment({ constraints: [], cnf: h.cnf, exp: 2 ** 31 })).rejects.toThrow(/payment\.reference/);
  });

  it("verifies a key-bound presentation against the cnf key", async () => {
    const { key, ap2 } = await issuer();
    const h = holder();
    const open = await ap2.openPayment({
      constraints: [
        { type: "payment.reference", conditional_transaction_id: "oc_digest" },
        { type: "payment.amount_range", currency: "USD", max: 10_000 },
        { type: "payment.budget", currency: "USD", max: 50_000 },
      ],
      cnf: h.cnf,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const presented = await presentWithKeyBinding({ token: open.token, holderKey: h.privateKey, aud: ORIGIN, nonce: "n-1" });
    const v = await verifyMandate<OpenPaymentMandate>(presented, {
      publicJwk: key.publicJwk,
      expect: VCT.openPayment,
      audience: ORIGIN,
      nonce: "n-1",
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.keyBound).toEqual({ aud: ORIGIN, nonce: "n-1" });
  });

  // The control: the KB-JWT must verify against the key the mandate's OWN cnf names.
  // Sign the hop with a different key and it must fail — not fall back to "unbound".
  it("refuses a hop signed by a key the cnf does not name (bypass)", async () => {
    const { key, ap2 } = await issuer();
    const owner = holder();
    const attacker = holder();
    const open = await ap2.openPayment({
      constraints: [{ type: "payment.reference", conditional_transaction_id: "oc" }],
      cnf: owner.cnf,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const forged = await presentWithKeyBinding({ token: open.token, holderKey: attacker.privateKey, aud: ORIGIN, nonce: "n-1" });
    const v = await verifyMandate(forged, { publicJwk: key.publicJwk, audience: ORIGIN, nonce: "n-1" });
    expect(v.ok).toBe(false);
  });

  // A DIFFERENT nonce, not a replayed one: `verifyMandate` checks that the nonce matches the one
  // the caller issued, and keeps no record of nonces it has seen. Single-use is the caller's job
  // (invariant 6) — the test below pins that, so nobody reads this one as replay protection.
  it("refuses a different nonce and a wrong audience (bypass)", async () => {
    const { key, ap2 } = await issuer();
    const h = holder();
    const open = await ap2.openPayment({
      constraints: [{ type: "payment.reference", conditional_transaction_id: "oc" }],
      cnf: h.cnf,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const presented = await presentWithKeyBinding({ token: open.token, holderKey: h.privateKey, aud: ORIGIN, nonce: "n-1" });

    const wrongNonce = await verifyMandate(presented, { publicJwk: key.publicJwk, audience: ORIGIN, nonce: "n-2" });
    expect(wrongNonce.ok).toBe(false);
    if (!wrongNonce.ok) expect(wrongNonce.code).toBe("nonce");

    const wrongAud = await verifyMandate(presented, { publicJwk: key.publicJwk, audience: "https://evil.example", nonce: "n-1" });
    expect(wrongAud.ok).toBe(false);
    if (!wrongAud.ok) expect(wrongAud.code).toBe("audience");
  });

  // A key-bound token handed to a verifier that forgot to ask for binding must NOT quietly
  // pass as an ordinary mandate — that is how a stolen presentation gets reused.
  //
  // The assertion on `detail` pins WHICH control refused: the structural guard, before the
  // library is called. Another check further down returns the same code, so asserting only the
  // code would stay green with this guard deleted.
  it("refuses a key-bound token when no audience/nonce was supplied (bypass)", async () => {
    const { key, ap2 } = await issuer();
    const h = holder();
    const open = await ap2.openPayment({
      constraints: [{ type: "payment.reference", conditional_transaction_id: "oc" }],
      cnf: h.cnf,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const presented = await presentWithKeyBinding({ token: open.token, holderKey: h.privateKey, aud: ORIGIN, nonce: "n-1" });
    const v = await verifyMandate(presented, { publicJwk: key.publicJwk });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe("key-binding");
    expect(v.detail).toBe("token is key-bound but no audience/nonce was supplied to check it against");
  });

  // Documents the boundary rather than a control: the verifier is stateless, so the same
  // presentation with the same nonce verifies twice. If this ever starts failing, the verifier
  // grew a nonce store and the VerifyOptions.nonce docs must change with it.
  it("does not remember nonces — consuming one is the caller's job", async () => {
    const { key, ap2 } = await issuer();
    const h = holder();
    const open = await ap2.openPayment({
      constraints: [{ type: "payment.reference", conditional_transaction_id: "oc" }],
      cnf: h.cnf,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const presented = await presentWithKeyBinding({ token: open.token, holderKey: h.privateKey, aud: ORIGIN, nonce: "n-1" });
    const opts = { publicJwk: key.publicJwk, audience: ORIGIN, nonce: "n-1" };
    expect((await verifyMandate(presented, opts)).ok).toBe(true);
    expect((await verifyMandate(presented, opts)).ok).toBe(true);
  });
});
