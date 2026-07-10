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
import type { Presence, TrustLevel } from "../types.js";
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

// ────────────────────────────────────────────────────────────────────────────
// HNP seams (005, Option B): the Intent Mandate BOUNDS model + the deterministic
// draw gates — productized from spike/intent-mandate/ (13 tests ported alongside).
// The user's ceremony seals BOUNDS (caps / window / scope / delegate key); each
// DRAW (a per-purchase Payment Mandate) is checked in-bounds server-side on every
// completion path. Honesty: the wire crypto here is REAL (ES256 over the canonical
// draw; content-addressed intentId over SHA-256) — what the demo fakes is the PKI
// and the money, never the bounds enforcement, which is deterministic and total.
import { webcrypto } from "node:crypto";
import { refusal, type Refusal } from "./refusals.js";

const subtle = webcrypto.subtle;
type CryptoKey = webcrypto.CryptoKey;
const utf8 = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array): string => Buffer.from(buf as Uint8Array).toString("base64url");

/** The delegate key K_s — the ONLY key that may sign draws — as a public JWK. */
export interface DelegateJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** The user-sealed Intent Mandate bounds (intent-bounds-schema-draft.md: AP2 intent
 *  fields + EUDI SCA TS12 `PaymentTransaction` amounts). Content-addressed: `intentId`
 *  transitively commits to every other field, delegate key and honesty labels included. */
export interface IntentBounds {
  type: "credentagent.IntentBounds/v0";
  intentId: string;
  /** The human-readable mandate the user actually approved (AP2 natural-language field). */
  naturalLanguageDescription?: string;
  /** Merchant allowlist; absent/empty ⇒ any suitable merchant (multi-merchant is native under B). */
  merchants?: string[];
  /** SKU/GTIN scope allowlist (checked by the wallet/rail; the seam checks merchants). */
  skus?: string[];
  currency: string;
  /** Per-draw cap (TS12 max_amount) — an absolute ceiling, tolerance 0. */
  maxAmount: number;
  /** Cumulative cap (TS12 total_amount) across all committed draws. */
  totalAmount: number;
  /** Presence-required threshold: a draw above it needs a fresh human tap (step-up ≤ cap). */
  stepUpOver?: number;
  intentExpiry?: string;
  notBefore?: string;
  delegate: DelegateJwk;
  /** Credentials the agent MAY present under this grant. Age is NEVER delegable → never listed. */
  mayPresent?: string[];
  /** Honesty axes (constitution VII v1.1.0): when consent happened / how strongly
   *  bound. Carried in the TYPES, not just prose (CLAUDE.md honesty invariant) — a
   *  consumer switches exhaustively and the compiler flags a new rung. An intent is
   *  always delegated, so `presence` narrows to the two delegated rungs. */
  presence: Extract<Presence, "delegated" | "delegated-demo">;
  trust_level: TrustLevel;
  subject?: string;
}

/** One draw — the per-purchase spend against an intent, signed by the delegate key. */
export interface Draw {
  type: "credentagent.Draw/v0";
  intentId: string;
  paymentMandateId: string;
  merchant: string;
  amount: number;
  currency: string;
  /** The PSP-issued settlement transaction id — single-use per intent (replay guard). */
  pspTransactionId: string;
  presentments?: string[];
  /** b64url ES256 signature by the delegate key over the canonical draw (sans this field). */
  signature?: string;
}

/** A committed (already-drawn) spend, as the RevocationStore records it. */
export interface CommittedDraw {
  amount: number;
  pspTransactionId: string;
}

/** Canonical JSON (stable, recursive key sort) — the exact bytes hashed + signed. Any
 *  edit to any field changes these bytes, so a signature/hash covers the whole document. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

/** intentId = "int_" + b64url(SHA-256(canonical(bounds \ intentId))) — no circularity,
 *  and it transitively commits to EVERY other field. */
export async function contentAddressId(bounds: object): Promise<string> {
  const { intentId: _omit, ...rest } = bounds as Record<string, unknown>;
  const digest = await subtle.digest("SHA-256", utf8.encode(canonical(rest)));
  return "int_" + b64url(digest);
}

export async function sealIntent(boundsWithoutId: Omit<IntentBounds, "intentId">): Promise<IntentBounds> {
  return { ...boundsWithoutId, intentId: await contentAddressId(boundsWithoutId) } as IntentBounds;
}

/** Generate a delegate keypair K_s (ES256 / P-256). The bounds carry the PUBLIC JWK. */
export async function generateDelegate(): Promise<{ privateKey: CryptoKey; delegate: DelegateJwk }> {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, delegate: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! } };
}

/** Sign a draw with the delegate key over its canonical form (any prior signature stripped). */
export async function signDraw(draw: Draw, privateKey: CryptoKey): Promise<Draw> {
  const { signature: _omit, ...unsigned } = draw;
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, utf8.encode(canonical(unsigned)));
  return { ...(unsigned as Draw), signature: b64url(sig) };
}

