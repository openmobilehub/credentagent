// The AP2 mandate payloads — the wire format, and nothing else.
//
// Verified 2026-09-01 against google-agentic-commerce/AP2 @ main:
//   code/sdk/schemas/ap2/{payment,open_payment,checkout,open_checkout}_mandate.json
//   code/sdk/schemas/ap2/types/amount.json · code/sdk/schemas/ucp/types/checkout.json
//
// Two rules this file exists to enforce:
//   1. `vct` is the ONLY type discriminator. AP2 versions each mandate type in that
//      claim (`mandate.payment.1`), not with a protocol-wide version number.
//   2. Money is an INTEGER in ISO-4217 minor units. There is no float in this file,
//      and `money.ts` owns the only conversion in the package.
//
// HONESTY: a correct wire format is not a trust anchor. These types say what a record
// CLAIMS; `verify.ts` says whether the claim is signed, and `trust.ts` says how strongly
// that signature binds. None of them prove the credential behind it came from a real
// issuer — that is #14 and is still open.

/** Verifiable Credential Type — the AP2 mandate discriminator (SD-JWT `vct`). */
export const VCT = {
  checkout: "mandate.checkout.1",
  payment: "mandate.payment.1",
  openCheckout: "mandate.checkout.open.1",
  openPayment: "mandate.payment.open.1",
} as const;

export type Vct = (typeof VCT)[keyof typeof VCT];

/** ISO-4217 amount. `value` is minor units (27999 === $279.99) — never a float. */
export interface Amount {
  /** Minor units per ISO-4217. AP2 calls this field `amount`; see `toWire`. */
  amount: number;
  /** ISO-4217 alpha-3, uppercase (`"USD"`). */
  currency: string;
}

/** AP2 merchant. `id` is the stable identifier the payee constraints match on. */
export interface Merchant {
  id: string;
  name?: string;
  /** Origin the merchant transacts from — how we bind a mandate to this gate's RP. */
  origin?: string;
}

export interface PaymentInstrument {
  /** Free-form per AP2; we emit a network + a display reference, never a PAN. */
  type: string;
  network?: string;
  reference?: string;
}

// ── UCP Checkout (what a Checkout Mandate wraps) ──────────────────────────────

export interface UcpLineItem {
  id: string;
  name?: string;
  quantity: number;
  /** Unit price, minor units. */
  unit_amount: Amount;
  /** quantity × unit_amount, minor units. Re-derived, never trusted off the wire. */
  total_amount: Amount;
  /** Our extension: the age this line demands, so an age gate can read the checkout. */
  minimum_age?: number;
}

export type UcpTotalType = "subtotal" | "discount" | "total";

export interface UcpTotal {
  type: UcpTotalType;
  amount: Amount;
}

export type UcpCheckoutStatus =
  | "incomplete"
  | "requires_escalation"
  | "ready_for_complete"
  | "complete_in_progress"
  | "completed"
  | "canceled";

/**
 * UCP Checkout object (`dev.ucp.shopping.checkout`). `merchant` is an AP2 extension for
 * mandate binding. `totals` MUST carry exactly one `subtotal` and one `total`.
 */
export interface UcpCheckout {
  id: string;
  merchant: Merchant;
  line_items: UcpLineItem[];
  status: UcpCheckoutStatus;
  currency: string;
  totals: UcpTotal[];
  links: { type: string; url: string }[];
}

// ── The four mandates ─────────────────────────────────────────────────────────

interface MandateBase {
  iat: number;
  exp: number;
}

/** "I authorize THIS checkout." Wraps a signed Checkout as an opaque JWT + its digest. */
export interface CheckoutMandate extends MandateBase {
  vct: typeof VCT.checkout;
  /** base64url JWT of the Checkout payload, signed by the merchant surface. */
  checkout_jwt: string;
  /** base64url hash of `checkout_jwt`; algorithm MUST match `_sd_alg`, else sha-256. */
  checkout_hash: string;
}

/** "I authorize THIS payment." Bound to its checkout by `transaction_id`. */
export interface PaymentMandate extends MandateBase {
  vct: typeof VCT.payment;
  /** base64url hash of the Checkout Mandate's `checkout_jwt` — the binding to the cart. */
  transaction_id: string;
  payee: Merchant;
  payment_amount: Amount;
  payment_instrument: PaymentInstrument;
  execution_date?: string;
  /** Risk signals collected by the trusted surface. We carry the ceremony evidence here. */
  risk_data?: Record<string, unknown>;
}

// ── Constraints (the "open" mandates' vocabulary) ─────────────────────────────

export interface AllowedMerchantsConstraint {
  type: "checkout.allowed_merchants";
  allowed: Merchant[];
}

export interface LineItemsConstraint {
  type: "checkout.line_items";
  /** Item ids the future checkout may contain. Empty ⇒ nothing may be bought. */
  allowed: string[];
}

export type CheckoutConstraint = AllowedMerchantsConstraint | LineItemsConstraint;

export interface AllowedPayeesConstraint {
  type: "payment.allowed_payees";
  allowed: Merchant[];
}

export interface AmountRangeConstraint {
  type: "payment.amount_range";
  currency: string;
  /** Per-payment ceiling, minor units. */
  max: number;
  min?: number;
}

export interface BudgetConstraint {
  type: "payment.budget";
  currency: string;
  /** Cumulative ceiling across every payment under this mandate, minor units. */
  max: number;
}

export interface PaymentReferenceConstraint {
  type: "payment.reference";
  /** Digest of the associated Open Checkout Mandate — the two halves' binding. */
  conditional_transaction_id: string;
}

export type PaymentConstraint =
  | AllowedPayeesConstraint
  | AmountRangeConstraint
  | BudgetConstraint
  | PaymentReferenceConstraint;

/** RFC 7800 §3.1 confirmation claim. REQUIRED on both open mandates. */
export interface Cnf {
  jwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
}

/** "I authorize FUTURE checkouts within these constraints." MUST contain line_items. */
export interface OpenCheckoutMandate extends MandateBase {
  vct: typeof VCT.openCheckout;
  constraints: CheckoutConstraint[];
  cnf: Cnf;
}

/** "I authorize FUTURE payments within these constraints." MUST contain payment.reference. */
export interface OpenPaymentMandate extends MandateBase {
  vct: typeof VCT.openPayment;
  constraints: PaymentConstraint[];
  cnf: Cnf;
  payee?: Merchant;
  payment_amount?: Amount;
  payment_instrument?: PaymentInstrument;
}

export type AnyMandate = CheckoutMandate | PaymentMandate | OpenCheckoutMandate | OpenPaymentMandate;

// ── Constraint lookup — typed, so a caller cannot read a constraint that isn't there ──

type AnyConstraint = CheckoutConstraint | PaymentConstraint;

export function findConstraint<K extends AnyConstraint["type"]>(
  constraints: ReadonlyArray<AnyConstraint>,
  type: K,
): Extract<AnyConstraint, { type: K }> | undefined {
  return constraints.find((c): c is Extract<AnyConstraint, { type: K }> => c.type === type);
}
