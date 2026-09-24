// Adapters: the gate's internal models → AP2 payloads. The ONLY place that knows both
// vocabularies, so `ap2/` stays a clean wire-format module and the rails stay unaware of
// SD-JWT.
//
// Nothing here decides anything. A `CeremonyOrder` arriving with a wrong total produces a
// Checkout with a wrong total — re-pricing (security invariant 2) is upstream, and putting
// a number into a mandate has never made it true.
import { amountOfMinor, sumAmounts, toMinorUnits } from "./money.js";
import type { CeremonyOrder } from "../ceremony/types.js";
import type {
  Amount,
  CheckoutConstraint,
  LineItemRequirement,
  Merchant,
  PaymentConstraint,
  UcpCheckout,
  UcpLineItem,
  UcpTotal,
} from "./types.js";

/**
 * The merchant identity a mandate binds to. Derived from the gate's own origin.
 *
 * `name` is REQUIRED by `types/merchant.json`, so a caller that has no display name gets the
 * host — the one string that is true about this merchant whatever else we know.
 */
export function merchantFor(origin: string, name?: string): Merchant {
  const { host } = new URL(origin);
  return { id: host, name: name ?? host, origin };
}

/**
 * `CeremonyOrder` → UCP Checkout.
 *
 * The discount becomes its own `totals` entry rather than being folded into the subtotal,
 * because invariant 3 requires the line sum, the discount and the payable total to stay
 * separately checkable. A reader that can only see the final number cannot tell a
 * legitimate 10% off from a tampered one.
 *
 * Amounts in `totals` are plain integers in the checkout's currency's minor units, per
 * `ucp/types/total.json`: the currency lives once on the checkout, and repeating it per
 * entry is how two of them end up disagreeing.
 */
export function checkoutFromOrder(order: CeremonyOrder, merchant: Merchant): UcpCheckout {
  const currency = order.currency.toUpperCase();
  const line_items: UcpLineItem[] = order.lines.map((l) => ({
    id: l.id,
    item: {
      id: l.id,
      title: l.name ?? l.id,
      ...(typeof l.minimumAge === "number" ? { minimum_age: l.minimumAge } : {}),
    },
    quantity: l.quantity,
    totals: [
      { type: "subtotal", amount: toMinorUnits(l.unitPrice * l.quantity, currency) },
      { type: "total", amount: toMinorUnits(l.lineTotal, currency) },
    ],
  }));

  const subtotal = sumAmounts(line_items.map((l) => lineTotalOf(l, currency)), currency);
  const discount = toMinorUnits(order.discount ?? 0, currency);
  const totals: UcpTotal[] = [
    { type: "subtotal", amount: subtotal.amount },
    ...(discount > 0 ? [{ type: "discount" as const, amount: discount }] : []),
    { type: "total", amount: toMinorUnits(order.total, currency) },
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

/** A line's own payable `total` entry. Throws rather than read a line that has none. */
function lineTotalOf(line: UcpLineItem, currency: string): Amount {
  const total = line.totals.find((t) => t.type === "total");
  if (!total) throw new Error(`line ${line.id} has no \`total\` entry — UCP requires one per line`);
  return amountOfMinor(total.amount, currency);
}

/** The `total` entry — the one number a payment must match. Throws if the cart has none. */
export function totalOf(checkout: UcpCheckout): Amount {
  const total = checkout.totals.find((t) => t.type === "total");
  if (!total) throw new Error(`checkout ${checkout.id} has no \`total\` entry — UCP requires exactly one`);
  return amountOfMinor(total.amount, checkout.currency.toUpperCase());
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
  const lineSum = sumAmounts(checkout.line_items.map((l) => lineTotalOf(l, currency)), currency);
  const discount = checkout.totals.find((t) => t.type === "discount")?.amount ?? 0;
  return amountOfMinor(lineSum.amount - discount, currency);
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

/**
 * Constraints for `mandate.checkout.open.1`. MUST include `checkout.line_items`.
 *
 * `checkout.line_items` is a list of REQUIREMENTS, not bare ids: each one names the items that
 * satisfy it and how many are needed. A grant's allow-list is the simplest case of that, so each
 * sku becomes a one-item requirement. The gate's catalog keys ARE its product ids and carry no
 * separate display name, so `title` is the id — the only string that is true here. Anything
 * richer ("one coffee, either size") is a later feature, not a translation.
 */
export function checkoutConstraintsFromGrant(g: GrantBoundsInput, origin: string): CheckoutConstraint[] {
  const items = g.skus.map((sku): LineItemRequirement => ({
    id: sku,
    acceptable_items: [{ id: sku, title: sku }],
    quantity: 1,
  }));
  if (items.length === 0) {
    throw new Error("`checkout.line_items` needs at least one requirement — an empty list authorizes nothing");
  }
  return [
    { type: "checkout.allowed_merchants", allowed: [merchantFor(origin, g.merchant), ...(g.alsoAllowed ?? [])] },
    { type: "checkout.line_items", items: items as [LineItemRequirement, ...LineItemRequirement[]] },
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
