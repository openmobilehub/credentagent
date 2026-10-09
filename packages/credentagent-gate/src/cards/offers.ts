// The offers card (spec 015 FR-8): the stores' catalogs side by side, narrowed to the product the person
// named, with the plain summary the AP2 demo learned the person needs — "only one store sells it", "none
// is within your limit" — derived here, once, together with the matching note for the model.
import { OFFERS_KIND, type Offer, type OffersCardData, type OffersInput, type OffersSummary, type StoreOffers } from "./contract.js";

const usd = (dollars: number): string => `$${dollars.toFixed(2)}`;

export function offersCard({ stores, product, maxPrice }: OffersInput): { data: OffersCardData; note: string } {
  const wanted = product?.trim().toLowerCase();
  const matches = (p: Offer): boolean => p.id.toLowerCase() === wanted || p.name.toLowerCase().includes(wanted ?? "");
  const narrowed: StoreOffers[] = wanted ? stores.map((s) => ("products" in s ? { ...s, products: s.products.filter(matches) } : s)) : stores;
  const sellers = narrowed.flatMap((s) => ("products" in s && s.products.length > 0 ? [s.store] : []));
  const offers = narrowed.flatMap((s) => ("products" in s ? s.products.map((p) => ({ store: s.store, price: p.price })) : []));
  const cheapest = offers.reduce<{ store: string; price: number } | undefined>((a, b) => (a === undefined || b.price < a.price ? b : a), undefined);
  const within = maxPrice === undefined ? undefined : [...new Set(offers.filter((o) => o.price <= maxPrice).map((o) => o.store))];
  const summary: OffersSummary | undefined =
    wanted && product !== undefined
      ? { product, sellers, ...(maxPrice !== undefined ? { maxPrice, within, ...(cheapest ? { cheapest } : {}) } : {}) }
      : undefined;
  return { data: { kind: OFFERS_KIND, stores: narrowed, ...(summary ? { summary } : {}) }, note: noteFor(summary) };
}

function noteFor(summary: OffersSummary | undefined): string {
  if (summary && summary.sellers.length === 0) return `No store sells "${summary.product}". Say so; don't request a permission.`;
  if (summary?.within?.length === 0 && summary.cheapest && summary.maxPrice !== undefined) {
    return (
      `No offer is within the person's maximum of ${usd(summary.maxPrice)}: the cheapest is ${usd(summary.cheapest.price)} at ${summary.cheapest.store}. ` +
      "Don't request a permission and don't buy. Tell them that, and that buying it would need a higher limit, which means signing a new permission on their phone."
    );
  }
  if (summary && summary.sellers.length === 1) return `Only ${summary.sellers[0]} sells it — no comparison to make. Say so in a sentence, then request the permission there.`;
  return "The person sees these offers side by side in a card. Don't re-list them; say which store you pick and why, in a sentence or two.";
}
