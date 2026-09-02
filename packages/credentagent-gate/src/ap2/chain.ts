// The mandate chain — assembling one, and checking one end to end.
//
// This replaces the pairwise reconciliation the gate used to do (cart↔payment in
// `reconciliation.ts`, bounds↔draw in `mandate.ts`, each with its own notion of agreement).
// One function now answers the whole question, so there is one place to read and one place
// for a future change to go wrong.
//
// The check this file exists for — security invariant 3 — is that the LINE SUM, the cart's
// stated TOTAL, and the SIGNED payment amount all agree. Three numbers, one comparison, in
// integers.
import { digestToken } from "./sdjwt.js";
import { openCheckoutPayload, verifyMandate, type MandateRefusal } from "./verify.js";
import { rederiveTotal, totalOf } from "./from-gate.js";
import { amountsEqual, formatAmount } from "./money.js";
import type { PublicJwkP256 } from "./keys.js";
import {
  VCT,
  findConstraint,
  type Amount,
  type CheckoutMandate,
  type OpenPaymentMandate,
  type PaymentMandate,
  type UcpCheckout,
} from "./types.js";

/** A settled purchase's evidence: the mandates, as they travel. */
export interface MandateChain {
  /** `mandate.checkout.1` — the cart that was authorized. */
  checkout: string;
  /** `mandate.payment.1` — the payment authorized against it. */
  payment: string;
  /** `mandate.checkout.open.1` — present on a delegated (grant) spend. */
  openCheckout?: string;
  /** `mandate.payment.open.1` — present on a delegated (grant) spend. */
  openPayment?: string;
}

export type ChainRefusalCode =
  | MandateRefusal["code"]
  | "transaction-mismatch" // the payment names a different checkout
  | "amount-mismatch" // the signed amount ≠ the cart's re-derived total
  | "total-tampered" // the cart's stated total ≠ its own line sum minus discount
  | "payee-mismatch" // the payment pays someone other than the cart's merchant
  | "over-per-spend" // a delegated spend exceeds the open mandate's amount_range
  | "grant-unbound"; // the open payment mandate does not reference the open checkout

export interface ChainRefusal {
  ok: false;
  code: ChainRefusalCode;
  detail?: string;
}

export interface ChainVerdict {
  ok: true;
  checkout: UcpCheckout;
  /** The amount the chain actually authorizes, re-derived — not the number it claims. */
  amount: Amount;
  payment: PaymentMandate;
  /** Present only on a delegated spend. */
  delegated?: { openPayment: OpenPaymentMandate };
}

export type ChainResult = ChainVerdict | ChainRefusal;

const refuse = (code: ChainRefusalCode, detail?: string): ChainRefusal => ({ ok: false, code, ...(detail ? { detail } : {}) });

export interface VerifyChainOptions {
  publicJwk: PublicJwkP256;
  /**
   * The catalog-re-derived total. When supplied, the chain must match it — this is the
   * check that keeps the mandate from becoming the price authority. Callers on a completion
   * path MUST pass it; omitting it verifies the chain's internal agreement only.
   */
  expectedTotal?: Amount;
  /** Required when the chain carries key-bound open mandates. */
  audience?: string;
  nonce?: string;
  nowMs?: number;
}

/**
 * Verify a whole mandate chain.
 *
 * Order matters and is deliberate: signatures first (nothing downstream may read an
 * unverified field), then the cart's internal consistency, then the payment's binding to
 * that cart, then — for a delegated spend — the grant's bounds. Each step fails closed.
 */
export async function verifyChain(chain: MandateChain, opts: VerifyChainOptions): Promise<ChainResult> {
  const base = { publicJwk: opts.publicJwk, nowMs: opts.nowMs };

  const co = await verifyMandate<CheckoutMandate>(chain.checkout, { ...base, expect: VCT.checkout });
  if (!co.ok) return co;

  const opened = await openCheckoutPayload(co.mandate, opts.publicJwk, (t) => digestToken(t));
  if (!opened.ok) return opened;
  const checkout = opened.checkout;

  // The cart must add up to what it says it adds up to, before anything trusts its total.
  const stated = totalOf(checkout);
  const rederived = rederiveTotal(checkout);
  if (!amountsEqual(stated, rederived)) {
    return refuse("total-tampered", `stated=${formatAmount(stated)} lines−discount=${formatAmount(rederived)}`);
  }

  const pay = await verifyMandate<PaymentMandate>(chain.payment, { ...base, expect: VCT.payment });
  if (!pay.ok) return pay;

  // The payment's binding to THIS cart. `transaction_id` is the digest of the checkout JWT,
  // so a payment lifted from another order cannot be replayed onto this one.
  const expectedTx = digestToken(co.mandate.checkout_jwt);
  if (pay.mandate.transaction_id !== expectedTx) {
    return refuse("transaction-mismatch", "the payment mandate names a different checkout");
  }

  if (pay.mandate.payee.id !== checkout.merchant.id) {
    return refuse("payee-mismatch", `payee=${pay.mandate.payee.id} merchant=${checkout.merchant.id}`);
  }

  // Invariant 3, in one line: the signed amount and the cart's own arithmetic must agree.
  if (!amountsEqual(pay.mandate.payment_amount, rederived)) {
    return refuse("amount-mismatch", `signed=${formatAmount(pay.mandate.payment_amount)} cart=${formatAmount(rederived)}`);
  }

  // …and both must agree with what the CATALOG says, when the caller knows it. A chain that
  // is internally consistent about the wrong price is still the wrong price.
  if (opts.expectedTotal && !amountsEqual(rederived, opts.expectedTotal)) {
    return refuse("amount-mismatch", `chain=${formatAmount(rederived)} catalog=${formatAmount(opts.expectedTotal)}`);
  }

  if (!chain.openPayment) return { ok: true, checkout, amount: rederived, payment: pay.mandate };

  // ── Delegated spend: the grant's own authority ──────────────────────────────
  const openPay = await verifyMandate<OpenPaymentMandate>(chain.openPayment, {
    ...base,
    expect: VCT.openPayment,
    audience: opts.audience,
    nonce: opts.nonce,
  });
  if (!openPay.ok) return openPay;

  if (chain.openCheckout) {
    const openCo = await verifyMandate(chain.openCheckout, {
      ...base,
      expect: VCT.openCheckout,
      audience: opts.audience,
      nonce: opts.nonce,
    });
    if (!openCo.ok) return openCo;

    const ref = findConstraint(openPay.mandate.constraints, "payment.reference");
    if (!ref || ref.conditional_transaction_id !== digestToken(chain.openCheckout)) {
      return refuse("grant-unbound", "the open payment mandate does not reference this open checkout");
    }
  }

  const range = findConstraint(openPay.mandate.constraints, "payment.amount_range");
  if (range) {
    if (range.currency !== rederived.currency) {
      return refuse("over-per-spend", `grant is in ${range.currency}, spend is in ${rederived.currency}`);
    }
    if (rederived.amount > range.max) {
      return refuse("over-per-spend", `spend=${rederived.amount} max=${range.max} (minor units)`);
    }
  }

  return { ok: true, checkout, amount: rederived, payment: pay.mandate, delegated: { openPayment: openPay.mandate } };
}
