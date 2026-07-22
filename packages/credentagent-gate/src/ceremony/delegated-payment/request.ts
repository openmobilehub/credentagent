// Build the delegated ceremony's request: derive the amount binding + combined DCQL
// from the RE-PRICED order, hand them to the host's external verifier, and seal the
// handle it returns.
//
// The gate is NOT the OpenID4VP verifier on this rail — the external verifier mints
// and signs the wallet request (which is why `readerIdentity` (#51) does not apply
// here: that verifier presents its own reader identity). What the gate keeps is the
// part that must never move: the amount, currency and payee come from
// `buildBindingFields` over the catalog-re-priced order — the SAME derivation the
// dc-payment rail's transaction_data uses, so the two rails cannot drift (invariant 2).
//
// The adapter BINDS to that figure; it never supplies it. At verification the returned
// verdict is re-checked against this same re-derived binding (#87), so an adapter that
// reports a different amount is refused rather than trusted.
import { buildBindingFields } from "../mandate.js";
import type { CeremonyContext } from "../mount.js";
import type { CeremonyOrder } from "../types.js";
import type { Origin } from "../origin.js";
import type { DcqlQuery } from "../../types.js";
import { delegatedPolicyEntries, mergeDelegatedDcql } from "./dcql.js";
import { sealReference } from "./referenceToken.js";

export interface DelegatedRequestResult {
  protocol: "delegated-openid4vp";
  /** The verifier-specific payload the browser forwards (e.g. `{ dcql, transaction_data,
   *  nonce, verifierUrl }`). Opaque to the gate — forwarded, never interpreted. */
  handoff: unknown;
  /** Sealed `{ reference, orderId }` the browser carries back to /verify. */
  referenceToken: string;
  /** The combined query handed to the adapter (echoed for callers/tests). */
  dcql_query: DcqlQuery;
  // Deliberately NO `trust_level` here, unlike the sibling rails. At request time the
  // gate has verified nothing, and on this rail trust is whatever the EXTERNAL verifier
  // reports at /verify — announcing a level up front would be a claim we cannot back
  // (Principle VII). It appears on the verdict, not on the request.
}

/**
 * Build the delegated request for a re-priced order. Throws when no verifier is
 * configured — the caller (routes.ts) only serves this rail when `ctx.verifier` is
 * present, so reaching here without one is a programming error, not a gate decision.
 */
export async function buildDelegatedRequest(
  ctx: CeremonyContext,
  order: CeremonyOrder,
  origin: Origin,
): Promise<DelegatedRequestResult> {
  const verifier = ctx.verifier;
  if (!verifier) throw new Error("[credentagent] delegated rail reached with no `verifier` seam configured");

  // Invariant 2/6: amount + currency + payee re-derived server-side from the
  // catalog-priced order and THIS request's origin — never from the token or the adapter.
  const binding = buildBindingFields(order, origin);
  const dcql = mergeDelegatedDcql(delegatedPolicyEntries(ctx.credentialRegistry, order));

  const { reference, handoff } = await verifier.buildRequest({ order, dcql, binding, origin });

  return {
    protocol: "delegated-openid4vp",
    handoff,
    // Bind the adapter's handle to THIS order before it touches the browser.
    referenceToken: sealReference({ reference, orderId: order.id }, ctx.signingKey),
    dcql_query: dcql,
  };
}
