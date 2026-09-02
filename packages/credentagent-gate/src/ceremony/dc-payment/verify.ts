// AP2-shaped DC payment mandate + four deterministic gates. TWO verify paths feed
// ONE set of gates:
//   • the instant-demo path (buildDcPresentation + runDcGates) — disclosed instrument
//     claims passed in directly; the amount-bound transaction_data is re-derived +
//     re-checked, so a tampered amount is refused. The tested default (CT6–CT8).
//   • the REAL OpenID4VP path (verifyDcPresentation, below) — the wallet's
//     JWE-encrypted response is decrypted (jose ECDH-ES compactDecrypt), the ISO
//     18013-5 mdoc DeviceResponse is parsed, and the wallet's device-SIGNED
//     transaction_data_hash (from deviceSigned) is extracted and re-checked against
//     SHA-256 of the transaction_data we sent — proving the wallet authorized THIS
//     amount/payee, not merely that a token decrypted.
//
// TRUST_LEVEL stays "presence-only-demo" (Principle VII / FR-011): the wire crypto
// — JWE decryption, the ISO-mdoc CBOR parse, the transaction_data hash binding — is
// REAL; what is NOT yet verified is the issuer/device COSE SIGNATURE against a real
// trust anchor (main self-signs its mdoc certs). Faithfully ported from the demo's
// payment-gate/dc-payment/{mandate,verify}.ts. No gate trusts a `verified` flag —
// AMOUNT BINDING (Security invariants 2/3) is always re-derived from the
// catalog-priced lines.
import { randomUUID } from "node:crypto";
import * as jose from "jose";
import { buildBindingFields, DEFAULT_LOYALTY_DISCOUNT_PCT } from "../mandate.js";
import type { CeremonyOrder } from "../types.js";
import type { Origin } from "../origin.js";
import { buildTransactionData, decodeTransactionData, encodeTransactionData, hashTransactionData, txHashNameFromCose } from "./txData.js";
import { openReaderContext } from "../mdoc/readerContext.js";
import { decodeVpToken, extractTransactionDataHash, extractTransactionDataHashAlg, inspectAuthBlocks } from "../mdoc/mdoc.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function claimText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) return String((v as { value: unknown }).value);
  return String(v);
}

const DEFAULT_ISSUER = "did:web:credentagent.local";

export interface DcInstrument {
  issuer: string | null;
  instrumentId: string | null;
  maskedAccount: string | null;
  holder: string | null;
  expiry: string | null;
}

/**
 * The rail's own presentation record — what the wallet disclosed and what the gates read.
 *
 * It used to declare itself `type: "ap2.PaymentMandate"`, `version: "0.1-dc-demo"`. It was
 * neither: no AP2 field names, no signature. Since spec 013 the AP2 record for this
 * completion is a real SD-JWT minted alongside it (`issueCeremonyChain`), and this object is
 * honestly named for what it is — the disclosed presentation the deterministic gates check.
 */
export interface DcPresentation {
  type: "credentagent.DcPresentation/v1";
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
    /**
     * The transaction_data_hash Gate 1 re-checks against SHA-256(transactionData).
     * Instant-demo: the server's own hash (always matches). REAL path: the value
     * EXTRACTED from the wallet's device-signed DeviceResponse — so Gate 1 verifies
     * the wallet actually authorized THIS amount/payee.
     */
    transactionDataHash: string | null;
    /**
     * The COSE hash-algorithm id the wallet reported in `transaction_data_hash_alg`
     * (e.g. -16 SHA-256, -43 SHA-384). Null ⇒ the wallet used Multipaz's SHA-256
     * default and omitted the element. Gate 1 recomputes the hash with this algorithm.
     */
    transactionDataHashAlg?: number | null;
    /** Presence-only: the instrument was disclosed but not cryptographically verified. */
    presented: boolean;
    /**
     * REAL path only — the wallet's raw mdoc vp_token (base64url DeviceResponse) and
     * the structural issuerAuth/deviceAuth presence Gate 2 reads. Absent on the
     * instant-demo path (Gate 2 falls back to instrument presence there).
     */
    vpToken?: string;
    authBlocks?: { hasIssuerAuth: boolean; hasDeviceAuth: boolean };
  };
  // Honesty axis (Principle VII) — carried on the record so the limitation is stated in the
  // data, not buried in prose. Presence-only: the instrument was DISCLOSED, and (on the real
  // path) the wallet signed the transaction_data — but no issuer anchor validates either (#14).
  trust_level: "presence-only-demo";
}

