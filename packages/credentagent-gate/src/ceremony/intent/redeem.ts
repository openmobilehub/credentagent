// The agent-facing operations of the intent rail (005), human NOT present: redeem a
// signed draw and revoke a grant. Framework-agnostic core; `routes.ts` is the thin
// HTTP wrapper.
//
// SECURITY: redeem NEVER completes a draw itself — it runs it through the SHARED
// completion seam (`ctx.completion`), the one choke point every rail records through
// (invariant 1). The completion's draw branch is the authority: it re-verifies
// signature/bounds, re-checks revocation (fail-closed, TOCTOU-safe), does the atomic
// single-use consume, and suppresses settlement. This handler adds only the running
// balance and maps to a typed result.
import type { CompletionSeam, CeremonyOrder } from "../types.js";
import type { IntentBounds, Draw } from "../mandate.js";
import type { RevocationStore } from "../revocation.js";
import type { RefusalCode, RefusalRetryable } from "../refusals.js";

/** The seams redeem needs — a slice of CeremonyContext, so it unit-tests cleanly.
 *  `completion` and `revocation` MUST share the same revocation store (the mount
 *  contract) or the single-use consume and the `remaining` reading disagree. */
export interface RedeemContext {
  completion: CompletionSeam;
  revocation: RevocationStore;
}

/** Mirrors `DelegatedGate`'s SpendResult (DX consistency) — the same shape the
 *  in-process facade returns, so agent and host see one mental model. */
export interface RedeemResult {
  ok: boolean;
  amount: number;
  remaining: number;
  reason?: RefusalCode;
  retryable?: RefusalRetryable;
  delegationId?: string;
}

/** Redeem a delegate-signed draw against its grant, presenting the re-priced order.
 *  Never throws for a gate decision — returns a typed RedeemResult. */
export async function redeemDraw(
  input: { intent: IntentBounds; order: CeremonyOrder; draw: Draw },
  ctx: RedeemContext,
): Promise<RedeemResult> {
  const { intent, order, draw } = input;

  const res = await ctx.completion({
    order,
    mandateId: draw.pspTransactionId,
    amount: draw.amount,
    currency: draw.currency,
    method: "delegated",
    gates: [],
    draw: { intent, draw },
  });

  const remaining = await headroom(intent, ctx);
  if (res.completed) return { ok: true, amount: draw.amount, remaining, delegationId: res.delegationId };
  const first = res.refusals?.[0];
  return { ok: false, amount: draw.amount, remaining, reason: first?.code, retryable: first?.retryable };
}

/** Cumulative headroom left on the grant (total − committed draws). Defaults to the
 *  full cap if the ledger is unreadable — the refusal already carries any failure. */
async function headroom(intent: IntentBounds, ctx: RedeemContext): Promise<number> {
  try {
    const committed = await ctx.revocation.priorDraws(intent.intentId);
    return intent.totalAmount - committed.reduce((sum, d) => sum + d.amount, 0);
  } catch {
    return intent.totalAmount;
  }
}

/** Revoke one grant — the very next redeem dies (fail-closed). */
export async function revokeGrant(intentId: string, ctx: RedeemContext): Promise<void> {
  await ctx.revocation.revoke(intentId);
}

/** Revoke every grant carrying a subject (the kill-switch). */
export async function revokeSubject(subject: string, ctx: RedeemContext): Promise<void> {
  await ctx.revocation.revokeSubject(subject);
}

// NOTE (flagged for the reviewed build): an "active grants" listing (FR-010 audit
// surface) is NOT implementable over the current RevocationStore — it tracks revoked
// ids + committed draws, not the set of minted grants. It needs a store extension
// (record each mint) or a separate grants store. Deliberately omitted here.
