// Cart ↔ Payment reconciliation — the cross-mandate agreement check. A signed
// ap2.CartMandate (cartMandate.ts) and the ap2.PaymentMandate (mandate.ts) each
// seal an amount; this proves the two envelopes tell ONE story before an order
// completes: same order / subject, the payment's bound amount equals the cart's
// RE-DERIVED total (the catalog stays the source of truth — invariant 2, never the
// token), and a consistent currency. Refuse on ANY mismatch.
//
// It runs at the shared completion seam (completion.ts) so EVERY payment path —
// passkey, dc-payment, instant-demo — reconciles against the SAME amount binding
// (invariant 3): a signed cart and a signed payment that disagree on amount (a
// tampered cart, a swapped order, a discount one path blesses and another refuses)
// cannot slip through, because there is exactly one reconciliation.
//
// ADDITIVE + FAIL-CLOSED: the payment binding always reaches the seam (each rail
// projects `amount`/`currency` from its `mandate.payment`); this check only adds a
// requirement when a Cart Mandate ALSO rides along, and never relaxes one.
import type { CartMandate } from "./cartMandate.js";

/** The Payment Mandate's bound fields as they reach the completion seam — each rail
 *  projects them from its verified `mandate.payment` (+ the id of the order the
 *  payment authorizes). Scalars, not the mandate object, so the seam stays
 *  decoupled from the passkey/dc-payment mandate shapes. */
export interface PaymentBinding {
  /** The Payment Mandate's bound amount (`mandate.payment.amount`). */
  amount: number;
  /** The Payment Mandate's bound currency (`mandate.payment.currency`). */
  currency: string;
  /** The order id the payment authorizes (the mandate's cart/subject). */
  orderId: string;
}

/** Why a Cart ↔ Payment reconciliation refused. */
export type ReconcileRefusal = "order-id" | "currency" | "amount";

export type ReconcileVerdict = { ok: true } | { ok: false; reason: ReconcileRefusal };

/**
 * Reconcile a (signature-verified) Cart Mandate with the Payment Mandate's binding,
 * given the catalog-RE-DERIVED total (server-side truth, never the token — invariant
 * 2). The verdict is `ok` only when all three agree:
 *   1. order id / subject — the cart and the payment authorize the SAME order
 *      (a Cart Mandate swapped onto another order's payment is refused);
 *   2. currency — the cart and the payment settle in the same currency;
 *   3. amount — `cart.total === rederivedTotal === payment.amount`, a single bound
 *      figure (a cart sealed for X against a payment for Y≠X is refused; a discount
 *      reconciles only when the re-derived total already reflects it — invariant 3).
 * Returns a typed verdict; it never throws.
 */
export function reconcileCartPayment(
  cart: CartMandate,
  payment: PaymentBinding,
  rederivedTotal: number,
): ReconcileVerdict {
  if (cart.orderId !== payment.orderId) return { ok: false, reason: "order-id" };
  if (cart.currency !== payment.currency) return { ok: false, reason: "currency" };
  if (cart.total !== rederivedTotal || cart.total !== payment.amount) return { ok: false, reason: "amount" };
  return { ok: true };
}
