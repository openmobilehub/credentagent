// The order proof receipt: what the gate proved for an order, kept WITH the order (per order
// id, never process-global — invariant 4) so it survives completion and can be shown afterwards
// (spec docs/superpowers/specs/2026-09-27-order-proof-receipt-design.md). Each entry states its
// OWN trust_level; nothing here upgrades trust.
//
// A receipt never holds the wallet's raw answer (#320), even with inspectPresentations on: the
// order's records are read by order id alone (the status routes, get-order-status, the paid page,
// and whoever completes the payment). That answer goes only to the browser that presented it,
// in its own verify response.
import type { TrustLevel } from "../types.js";

/** How a proof was made — "instant-demo" means no wallet was involved. */
export type ProofRail = "credential" | "dc-payment" | "passkey" | "instant-demo";

export interface ProofEntry {
  /** Buyer-facing label, e.g. "Age 21+", "Membership", "Pay (USD)". One entry per gate. */
  gate: string;
  rail: ProofRail;
  trust_level: TrustLevel;
  /** What the gate checked, as the rail reported it. */
  checks: { gate: string; pass: boolean; detail: string }[];
  presentedAt: string;
}

/** Add `entry`, replacing an earlier proof of the SAME gate (re-proving never piles up). */
export function upsertProof(proofs: readonly ProofEntry[] | undefined, entry: ProofEntry): ProofEntry[] {
  return [...(proofs ?? []).filter((p) => p.gate !== entry.gate), entry];
}

/** The proofs without credential bytes. The type already has no `presentation`; this drops one an
 *  untyped caller attached, or one stored before #320, at each door a stored proof leaves by. */
export function withoutPresentations(proofs: readonly ProofEntry[]): ProofEntry[];
export function withoutPresentations(proofs: readonly ProofEntry[] | undefined): ProofEntry[] | undefined;
export function withoutPresentations(proofs: readonly ProofEntry[] | undefined): ProofEntry[] | undefined {
  return proofs?.map((p) => {
    const { presentation: _bytes, ...receipt } = p as ProofEntry & { presentation?: unknown };
    return receipt;
  });
}
