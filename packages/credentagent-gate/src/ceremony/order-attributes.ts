// Preserve a product's non-price ATTRIBUTES across a catalog re-price (#59 finding 3).
//
// Re-pricing reduces each line to `{ productId, quantity }` and rebuilds it from the host's
// `CeremonyCatalog.createOrder` — the price is ALWAYS re-derived server-side, never the token
// (invariant 2). But a custom gate's `appliesTo` keys on product ATTRIBUTES (a prescription gate
// on `requiresRx`, a license gate on `category`, an age gate on `minimumAge`), and a host catalog
// that forwards only price + quantity silently STRIPS them. The manifest ran `appliesTo` against
// the faithful host order and applied the gate; completion would then re-run it against the lossy
// re-price, find the field gone, and skip the gate — completing the order UNPROVEN (a fail-OPEN
// that only a lossy third-party catalog triggers; the in-repo catalogs already forward the field).
//
// The library-level defense: after the catalog re-prices, re-attach any attribute the re-price
// LEFT UNDEFINED from the server-authoritative faithful order line (the stored created order, or
// the order the rail already resolved). Two properties keep this safe:
//   • The catalog stays the PRICE authority — a key the re-price already set (unitPrice,
//     lineTotal, currency, and any attribute a faithful catalog DID forward) is never overridden.
//   • The merge can only ADD gate triggers, never remove one — so it is strictly fail-closed:
//     it cannot be used to suppress a gate, only to restore one a lossy catalog dropped.
// Lines are matched by product id.
import type { CeremonyOrderLine } from "./types.js";

export function preserveLineAttributes(
  repriced: CeremonyOrderLine[],
  faithful: readonly CeremonyOrderLine[],
): CeremonyOrderLine[] {
  const faithfulById = new Map(faithful.map((l) => [l.id, l]));
  return repriced.map((line) => {
    const source = faithfulById.get(line.id);
    if (!source) return line;
    const merged: CeremonyOrderLine = { ...line };
    for (const [key, value] of Object.entries(source)) {
      // Fill only the gaps the re-price left — never override a catalog-set price field.
      if (merged[key] === undefined && value !== undefined) merged[key] = value;
    }
    return merged;
  });
}
