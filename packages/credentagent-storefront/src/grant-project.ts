// projectGrantView — the ONE choke point that builds a GrantViewData (spec 011 FR-1, A2).
//
// Server-side only (it imports the gate's `grantLifecycle` value + reads a live Grant handle).
// It runs the engine money read (`grant.usage()`) and the gate's lifecycle rule so neither is
// re-derived in the widget, normalizes `allow`, and resolves the SKU-bound product from the LIVE
// catalog — the same catalog the spend path re-prices against (invariant 2).

import { grantLifecycle } from "@openmobilehub/credentagent-gate";
import type { Grant } from "@openmobilehub/credentagent-gate";
import type { Product } from "./index.js";
import { GRANT_VIEW_KIND, type GrantViewData, type GrantViewProduct } from "./grant-view.js";

/** Build the inert {@link GrantViewData} projection from a live grant handle + the live catalog. */
export async function projectGrantView(grant: Grant, opts: { catalog: Product[] }): Promise<GrantViewData> {
  const { budget, spent, remaining } = await grant.usage();
  const skus = grant.allow?.skus ?? [];
  const categories = grant.allow?.categories ?? [];
  // A single-SKU grant is the flagship (spec §1): resolve the one product so the card shows the
  // real name/price/image. More than one sku ⇒ the category card renders chips, no single product.
  const product = skus.length === 1 ? resolveProduct(skus[0], opts.catalog) : undefined;
  return {
    kind: GRANT_VIEW_KIND,
    id: grant.id,
    merchant: grant.merchant,
    status: grant.status,
    lifecycle: grantLifecycle({ status: grant.status, budget, remaining }),
    budget,
    spent,
    remaining,
    perSpend: grant.perSpend,
    allow: { skus, categories },
    ...(grant.description ? { description: grant.description } : {}),
    approveUrl: grant.approveUrl,
    presence: grant.presence,
    trustLevel: grant.trustLevel,
    ...(product ? { product } : {}),
  };
}

function resolveProduct(id: string, catalog: Product[]): GrantViewProduct | undefined {
  const p = catalog.find((c) => c.id === id);
  if (!p) return undefined;
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    currency: p.currency,
    category: p.category,
    ...(p.image ? { image: p.image } : {}),
  };
}
