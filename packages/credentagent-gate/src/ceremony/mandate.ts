// Binding fields + the AP2-shaped passkey mandate + the four deterministic gates.
// Extracted from the demo's payment-gate/mandate.ts; the demo's `Order` and the
// hardcoded `LOYALTY_DISCOUNT_PCT` become an injected `CeremonyOrder` + an opt so
// the package stays dependency-free. No gate trusts a `verified` boolean — each is
// re-derived from the mandate's own fields.
//
// Trust is PRESENCE-ONLY (Principle VII): the signature is a dev-mock SHA-256
// digest and the mandate carries `trust_level: "presence-only-demo"`. Real
// KB-JWT / key-bound signing is deferred (v0.2); this is a flow demo, not a real
// safety control.
import { createHash, randomUUID } from "node:crypto";
import type { CeremonyOrder } from "./types.js";
import type { Origin } from "./origin.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// The demo's whole-cart loyalty discount; the host can override via runGates opts.
export const DEFAULT_LOYALTY_DISCOUNT_PCT = 10;
const DEFAULT_ISSUER = "did:web:credentagent.local";
const DEFAULT_PAYEE_NAME = "CredentAgent Gate Demo";

export interface BindingFields {
  amount: number;
  currency: string;
  payee: { id: string; name: string };
  orderId: string;
}

export function buildBindingFields(order: CeremonyOrder, origin: Origin, payeeName = DEFAULT_PAYEE_NAME): BindingFields {
  return {
    amount: order.total,
    currency: order.currency,
    payee: { id: origin.rpID, name: payeeName },
    orderId: order.id,
  };
}

// Minimal shape of what @simplewebauthn returns that we carry into the mandate.
export interface VerifiedAuthenticator {
  credentialID: string;
  userVerified: boolean;
  credentialDeviceType: "singleDevice" | "multiDevice";
  credentialBackedUp: boolean;
}

export interface PasskeyMandate {
  type: "ap2.PaymentMandate";
  version: "0.1-mock";
  id: string;
  issuedAt: string;
  expiresAt: string;
  issuer: string;
  subject: { credentialID: string };
  cart: CeremonyOrder;
  payment: { instrument: string; instrumentReference: string; network: string; amount: number; currency: string };
  userAuthorization: {
    type: "webauthn.assertion";
    credentialID: string;
    userVerified: boolean;
    hardwareBacked: boolean;
    deviceType: string;
    backedUp: boolean;
    rpID: string;
    origin: string;
    ceremonyTimestamp: string;
  };
  payeeId: string;
  // Honesty axis (Principle VII) — carried on every mandate so the limitation is
  // stated in the data, not buried in prose.
  trust_level: "presence-only-demo";
  signature: { alg: "MOCK-DEV-SIGNER"; value: string; note: string };
}

export function buildPasskeyMandate(args: {
  order: CeremonyOrder;
  authenticator: VerifiedAuthenticator;
  origin: Origin;
  issuer?: string;
  payeeName?: string;
}): PasskeyMandate {
  const { order, authenticator, origin } = args;
  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60_000);
  const binding = buildBindingFields(order, origin, args.payeeName);

  const body = {
    type: "ap2.PaymentMandate" as const,
    version: "0.1-mock" as const,
    id: "mandate_pm_" + randomUUID(),
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    issuer: args.issuer ?? DEFAULT_ISSUER,
    subject: { credentialID: authenticator.credentialID },
    cart: order,
    payment: {
      instrument: "stripe_test",
      // eslint-disable-next-line no-restricted-properties -- cosmetic mock display id, not security randomness
      instrumentReference: "pi_3Mock" + Math.random().toString(36).slice(2, 10).toUpperCase(),
      network: "card",
      amount: binding.amount,
      currency: binding.currency,
    },
    userAuthorization: {
      type: "webauthn.assertion" as const,
      credentialID: authenticator.credentialID,
      userVerified: authenticator.userVerified,
      // A single-device credential is bound to this authenticator's hardware; a
      // multi-device (syncable) passkey is not strictly hardware-bound.
      hardwareBacked: authenticator.credentialDeviceType === "singleDevice",
      deviceType: authenticator.credentialDeviceType,
      backedUp: authenticator.credentialBackedUp,
      rpID: origin.rpID,
      origin: origin.origin,
      ceremonyTimestamp: now.toISOString(),
    },
    payeeId: binding.payee.id,
    trust_level: "presence-only-demo" as const,
  };

  const digest = createHash("sha256").update(JSON.stringify(body)).digest("base64");
  return {
    ...body,
    signature: {
      alg: "MOCK-DEV-SIGNER",
      value: "mock-sig:" + digest,
      note: "Mock dev signer (presence-only-demo). Production replaces with AP2-conformant key-bound signing.",
    },
  };
}

export interface GateResult {
  gate: string;
  pass: boolean;
  detail: string;
}

export function runGates(mandate: PasskeyMandate, opts: { loyaltyDiscountPct?: number } = {}): GateResult[] {
  const pct = opts.loyaltyDiscountPct ?? DEFAULT_LOYALTY_DISCOUNT_PCT;
  const ua = mandate.userAuthorization;
  const cart = mandate.cart;
  const lineSum = round2(cart.lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const results: GateResult[] = [];

  // Gate 1 — amount integrity. Re-sum the (undiscounted) cart lines and re-derive
  // the payable total; payment.amount is NOT trusted. A loyalty discount, if
  // present, must be either zero or EXACTLY the configured percentage of the line
  // sum — this lets a legitimately discounted order pass and rejects a token
  // tampered with an arbitrary discount. Payable must equal cart.total AND the
  // authorized payment.amount.
  const discount = cart.discount ?? 0;
  const discountOk = discount === 0 || discount === round2(lineSum * (pct / 100));
  const payable = round2(lineSum - discount);
  const amountOk = discountOk && payable === cart.total && payable === mandate.payment.amount;
  results.push({
    gate: "Amount integrity",
    pass: amountOk,
    detail: `lines=${lineSum} · discount=${discount} · payable=${payable} · payment=${mandate.payment.amount} · cart.total=${cart.total}`,
  });

  // Gate 2 — authorization present & structurally a webauthn assertion.
  const authPresent = ua.type === "webauthn.assertion" && !!ua.credentialID;
  results.push({
    gate: "Authorization present",
    pass: authPresent,
    detail: `type=${ua.type} · credentialID=${ua.credentialID || "∅"}`,
  });

  // Gate 3 — user verification asserted by the authenticator.
  results.push({
    gate: "User verification",
    pass: ua.userVerified === true,
    detail: `userVerified=${ua.userVerified} · hardwareBacked=${ua.hardwareBacked}`,
  });

  // Gate 4 — subject binding: re-check subject == authorization credentialID.
  const subjectOk = !!mandate.subject.credentialID && mandate.subject.credentialID === ua.credentialID;
  results.push({
    gate: "Subject binding",
    pass: subjectOk,
    detail: `subject=${mandate.subject.credentialID} · auth=${ua.credentialID}`,
  });

  return results;
}
