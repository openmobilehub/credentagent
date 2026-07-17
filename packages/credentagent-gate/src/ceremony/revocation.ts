// The revocation + committed-draw store behind HNP grants (005 FR-009/FR-010).
// Keyed per intentId — never process-global (invariant 4) — with a per-subject
// kill-switch. Consulted FAIL-CLOSED at the completion seam: a store that errors
// refuses the draw (revocation-unavailable), never allows it.
//
// `commitDraw` is the atomic REVOCATION + single-use/replay + cumulative-cap control, and
// MUST be atomic: it makes all three decisions (grant-not-revoked AND unused pspTransactionId
// AND committed-sum + amount ≤ totalAmount) in one check-and-append. The seam's upfront
// `isRevoked` read is a fast pre-check only — a revoke landing AFTER it (during checkDraw's
// async crypto) is still caught HERE, so a revoked grant can't complete in-flight (no TOCTOU).
// checkDraw's own `over-total` / `replay` gates are likewise a fast pre-check,
// but they read `priorDraws` and commit separately — so two concurrent draws with different
// psp ids can both pass those gates and, without an atomic cap decision here, both commit and
// breach the cumulative cap. Likewise `completeOrder`'s idempotency is keyed by ORDER id, so
// two redemptions minting two order ids would both pass without the atomic per-intent consume.
// The in-memory default is single-instance only (Node's single-threaded event loop makes the
// check-and-append atomic per tick); multi-instance deploys MUST inject a shared CAS-capable
// store (Redis Lua doing both checks), mirroring VerificationStore.
import type { MaybePromise } from "./types.js";
import type { CommittedDraw } from "./mandate.js";

/** The atomic result: committed, or rejected for a specific revocation/single-use/cap reason. */
export type CommitResult = { ok: true } | { ok: false; reason: "revoked" | "consumed" | "over-total" };

export interface RevocationStore {
  /** Is this grant (or its subject, via the kill-switch) revoked? */
  isRevoked(intentId: string, subject?: string): MaybePromise<boolean>;
  revoke(intentId: string): MaybePromise<void>;
  /** Kill-switch: revoke every grant carrying this subject. */
  revokeSubject(subject: string): MaybePromise<void>;
  /** Committed draws for the intent (feeds checkDraw's cumulative + replay pre-checks). */
  priorDraws(intentId: string): MaybePromise<CommittedDraw[]>;
  /** Atomically commit a draw iff (a) the grant (and its `subject`) is NOT revoked, (b) its
   *  pspTransactionId is unused for this intent, AND (c) committed-sum + amount ≤ `totalAmount`.
   *  All three — kill-switch, single-use, cumulative cap — are decided HERE in one
   *  check-and-append, so a revoke or concurrent draw landing after the seam's fast pre-checks
   *  still refuses. `revoked` = grant/subject revoked; `consumed` = duplicate txid;
   *  `over-total` = would breach the cap. */
  commitDraw(intentId: string, draw: CommittedDraw, opts: { totalAmount: number; subject?: string }): MaybePromise<CommitResult>;
}

export class MemoryRevocationStore implements RevocationStore {
  private readonly revoked = new Set<string>();
  private readonly revokedSubjects = new Set<string>();
  private readonly draws = new Map<string, CommittedDraw[]>();

  isRevoked(intentId: string, subject?: string): boolean {
    return this.revoked.has(intentId) || (subject !== undefined && this.revokedSubjects.has(subject));
  }
  revoke(intentId: string): void {
    this.revoked.add(intentId);
  }
  revokeSubject(subject: string): void {
    this.revokedSubjects.add(subject);
  }
  priorDraws(intentId: string): CommittedDraw[] {
    return this.draws.get(intentId) ?? [];
  }
  commitDraw(intentId: string, draw: CommittedDraw, opts: { totalAmount: number; subject?: string }): CommitResult {
    // Revocation is decided in the SAME atomic critical section as single-use + cap, so a
    // revoke that lands after the seam's fast `isRevoked` pre-check still stops the draw.
    if (this.revoked.has(intentId) || (opts.subject !== undefined && this.revokedSubjects.has(opts.subject)))
      return { ok: false, reason: "revoked" };
    const list = this.draws.get(intentId) ?? [];
    if (list.some((d) => d.pspTransactionId === draw.pspTransactionId)) return { ok: false, reason: "consumed" };
    const spent = list.reduce((s, d) => s + d.amount, 0);
    if (spent + draw.amount > opts.totalAmount) return { ok: false, reason: "over-total" };
    list.push(draw);
    this.draws.set(intentId, list);
    return { ok: true };
  }
}
