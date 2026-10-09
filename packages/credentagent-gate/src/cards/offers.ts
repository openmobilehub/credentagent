// The offers card (spec 015 FR-8): the stores' catalogs side by side, narrowed to the product the person
// named, with the plain summary the AP2 demo learned the person needs — "only one store sells it", "none
// is within your limit" — derived here, once, together with the matching note for the model.
import { OFFERS_KIND, type Offer, type OffersCardData, type OffersInput, type OffersSummary, type StoreOffers } from "./contract.js";

const usd = (dollars: number): string => `$${Number(dollars).toFixed(2)}`;

export function offersCard({ stores: sent, product, maxPrice }: OffersInput): { data: OffersCardData; note: string } {
  // A store's JSON may carry prices and ratings as numeric strings. Turn them into numbers once, here, so the
  // data, the summary, the note and the card all compare numbers ("9" < "12" is false as text).
  const stores: StoreOffers[] = sent.map((s) => ("products" in s ? { ...s, products: s.products.map(asNumbers) } : s));
  const named = product?.trim();
  const wanted = named?.toLowerCase();
  const matches = (p: Offer): boolean => p.id.toLowerCase() === wanted || p.name.toLowerCase().includes(wanted ?? "");
  const narrowed: StoreOffers[] = wanted ? stores.map((s) => ("products" in s ? { ...s, products: s.products.filter(matches) } : s)) : stores;
  const sellers = narrowed.flatMap((s) => ("products" in s && s.products.length > 0 ? [s.store] : []));
  const offers = narrowed.flatMap((s) => ("products" in s ? s.products.map((p) => ({ store: s.store, price: p.price })) : []));
  const cheapest = offers.reduce<{ store: string; price: number } | undefined>((a, b) => (a === undefined || b.price < a.price ? b : a), undefined);
  const within = maxPrice === undefined ? undefined : [...new Set(offers.filter((o) => o.price <= maxPrice).map((o) => o.store))];
  // A limit counts even when the person named no product: "nothing fits" must reach the model either way.
  const summary: OffersSummary | undefined =
    wanted || maxPrice !== undefined
      ? { ...(wanted ? { product: named } : {}), sellers, ...(maxPrice !== undefined ? { maxPrice, within, ...(cheapest ? { cheapest } : {}) } : {}) }
      : undefined;
  const unread = narrowed.filter((s) => "error" in s).length;
  return { data: { kind: OFFERS_KIND, stores: narrowed, ...(summary ? { summary } : {}) }, note: noteFor(summary, unread) };
}

const asNumbers = (p: Offer): Offer => ({ ...p, price: Number(p.price), ...(p.rating !== undefined ? { rating: Number(p.rating) } : {}) });

/** `unread`: how many stores could not be read — "no store sells it" and "only one sells it" are then claims about
 *  the stores that could be read, and the note must not say more than that. */
function noteFor(summary: OffersSummary | undefined, unread: number): string {
  if (summary?.product !== undefined && summary.sellers.length === 0) {
    return unread > 0
      ? `No store I could read sells "${summary.product}" (${unread} could not be read). Say so; don't request a permission.`
      : `No store sells "${summary.product}". Say so; don't request a permission.`;
  }
  if (summary?.within?.length === 0 && summary.cheapest && summary.maxPrice !== undefined) {
    return (
      `No offer is within the person's maximum of ${usd(summary.maxPrice)}: the cheapest is ${usd(summary.cheapest.price)} at ${summary.cheapest.store}. ` +
      "Don't request a permission and don't buy. Tell them that, and that buying it would need a higher limit, which means signing a new permission on their phone."
    );
  }
  if (summary?.product !== undefined && summary.sellers.length === 1) {
    return unread > 0
      ? `Only ${summary.sellers[0]} sells it among the stores I could read (${unread} could not be read) — say so in a sentence, then request the permission there.`
      : `Only ${summary.sellers[0]} sells it — no comparison to make. Say so in a sentence, then request the permission there.`;
  }
  return "The person sees these offers side by side in a card. Don't re-list them; say which store you pick and why, in a sentence or two.";
}
