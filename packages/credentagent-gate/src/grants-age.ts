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
// IT DOES NOT GUESS. The storefront now pins a grant to the exact product the human named before
// the link is even created (#175 — MCP's multi round-trip pattern), so `allow.skus` is the real
// answer and there is nothing to infer. A grant that names no product gets no age step: a page
// that forecast "your category MIGHT contain something 21+" would be warning about an item nobody
// has chosen, and would be wrong the moment the catalog changed. Silence is the honest answer,
// and the server-side refusal at spend time is unaffected either way.

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

/** The age fact a grant's named products imply, derived server-side from the catalog. */
export interface GrantAgeScope {
  /** The strictest `minAge` among the products the grant names; `null` when none is restricted. */
  minimumAge: number | null;
  /** Those products, in the order the grant names them — the disclosure list. */
  items: AgeRestrictedItem[];
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
 * The age-restricted products this grant NAMES, looked up in the catalog. Pure: no I/O, no agent
 * input, no new field on the wire.
 *
 * Only `allow.skus` is read. A grant bounded by category alone — or by nothing — names no product,
 * so it reports `{ minimumAge: null, items: [] }` rather than guessing what might be in scope.
 */
export function ageScopeFor(allow: GrantAllow | undefined, catalog: Record<string, CatalogEntry> | undefined): GrantAgeScope {
  const items: AgeRestrictedItem[] = [];
  for (const sku of allow?.skus ?? []) {
    const entry = catalog?.[sku];
    if (entry === undefined) continue; // a sku this catalog doesn't price says nothing about age
    const minAge = minAgeOf(entry);
    // Only a positive threshold restricts: a 0/absent minAge is an unrestricted product.
    if (typeof minAge !== "number" || !(minAge > 0)) continue;
    const name = nameOf(entry);
    items.push({ sku, ...(name ? { name } : {}), price: priceOf(entry), minAge });
  }
  return { minimumAge: items.length ? Math.max(...items.map((i) => i.minAge)) : null, items };
}
