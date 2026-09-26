// @openmobilehub/credentagent-storefront — the agentic storefront core (v0.1 slice).
//
// The cart → priced-cart → order model an MCP shopping app needs, **catalog-injected**
// (bring your own products). Own-the-code: fork it and edit your catalog. This slice
// is the pure pricing/order model; the MCP tools + widget bundle that render it are
// tracked in the roadmap.

import { PRODUCT_IMAGES } from "./generated-images.js";

/** Default loyalty discount, in percent. Override per-call via PriceOpts. */
export const LOYALTY_DISCOUNT_PCT = 10;

/** `_meta` keys the storefront tools use to embed the catalog / cart for the widget to read. */
export const CATALOG_META_KEY = "product-picker/catalog";
export const CART_META_KEY = "product-picker/cart";
/** `_meta` key for the signed cart a session-less (MCP 2026-07-28) client carries — see cart-token.ts. */
export const CART_TOKEN_META_KEY = "product-picker/cart-token";

/** A product review, surfaced by `get-product-reviews`. */
export interface Review {
  author: string;
  rating: number;
  text: string;
}

/** One choice a product needs pinned down (size, colour, …) before it is a specific purchase. */
export interface ProductVariant {
  /** The answer's field name, e.g. `"size"`. Unique per product. */
  name: string;
  /** How to ask for it, e.g. `"Which size?"`. Defaults to `Which <name>?`. */
  label?: string;
  /** The acceptable values — a closed set, so the human picks instead of free-typing. */
  options: string[];
}

export interface Product {
  id: string;
  name: string;
  price: number;
  currency: string;
  image: string;
  category: string;
  description: string;
  /** Minimum age to purchase (e.g. 21). Absent = no age restriction. */
  minimumAge?: number;
  /** Requires a prescription to purchase — a custom `appliesTo` flag (e.g. the prescription gate). */
  requiresRx?: boolean;
  /**
   * Choices the buyer must make before this product is fully specified — size, colour, finish.
   * A grant for "sneakers" is not yet a grant for a PARTICULAR pair, so the tools that create one
   * ask for each missing choice (over MCP's multi round-trip pattern) and put the answers in the
   * sentence the human approves. Absent = nothing to choose.
   */
  variants?: ProductVariant[];
  /** Any additional catalog attribute a custom `defineCredential` `appliesTo` keys on
   *  (e.g. `region`, `licenseTier`). Forwarded verbatim onto the priced line by `priceCart`,
   *  so a custom gate can key on ANY product field — not just the ones we predefine. */
  [attribute: string]: unknown;
}

export interface CartItemInput {
  productId: string;
  quantity: number;
}

export interface PricedCartLine {
  id: string;
  name: string;
  unitPrice: number;
  currency: string;
  quantity: number;
  lineTotal: number;
  /**
   * Per-product age threshold (e.g. 21), re-derived from the catalog onto the
   * line. Lets a priced `Order` feed `@openmobilehub/credentagent-gate`'s
   * `requirements()` directly — no `toGateOrder` mapping needed.
   */
  minimumAge?: number;
  /** Product category, carried through for custom `.when()` / `appliesTo` predicates. */
  category?: string;
  /** Prescription flag, re-derived onto the line so a custom `appliesTo` (e.g. the prescription
   *  gate) sees the SAME field at manifest time and at the completion sweep — else it fails open. */
  requiresRx?: boolean;
  /** Any custom catalog attribute forwarded from the product (see `Product`), so a custom
   *  gate's `appliesTo` can key on ANY product field, consistently at manifest + completion. */
  [attribute: string]: unknown;
}

export interface PricedCart {
  lines: PricedCartLine[];
  itemCount: number;
  subtotal: number;
  discount: number;
  total: number;
  currency: string;
  unknownIds: string[];
  hasAgeRestricted: boolean;
  ageVerified: boolean;
  loyaltyApplied: boolean;
}

export interface Order {
  id: string;
  lines: PricedCartLine[];
  itemCount: number;
  subtotal: number;
  discount: number;
  total: number;
  currency: string;
  createdAt: string;
}

