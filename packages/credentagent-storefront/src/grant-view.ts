// GrantViewData — the JSON-safe, server-derived projection a grant widget renders (spec 011).
//
// This is the ONE data contract the grant widget speaks: a plain-data snapshot the four grant
// tools emit as structuredContent, discriminated by `kind`. It is the INERT projection (spec 011
// amendment A1) — it carries NO methods, so a view physically cannot call spend()/revoke() (FR-5
// display-only BY CONSTRUCTION, not convention). Money arrives computed server-side from the
// engine (invariant 2 discipline applied to display); the widget never re-derives amounts.
//
// This module is a LEAF on purpose: it imports only TYPES from the gate, so the browser widget
// bundle that imports `GRANT_VIEW_KIND` + the types never pulls the gate's Node runtime in. The
// projection that BUILDS a GrantViewData (which needs the gate's `grantLifecycle` value + a live
// grant handle + catalog) lives server-side in `grant-project.ts`.

import type { GrantLifecycle, GrantStatus } from "@openmobilehub/credentagent-gate";

/** Marker discriminating a grant tool result from a shopping (cart/catalog) result, so the widget
 *  dispatch renders the grant view instead of the product picker. */
export const GRANT_VIEW_KIND = "credentagent.grant";

/** The resolved product for a single-SKU grant (FR-1) — pulled from the live catalog so the
 *  flagship card shows the real name / price / image, not just an id. */
export interface GrantViewProduct {
  id: string;
  name: string;
  price: number;
  currency: string;
  category: string;
  image?: string;
}

/** The grant projection every view (stock OR custom) receives (spec 011 FR-1). Plain data only —
 *  no methods, so a view cannot enact anything; it can only display. */
export interface GrantViewData {
  /** Always `GRANT_VIEW_KIND` — the discriminator the app dispatch reads. */
  kind: typeof GRANT_VIEW_KIND;
  id: string;
  merchant: string;
  /** Raw lifecycle status from the engine (pending | authorized | denied | revoked). */
  status: GrantStatus;
  /** Display lifecycle, derived ONCE server-side (never in the widget) — spec A2. */
  lifecycle: GrantLifecycle;
  budget: number;
  spent: number;
  remaining: number;
  perSpend: number;
  /** Normalized item bounds (never undefined): the allowed SKUs and categories. */
  allow: { skus: string[]; categories: string[] };
  description?: string;
  /** Where the human approves once — the ceremony deep-link the approvalCard links to. */
  approveUrl: string;
  /** Honesty axis — carried verbatim into the non-omittable trust line (FR-4). */
  presence: string;
  trustLevel: string;
  /** Present for single-SKU grants: the resolved product (the flagship productGrantCard). */
  product?: GrantViewProduct;
  /**
   * What the human proved from their wallet before authorizing this grant (#172) — the fact an
   * AGENT needs to answer "may I buy this?" without guessing.
   *
   * Without these fields the agent sees an authorized grant that looks identical whether or not
   * an age proof was presented, so it falls back on the old rule and tells the human their
   * purchase still needs them present — while the server would in fact complete it. The
   * projection has to carry the change, not just the enforcement.
   */
  credentials: {
    /** The age threshold the human proved, or `null`. An age-restricted purchase completes
     *  unattended only at or below this number. */
    ageVerified: number | null;
    /** The loyalty rate sealed into this grant, or `null` — every purchase is priced at it. */
    loyaltyDiscountPct: number | null;
    /** Honesty axis for those claims: "presence-only-demo" until issuer trust lands (#14).
     *  Absent when the human proved nothing. */
    trustLevel?: string;
  };
}
