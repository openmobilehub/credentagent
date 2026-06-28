// Map a wallet's disclosed mdoc claims to a verified boolean for the age /
// membership gate, and re-derive an order's age restriction from its catalog-priced
// lines.
//
// TWO verification entry points, ONE policy:
//   • evaluateCredential(kind, claims, …) — the instant-demo path. Disclosed claims
//     are passed in directly (no wallet round-trip). The explicit-positive-claim
//     control (Security invariant 5) still runs.
//   • verifyCredentialPresentation(…) — the REAL OpenID4VP path. The wallet's
//     JWE-encrypted response is decrypted (jose ECDH-ES compactDecrypt), nonce-bound
//     to THIS request (apu/apv echo check), the ISO 18013-5 mdoc DeviceResponse is
//     parsed, and the disclosed claims are flattened into the SAME policy check.
//   • verifyMdocPresentation(…) (mdoc-verify.ts) — the REAL iOS org-iso-mdoc path:
//     HPKE-decrypt the DeviceResponse bound to the web origin, then the same policy.
//
// TRUST_LEVEL stays "presence-only-demo" (Principle VII / FR-011). The wire crypto
// (JWE/HPKE decryption, ECDH-ES, nonce binding, ISO-mdoc CBOR parsing) is REAL and
// verified; what is NOT yet real is the issuer TRUST ANCHOR — the mdoc's issuer /
// device COSE signatures are not checked against a real CA (main self-signs its
// mdoc certs), so a self-crafted mdoc would still parse. That hardening is the
// acknowledged future work, shared with dc-payment.
//
// The policy itself (what claims pass) reuses the package's own age.over(N) /
// membership.discount() builders so the threshold + membership rules have a single
// definition:
//   • age      — requires the positive over-age claim AT THE ORDER'S THRESHOLD
//                (age_over_21 === true for a 21+ gate; an age_over_18 proof is refused).
//   • membership — requires a real, non-empty membership id. A bare token or an
//                unrelated claim must NOT grant the discount (it lowers the bound
//                amount, so a forged loyalty state would reduce the charge).
import * as jose from "jose";
import { age, membership } from "../../credentials.js";
import { DEFAULT_LOYALTY_DISCOUNT_PCT } from "../mandate.js";
import type { CeremonyOrder } from "../types.js";
import type { CredentialKind } from "./dcql.js";
import { openReaderContext } from "../mdoc/readerContext.js";
import { decodeVpToken, type DisclosedEntry } from "../mdoc/mdoc.js";

export type { CredentialKind } from "./dcql.js";

export interface GateResult {
  gate: string;
  pass: boolean;
  detail: string;
}

export interface CredGateResult {
  verified: boolean;
  /** Membership id when a membership gate verified; null otherwise. */
  membershipNumber: string | null;
  gates: GateResult[];
  /** Honesty axis — stated in the receipt, not buried in prose. */
  trust_level: "presence-only-demo";
}

export interface EvaluateOpts {
  /** The minimum age the order's products demand (age gate only; default 21). */
  minimumAge?: number;
  /** The membership discount percent surfaced in the gate detail (default 10). */
  percent?: number;
}

/**
 * Re-derive the age threshold this order requires from its catalog-priced lines —
 * the strictest `minimumAge` present, or `null` when nothing is age-restricted.
 * Always read from the (re-priced) lines, never the order token (invariant 2).
 */
export function requiredAgeForOrder(order: CeremonyOrder): number | null {
  const ages = order.lines
    .map((l) => l.minimumAge)
    .filter((a): a is number => typeof a === "number" && a > 0);
  return ages.length ? Math.max(...ages) : null;
}

/** True iff this order is age-restricted but carries no positive per-order age claim. */
export function isAgeUnsatisfied(order: CeremonyOrder, verification: { ageVerified?: boolean } | undefined | null): boolean {
  return requiredAgeForOrder(order) != null && verification?.ageVerified !== true;
}

/**
 * Evaluate disclosed claims (PRESENCE-ONLY) for one credential kind. Reuses the
 * package's `age.over(N)` / `membership.discount()` `verify()` so the positive-claim
 * rule has a single definition.
 */