export interface PriceOpts {
  ageVerified?: boolean;
  loyaltyApplied?: boolean;
  /** Loyalty discount percent (defaults to LOYALTY_DISCOUNT_PCT). */
  loyaltyDiscountPct?: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Price a cart against an injected catalog. Unknown ids are collected, not
 * thrown. Pure — no globals, so the same function serves any storefront.
 */
export function priceCart(items: CartItemInput[], catalog: Product[], opts: PriceOpts = {}): PricedCart {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const lines: PricedCartLine[] = [];
  const unknownIds: string[] = [];
  let hasAgeRestricted = false;
  for (const { productId, quantity } of items) {
    const product = byId.get(productId);
    if (!product) {
      unknownIds.push(productId);
      continue;
    }
    if (quantity <= 0) continue;
    if (product.minimumAge != null) hasAgeRestricted = true;
    // Forward EVERY catalog attribute the product carries beyond the display/pricing
    // fields (category, minimumAge, requiresRx, AND any custom attribute) onto the priced
    // line, so a custom `defineCredential` `appliesTo` can key on ANY product field — and
    // sees it identically at manifest time and at the completion sweep (never fail-open).
    // `image`/`description`/`price` are display/pricing; `price` is re-derived as `unitPrice`.
    const { image, description, price, ...attrs } = product;
    void image; void description;
    lines.push({
      ...attrs, // id, name, currency, category, minimumAge, requiresRx + any custom attribute
      unitPrice: price,
      quantity,
      lineTotal: round2(price * quantity),
    });
  }
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const subtotal = round2(lines.reduce((sum, l) => sum + l.lineTotal, 0));
  const loyaltyApplied = !!opts.loyaltyApplied;
  const pct = opts.loyaltyDiscountPct ?? LOYALTY_DISCOUNT_PCT;
  const discount = loyaltyApplied ? round2(subtotal * (pct / 100)) : 0;
  const total = round2(subtotal - discount);
  const currency = lines[0]?.currency ?? "USD";
  return {
    lines,
    itemCount,
    subtotal,
    discount,
    total,
    currency,
    unknownIds,
    hasAgeRestricted,
    ageVerified: !!opts.ageVerified,
    loyaltyApplied,
  };
}

/** The strictest minimum age across the cart's products, or null if none. */
export function requiredAgeForLines(lines: { id: string }[], catalog: Product[]): number | null {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  let max: number | null = null;
  for (const { id } of lines) {
    const m = byId.get(id)?.minimumAge;
    if (m != null && (max === null || m > max)) max = m;
  }
  return max;
}

/** Snapshot a priced cart into an immutable order. */
export function createOrder(items: CartItemInput[], id: string, catalog: Product[], opts: PriceOpts = {}): Order {
  const { lines, itemCount, subtotal, discount, total, currency } = priceCart(items, catalog, opts);
  return { id, lines, itemCount, subtotal, discount, total, currency, createdAt: new Date().toISOString() };
}

/** Look up a product by id in the injected catalog. */
export function getProduct(catalog: Product[], productId: string): Product | undefined {
  return catalog.find((p) => p.id === productId);
}

/** Reviews for a product, from the injected reviews map (empty if none). */
export function getReviews(reviews: Record<string, Review[]> | undefined, productId: string): Review[] {
  return reviews?.[productId] ?? [];
}

/** What to read from the catalog: filters, then one page of the matches. All optional. */
export interface ProductQuery {
  /** Exact category match (case-sensitive, like the catalog value). */
  category?: string;
  /** Case-insensitive substring over `name` and `description`. */
  query?: string;
  /** Page size. Omit for every remaining match. */
  limit?: number;
  /** Opaque — pass back a previous page's `nextCursor` verbatim. */
  cursor?: string;
}

/** One page of catalog matches, in catalog order. */
export interface ProductPage {
  products: Product[];
  /** How many products match the filters, across all pages. */
  totalCount: number;
  /** Pass as `cursor` for the next page; `null` when this is the last one. */
  nextCursor: string | null;
}

// The cursor is an offset into the filtered matches, wrapped so callers treat it as opaque (and
// so it can become a keyset cursor later without changing the contract). btoa/atob, not Buffer:
// this module also ships in the browser widget bundle.
const encodeCursor = (offset: number): string => btoa(`o:${offset}`).replace(/=+$/, "");
function decodeCursor(cursor: string): number {
  let decoded = "";
  try {
    decoded = atob(cursor);
  } catch {
    /* not base64 — falls through to the refusal below */
  }
  const match = /^o:(\d+)$/.exec(decoded);
  if (!match) throw new RangeError(`Invalid cursor "${cursor}" — pass back a nextCursor exactly as it was returned.`);
  return Number(match[1]);
}

/**
 * Read products from an injected catalog: filter by `category` / `query`, then return one page.
 * The single catalog read behind both `list-products` (data) and `browse-products` (the picker),
 * so the two can never disagree about what the store sells. Pure — prices and ages come from
 * `catalog` alone. Throws a `RangeError` on a malformed `cursor` (never silently restarts) or a
 * non-positive `limit`.
 */
export function listProducts(catalog: Product[], q: ProductQuery = {}): ProductPage {
  if (q.limit !== undefined && !(Number.isInteger(q.limit) && q.limit > 0)) {
    throw new RangeError(`Invalid limit ${q.limit} — use a positive integer, or omit it for every match.`);
  }
  const needle = q.query?.toLowerCase();
  const matches = catalog.filter(
    (p) =>
      (q.category === undefined || p.category === q.category) &&
      (needle === undefined || p.name.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle)),
  );
  const start = q.cursor === undefined ? 0 : decodeCursor(q.cursor);
  const end = q.limit === undefined ? matches.length : start + q.limit;
  return {
    products: matches.slice(start, end),
    totalCount: matches.length,
    nextCursor: end < matches.length ? encodeCursor(end) : null,
  };
}

