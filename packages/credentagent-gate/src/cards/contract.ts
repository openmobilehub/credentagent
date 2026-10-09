// The card kit's data contract (spec 015): what a tool result carries for each card, shared by the
// server half (which builds it) and the card page (which renders it). A LEAF on purpose — plain types
// and constants, no Node and no React — so both sides import it.

/** A permission to sign on the phone (spec 015 FR-7). */
export const PERMISSION_KIND = "credentagent.permission";
/** The card-only tool the permission card follows the signature through — hidden from the model. */
export const PERMISSION_STATUS_TOOL = "credentagent-permission-status";
/** Where the QR code of the signing link rides: the result's `_meta`, so it costs the model no context. */
export const QR_META_KEY = "credentagent/qr";

/** What a server passes to `cards.permission()`. */
export interface PermissionInput {
  /** The store's id for the permission (the grant) the person is asked to sign. */
  grantId: string;
  store: { name: string; url?: string; merchantId?: string };
  /** The signing link — the card shows it as a QR code and an "Open link" button. */
  approveUrl: string;
  /** The products the permission covers, as the person should read them. */
  products: string[];
  /** In dollars. */
  limits: { perPurchase: number; total: number };
  /** One sentence: why this store (shown to the person). */
  why?: string;
  /** What the purchase will be verified at — said out loud, never defaulted (e.g. "presence-only-demo"). */
  trustLevel: string;
}

/** The permission card's data: the input, marked with its kind. */
export interface PermissionCardData extends PermissionInput {
  kind: typeof PERMISSION_KIND;
}

/** What the card-only status tool answers. `announce`: the card should tell the chat the permission
 *  was signed — decided on the server, once per grant, never while the model waits in its own turn.
 *  `final`: the card can stop asking. */
export interface PermissionStatusAnswer {
  status: string;
  trustLevel?: string;
  announce: boolean;
  final: boolean;
}

/** The stores' offers side by side (spec 015 FR-8). */
export const OFFERS_KIND = "credentagent.offers";

export interface Offer {
  id: string;
  name: string;
  /** In dollars. */
  price: number;
  rating?: number;
}

/** One store's catalog as the agent read it — or the error that stopped it. */
export type StoreOffers = { store: string; url: string; products: Offer[] } | { url: string; error: string };

/** What a server passes to `cards.offers()`. */
export interface OffersInput {
  stores: StoreOffers[];
  /** The product the person named — an id, or words from its name. */
  product?: string;
  /** The most the person will pay for one, in dollars. */
  maxPrice?: number;
}

/** What the card says plainly: who sells the product, and with a limit, what fits it. */
export interface OffersSummary {
  /** The product the person named, when they named one. */
  product?: string;
  /** The stores that sell it (with no product named: the stores that have any product). */
  sellers: string[];
  maxPrice?: number;
  /** With a limit: the stores that sell it within it. */
  within?: string[];
  /** With a limit: the cheapest offer. */
  cheapest?: { store: string; price: number };
}

export interface OffersCardData {
  kind: typeof OFFERS_KIND;
  stores: StoreOffers[];
  summary?: OffersSummary;
}
