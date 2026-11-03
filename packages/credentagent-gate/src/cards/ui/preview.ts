// Sample results for previewing every card without a chat (spec 015 FR-9). Open the built page in a
// browser tab with `?view=<name>` (add `&theme=dark` for dark); with no view it lists them all. Each
// sample is shaped exactly like a tool result, so the preview runs the same code path as a chat.

import { GRANT_VIEW_KIND, type GrantViewData } from "../grant-view";
import { REVOKE_TOOL_META } from "./card-store";

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

const SAMPLES: Readonly<Record<string, object>> = {
  "grant-pending": grant({ status: "pending", lifecycle: "pending", spent: 0, remaining: 200, allow: { skus: [whiskey.id], categories: [] }, product: whiskey }),
  // The whiskey is 21+: an active grant spends on it unattended only with the age proof it carries.
  "grant-product": grant({ allow: { skus: [whiskey.id], categories: [] }, product: whiskey, credentials: { ageVerified: 21, loyaltyDiscountPct: null, trustLevel: "presence-only-demo" } }),
  "grant-category": grant({ allow: { skus: ["drift-mouse"], categories: ["Beverages", "Electronics"] } }),
  "grant-open": grant({}),
  "grant-low": grant({ lifecycle: "low", spent: 180, remaining: 20 }),
  "grant-spent": grant({ lifecycle: "exhausted", spent: 200, remaining: 0 }),
  "grant-revoked": grant({ status: "revoked", lifecycle: "revoked" }),
  "grant-declined": grant({ status: "denied", lifecycle: "denied", spent: 0, remaining: 200 }),
};

/** The names `?view=` accepts, in display order. */
export const previewViews = (): string[] => Object.keys(SAMPLES);

/** A sample tool result for a view name, or null for an unknown or missing name. It names a Revoke
 *  tool as a server would, so the preview draws Revoke; the preview has no server to call it on. */
export function previewResult(view: string | null): { structuredContent: object; _meta: Record<string, unknown> } | null {
  return view !== null && Object.hasOwn(SAMPLES, view)
    ? { structuredContent: SAMPLES[view], _meta: { [REVOKE_TOOL_META]: "revoke-grant" } }
    : null;
}