/** Signer-agnostic verification seam: the default verifies ES256/P-256 (the wallet
 *  server's K_s — the Option-B target); hosts may inject e.g. an HMAC verifier. */
export type DrawVerifier = (draw: Draw, delegate: DelegateJwk) => Promise<boolean>;

export const verifyDrawEs256: DrawVerifier = async (draw, delegate) => {
  try {
    const { signature, ...unsigned } = draw;
    if (typeof signature !== "string") return false;
    const key = await subtle.importKey(
      "jwk",
      { ...delegate, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    return await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(signature, "base64url"),
      utf8.encode(canonical(unsigned)),
    );
  } catch {
    return false;
  }
};

export interface CheckDrawContext {
  now?: number;
  priorDraws?: CommittedDraw[];
  verify?: DrawVerifier;
}

export interface DrawVerdict {
  ok: boolean;
  refusals: Refusal[];
}

/** THE DETERMINISTIC GATES: is this draw in-bounds? Pure and total — injected `now` /
 *  `priorDraws`, never throws, accumulates typed refusals (no first-fail) so the surface
 *  can act on the full picture. This is defense-in-depth's inner ring: the completion
 *  seam re-runs it server-side on EVERY path (invariant 1). */
export async function checkDraw(intent: IntentBounds, draw: Draw, ctx: CheckDrawContext = {}): Promise<DrawVerdict> {
  const now = ctx.now ?? Date.now();
  const priorDraws = ctx.priorDraws ?? [];
  const verify = ctx.verify ?? verifyDrawEs256;
  const refusals: Refusal[] = [];

  // 0. INTEGRITY: the intent's own fields must hash to its intentId. Content-addressing is
  // the whole trust root — without recomputing it here, `intentId` is a bare string label,
  // and a caller could keep a victim's id while swapping `delegate` / `maxAmount` / `merchants`
  // and signing the draw with the substituted key (every check below would then run against
  // bounds the user never approved). Recompute and refuse on mismatch.
  if ((await contentAddressId(intent)) !== intent.intentId) refusals.push(refusal("bounds-tampered"));

  // 1. binds to THIS intent
  if (draw.intentId !== intent.intentId) refusals.push(refusal("intent-mismatch"));

  // 2. signed by the delegate key named in the (content-addressed, integrity-checked) bounds
  if (!(await verify(draw, intent.delegate))) refusals.push(refusal("signature"));

  // 3. currency
  if (draw.currency !== intent.currency)
    refusals.push(refusal("currency-mismatch", { expected: intent.currency, got: draw.currency }));

  // 4. per-draw cap (TS12 max_amount) — absolute ceiling
  if (draw.amount > intent.maxAmount) refusals.push(refusal("over-cap", { cap: intent.maxAmount, amount: draw.amount }));

  // 5. cumulative cap (TS12 total_amount) — committed draws + this one
  const spent = priorDraws.reduce((s, d) => s + d.amount, 0);
  if (spent + draw.amount > intent.totalAmount)
    refusals.push(refusal("over-total", { total: intent.totalAmount, wouldBe: spent + draw.amount }));

  // 6. window (notBefore ≤ now ≤ intentExpiry)
  if (intent.notBefore && now < Date.parse(intent.notBefore))
    refusals.push(refusal("not-yet-valid", { notBefore: intent.notBefore }));
  if (intent.intentExpiry && now > Date.parse(intent.intentExpiry))
    refusals.push(refusal("expired", { intentExpiry: intent.intentExpiry }));

  // 7. scope — merchant allowlist (absent/empty ⇒ any suitable merchant)
  if (Array.isArray(intent.merchants) && intent.merchants.length > 0 && !intent.merchants.includes(draw.merchant))
    refusals.push(refusal("out-of-scope", { merchant: draw.merchant }));

  // 8. replay — the PSP transaction id is single-use per intent
  if (priorDraws.some((d) => d.pspTransactionId === draw.pspTransactionId))
    refusals.push(refusal("replay", { pspTransactionId: draw.pspTransactionId }));

  // 9. presentments ⊆ mayPresent. Age is NEVER delegable → never in mayPresent (invariant 5).
  for (const p of draw.presentments ?? []) {
    if (!(intent.mayPresent ?? []).includes(p)) refusals.push(refusal("unpermitted-presentment", { presentment: p }));
  }

  // 10. step-up: over the presence-required threshold ⇒ a fresh human tap resumes it.
  if (typeof intent.stepUpOver === "number" && draw.amount > intent.stepUpOver)
    refusals.push(refusal("step-up", { threshold: intent.stepUpOver }));

  return { ok: refusals.length === 0, refusals };
}
