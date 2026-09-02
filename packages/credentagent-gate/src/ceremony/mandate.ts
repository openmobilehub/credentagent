// Binding fields + the human-not-present bounds model (Intent Mandate bounds, draws, and
// the deterministic draw gates).
//
// WHAT LEFT THIS FILE (spec 013): the `ap2.PaymentMandate` "0.1-mock" and its
// `MOCK-DEV-SIGNER` — a SHA-256 digest of the payload, with a note attached admitting it was
// a mock — along with `runGates`. Both were replaced by real ES256-signed AP2 mandates in
// `../ap2/`: `issueCeremonyChain` mints them and `runCeremonyGates` re-derives the same four
// checks in integer minor units. The WebAuthn assertion is now carried as AP2 `risk_data`,
// which is what it always honestly was: evidence the trusted surface collected, not a
// signature.
//
// WHAT STAYED: the bounds model below. Its draw signing was ALREADY real ES256 over a
// content-addressed canonical form, and it is the ENFORCEMENT engine, not a wire format.
// Expressing those bounds as `mandate.checkout.open.1` / `mandate.payment.open.1` on the wire
// is `../ap2/from-gate.ts`; the enforcement here is unchanged.
import type { CeremonyOrder } from "./types.js";
import type { Origin } from "./origin.js";

/** The demo storefront's whole-cart loyalty rate. A host that offers one seals its OWN rate
 *  into the grant (`membershipProof.discountPct`) so both sides of the amount binding read
 *  the same number; this constant is only the built-in demo's default. */
export const DEFAULT_LOYALTY_DISCOUNT_PCT = 10;
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
  /** Credentials the agent MAY present under this grant. An identity claim is never something
   *  the AGENT presents — an age proof rides `ageProof` below, captured from the human's own
   *  wallet at approval time. */
  mayPresent?: string[];
  /** The human's age claim, proved at approval time and sealed into these bounds (#172). Absent
   *  ⇒ an age-restricted draw steps up exactly as before. Covered by `intentId`. */
  ageProof?: SealedAgeProof;
  /** The human's loyalty membership, proved at approval time and sealed into these bounds (#172).
   *  Absent ⇒ every draw prices at full catalog price, exactly as before. Covered by `intentId`,
   *  so the rate cannot move after the human approved it. */
  membershipProof?: SealedMembershipProof;
  /** Honesty axes (constitution VII v1.1.0): when consent happened / how strongly bound. */
  presence: "delegated" | "delegated-demo";
  trust_level: string;
  subject?: string;
}

/**
 * An age claim the human proved AT APPROVAL TIME, sealed into the intent (issue #172).
 *
 * The delegation rule this reverses: age used to be non-delegable, full stop — an agent could
 * never buy an age-restricted item, so a grant scoped to a category of 21+ goods could spend
 * nothing and the human had no way to unblock it. The reversal is narrow: the human proves age
 * ONCE, on their own phone, with their own wallet, at the exact moment they grant the authority.
 * Nothing is delegated to the agent — the identity claim is the human's, captured while they are
 * present, and it rides the grant rather than the agent.
 *
 * Because `sealIntent` content-addresses the WHOLE bounds object into `intentId`, this field is
 * covered by the grant's identity: it cannot be added, raised, or extended after the fact
 * without producing a different grant.
 *
 * HONESTY: `trust_level` is "presence-only-demo" — the wire crypto behind the proof is real
 * (signed OpenID4VP request, sealed nonce, JWE/HPKE decrypt, ISO-mdoc parse) but there is NO
 * issuer trust anchor yet, so a self-crafted mdoc would pass. This is DISCLOSURE + BINDING, not
 * a real safety control, until issuer-verified trust lands (#14).
 */
export interface SealedAgeProof {
  /** The threshold actually disclosed (`age_over_N === true`). A draw whose order demands a
   *  HIGHER threshold still steps up — an 18+ proof never opens a 21+ item. */
  provenAge: number;
  /** When the ceremony ran (ISO 8601) — the audit line on the sealed record. */
  verifiedAt: string;
  /** The underlying credential's own validity horizon (ISO 8601). Past ⇒ fail closed. UNSET
   *  today: the mdoc's validity window is not parsed yet, so nothing may claim one (#14). */
  expiresAt?: string;
  /** Honesty axis — how strongly the claim is bound. "presence-only-demo" in v0.1. */
  trust_level: string;
}

/**
 * Does a sealed age proof cover an order that demands `requiredAge`? The ONE definition, read by
 * the delegated-draw branch of `completeOrder` and by any host pre-check that wants to answer the
 * same question before spending (the storefront's `spend-from-grant`).
 *
 * FAIL-CLOSED on every axis: no proof, a malformed/non-finite threshold, a threshold BELOW what
 * the order demands, or a credential whose stated validity has passed. `requiredAge` must always
 * be re-derived from the catalog-priced lines — never read off a token or a request body.
 * `nowMs` is epoch milliseconds (the same clock seam `checkDraw` reads).
 */
