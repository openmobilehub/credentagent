// The AP2 mandate payloads — the wire format, and nothing else.
//
// Checked field-by-field on 2026-09-23 against google-agentic-commerce/AP2 @ main:
//   code/sdk/schemas/ap2/{payment,open_payment,checkout,open_checkout}_mandate.json
//   code/sdk/schemas/ap2/types/{amount,merchant,payment_instrument,pisp}.json
//   code/sdk/schemas/ucp/types/{checkout,line_item,total,link,buyer}.json
// Required/optional here follows each schema's `required` list, so anything these types
// describe validates against the schema that owns it.
//
// Where we ADD to a schema — never where we contradict one. Each of these sits in an object
// the schema does not close with `additionalProperties: false`, so it stays valid:
//   · `Merchant.origin`      — the origin a mandate is bound to (this gate's RP).
//   · `UcpItem.minimum_age`  — the age a product demands, so an age gate can read a checkout.
//   · `Cnf.jwk` narrowed to an EC P-256 key. The schema says only "object"; we issue P-256.
// Upstream's `ucp/types/line_item.json` refs an `item.json` that is not in the repository,
// so `UcpItem` is modelled from the fields UCP's line item actually uses.
//
// Two rules this file exists to enforce:
//   1. `vct` is the ONLY type discriminator. AP2 versions each mandate type in that claim
//      (`mandate.payment.1`), not with a protocol-wide version number.
//   2. Money is an INTEGER in ISO-4217 minor units. There is no float in this file, and
//      `money.ts` owns the only conversion in the package.
//
// HONESTY: a correct wire format is not a trust anchor. These types say only what a record
// CLAIMS. Whether the claim is SIGNED is the verifier's answer (the next increment of spec
// 013); how strongly the signature binds is what `trust_level` reports. Neither proves the
// credential behind the record came from a real issuer — that is #14 and is still open.
//
// SCOPE: this file and `money.ts` are the first increment of spec 013 — the payloads and the
// arithmetic, with no crypto and no wiring. `money.ts` is live: `grants.ts` converts through
// it, so the package has exactly one money converter. THESE TYPES are not yet used by
// anything, and neither file is exported from `index.ts` until the issuer/verifier lands, so
// the public API never offers a mandate type a caller has no way to produce or check.

/** Verifiable Credential Type — the AP2 mandate discriminator (SD-JWT `vct`). */
export const VCT = {
  checkout: "mandate.checkout.1",
  payment: "mandate.payment.1",
  openCheckout: "mandate.checkout.open.1",
  openPayment: "mandate.payment.open.1",
} as const;

export type Vct = (typeof VCT)[keyof typeof VCT];

/** ISO-4217 amount (`types/amount.json`). 27999 USD is $279.99 — minor units, never a float. */
export interface Amount {
  /** Minor units per ISO-4217. Build one with `amountFrom` / `amountOfMinor` in `money.ts`. */
  amount: number;
  /** ISO-4217 alpha-3, uppercase (`"USD"`). */
  currency: string;
}

/** AP2 merchant (`types/merchant.json`). `id` is what the payee constraints match on. */
export interface Merchant {
  id: string;
  name: string;
  website?: string;
  /** OUR EXTENSION: origin the merchant transacts from — how a mandate binds to this gate's RP. */
  origin?: string;
}

/** AP2 payment instrument (`types/payment_instrument.json`). Never carries a PAN. */
export interface PaymentInstrument {
  id: string;
  /** Category of instrument, e.g. `"card"`. Free-form per the schema. */
  type: string;
  /** Shown to the human for recognition, e.g. `"Visa ···4242"`. */
  description?: string;
}

/** Payment Initiation Service Provider (`types/pisp.json`). All three fields are required. */
export interface Pisp {
  legal_name: string;
  brand_name: string;
  domain_name: string;
}

// ── UCP Checkout (what a Checkout Mandate wraps) ──────────────────────────────

/** A product on a checkout line. */
export interface UcpItem {
  id: string;
  title: string;
  /** OUR EXTENSION: the age this product demands, so an age gate can read a checkout. */
  minimum_age?: number;
}

/**
 * A cost breakdown entry (`ucp/types/total.json`). `amount` is a SIGNED integer in the
 * checkout's currency's minor units — a plain number, not an `Amount`: the currency lives
 * once on the checkout, and repeating it per line is how two of them end up disagreeing.
 */
export type UcpTotalType = "subtotal" | "discount" | "items_discount" | "fulfillment" | "tax" | "fee" | "total";

export interface UcpTotal {
  type: UcpTotalType;
  amount: number;
  display_text?: string;
}

/** A checkout line (`ucp/types/line_item.json`). Product details nest under `item`. */
export interface UcpLineItem {
  id: string;
  item: UcpItem;
  quantity: number;
  /** Per-line breakdown, same shape as the checkout's. Re-derived, never trusted off the wire. */
  totals: UcpTotal[];
  parent_id?: string;
}

/** A typed URL reference (`ucp/types/link.json`) — terms, privacy, support. */
export interface UcpLink {
  type: string;
  url: string;
  title?: string;
}