/** @deprecated Renamed to {@link DcPresentation} in 0.5.0 — it was never an AP2 mandate. */
export type DcMandate = DcPresentation;

/**
 * Build the presence-only DC payment mandate. The transaction_data is derived from
 * the (catalog-re-priced) order + this RP's origin, so its amount/payee are the
 * server's truth; `presentedAmount` is what the caller asserts authorizing (Gate 1
 * re-checks it equals the re-derived payable — a tampered value is refused).
 */
export function buildDcPresentation(args: {
  order: CeremonyOrder;
  origin: Origin;
  claims: Record<string, unknown>;
  presentedAmount?: number;
  issuer?: string;
}): DcPresentation {
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
    type: "credentagent.DcPresentation/v1",
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

export function runDcGates(mandate: DcPresentation, origin: Origin, opts: { loyaltyDiscountPct?: number } = {}): GateResult[] {
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
  // Honor the wallet's declared hash algorithm before comparing. A null/absent id ⇒
  // Multipaz's SHA-256 default; a known COSE id ⇒ that hash; an UNKNOWN id ⇒ `nodeAlg`
  // is null so we do NOT recompute and hashOk stays false (fail closed rather than
  // silently assume SHA-256). The wallet's device-signed hash must equal our recompute
  // over the exact transaction_data we sent, with the same algorithm.
  const nodeAlg = txHashNameFromCose(ua.transactionDataHashAlg);
  const recomputed = nodeAlg ? hashTransactionData(ua.transactionData, nodeAlg) : null;
  const hashOk = nodeAlg !== null && ua.transactionDataHash === recomputed;
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
    detail: `hash ${hashOk ? "✓" : "✗"} (${nodeAlg ?? "unknown-alg"}) · amount ${amountOk ? "✓" : "✗"} (${txd.payload.amount}/${mandate.payment.amount} vs ${payable}) · currency ${currencyOk ? "✓" : "✗"} · payee ${payeeOk ? "✓" : "✗"} (${txd.payload.payee?.id} vs ${expectedPayee})`,
  });

  // Gate 2 — authorization present. On the REAL path, the wallet's mdoc carries
  // structural issuerAuth + deviceAuth blocks (inspected from the parsed
  // DeviceResponse); on the instant-demo path a disclosed instrument id stands in
  // for them. Either way this is presence-only — the COSE signatures themselves are
  // NOT verified against a trust anchor (acknowledged future work).
  const instrumentId = mandate.payment.instrument.instrumentId;
  const auth = ua.authBlocks;
  const authPass = auth ? auth.hasIssuerAuth && auth.hasDeviceAuth : !!instrumentId;
  results.push({
    gate: "Authorization present",
    pass: authPass,
    detail: auth
      ? `issuerAuth ${auth.hasIssuerAuth ? "✓" : "✗"} · deviceAuth ${auth.hasDeviceAuth ? "✓" : "✗"} (presence-only — COSE signatures not verified)`
      : `instrument=${instrumentId ?? "∅"} (presence-only — device/issuer signatures not verified)`,
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

// ── REAL OpenID4VP path ───────────────────────────────────────────────────────
// Disclosed mdoc claim values can be {_tag, value} (e.g. tag-1004 dates) or raw.
function disclosedClaims(vpStr: string): Record<string, unknown> {
  const disclosed = decodeVpToken({ dpc: vpStr });
  return Object.fromEntries((disclosed[0]?.claims ?? []).map((c) => [c.label.split(" / ").pop()!, c.value]));
}

/**
 * Build the DC mandate from a REAL wallet DeviceResponse. Unlike the instant-demo
 * builder, `transactionDataHash` is the value EXTRACTED from the wallet's
 * device-signed mdoc (deviceSigned/transaction_data_hash) — Gate 1 then re-checks it
 * equals SHA-256 of the transaction_data WE sealed (transactionDataB64). The vpToken
 * + parsed issuerAuth/deviceAuth presence drive Gate 2. The instrument fields come
 * from the issuer-signed namespaces of the SAME DeviceResponse.
 */
export function buildDcMandateFromPresentation(args: {
  order: CeremonyOrder;
  vpStr: string;
  transactionDataB64: string;
  issuer?: string;
}): DcPresentation {
  const { order, vpStr, transactionDataB64 } = args;
  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60_000);
  const claims = disclosedClaims(vpStr);
  const instrument: DcInstrument = {
    issuer: claimText(claims["issuer_name"]),
    instrumentId: claimText(claims["payment_instrument_id"]),
    maskedAccount: claimText(claims["masked_account_reference"]),
    holder: claimText(claims["holder_name"]),
    expiry: claimText(claims["expiry_date"]),
  };
  const blocks = inspectAuthBlocks(vpStr);
  return {
    type: "credentagent.DcPresentation/v1",
    id: "mandate_pm_" + randomUUID(),
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    issuer: args.issuer ?? DEFAULT_ISSUER,
    subject: { credentialId: instrument.instrumentId },
    cart: order,
    payment: { instrument, amount: order.total, currency: order.currency },
    userAuthorization: {
      type: "openid4vp-dc-api",
      transactionData: transactionDataB64,
      // The wallet's signed hash — re-checked in Gate 1 against our recomputed hash.
      transactionDataHash: extractTransactionDataHash(vpStr),
      // The algorithm the wallet used, so Gate 1 recomputes with it (null ⇒ SHA-256).
      transactionDataHashAlg: extractTransactionDataHashAlg(vpStr),
      presented: true,
      vpToken: vpStr,
      authBlocks: { hasIssuerAuth: blocks.hasIssuerAuth, hasDeviceAuth: blocks.hasDeviceAuth },
    },
    trust_level: "presence-only-demo",
  };
}

export interface DcVerification {
  mandate: DcPresentation;
  gates: GateResult[];
}

/**
 * Verify the wallet's REAL OpenID4VP presentation: open the sealed reader context,
 * JWE-decrypt the response (jose ECDH-ES compactDecrypt), pull the mdoc vp_token,
 * build the amount-bound mandate from the device-signed DeviceResponse, and run the
 * four gates. Faithfully ported from the demo's payment-gate/dc-payment/verify.ts.
 * The crypto (decryption + the transaction_data hash binding) is REAL; the issuer
 * trust anchor is not (trust_level presence-only-demo).
 */
export async function verifyDcPresentation(args: {
  order: CeremonyOrder;
  origin: Origin;
  result: { protocol?: string; data?: unknown };
  readerContextToken: string;
  secret: string;
}): Promise<DcVerification> {
  const { order, origin, result, readerContextToken, secret } = args;
  const ctx = await openReaderContext(readerContextToken, secret);

  let data: unknown = result?.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { /* leave as string */ }
  }
  const jwe: string | undefined = (data as { response?: string } | undefined)?.response;
  if (!jwe) throw new Error("no .response (JWE) in result.data");

  const encPrivKey = await jose.importJWK(ctx.ecdhPrivateJwk, "ECDH-ES");
  const { plaintext } = await jose.compactDecrypt(jwe, encPrivKey);
  const openid4vpResponse = JSON.parse(new TextDecoder().decode(plaintext)) as { vp_token?: { dpc?: unknown } };
  const vpToken = openid4vpResponse.vp_token; // { dpc: [ "<DeviceResponse b64url>" ] }
  const vpStr: string | undefined = Array.isArray(vpToken?.dpc) ? (vpToken!.dpc[0] as string) : (vpToken?.dpc as string | undefined);
  if (!vpStr) throw new Error("no vp_token.dpc in decrypted response");

  const mandate = buildDcMandateFromPresentation({ order, vpStr, transactionDataB64: ctx.transactionDataB64 });
  const gates = runDcGates(mandate, origin);
  return { mandate, gates };
}
