// The revocation + committed-draw store behind HNP grants (005 FR-009/FR-010).
// Keyed per intentId — never process-global (invariant 4) — with a per-subject
// kill-switch. Consulted FAIL-CLOSED at the completion seam: a store that errors
// refuses the draw (revocation-unavailable), never allows it.
//
// `commitDraw` is the single-use / replay control and MUST be atomic
// (check-and-append): `completeOrder`'s idempotency is keyed by ORDER id, so two
// concurrent redemptions producing two order ids would otherwise both pass. The
// in-memory default is single-instance only (Node's single-threaded event loop
// makes the check-and-append atomic per tick); multi-instance deploys MUST inject
// a shared CAS-capable store (Redis SETNX/Lua), mirroring VerificationStore.
import type { MaybePromise } from "./types.js";
import type { CommittedDraw } from "./mandate.js";

export interface RevocationStore {
  /** Is this grant (or its subject, via the kill-switch) revoked? */
  isRevoked(intentId: string, subject?: string): MaybePromise<boolean>;
  revoke(intentId: string): MaybePromise<void>;
  /** Kill-switch: revoke every grant carrying this subject. */
  revokeSubject(subject: string): MaybePromise<void>;
  /** Committed draws for the intent (feeds checkDraw's cumulative + replay gates). */
  priorDraws(intentId: string): MaybePromise<CommittedDraw[]>;
  /** Atomically commit a draw iff its pspTransactionId is unused for this intent.
   *  Returns false (commits nothing) on a duplicate — exactly one of N concurrent
   *  draws with one pspTransactionId may win. */
  commitDraw(intentId: string, draw: CommittedDraw): MaybePromise<boolean>;
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
  commitDraw(intentId: string, draw: CommittedDraw): boolean {
    const list = this.draws.get(intentId) ?? [];
    if (list.some((d) => d.pspTransactionId === draw.pspTransactionId)) return false;
    list.push(draw);
    this.draws.set(intentId, list);
    return true;
  }
}
