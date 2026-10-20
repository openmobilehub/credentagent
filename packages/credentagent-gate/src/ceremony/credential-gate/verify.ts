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
import { DEFAULT_LOYALTY_DISCOUNT_PCT, recordedAgeCovers } from "../mandate.js";
import type { CeremonyOrder } from "../types.js";
import type { CeremonyContext } from "../mount.js";
import type { Credential } from "../../types.js";
import { registeredMinAge } from "../../manifest.js";
import type { CredentialKind } from "./dcql.js";
import { openReaderContext } from "../mdoc/readerContext.js";
import { decodeVpToken, type DisclosedEntry } from "../mdoc/mdoc.js";
import { firstDeviceResponse } from "../inspect.js";

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

/** A wallet presentation's result: the policy outcome plus the DeviceResponse it was
 *  decided on (base64url) — the route returns it only when `inspectPresentations` is on. */
export type PresentationResult = CredGateResult & { deviceResponse?: string };

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

/**
 * The age THIS order must prove: the strictest of its lines' `minimumAge` and the age its own
 * policy requires (`age.over(n)` — `CompletionInput.policyMinAge`, #354), or `null` when neither
 * asks for one. The policy age comes from the mounted lookup; when that doesn't know the order,
 * from the registered `age` credential — the same fallback `completeOrder` uses. Every rail
 * evaluates an age proof at this threshold. `completeOrder` does not call this: it re-derives
 * the threshold inline from the same sources and enforces it. They differ in two cases. The
 * first is a malformed age. A line `minimumAge` of NaN, or a policy age that isn't a usable number
 * (NaN, ±Infinity, a `true` or a BigInt from the host's `policyAge` lookup; numeric text such as
 * "25" is read as that number), is dropped here — only that value, the other source still counts.
 * Completion reads the same values its own way: NaN and +Infinity make it refuse the order, a
 * BigInt makes it throw, -Infinity is ignored (as here), and `true` counts as 1, so the policy's
 * own age is lost while an item's tag still applies. `ageStepFor` never ticks Age for NaN,
 * +Infinity, `true` or a BigInt, so a page never shows Age ✓ for an order completion refuses
 * or throws on. The second:
 * a host completion built without `credentialRegistry` has no registered `age` to fall back to, so
 * for an order the server forgot it asks none while this asks the mount's (#411).
 */
export async function requiredAgeFor(
  ctx: Pick<CeremonyContext, "policyAge" | "credentialRegistry" | "orderPolicies">,
  order: CeremonyOrder,
): Promise<number | null> {
  return (await ageDemandFor(ctx, order)).age;
}

/** `requiredAgeFor`'s threshold, plus `malformed`: a value the pages never tick Age for. Payment
 *  refuses the order for NaN or +Infinity (a policy age or a line `minimumAge`) and throws on a
 *  BigInt. It reads a `true` as 1, a `false` as 0, and an object that reads as a number (`[25]`)
 *  as that number, while the page drops such a value. So on a tagged item payment may complete
 *  and the page never ticks; on an untagged one the page shows no Age step while payment still
 *  asks 1 (`true`) or 25 (`[25]`). Only a lookup that breaks `PolicyAgeLookup`'s number type
 *  returns these. -Infinity and numeric text aren't malformed: both sides ignore / convert them. */
async function ageDemandFor(
  ctx: Pick<CeremonyContext, "policyAge" | "credentialRegistry" | "orderPolicies">,
  order: CeremonyOrder,
): Promise<{ age: number | null; malformed: boolean }> {
  const gateOrder = { id: order.id, total: order.total, currency: order.currency, lines: order.lines.map((l) => ({ ...l })) };
  const rawPolicyAge = (await ctx.policyAge?.(order.id)) ?? registeredMinAge(gateOrder, ctx.credentialRegistry, ctx.orderPolicies?.get(order.id));
  // Convert only text, so an untyped store read of "25" asks 25 as completion's `Math.max` does.
  // Anything else that isn't a number (`true`, a BigInt) stays malformed: converting it would ask
  // a made-up age (`true` → 1) or tick one completion throws on.
  const policyAge: unknown = rawPolicyAge == null ? 0 : typeof rawPolicyAge === "string" ? Number(rawPolicyAge) : rawPolicyAge;
  const policyOk = typeof policyAge === "number" && Number.isFinite(policyAge);
  // Drop a malformed policy age alone: `Math.max` with NaN is NaN, which would also drop the
  // lines' own `minimumAge` and hide a tagged item's Age step.
  const age = Math.max(requiredAgeForOrder(order) ?? 0, policyOk ? policyAge : 0);
  // Malformed = NaN or +Infinity, which completion refuses the order for, or a policy age that
  // isn't a number at all. A -Infinity loses completion's `Math.max`, so it is ignored, not
  // refused; so is a line `minimumAge` that isn't a number (completion reads it as 0).
  const bad = (a: number) => Number.isNaN(a) || a === Infinity;
  const malformed =
    (rawPolicyAge != null && (typeof policyAge !== "number" || bad(policyAge))) ||
    order.lines.some((l) => typeof l.minimumAge === "number" && bad(l.minimumAge));
  return { age: age > 0 ? age : null, malformed };
}

