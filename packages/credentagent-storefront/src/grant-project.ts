// projectGrantView — a live grant as the card's data, with the one thing only the storefront knows:
// the product of a single-SKU grant, resolved from the LIVE catalog (the same catalog the spend path
// re-prices against, invariant 2). Everything else is the gate's `grantView`, which any MCP server
// can call; this file is just the catalog lookup around it.

import { grantView } from "@openmobilehub/credentagent-gate";
import type { Grant } from "@openmobilehub/credentagent-gate";
import type { Product } from "./index.js";
import type { GrantViewData, GrantViewProduct } from "@openmobilehub/credentagent-gate/cards";

/** Build the inert {@link GrantViewData} from a live grant handle + the live catalog. */
export async function projectGrantView(grant: Grant, opts: { catalog: Product[] }): Promise<GrantViewData> {
  const skus = grant.allow?.skus ?? [];
  // A single-SKU grant is the flagship (spec §1): resolve the one product so the card shows the
  // real name/price/image. More than one sku ⇒ the category card renders chips, no single product.
  const product = skus.length === 1 ? resolveProduct(skus[0], opts.catalog) : undefined;
  return grantView(grant, { product });
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
