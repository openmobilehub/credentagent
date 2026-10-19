// Adapters: the gate's internal models → AP2 payloads. The ONLY place that knows both
// vocabularies, so `ap2/` stays a clean wire-format module and the rails stay unaware of
// SD-JWT.
//
// The adapters decide nothing. A `CeremonyOrder` arriving with a wrong total produces a
// Checkout with a wrong total — re-pricing (security invariant 2) is upstream, and putting
// a number into a mandate has never made it true. The one exception is `checkLineItems`:
// the shape every cart line must have, which the quoting and the verifying store both refuse by.
import { amountOfMinor, sumAmounts, toMinorUnits } from "./money.js";
import type { CeremonyOrder } from "../ceremony/types.js";
import { basePathOf } from "../ceremony/origin.js";
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
 * The merchant identity a mandate binds to. Derived from the gate's own public URL.
 *
 * The id is the host PLUS the base path (#331): two stores mounted on one host at `/coffee`
 * and `/wine` are different merchants, and a permission signed for one must not be spendable
 * at the other. A store at the root keeps the bare host, so mandates already signed for it
 * still match.
 *
 * `name` is REQUIRED by `types/merchant.json`, so a caller that has no display name gets the
 * id — the one string that is true about this merchant whatever else we know.
 */
export function merchantFor(origin: string, name?: string): Merchant {
  const { host } = new URL(origin);
  const id = `${host}${basePathOf(origin)}`;
  return { id, name: name ?? id, origin };
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
  const line_items: UcpLineItem[] = order.lines.map((l) => {
    // A checkout LINE quotes a real price (`ap2/types/item.json` requires one). A CONSTRAINT's
    // item deliberately does not — see `checkoutConstraintsFromGrant`, and `ConstraintItem`.
    const price = toMinorUnits(l.unitPrice, currency);
    // A line's total is price × quantity, which is what `checkLineItems` requires (#286). A
    // discount is never folded into a line: it is the checkout's own `discount` entry, below.
    const lineTotal = price * l.quantity;
    return {
      id: l.id,
      item: { id: l.id, title: l.name ?? l.id, price, ...(typeof l.minimumAge === "number" ? { minimum_age: l.minimumAge } : {}) },
      quantity: l.quantity,
      totals: [
        { type: "subtotal", amount: lineTotal },
        { type: "total", amount: lineTotal },
      ],
    };
  });

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
  const total = line.totals.find((t) => t?.type === "total");
  if (!total) throw new Error(`line ${line.id} has no \`total\` entry — UCP requires one per line`);
  return amountOfMinor(total.amount, currency);
}

/**
 * Why {@link checkLineItems} refused a cart. Whose mistake it is decides the answer:
 * - `"quantity"` — a line's quantity is not a whole number of at least 1. The quantity is what the
 *   agent asked for, so this is a bad request (a 400).
 * - `"price"` — an item's price is not a whole number of minor units above 0, and
 * - `"line-total"` — a line's `total` is not its price × quantity. Both come from your own catalog
 *   and quote code, so they are your bug (a 500), not the agent's.
 * - `"malformed"` — no `line_items` list, or a line with no item id: the cart is not a UCP cart.
 */
export type LineItemsRefusal = "quantity" | "price" | "line-total" | "malformed";

/** {@link checkLineItems}'s answer. `detail` is for logs, never for a decision — branch on `code`. */
export type LineItemsCheck = { ok: true } | { ok: false; code: LineItemsRefusal; detail: string };

/**
 * What every cart line needs before anything adds it up: an item id, a whole quantity of at
 * least 1, a unit price that is a whole number of minor units above 0, and a `total` entry equal
 * to price × quantity — the number the cart total is actually summed from.
 *
 * One rule for the store that quotes a cart (`Ap2Issuer.signCheckout`) and the store that verifies
 * one (`verifyDelegatedPurchase`). A line of quantity −1 is skipped by the `checkout.line_items`
 * limit yet still subtracted from the total — "1 coffee and −1 tea" would fit every limit and
 * match an honest catalog's price (#286). So such a line is refused, never read.
 *
 * Exported so a store can check a cart built from an agent's request and answer it by `code`,
 * rather than catch `signCheckout`'s throw.
 */
export function checkLineItems(lines: readonly UcpLineItem[]): LineItemsCheck {
  const no = (code: LineItemsRefusal, detail: string): LineItemsCheck => ({ ok: false, code, detail });
  // The verifier passes a cart decoded off the wire, so nothing here trusts the type.
  if (!Array.isArray(lines)) return no("malformed", "the checkout has no line_items list");
  for (const line of lines) {
    if (!line?.item || typeof line.item.id !== "string") return no("malformed", "a checkout line has no item id");
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1)
      return no("quantity", `line ${line.id} has quantity ${line.quantity} — each line's quantity must be a whole number of at least 1`);
    if (!Number.isSafeInteger(line.item.price) || line.item.price < 1)
      return no("price", `line ${line.id} has price ${line.item.price} — each item's price must be a whole number of minor units above 0`);
    const expected = line.item.price * line.quantity;
    const total = Array.isArray(line.totals) ? line.totals.find((t: UcpTotal | undefined) => t?.type === "total")?.amount : undefined;
    if (total !== expected) return no("line-total", `line ${line.id} has total ${total} — each line's total must be its price × quantity, ${expected}`);
  }
  return { ok: true };
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