export function ageProofCovers(proof: SealedAgeProof | undefined, requiredAge: number, nowMs: number = Date.now()): boolean {
  if (!proof || typeof proof.provenAge !== "number" || !Number.isFinite(proof.provenAge)) return false;
  if (proof.provenAge < requiredAge) return false;
  if (proof.expiresAt !== undefined) {
    const expiry = Date.parse(proof.expiresAt);
    // An unparseable expiry is a malformed proof, not an absent one — refuse rather than ignore.
    if (!Number.isFinite(expiry) || expiry <= nowMs) return false;
  }
  return true;
}

/**
 * A loyalty membership the human proved AT APPROVAL TIME, sealed into the intent (issue #172).
 *
 * Same shape of consent as {@link SealedAgeProof}: the credential is the HUMAN's, presented by
 * THEIR wallet while they are present, and the agent never holds or presents one. Where the age
 * proof UNLOCKS items, this one LOWERS the price of every purchase made under the grant.
 *
 * `discountPct` is sealed here rather than read from config at spend time on purpose. The rate is
 * part of what the human approved ("10% off"), so it must be tamper-evident — and BOTH sides of
 * the amount binding read this one number: the draw signer prices with it, and `completeOrder`
 * re-prices with it. A rate that could move between those two moments would break invariant 3
 * (the line sum, the order total and the signed amount must agree on every path).
 *
 * HONESTY: `trust_level` is "presence-only-demo" — real wire crypto, no issuer trust anchor yet.
 */
export interface SealedMembershipProof {
  /** The membership id the wallet disclosed — a real, non-empty one (invariant 5). */
  membershipNumber: string;
  /** The percentage off, as approved and shown to the human. Sealed; never re-read from config. */
  discountPct: number;
  /** When the ceremony ran (ISO 8601) — the audit line on the sealed record. */
  verifiedAt: string;
  /** Honesty axis — how strongly the claim is bound. "presence-only-demo" in v0.1. */
  trust_level: string;
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
  // `undefined` is not JSON: as an object value JSON.stringify DROPS the key; in an array it
  // becomes null. Match that here so seal-time and check-time bytes agree across a JSON
  // round-trip — an optional bound left undefined (`subject`/`description`/`presentments`)
  // must not change the hash after transport, else a legitimate grant refuses itself
  // (bounds-tampered / signature) the moment it is stored, logged, or sent over the wire.
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort().filter((k) => obj[k] !== undefined);
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
  // extractable=false: the PRIVATE key K_s (the grant's sole spending authority) is only ever
  // used in-process for subtle.sign and never needs to leave — the public JWK still exports
  // (WebCrypto public keys are always extractable). Removes a needless path for the raw
  // signing key to leak via an accidental export/serialize.
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
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

  // 3.5. amount DOMAIN — the caps below are `>` comparisons that FAIL OPEN on a non-finite or
  // non-positive amount: `NaN > cap` is false (a NaN draw clears every ceiling AND, once
  // committed, makes the cumulative `spent` NaN → the total cap is disabled forever), and a
  // negative draw slips every ceiling then REFUNDS cumulative headroom. A "pure and total"
  // gate must validate the domain of the value it bounds before comparing it. Refuse here so
  // the `>`-checks below only ever see a finite, positive amount.
  if (!Number.isFinite(draw.amount) || draw.amount <= 0)
    refusals.push(refusal("invalid-amount", { amount: draw.amount }));

  // 4. per-draw cap (TS12 max_amount) — absolute ceiling
  if (draw.amount > intent.maxAmount) refusals.push(refusal("over-cap", { cap: intent.maxAmount, amount: draw.amount }));

  // 5. cumulative cap (TS12 total_amount) — committed draws + this one
  const spent = priorDraws.reduce((s, d) => s + d.amount, 0);
  if (spent + draw.amount > intent.totalAmount)
    refusals.push(refusal("over-total", { total: intent.totalAmount, wouldBe: spent + draw.amount }));

  // 6. window (notBefore ≤ now ≤ intentExpiry). FAIL-CLOSED on an unparseable bound: a typo'd
  // date must not silently disable the window — `Date.parse` returns NaN, and `now > NaN` is
  // false, so an un-parseable expiry would leave the grant valid forever. Treat NaN as refused.
  if (intent.notBefore) {
    const notBefore = Date.parse(intent.notBefore);
    if (Number.isNaN(notBefore) || now < notBefore) refusals.push(refusal("not-yet-valid", { notBefore: intent.notBefore }));
  }
  if (intent.intentExpiry) {
    const expiry = Date.parse(intent.intentExpiry);
    if (Number.isNaN(expiry) || now > expiry) refusals.push(refusal("expired", { intentExpiry: intent.intentExpiry }));
  }

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