export function evaluateCredential(kind: CredentialKind, claims: Record<string, unknown>, opts: EvaluateOpts = {}): CredGateResult {
  if (kind === "age") {
    const minimumAge = opts.minimumAge ?? 21;
    // age.over(N).verify checks claims[`age_over_${N}`] === true — an explicit
    // positive at THIS threshold (a lower-threshold proof does not satisfy it).
    const verified = age.over(minimumAge).verify(claims);
    return {
      verified,
      membershipNumber: null,
      gates: [{ gate: `Age over ${minimumAge}`, pass: verified, detail: verified ? `age_over_${minimumAge} disclosed true` : `age_over_${minimumAge} not disclosed as true` }],
      trust_level: "presence-only-demo",
    };
  }

  const percent = opts.percent ?? DEFAULT_LOYALTY_DISCOUNT_PCT;
  const verified = membership.discount(percent).verify(claims);
  const membershipNumber = verified ? String(claims.membership_number) : null;
  return {
    verified,
    membershipNumber,
    gates: [{ gate: "Membership", pass: verified, detail: verified ? `member ${membershipNumber}` : "no membership id disclosed" }],
    trust_level: "presence-only-demo",
  };
}

// ── Disclosed mdoc DeviceResponse → the flat `claims` record `evaluateCredential`
//    reads. mdoc.ts labels each claim "<namespace> / <elementId>"; we key by the
//    bare elementId. Values can be raw or {_tag, value} (sanitized dates etc.) — a
//    boolean (e.g. age_over_21) is preserved as a boolean so the strict
//    `=== true` check holds; everything else is surfaced as-is. The SAME
//    evaluateCredential policy then runs — no second source of truth for "verified".
function flattenDisclosed(disclosed: DisclosedEntry[]): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  for (const entry of disclosed) {
    for (const c of entry.claims) {
      const elementId = c.label.split(" / ").pop();
      if (!elementId) continue;
      const v = c.value;
      claims[elementId] = v && typeof v === "object" && "value" in (v as Record<string, unknown>)
        ? (v as { value: unknown }).value
        : v;
    }
  }
  return claims;
}

// ── REAL OpenID4VP path (Android Chrome). Open the sealed reader context, decrypt
//    the wallet's JWE response (jose ECDH-ES compactDecrypt), enforce nonce binding,
//    parse the ISO 18013-5 mdoc vp_token, and run the SAME evaluateCredential policy.
//    Faithfully ported from the demo's payment-gate/credential-gate/verify.ts. The
//    issuer/device signature (trust anchor) is the acknowledged future work —
//    trust_level stays presence-only-demo. ──────────────────────────────────────
export async function verifyCredentialPresentation(args: {
  kind: CredentialKind;
  result: { protocol?: string; data?: unknown };
  readerContextToken: string;
  secret: string;
  minimumAge?: number;
  percent?: number;
}): Promise<CredGateResult> {
  const { kind, result, readerContextToken, secret, minimumAge, percent } = args;
  const ctx = await openReaderContext(readerContextToken, secret);

  let data: unknown = result?.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { /* leave as string */ }
  }
  const jwe: string | undefined = (data as { response?: string } | undefined)?.response;
  if (!jwe) throw new Error("no .response (JWE) in result.data");

  // Nonce binding — reject on contradiction, accept on absence. OpenID4VP 1.0
  // makes the apu/apv key-agreement parameters optional (the Multipaz test app
  // sends them empty cross-device; some same-device paths echo the request nonce
  // in apu; pre-1.0 drafts used apv), so their absence proves nothing — but a
  // NON-EMPTY value bound to a DIFFERENT nonce is a response produced for another
  // request, and is refused. Request-binding doesn't rest on this echo: every
  // /request seals a fresh ephemeral decryption key with a short TTL, so a captured
  // response only ever decrypts under the request that produced it.
  if (!ctx.nonce) throw new Error("reader context has no nonce to check");
  const { apu, apv } = jose.decodeProtectedHeader(jwe);
  const nonceForms = [jose.base64url.encode(ctx.nonce), ctx.nonce];
  const echoed = [apu, apv].filter((p): p is string => typeof p === "string" && p.length > 0);
  if (echoed.length > 0 && !echoed.some((p) => nonceForms.includes(p))) {
    throw new Error("nonce mismatch: response is not bound to this request");
  }

  const encPrivKey = await jose.importJWK(ctx.ecdhPrivateJwk, "ECDH-ES");
  const { plaintext } = await jose.compactDecrypt(jwe, encPrivKey);
  const openid4vpResponse = JSON.parse(new TextDecoder().decode(plaintext)) as { vp_token?: unknown };
  const vpToken = openid4vpResponse.vp_token;
  const disclosed = vpToken ? decodeVpToken(vpToken) : [];
  return evaluateCredential(kind, flattenDisclosed(disclosed), { minimumAge, percent });
}

// Shared by mdoc-verify.ts: a decoded DeviceResponse → the evaluateCredential
// policy, flattening the disclosed claims into the common record shape.
export function evaluateDisclosed(kind: CredentialKind, disclosed: DisclosedEntry[], opts: EvaluateOpts = {}): CredGateResult {
  return evaluateCredential(kind, flattenDisclosed(disclosed), opts);
}
