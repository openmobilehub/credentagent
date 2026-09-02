// Adapters: the gate's internal models → AP2 payloads. The ONLY place that knows both
// vocabularies, so `ap2/` stays a clean wire-format module and the rails stay unaware of
// SD-JWT.
//
// Nothing here decides anything. A `CeremonyOrder` arriving with a wrong total produces a
// Checkout with a wrong total — re-pricing (security invariant 2) is upstream, and putting
// a number into a mandate has never made it true.
import { amountFrom, amountOfMinor, sumAmounts, toMinorUnits } from "./money.js";
import type { CeremonyOrder } from "../ceremony/types.js";
import type {
  Amount,
  CheckoutConstraint,
  Merchant,
  PaymentConstraint,
  UcpCheckout,
  UcpLineItem,
  UcpTotal,
} from "./types.js";

/** The merchant identity a mandate binds to. Derived from the gate's own origin. */
export function merchantFor(origin: string, name?: string): Merchant {
  const { host } = new URL(origin);
  return { id: host, ...(name ? { name } : {}), origin };
}

/**
 * `CeremonyOrder` → UCP Checkout.
 *
 * The discount becomes its own `totals` entry rather than being folded into the subtotal,
 * because invariant 3 requires the line sum, the discount and the payable total to stay
 * separately checkable. A reader that can only see the final number cannot tell a
 * legitimate 10% off from a tampered one.
 */
export function checkoutFromOrder(order: CeremonyOrder, merchant: Merchant): UcpCheckout {
  const currency = order.currency.toUpperCase();
  const line_items: UcpLineItem[] = order.lines.map((l) => ({
    id: l.id,
    ...(l.name ? { name: l.name } : {}),
    quantity: l.quantity,
    unit_amount: amountFrom(l.unitPrice, currency),
    total_amount: amountFrom(l.lineTotal, currency),
    ...(typeof l.minimumAge === "number" ? { minimum_age: l.minimumAge } : {}),
  }));

  const subtotal = sumAmounts(line_items.map((l) => l.total_amount), currency);
  const discount = toMinorUnits(order.discount ?? 0, currency);
  const totals: UcpTotal[] = [
    { type: "subtotal", amount: subtotal },
    ...(discount > 0 ? [{ type: "discount" as const, amount: amountOfMinor(discount, currency) }] : []),
    { type: "total", amount: amountFrom(order.total, currency) },
  ];

  return {
    id: order.id,
    merchant,
    line_items,
    status: "ready_for_complete",
    currency,
    totals,
    links: [],
  };
}

/** The `total` entry — the one number a payment must match. Throws if the cart has none. */
export function totalOf(checkout: UcpCheckout): Amount {
  const total = checkout.totals.find((t) => t.type === "total");
  if (!total) throw new Error(`checkout ${checkout.id} has no \`total\` entry — UCP requires exactly one`);
  return total.amount;
}

/**
 * Re-derive the payable total from the line items and the discount entry.
 *
 * This is the AP2-side expression of invariant 3, and it is deliberately a separate
 * function from {@link totalOf}: one reads what the cart CLAIMS, the other computes what
 * the cart's own parts ADD UP TO. Code that compares them catches a tampered total; code
 * that only ever reads the claim does not.
 */
export function rederiveTotal(checkout: UcpCheckout): Amount {
  const currency = checkout.currency.toUpperCase();
  const lineSum = sumAmounts(checkout.line_items.map((l) => l.total_amount), currency);
  const discount = checkout.totals.find((t) => t.type === "discount")?.amount.amount ?? 0;
  return { amount: lineSum.amount - discount, currency };
}

// ── Grants → the "open" mandates' constraint vocabulary ───────────────────────

export interface GrantBoundsInput {
  /** Merchant id the grant is scoped to. */
  merchant: string;
  /** Cumulative budget, major units (the gate's historical representation). */
  budget: number;
  /** Per-purchase ceiling, major units. */
  perSpend: number;
  currency: string;
  /** Item ids the grant may buy. Required: an open checkout with no line_items buys nothing. */
  skus: string[];
  /** Additional merchants, when a grant names more than one (#156's enforcement already allows it). */
  alsoAllowed?: Merchant[];
}

/** Constraints for `mandate.checkout.open.1`. MUST include `checkout.line_items`. */
export function checkoutConstraintsFromGrant(g: GrantBoundsInput, origin: string): CheckoutConstraint[] {
  return [
    { type: "checkout.allowed_merchants", allowed: [merchantFor(origin, g.merchant), ...(g.alsoAllowed ?? [])] },
    { type: "checkout.line_items", allowed: [...g.skus] },
  ];
}

/**
 * Constraints for `mandate.payment.open.1`. MUST include `payment.reference`, which is what
 * ties the two halves of a grant together: the payment authority is only valid for the
 * checkout authority whose digest it names.
 */
export function paymentConstraintsFromGrant(
  g: GrantBoundsInput,
  origin: string,
  openCheckoutDigest: string,
): PaymentConstraint[] {
  const currency = g.currency.toUpperCase();
  return [
    { type: "payment.reference", conditional_transaction_id: openCheckoutDigest },
    { type: "payment.allowed_payees", allowed: [merchantFor(origin, g.merchant), ...(g.alsoAllowed ?? [])] },
    { type: "payment.amount_range", currency, max: toMinorUnits(g.perSpend, currency) },
    { type: "payment.budget", currency, max: toMinorUnits(g.budget, currency) },
  ];
}