/**
 * The rail pages' Age step for THIS order (#414) — the payment, passkey, credential and
 * outside-verifier pages: the age completion will ask (`requiredAgeFor`, 0 = none) and whether
 * the proof on record covers it (`recordedAgeCovers`, completion's own rule). Pass it to
 * `checkoutRail` so the progress rail shows an Age step for an age only the policy asks for, and
 * never ticks a proof made below the order's age. A malformed age (NaN or +Infinity, or a policy
 * age that is neither a number nor numeric text) never ticks; completion refuses NaN and +Infinity
 * whatever the proof.
 *
 * Out of scope here, deliberately: the checkout page itself (`checkout-page.ts`) still ticks Age
 * for any `ageVerified`. It renders from the policy manifest and the exported `RenderVerification`
 * (a bare boolean, no proven age), and its Age status also unlocks the Pay button, so changing it
 * changes a public render API and that page's flow, not just a progress rail. Completion still
 * refuses a too-young proof there. Making that page tick Age only for a proof that
 * covers the order's age is deferred to its own change, after #414.
 */
export async function ageStepFor(
  ctx: Pick<CeremonyContext, "policyAge" | "credentialRegistry" | "orderPolicies">,
  order: CeremonyOrder,
  record: { ageVerified?: boolean; ageVerifiedOver?: number } | null | undefined,
): Promise<{ requiredAge: number; ageVerified: boolean }> {
  const { age, malformed } = await ageDemandFor(ctx, order);
  const requiredAge = age ?? 0;
  return { requiredAge, ageVerified: !malformed && recordedAgeCovers(record, requiredAge, requiredAgeForOrder(order) ?? 0) };
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

/**
 * Evaluate disclosed claims for a CUSTOM credential (007) with that credential's OWN
 * `verify` — the explicit-positive-claim control (invariant 5) is the developer's
 * predicate (e.g. `c.license_active === true`), run SERVER-SIDE here; it never crosses
 * the wire (Principle VI). Same presence-only posture as the built-ins: disclosure +
 * nonce binding are enforced, issuer/device trust is not (trust_level presence-only-demo).
 */
export function evaluateCustom(credential: Credential, claims: Record<string, unknown>): CredGateResult {
  const verified = credential.verify(claims);
  return {
    verified,
    membershipNumber: null,
    gates: [{ gate: credential.ui.label, pass: verified, detail: verified ? "claim verified" : "required claim not disclosed" }],
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
  /** Custom credential (007): when present, its OWN `verify` runs instead of the
   *  built-in age/membership policy — same decrypt/nonce-binding path. */
  credential?: Credential;
}): Promise<PresentationResult> {
  const { kind, result, readerContextToken, secret, minimumAge, percent, credential } = args;
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
  const flat = flattenDisclosed(disclosed);
  const out = credential ? evaluateCustom(credential, flat) : evaluateCredential(kind, flat, { minimumAge, percent });
  const deviceResponse = firstDeviceResponse(vpToken);
  return deviceResponse ? { ...out, deviceResponse } : out;
}

// Shared by mdoc-verify.ts: a decoded DeviceResponse → the evaluateCredential
// policy, flattening the disclosed claims into the common record shape.
export function evaluateDisclosed(kind: CredentialKind, disclosed: DisclosedEntry[], opts: EvaluateOpts = {}): CredGateResult {
  return evaluateCredential(kind, flattenDisclosed(disclosed), opts);
}

// Shared by mdoc-verify.ts (007): a decoded DeviceResponse → a CUSTOM credential's own
// `verify`, flattening the disclosed claims into the same record shape first.
export function evaluateDisclosedCustom(credential: Credential, disclosed: DisclosedEntry[]): CredGateResult {
  return evaluateCustom(credential, flattenDisclosed(disclosed));
}