/** The buyer (`ucp/types/buyer.json`). Every field optional; we emit as little as we can. */
export interface UcpBuyer {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
}

export type UcpCheckoutStatus =
  | "incomplete"
  | "requires_escalation"
  | "ready_for_complete"
  | "complete_in_progress"
  | "completed"
  | "canceled";

/**
 * UCP Checkout object (`dev.ucp.shopping.checkout`), the thing a Checkout Mandate wraps.
 *
 * `totals` MUST carry exactly one `subtotal` and one `total`. `merchant` is an AP2 extension
 * and optional in the schema; this gate always emits it, because the mandate binds to it.
 */
export interface UcpCheckout {
  id: string;
  line_items: UcpLineItem[];
  status: UcpCheckoutStatus;
  currency: string;
  totals: UcpTotal[];
  links: UcpLink[];
  merchant?: Merchant;
  buyer?: UcpBuyer;
  expires_at?: string;
  continue_url?: string;
}

// ── The four mandates ─────────────────────────────────────────────────────────

/** `iat`/`exp` are OPTIONAL in every mandate schema. Our verifier requires `exp` regardless —
 *  a mandate that never expires is a standing authorization nobody agreed to. */
interface MandateBase {
  iat?: number;
  exp?: number;
}

/** "I authorize THIS checkout." Wraps a signed Checkout as an opaque JWT + its digest. */
export interface CheckoutMandate extends MandateBase {
  vct: typeof VCT.checkout;
  /** JWT of the Checkout payload, signed by the merchant surface. */
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
  pisp?: Pisp;
  /** ISO-8601. Absent means execute immediately. */
  execution_date?: string;
  /** Risk signals collected by the trusted surface. We carry the ceremony evidence here. */
  risk_data?: Record<string, unknown>;
}

// ── Constraints (the "open" mandates' vocabulary) ─────────────────────────────

export interface AllowedMerchantsConstraint {
  type: "checkout.allowed_merchants";
  allowed: Merchant[];
}

/** One item a future checkout must contain: exactly one of `acceptable_items`, `quantity` of it. */
export interface LineItemRequirement {
  id: string;
  acceptable_items: UcpItem[];
  /** Required quantity of a matching item. Must be > 0. */
  quantity: number;
}

/**
 * The product allow-list. `items` is a list of REQUIREMENTS, not bare ids: each one names the
 * items that satisfy it and how many are needed, which is what lets one mandate say
 * "one coffee, either size" rather than "these SKUs, any quantity".
 */
export interface LineItemsConstraint {
  type: "checkout.line_items";
  /** At least one requirement — the schema's `minItems: 1`, carried in the type. */
  items: [LineItemRequirement, ...LineItemRequirement[]];
}

export type CheckoutConstraint = AllowedMerchantsConstraint | LineItemsConstraint;

export interface AllowedPayeesConstraint {
  type: "payment.allowed_payees";
  allowed: Merchant[];
}

export interface AllowedPaymentInstrumentsConstraint {
  type: "payment.allowed_payment_instruments";
  allowed: PaymentInstrument[];
}

export interface AllowedPispsConstraint {
  type: "payment.allowed_pisps";
  allowed: Pisp[];
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

/** How often the agent may reuse this mandate. */
export type RecurrenceFrequency =
  | "ON_DEMAND"
  | "DAILY"
  | "WEEKLY"
  | "BIWEEKLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "ANNUALLY";

export interface AgentRecurrenceConstraint {
  type: "payment.agent_recurrence";
  frequency: RecurrenceFrequency;
  max_occurrences?: number;
}

/** The window a payment may execute in. ISO-8601 dates. */
export interface ExecutionDateConstraint {
  type: "payment.execution_date";
  not_before?: string;
  not_after?: string;
}

export interface PaymentReferenceConstraint {
  type: "payment.reference";
  /** Digest of the associated Open Checkout Mandate — the two halves' binding. */
  conditional_transaction_id: string;
}

export type PaymentConstraint =
  | AllowedPayeesConstraint
  | AllowedPaymentInstrumentsConstraint
  | AllowedPispsConstraint
  | AmountRangeConstraint
  | BudgetConstraint
  | AgentRecurrenceConstraint
  | ExecutionDateConstraint
  | PaymentReferenceConstraint;

/** RFC 7800 §3.1 confirmation claim. REQUIRED on both open mandates. The schema says only
 *  "object"; we narrow it to the EC P-256 key this gate issues and verifies. */
export interface Cnf {
  jwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
}

/** "I authorize FUTURE checkouts within these constraints." MUST contain a line_items constraint. */
export interface OpenCheckoutMandate extends MandateBase {
  vct: typeof VCT.openCheckout;
  constraints: CheckoutConstraint[];
  cnf: Cnf;
}

/** "I authorize FUTURE payments within these constraints." */
export interface OpenPaymentMandate extends MandateBase {
  vct: typeof VCT.openPayment;
  constraints: PaymentConstraint[];
  cnf: Cnf;
  payee?: Merchant;
  payment_amount?: Amount;
  payment_instrument?: PaymentInstrument;
  pisp?: Pisp;
  execution_date?: string;
  risk_data?: Record<string, unknown>;
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