/** A product narrowed to some of its fields — always keeping `id`, the handle every tool takes. */
export type ProductProjection = Pick<Product, "id"> & Partial<Product>;

/** Keep only `fields` (plus `id`). A field the product doesn't carry is omitted, never invented. */
export function projectProduct(product: Product, fields: readonly string[]): ProductProjection {
  // fromEntries + spread define plain own properties, so even a field named `__proto__` can't
  // reach the result's prototype.
  const picked = Object.fromEntries(fields.filter((f) => Object.hasOwn(product, f)).map((f) => [f, product[f]]));
  return { id: product.id, ...picked };
}

/**
 * A source of products for `createStorefront({ catalog })`. The static-array default is
 * wrapped in `staticCatalog(...)`; a DYNAMIC source (e.g. `firestoreCatalog(...)` from
 * `@openmobilehub/credentagent-storefront/firestore`) loads products server-side with a TTL
 * cache so a merchant edits the catalog without a redeploy.
 *
 * Two methods so an async source can feed the gate's SYNCHRONOUS ceremony re-price:
 * `load()` refreshes (fail-closed on a cold/empty load); `current()` returns the
 * last-known-good snapshot the synchronous re-price paths read. The storefront awaits
 * `load()` before every request, so `current()` is always warm inside a handler. Prices
 * and age thresholds are always re-derived from this source server-side (Security
 * invariant 2 — never trust the order token).
 */
export interface CatalogSource {
  /** Load the current catalog, TTL-cached. Rejects (fail-closed) on a cold/empty load. */
  load(): Promise<Product[]>;
  /** Last-known-good snapshot for the synchronous re-price paths. Throws if never loaded. */
  current(): Product[];
}

/** Wrap a static product array as a {@link CatalogSource} — the zero-config default (never fails). */
export function staticCatalog(products: Product[]): CatalogSource {
  return { load: async () => products, current: () => products };
}

/** True when `x` is a {@link CatalogSource} (has a `load` method) rather than a plain `Product[]`. */
export function isCatalogSource(x: Product[] | CatalogSource | undefined): x is CatalogSource {
  return !!x && !Array.isArray(x) && typeof (x as CatalogSource).load === "function";
}

/** A tiny runnable catalog (incl. one age-restricted item) so the package demos itself. */
// Generated, self-contained product images (see generated-images.ts) — emoji tiles
// embedded as data URIs, so the catalog needs no external image service.
export const SAMPLE_CATALOG: Product[] = [
  {
    id: "aurora-headphones",
    name: "Aurora Wireless Headphones",
    price: 199.0,
    currency: "USD",
    image: PRODUCT_IMAGES["aurora-headphones"],
    category: "Audio",
    description: "Over-ear ANC headphones with 40h battery life.",
  },
  {
    id: "oak-whiskey",
    name: "Oak Reserve Whiskey Collection",
    price: 124.0,
    currency: "USD",
    image: PRODUCT_IMAGES["oak-whiskey"],
    category: "Beverages",
    description: "Trio of small-batch aged whiskeys. 21+ only.",
    minimumAge: 21,
  },
  {
    id: "drift-mouse",
    name: "Drift Wireless Mouse",
    price: 49.0,
    currency: "USD",
    image: PRODUCT_IMAGES["drift-mouse"],
    category: "Electronics",
    description: "Ergonomic silent-click wireless mouse, 6-month battery.",
  },
  {
    id: "celebration-champagne",
    name: "Celebration Champagne Duo",
    price: 89.0,
    currency: "USD",
    image: PRODUCT_IMAGES["celebration-champagne"],
    category: "Beverages",
    description: "Brut champagne duo with two crystal flutes. 21+ only.",
    minimumAge: 21,
  },
  {
    id: "summit-backpack",
    name: "Summit Trail Backpack",
    price: 129.0,
    currency: "USD",
    image: PRODUCT_IMAGES["summit-backpack"],
    category: "Outdoors",
    description: "35L weatherproof hiking backpack with a stowaway rain cover.",
  },
  {
    id: "court-sneakers",
    name: "Cascade Court Sneakers",
    price: 95.0,
    currency: "USD",
    image: PRODUCT_IMAGES["court-sneakers"],
    category: "Apparel",
    description: "Low-top canvas court sneakers with a gum sole.",
    // Not a specific purchase until both are chosen — see ProductVariant.
    variants: [
      { name: "size", label: "Which size?", options: ["US 8", "US 9", "US 10", "US 11", "US 12"] },
      { name: "colour", label: "Which colour?", options: ["Black", "White", "Sand"] },
    ],
  },
  {
    id: "lumen-desk-lamp",
    name: "Lumen LED Desk Lamp",
    price: 59.0,
    currency: "USD",
    image: PRODUCT_IMAGES["lumen-desk-lamp"],
    category: "Home",
    description: "Dimmable LED desk lamp with a USB-C charging base.",
  },
];
