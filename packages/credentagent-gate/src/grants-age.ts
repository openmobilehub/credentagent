// The age-restricted products a grant's bounds NAME (issue #172) — the fact the approve/signing
// page needs before the human authorizes anything.
//
// A human could authorize a grant that was unable to buy the thing it was for: "$300, Beverages"
// over a catalog whose Beverages are all 21+ is a grant that can spend $0.00, because
// age-restricted goods refuse on every delegated purchase. Nothing on the page said so.
//
// THE AGENT IS NEVER ASKED. The server reads the grant's own sealed `allow.skus` against the
// catalog it already holds, and takes the highest `minAge` among those products.
//
// TWO WAYS TO ANSWER, AND THE PAGE SAYS WHICH.
//   • NAMED — the grant pins exact products (`allow.skus`). The storefront now resolves the human's
//     words to one product before the link exists (#175), so this is the common case and the
//     answer is exact: these products, this threshold.
//   • SCANNED — the grant allows a CATEGORY, or the whole store. Then the answer is a forecast
//     over what the catalog holds *right now*: a 21+ item added to Beverages next week could not
//     have been predicted. `from: "scanned"` carries that so the page can say so plainly instead
//     of implying a closed list.
//
// A FORECAST IS SAFE, and this is why it is worth making. The proof the human presents is sealed
// with the threshold they proved, and every purchase re-derives its OWN threshold from the priced
// line and refuses unless the proof covers it. So an incomplete scan can only fail to OFFER the
// step (the agent gets refused, exactly as it does today) — it can never grant more than what was
// proved. Under-offering is the failure mode; over-granting is not reachable.

import { priceOf, minAgeOf, nameOf, type CatalogEntry } from "./delegated.js";
import type { GrantAllow } from "./grants.js";

/** One age-restricted product a grant names — what the page calls out by name. */
export interface AgeRestrictedItem {
  sku: string;
  /** The catalog's display name, when it carries one (falls back to the sku id). */
  name?: string;
  price: number;
  minAge: number;
}

/** The age fact a grant's bounds imply, derived server-side from the catalog. */
export interface GrantAgeScope {
  /** The strictest `minAge` among the products in scope; `null` when none is restricted. */
  minimumAge: number | null;
  /** Those products — the disclosure list. */
  items: AgeRestrictedItem[];
  /** Where the list came from. `"named"` ⇒ the grant pins these exact products, so the list is
   *  closed. `"scanned"` ⇒ it was found by looking at what the allowed categories (or the whole
   *  store) hold right now, so it is a forecast and the page must not imply otherwise. */
  from: "named" | "scanned";
}

/**
 * Is `sku` inside the grant's `allow` bounds? Fail-closed: with bounds set, an unknown or
 * uncategorized item does NOT pass. No bounds (absent, or neither list present) ⇒ everything in
 * the catalog is allowed. This is the SPEND-TIME enforcement predicate `Grants.allowed()` runs.
 */
export function skuAllowed(allow: GrantAllow | undefined, sku: string, catalog: Record<string, CatalogEntry>): boolean {
  if (!allow || (!allow.skus && !allow.categories)) return true;
  if (allow.skus?.includes(sku)) return true;
  if (allow.categories) {
    const entry = catalog[sku];
    const category = typeof entry === "object" ? entry.category : undefined;
    if (category && allow.categories.includes(category)) return true;
  }
  return false;
}

/**
 * The age-restricted products a grant's bounds cover. Pure: no I/O, no agent input, no new field
 * on the wire.
 *
 * A grant that NAMES products reads only those — an exact, closed list. A grant bounded by
 * category (or unbounded) is scanned against the catalog, and the result is marked
 * `from: "scanned"` so the page can present it as what the shelf holds today rather than a
 * promise. Either way the spend-time refusal is unchanged; this is disclosure.
 */
export function ageScopeFor(allow: GrantAllow | undefined, catalog: Record<string, CatalogEntry> | undefined): GrantAgeScope {
  const named = allow?.skus ?? [];
  // Named products are read in the order the grant lists them; a scan walks the catalog and keeps
  // only what the bounds actually allow, so the disclosure can never list something the grant
  // couldn't buy anyway (it reuses the SPEND-TIME predicate, so the two cannot disagree).
  const skus = named.length ? named : Object.keys(catalog ?? {}).filter((sku) => skuAllowed(allow, sku, catalog ?? {}));

  const items: AgeRestrictedItem[] = [];
  for (const sku of skus) {
    const entry = catalog?.[sku];
    if (entry === undefined) continue; // a sku this catalog doesn't price says nothing about age
    const minAge = minAgeOf(entry);
    // Only a positive threshold restricts: a 0/absent minAge is an unrestricted product.
    if (typeof minAge !== "number" || !(minAge > 0)) continue;
    const name = nameOf(entry);
    items.push({ sku, ...(name ? { name } : {}), price: priceOf(entry), minAge });
  }
  return {
    minimumAge: items.length ? Math.max(...items.map((i) => i.minAge)) : null,
    items,
    from: named.length ? "named" : "scanned",
  };
}
