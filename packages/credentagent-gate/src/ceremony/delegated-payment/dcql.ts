// Derive ONE combined DCQL query from the policy, for a single delegated round-trip.
//
// The delegated rail asks for every applicable credential at once (the reference
// ceremony requests identity AND payment together), so the per-credential DCQL each
// builder carries has to be merged. Two things the merge must get right:
//
//  1. `credential_sets` become MANDATORY once merged. Without them, DCQL requires
//     EVERY entry in `credentials` (AND — see types.ts), so naively concatenating
//     age's [mdl, eupid] with payment's entry would demand the wallet hold an mDL AND
//     an EU-PID AND the payment card — which no wallet can satisfy. Each source query
//     therefore contributes its own alternatives as one set: a query that already
//     declares `credential_sets` keeps them; one that doesn't gets a set requiring
//     exactly its own ids (preserving AND-within-one-credential).
//
//  2. ids must be UNIQUE across the merged query. `dcql()` derives its id from the
//     doctype's LAST SEGMENT, so `payment` (org.openwallet.payment.1) and
//     `membership` (org.multipaz.loyalty.1) both yield "1" (#90). Colliding ids make
//     the merged query ambiguous and silently corrupt the `credential_sets`
//     references, so every entry is re-id'd here under its POLICY credential id,
//     which is unique by construction (the registry is keyed by it). This is a
//     merge-layer fix: it does not change what `dcql()` emits for the single-credential
//     rails (#90 tracks the underlying weakness).
import type { Credential, DcqlCredentialOption, DcqlCredentialSet, DcqlQuery, GateOrder } from "../../types.js";
import type { CeremonyOrder } from "../types.js";

/** One policy credential's contribution to the combined query. */
export interface DelegatedDcqlEntry {
  /** The POLICY credential id (`age` / `payment` / a custom id) — unique per registry. */
  credentialId: string;
  query: DcqlQuery;
}

/**
 * Merge per-credential DCQL into one query, namespacing ids and preserving each
 * source query's alternatives as its own `credential_sets` entry.
 */
export function mergeDelegatedDcql(entries: DelegatedDcqlEntry[]): DcqlQuery {
  const credentials: DcqlCredentialOption[] = [];
  const credential_sets: DcqlCredentialSet[] = [];

  for (const { credentialId, query } of entries) {
    // A single-credential query takes the policy id verbatim (`payment`), which reads
    // like the reference ceremony's ids; a multi-credential one keeps its own leaf to
    // stay distinguishable (`age_mdl`, `age_eupid`).
    const single = query.credentials.length === 1;
    const renamed = new Map<string, string>();
    for (const c of query.credentials) {
      const id = single ? credentialId : `${credentialId}_${c.id}`;
      renamed.set(c.id, id);
      credentials.push({ ...c, id });
    }
    const remap = (ids: string[]): string[] => ids.map((id) => renamed.get(id) ?? id);

    if (query.credential_sets?.length) {
      for (const set of query.credential_sets) credential_sets.push({ ...set, options: set.options.map(remap) });
    } else {
      // No declared alternatives ⇒ this credential's entries are all required
      // together. Say so explicitly, so merging neither widens nor narrows it.
      credential_sets.push({ options: [[...renamed.values()]] });
    }
  }

  return { credentials, credential_sets };
}

/**
 * The credentials this order must present in the delegated ceremony: every registered
 * policy credential that BLOCKS completion (`gate()` — age and custom gates — or
 * `authorize()` — payment) and whose `appliesTo` holds for the RE-PRICED order
 * (invariant 2: applicability is re-derived from catalog-priced lines, never a token).
 *
 * `discount()` credentials are excluded: a discount is opted into, not demanded, so
 * folding one into the required set would turn a benefit into a blocking requirement.
 */
export function delegatedPolicyEntries(
  registry: ReadonlyMap<string, Credential> | undefined,
  order: CeremonyOrder,
): DelegatedDcqlEntry[] {
  if (!registry) return [];
  const gateOrder: GateOrder = {
    id: order.id,
    total: order.total,
    currency: order.currency,
    lines: order.lines.map((l) => ({ ...l })),
  };
  const entries: DelegatedDcqlEntry[] = [];
  for (const cred of registry.values()) {
    if (cred.effect.kind !== "gate" && cred.effect.kind !== "authorize") continue;
    if (cred.appliesTo && !cred.appliesTo(gateOrder)) continue;
    entries.push({ credentialId: cred.id, query: cred.request });
  }
  // Payment settles last, mirroring the manifest resolver's ordering (Principle IV) so
  // the presented order matches what the buyer was told in `requires`.
  return [
    ...entries.filter((e) => registry.get(e.credentialId)!.effect.kind !== "authorize"),
    ...entries.filter((e) => registry.get(e.credentialId)!.effect.kind === "authorize"),
  ];
}
