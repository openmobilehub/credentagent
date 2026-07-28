// The non-delegable re-checks (008, #87). An external verifier brought TRUST (issuer /
// device signature) and DISCLOSURE; this file is where the gate re-asserts what it must
// NEVER outsource — that the amount the wallet signed over is the catalog price, to this
// payee, and that the merchant's OWN policy holds over the disclosed claims — before any
// money moves.
//
// Two properties make this safe rather than trusting `verdict.approved`:
//   1. The binding is re-derived from `buildBindingFields` over the RE-PRICED order — the
//      SAME derivation the dc-payment rail's transaction_data uses, so a delegated payment
//      cannot bind to a different amount/payee than a direct one (invariants 2/3/6).
//   2. The policy is re-run through the EXACT evaluators the credential rail uses
//      (`evaluateCredential` / `evaluateCustom`), writing the SAME per-order verification
//      state, so `completeOrder`'s shared age + custom-gate enforcement is the single
//      definition — the verifier's laxer business rules (18+ where we demand 21+) never
//      substitute for ours (invariants 1/5).
import { buildBindingFields } from "../mandate.js";
import type { CeremonyContext } from "../mount.js";
import type { CeremonyOrder, DelegatedVerdict, GateOutcome } from "../types.js";
import type { Origin } from "../origin.js";
import { evaluateCredential, evaluateCustom, requiredAgeForOrder } from "../credential-gate/verify.js";
import { delegatedPolicyEntries, mergeDelegatedDcql } from "./dcql.js";

/**
 * The two gates the gate itself owns on this rail (the rest of the presentment's trust is
 * the verifier's). Passed to `completeOrder` as `input.gates`, so a failure refuses at the
 * shared seam BEFORE settlement — never trusting `verdict.approved` alone.
 *
 *   • Verifier approved — NECESSARY (the verifier's trust verdict), never sufficient.
 *   • Amount binding — the amount/currency/payee the wallet signed over, re-derived from
 *     the catalog + this RP's origin and compared to what the verifier reports.
 */
export function runDelegatedGates(order: CeremonyOrder, origin: Origin, verdict: DelegatedVerdict): GateOutcome[] {
  const expected = buildBindingFields(order, origin);
  const b = verdict.binding;
  const amountOk = b.amount === expected.amount;
  const currencyOk = b.currency === expected.currency;
  // Payee re-derived from THIS request's origin (invariant 6): an attacker re-pointing the
  // ceremony at their own payee fails here, not at the adapter's word.
  const payeeOk = !!b.payee?.id && b.payee.id === expected.payee.id;
  return [
    {
      gate: "Verifier approved",
      pass: verdict.approved === true,
      detail: verdict.approved ? `approved · trust_level=${verdict.trust_level}` : `refused${verdict.reason ? ` — ${verdict.reason}` : ""}`,
    },
    {
      gate: "Amount binding",
      pass: amountOk && currencyOk && payeeOk,
      detail: `amount ${amountOk ? "✓" : "✗"} (${b.amount} vs ${expected.amount}) · currency ${currencyOk ? "✓" : "✗"} (${b.currency} vs ${expected.currency}) · payee ${payeeOk ? "✓" : "✗"} (${b.payee?.id ?? "∅"} vs ${expected.payee.id})`,
    },
  ];
}

/** Flatten the verdict's disclosed claims for ONE policy credential — union of every merged
 *  DCQL id that maps back to it (an age proof may arrive under `age_mdl` OR `age_eupid`). */
function claimsForCredential(policyId: string, idMap: Map<string, string>, verdictClaims: DelegatedVerdict["claims"]): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [mergedId, pid] of idMap) {
    if (pid === policyId) Object.assign(flat, verdictClaims[mergedId] ?? {});
  }
  return flat;
}

async function markAgeVerified(ctx: CeremonyContext, orderId: string): Promise<void> {
  const prev = (await ctx.verificationStore.read(orderId)) ?? {};
  await ctx.verificationStore.write(orderId, { ...prev, ageVerified: true });
}

async function markGateVerified(ctx: CeremonyContext, orderId: string, credId: string): Promise<void> {
  const prev = (await ctx.verificationStore.read(orderId)) ?? {};
  const verifiedGates = { ...(prev as { verifiedGates?: Record<string, true> }).verifiedGates, [credId]: true as const };
  await ctx.verificationStore.write(orderId, { ...prev, verifiedGates });
}

/**
 * Re-run THIS merchant's policy over the verdict's disclosed claims and write the per-order
 * verification state `completeOrder` enforces. Only `gate()` credentials (age, custom) are
 * evaluated here — a `payment` (`authorize`) credential is proven by the binding gate +
 * settlement, and `discount` credentials are never demanded in a delegated ceremony.
 *
 * On a passing claim we write the SAME field the credential rail writes (`ageVerified` /
 * `verifiedGates[id]`); on a failing/absent one we write NOTHING, so `completeOrder`'s shared
 * sweep refuses (reason `age` / `gate`). We never trust the verifier's own age/business check.
 */
export async function applyDelegatedPolicy(ctx: CeremonyContext, order: CeremonyOrder, verdict: DelegatedVerdict): Promise<void> {
  const entries = delegatedPolicyEntries(ctx.credentialRegistry, order);
  const { idMap } = mergeDelegatedDcql(entries);
  for (const { credentialId } of entries) {
    const cred = ctx.credentialRegistry?.get(credentialId);
    if (!cred || cred.effect.kind !== "gate") continue; // authorize → binding gate; discount → excluded
    const claims = claimsForCredential(credentialId, idMap, verdict.claims);
    const result =
      credentialId === "age"
        ? evaluateCredential("age", claims, { minimumAge: requiredAgeForOrder(order) ?? 21 })
        : evaluateCustom(cred, claims);
    if (!result.verified) continue; // leave state unwritten → completeOrder refuses
    if (credentialId === "age") await markAgeVerified(ctx, order.id);
    else await markGateVerified(ctx, order.id, credentialId);
  }
}

/** True iff the order's policy authorizes a payment (⇒ settlement is required). */
export function policyHasPayment(ctx: CeremonyContext, order: CeremonyOrder): boolean {
  return delegatedPolicyEntries(ctx.credentialRegistry, order).some(
    (e) => ctx.credentialRegistry?.get(e.credentialId)?.effect.kind === "authorize",
  );
}

/** Extract a display instrument from the disclosed payment claims (receipt only; the
 *  external verifier already verified the DPC — the gate does not re-check these). */
export function instrumentFromVerdict(verdict: DelegatedVerdict): Record<string, unknown> | undefined {
  const p = verdict.claims["payment"];
  if (!p) return undefined;
  const pick = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  return { issuer: pick("issuer_name"), holder: pick("holder_name"), maskedAccount: pick("masked_account_reference") };
}
