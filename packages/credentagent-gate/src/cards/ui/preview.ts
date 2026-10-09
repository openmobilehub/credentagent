// Sample results for previewing every card without a chat (spec 015 FR-5). Open the built page in a
// browser tab with `?view=<name>` (add `&theme=dark` for dark); with no view it lists them all. Each
// sample is shaped exactly like a tool result, so the preview runs the same code path as a chat.

import { GRANT_VIEW_KIND, type GrantViewData } from "../grant-view";
import { PERMISSION_KIND, PERMISSION_STATUS_TOOL, QR_META_KEY, RECEIPT_KIND, type PermissionCardData } from "../contract";
import { offersCard } from "../offers";
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

const coffee = (house: [number, number], espresso: [number, number], tea: [number, number]) => [
  { id: "house-blend", name: "House Blend, 1 lb bag", price: house[0], rating: house[1] },
  { id: "espresso-beans", name: "Espresso Beans, 1 lb bag", price: espresso[0], rating: espresso[1] },
  { id: "green-tea", name: "Green Tea, 50 bags", price: tea[0], rating: tea[1] },
];
const threeStores = [
  { store: "Acme Coffee Co", url: "https://acme.example", products: coffee([24, 4.1], [19, 4.0], [9, 3.8]) },
  { store: "BeanBarn", url: "https://beanbarn.example", products: coffee([21, 4.4], [22, 4.2], [8, 4.5]) },
  { store: "RoastWorks", url: "https://roastworks.example", products: [...coffee([26, 4.6], [18, 4.7], [11, 4.0]), { id: "cold-brew", name: "Cold Brew Concentrate, 32 oz", price: 14, rating: 4.8 }] },
];

/** A sample tool result: the card's data, plus the card-only `_meta` a host delivers beside it. */
export type PreviewResult = { structuredContent: object; _meta?: Record<string, unknown> };

const SAMPLES: Readonly<Record<string, PreviewResult>> = {
  offers: { structuredContent: offersCard({ stores: threeStores }).data },
  "only-one": { structuredContent: offersCard({ stores: threeStores, product: "cold brew" }).data },
  "over-limit": { structuredContent: offersCard({ stores: threeStores, product: "espresso", maxPrice: 15 }).data },
  permission: { structuredContent: permission, _meta: { [QR_META_KEY]: qrDataUrl(permission.approveUrl) } },
  "permission-signed": { structuredContent: { ...permission, grantId: "grant_preview_signed" }, _meta: { [QR_META_KEY]: qrDataUrl(permission.approveUrl) } },
  receipt: {
    structuredContent: {
      kind: RECEIPT_KIND,
      ok: true,
      order: {
        id: "ord_preview",
        store: "BeanBarn",
        total: 21,
        currency: "USD",
        items: ["1 × House Blend, 1 lb bag"],
        checks: [
          "The permission's wallet signature verifies",
          "The agent signed with the key that permission names",
          "The cart is the one we quoted and signed",
          "The permission allows this store",
          "Within the signed limits: $21.00 of $50.00, max $25.00 a purchase",
          "Our catalog prices it at $21.00",
          "Fresh purchase code, addressed to us (no replay)",
        ],
      },
      receiptUrl: "https://beanbarn.example/agent/orders/ord_preview",
      trustLevel: "presence-only-demo",
    },
  },
  refused: {
    structuredContent: { kind: RECEIPT_KIND, ok: false, store: "Acme Coffee Co", code: "constraint", reason: "This permission was signed for another store", trustLevel: "presence-only-demo" },
  },
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

/** What a preview card's tool call answers — only the signed permission's status tool, so its card shows "Signed". */
export function previewCall(view: string | null, tool: string): unknown {
  return view === "permission-signed" && tool === PERMISSION_STATUS_TOOL ? { status: "authorized", trustLevel: "device-signed", announce: false, final: true } : null;
}
