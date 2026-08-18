// What a grant's bounds actually cover, age-wise (issue #172) — the fact the approve page
// needs BEFORE the human taps Approve.
//
// Today a human can approve a grant that is unable to buy anything: "$300 total, $150 per
// purchase, Beverages only" over a catalog whose Beverages are all 21+ is a grant that can
// spend $0.00, because age-restricted goods refuse `step-up` on every delegated purchase.
// Nothing on the approve page said so.
//
// The agent is NEVER asked (it must not be the one saying "no age needed here"). The server
// works it out from the grant's OWN `allow` bounds against the catalog it already holds:
//
//   allow.skus       → look up each named product, take the highest minAge
//   allow.categories → scan the products in those categories, take the highest minAge
//   no bounds        → scan the whole catalog
//
// HONEST LIMIT: for a category grant this is a FORECAST made at approval time — a 21+ product
// added to Beverages next week could not have been predicted. That is fine: this module is
// DISCLOSURE, never enforcement. The server-side refusal (completion.ts's delegated branch,
// re-derived from the catalog-priced lines at spend time) stays exactly as it is. The gate
// remains the control, not the screen.

import { priceOf, minAgeOf, nameOf, categoryOf, type CatalogEntry } from "./delegated.js";
import type { GrantAllow } from "./grants.js";

/** One age-restricted product inside a grant's bounds — what the approve page names. */
export interface AgeRestrictedItem {
  sku: string;
  /** The catalog's display name, when it carries one (falls back to the sku id). */
  name?: string;
  price: number;
  minAge: number;
}

/** The age fact a grant's bounds imply, derived server-side from the catalog. */
export interface GrantAgeScope {
  /** The strictest `minAge` among the products the bounds cover; `null` when none is restricted. */
  minimumAge: number | null;
  /** Those products, cheapest-name-first as the catalog orders them — the disclosure list. */
  items: AgeRestrictedItem[];
}

/**
 * Is `sku` inside the grant's `allow` bounds? Fail-closed: with bounds set, an unknown or
 * uncategorized item does NOT pass. No bounds (absent, or neither list present) ⇒ everything
 * in the catalog is allowed.
 *
 * This is the ONE definition — `Grants.allowed()` (the spend-time enforcement) and
 * {@link ageScopeFor} (the approve-time disclosure) both call it, so the page can never
 * disclose a scope different from the one the gate enforces.
 */
export function skuAllowed(allow: GrantAllow | undefined, sku: string, catalog: Record<string, CatalogEntry>): boolean {
  if (!allow || (!allow.skus && !allow.categories)) return true;
  if (allow.skus?.includes(sku)) return true;
  if (allow.categories) {
    const category = categoryOf(catalog[sku]);
    if (category && allow.categories.includes(category)) return true;
  }
  return false;
}

/**
 * Derive the age scope a grant's bounds imply — the six lines issue #172 asks for, over data
 * the gate already holds. Pure: no I/O, no agent input, no new field on the wire.
 */
export function ageScopeFor(allow: GrantAllow | undefined, catalog: Record<string, CatalogEntry> | undefined): GrantAgeScope {
  const entries = Object.entries(catalog ?? {});
  const items: AgeRestrictedItem[] = [];
  for (const [sku, entry] of entries) {
    if (!skuAllowed(allow, sku, catalog ?? {})) continue;
    const minAge = minAgeOf(entry);
    // Only a positive threshold restricts: a 0/absent minAge is an unrestricted product.
    if (typeof minAge !== "number" || !(minAge > 0)) continue;
    const name = nameOf(entry);
    items.push({ sku, ...(name ? { name } : {}), price: priceOf(entry), minAge });
  }
  return { minimumAge: items.length ? Math.max(...items.map((i) => i.minAge)) : null, items };
}
