// Map a wallet's disclosed mdoc claims to a verified boolean for the age /
// membership gate, and re-derive an order's age restriction from its catalog-priced
// lines.
//
// TRUST IS PRESENCE-ONLY (Principle VII / FR-011). This is the WORKING mechanism
// adapted from the demo's instant-demo path: the disclosed claims are taken at face
// value — the mdoc's issuer / device signatures are NOT cryptographically verified
// (that hardening is system-wide future work, shared with dc-payment). What IS
// enforced here is the explicit-positive-claim control (Security invariant 5):
//   • age      — requires the positive over-age claim AT THE ORDER'S THRESHOLD
//                (age_over_21 === true for a 21+ gate; an age_over_18 proof is
//                refused). Verification reuses the package's own age.over(N) builder
//                so the threshold check has one definition.
//   • membership — requires a real, non-empty membership id. A bare token or an
//                unrelated claim must NOT grant the discount (it lowers the bound
//                amount, so a forged loyalty state would reduce the charge).
//
// The OpenID4VP signed-request / JWE-encrypted-presentation path (request.ts) is
// scaffolded alongside and PR-in-flight; that path would feed its decoded claims
// into this same `evaluateCredential`.
import { age, membership } from "../../credentials.js";
import { DEFAULT_LOYALTY_DISCOUNT_PCT } from "../mandate.js";
import type { CeremonyOrder } from "../types.js";
import type { CredentialKind } from "./dcql.js";

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
  const membershipNumber = verified ? String(claims.membership_id) : null;
  return {
    verified,
    membershipNumber,
    gates: [{ gate: "Membership", pass: verified, detail: verified ? `member ${membershipNumber}` : "no membership id disclosed" }],
    trust_level: "presence-only-demo",
  };
}
