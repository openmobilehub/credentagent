// Sample results for previewing every card without a chat (spec 015 FR-5). Open the built page in a
// browser tab with `?view=<name>` (add `&theme=dark` for dark); with no view it lists them all. Each
// sample is shaped exactly like a tool result, so the preview runs the same code path as a chat.

import { GRANT_VIEW_KIND, type GrantViewData } from "../grant-view";
import { PERMISSION_KIND, QR_META_KEY, type PermissionCardData } from "../contract";
import { qrDataUrl } from "../qr";

const grant = (over: Partial<GrantViewData>): GrantViewData => ({
  kind: GRANT_VIEW_KIND,
  id: "grant_preview",
  merchant: "Utopia",
  status: "authorized",
  lifecycle: "active",
  budget: 200,
  spent: 54,
  remaining: 146,
  perSpend: 130,
  allow: { skus: [], categories: [] },
  approveUrl: "https://utopia.example/credentagent/grants/grant_preview",
  presence: "delegated-demo",
  trustLevel: "server-issued-demo",
  credentials: { ageVerified: null, loyaltyDiscountPct: null },
  ...over,
});

const whiskey = { id: "oak-whiskey", name: "Oak Reserve Whiskey", price: 124, currency: "USD", category: "Beverages" };

const permission: PermissionCardData = {
  kind: PERMISSION_KIND,
  grantId: "grant_preview",
  store: { name: "BeanBarn", url: "https://beanbarn.example", merchantId: "beanbarn.example" },
  approveUrl: "https://beanbarn.example/credentagent/grants/grant_preview",
  products: ["House Blend, 1 lb bag"],
  limits: { perPurchase: 25, total: 50 },
  why: "lowest price for House Blend ($21), and a 4.4 rating — only RoastWorks rates higher, at $5 more.",
  trustLevel: "presence-only-demo",
};

/** A sample tool result: the card's data, plus the card-only `_meta` a host delivers beside it. */
export type PreviewResult = { structuredContent: object; _meta?: Record<string, unknown> };

const SAMPLES: Readonly<Record<string, PreviewResult>> = {
  permission: { structuredContent: permission, _meta: { [QR_META_KEY]: qrDataUrl(permission.approveUrl) } },
  "grant-pending": { structuredContent: grant({ status: "pending", lifecycle: "pending", spent: 0, remaining: 200, allow: { skus: [whiskey.id], categories: [] }, product: whiskey }) },
  "grant-product": { structuredContent: grant({ allow: { skus: [whiskey.id], categories: [] }, product: whiskey }) },
  "grant-category": { structuredContent: grant({ allow: { skus: ["drift-mouse"], categories: ["Beverages", "Electronics"] } }) },
  "grant-open": { structuredContent: grant({}) },
  "grant-low": { structuredContent: grant({ lifecycle: "low", spent: 180, remaining: 20 }) },
  "grant-spent": { structuredContent: grant({ lifecycle: "exhausted", spent: 200, remaining: 0 }) },
  "grant-revoked": { structuredContent: grant({ status: "revoked", lifecycle: "revoked" }) },
  "grant-declined": { structuredContent: grant({ status: "denied", lifecycle: "denied", spent: 0, remaining: 200 }) },
};

/** The names `?view=` accepts, in display order. */
export const previewViews = (): string[] => Object.keys(SAMPLES);

/** A sample tool result for a view name, or null for an unknown or missing name. */
export function previewResult(view: string | null): PreviewResult | null {
  return view !== null && Object.hasOwn(SAMPLES, view) ? SAMPLES[view] : null;
}
