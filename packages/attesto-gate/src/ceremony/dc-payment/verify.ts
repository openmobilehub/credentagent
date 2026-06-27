// AP2-shaped DC payment mandate + four deterministic gates — the WORKING
// presence-only mechanism, adapted from the demo's payment-gate/dc-payment/mandate.ts.
//
// TRUST IS PRESENCE-ONLY (Principle VII / FR-011). The disclosed instrument claims
// are taken at face value: the wallet's signed mdoc DeviceResponse (issuer/device
// signatures, the JWE-encrypted vp_token, and the device SIGNATURE over the
// transaction_data_hash) is NOT cryptographically verified here — that is the
// PR-in-flight crypto the demo does with jose + cbor-x + @peculiar/x509, scaffolded
// alongside in request.ts and refused 501 by the route's presentation path. What IS
// enforced — and what the four gates re-derive rather than trust — is the
// AMOUNT BINDING (Security invariants 2/3): the payable is re-summed from the
// catalog-priced lines and re-checked against the transaction_data and the presented
// amount, so a tampered amount is refused. No gate trusts a `verified` flag.
import { randomUUID } from "node:crypto";
import { buildBindingFields, DEFAULT_LOYALTY_DISCOUNT_PCT } from "../mandate.js";
import type { CeremonyOrder } from "../types.js";
import type { Origin } from "../origin.js";
import { buildTransactionData, decodeTransactionData, encodeTransactionData, hashTransactionData } from "./txData.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function claimText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) return String((v as { value: unknown }).value);
  return String(v);
}

const DEFAULT_ISSUER = "did:web:attesto.local";

export interface DcInstrument {
  issuer: string | null;
  instrumentId: string | null;
  maskedAccount: string | null;
  holder: string | null;
  expiry: string | null;
}

export interface DcMandate {
  type: "ap2.PaymentMandate";
  version: "0.1-dc-demo";
  id: string;
  issuedAt: string;
  expiresAt: string;
  issuer: string;
  subject: { credentialId: string | null };
  cart: CeremonyOrder;
  payment: { instrument: DcInstrument; amount: number; currency: string };
  userAuthorization: {
    type: "openid4vp-dc-api";
    /** The amount-bound transaction_data the wallet would sign over (base64url). */
    transactionData: string;
    /** SHA-256 of `transactionData` (the value the device signs; re-derived in Gate 1). */
    transactionDataHash: string;
    /** Presence-only: the instrument was disclosed but not cryptographically verified. */
    presented: boolean;
  };
  // Honesty axis (Principle VII) — carried on every mandate so the limitation is
  // stated in the data, not buried in prose.
  trust_level: "presence-only-demo";
}

/**
 * Build the presence-only DC payment mandate. The transaction_data is derived from
 * the (catalog-re-priced) order + this RP's origin, so its amount/payee are the
 * server's truth; `presentedAmount` is what the caller asserts authorizing (Gate 1
 * re-checks it equals the re-derived payable — a tampered value is refused).
 */
export function buildDcMandate(args: {
  order: CeremonyOrder;
  origin: Origin;
  claims: Record<string, unknown>;
  presentedAmount?: number;
  issuer?: string;
}): DcMandate {
  const { order, origin, claims } = args;
  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60_000);
  const txDataB64 = encodeTransactionData(buildTransactionData(order, origin));
  const instrument: DcInstrument = {
    issuer: claimText(claims["issuer_name"]),
    instrumentId: claimText(claims["payment_instrument_id"]),
    maskedAccount: claimText(claims["masked_account_reference"]),
    holder: claimText(claims["holder_name"]),
    expiry: claimText(claims["expiry_date"]),
  };
  return {
    type: "ap2.PaymentMandate",
    version: "0.1-dc-demo",
    id: "mandate_pm_" + randomUUID(),
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    issuer: args.issuer ?? DEFAULT_ISSUER,
    subject: { credentialId: instrument.instrumentId },
    cart: order,
    payment: { instrument, amount: args.presentedAmount ?? order.total, currency: order.currency },
    userAuthorization: {
      type: "openid4vp-dc-api",
      transactionData: txDataB64,
      transactionDataHash: hashTransactionData(txDataB64),
      presented: true,
    },
    trust_level: "presence-only-demo",
  };
}

export interface GateResult {
  gate: string;
  pass: boolean;
  detail: string;
}

export function runDcGates(mandate: DcMandate, origin: Origin, opts: { loyaltyDiscountPct?: number } = {}): GateResult[] {
  const pct = opts.loyaltyDiscountPct ?? DEFAULT_LOYALTY_DISCOUNT_PCT;
  const ua = mandate.userAuthorization;
  const cart = mandate.cart;
  const results: GateResult[] = [];

  // Gate 1 — amount binding. Re-sum the (undiscounted) cart lines, re-derive the
  // payable, and re-check it against (a) the transaction_data we'd send, (b) the
  // presented payment.amount. A loyalty discount, if present, must be either zero
  // or EXACTLY the configured percentage of the line sum (this lets a legitimately
  // discounted order pass and rejects an arbitrary discount). The stored amount is
  // NOT trusted; everything is re-derived here.
  const lineSum = round2(cart.lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const discount = cart.discount ?? 0;
  const discountOk = discount === 0 || discount === round2(lineSum * (pct / 100));
  const payable = round2(lineSum - discount);
  const recomputed = hashTransactionData(ua.transactionData);
  const hashOk = ua.transactionDataHash === recomputed;
  const txd = decodeTransactionData(ua.transactionData);
  const amountOk = discountOk && payable === cart.total && payable === mandate.payment.amount && Number(txd.payload.amount) === payable;
  const currencyOk = txd.payload.currency === cart.currency;
  // Payee must be THIS RP — re-derived from the request origin, not the token. An
  // attacker re-pointing the request to their own origin fails here (invariant 6).
  const expectedPayee = buildBindingFields(cart, origin).payee.id;
  const payeeOk = !!txd.payload.payee?.id && txd.payload.payee.id === expectedPayee;
  results.push({
    gate: "Amount binding",
    pass: hashOk && amountOk && currencyOk && payeeOk,
    detail: `hash ${hashOk ? "✓" : "✗"} · amount ${amountOk ? "✓" : "✗"} (${txd.payload.amount}/${mandate.payment.amount} vs ${payable}) · currency ${currencyOk ? "✓" : "✗"} · payee ${payeeOk ? "✓" : "✗"} (${txd.payload.payee?.id} vs ${expectedPayee})`,
  });

  // Gate 2 — authorization present. Presence-only: a disclosed instrument id stands
  // in for the issuerAuth + deviceAuth blocks the demo inspects on the real mdoc.
  const instrumentId = mandate.payment.instrument.instrumentId;
  results.push({
    gate: "Authorization present",
    pass: !!instrumentId,
    detail: `instrument=${instrumentId ?? "∅"} (presence-only — device/issuer signatures not verified)`,
  });

  // Gate 3 — credential not expired (disclosed expiry_date in the future).
  const expStr = mandate.payment.instrument.expiry;
  const notExpired = !!expStr && new Date(expStr).getTime() > Date.now();
  results.push({ gate: "Credential not expired", pass: notExpired, detail: `expiry_date=${expStr}` });

  // Gate 4 — subject binding: mandate.subject re-checked against the disclosed
  // instrument id.
  const subjectOk = !!instrumentId && mandate.subject.credentialId === instrumentId;
  results.push({ gate: "Subject binding", pass: subjectOk, detail: `subject=${mandate.subject.credentialId} · instrument=${instrumentId}` });

  return results;
}
