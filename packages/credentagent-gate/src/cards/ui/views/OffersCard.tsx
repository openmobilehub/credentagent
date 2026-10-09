// The offers card (spec 015 FR-8), ported from the AP2 demo: each store's offers side by side, read live,
// with the plain summary the server derived. It makes no trust claim — nothing is signed or paid here —
// so it has no honesty line.
import type { Offer, OffersCardData, OffersSummary, StoreOffers } from "../../contract";
import { Icon } from "./icons";
import { shortName, usd } from "./format";
import styles from "./cards.module.css";

type ReadStore = Extract<StoreOffers, { products: Offer[] }>;

export function OffersCard({ data }: { data: OffersCardData }) {
  const { summary } = data;
  const stores = data.stores.filter((s): s is ReadStore => "products" in s);
  const ids = [...new Set(stores.flatMap((s) => s.products.map((p) => p.id)))];
  const over = summary?.within !== undefined && summary.within.length === 0 && summary.sellers.length > 0;
  const unread = data.stores.length - stores.length; // stores that came back `{ url, error }`
  const said = summarySentence(summary, stores.length, over, unread > 0);
  const footer =
    ids.length === 0
      ? "Nothing to buy, so nothing to sign."
      : over
        ? "Nothing within your limit, so nothing to sign. Buying it would need a higher limit, signed on your phone."
        : "The agent picks one store, then asks you to sign a permission for it on your phone.";
  return (
    <section className={styles.card}>
      <p className={styles.eyebrow}>
        <Icon name="scale" />
        Compared {stores.length} {stores.length === 1 ? "store" : "stores"}
      </p>
      <h1>Offers, read live from each store</h1>
      {said ? <p className={over ? styles.limit : undefined}>{said}</p> : null}
      {unread > 0 ? (
        <p className={styles.sub}>
          Couldn&apos;t read {unread} {unread === 1 ? "store" : "stores"}.
        </p>
      ) : null}
      {ids.length > 0 ? (
        <table className={styles.offers}>
          <thead>
            <tr>
              <th>
                <span className={styles.sub}>Product</span>
              </th>
              {stores.map((s) => (
                <th key={s.url} scope="col">
                  {s.store}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ids.map((id) => (
              <OfferRow key={id} id={id} stores={stores} maxPrice={summary?.maxPrice} />
            ))}
          </tbody>
        </table>
      ) : null}
      <p className={styles.sub}>{footer}</p>
    </section>
  );
}

function OfferRow({ id, stores, maxPrice }: { id: string; stores: ReadStore[]; maxPrice?: number }) {
  const cells = stores.map((s) => s.products.find((p) => p.id === id));
  const sold = cells.filter((p): p is Offer => p !== undefined);
  const low = Math.min(...sold.map((p) => p.price));
  const top = Math.max(...sold.map((p) => p.rating ?? -Infinity));
  const compared = sold.length > 1; // "lowest" and "top rated" mean nothing with a single seller
  return (
    <tr>
      <th scope="row">{shortName(sold[0].name)}</th>
      {cells.map((p, i) => (
        <td key={stores[i].url}>
          {p ? (
            <div>
              <div className={styles.price}>{usd(p.price)}</div>
              {p.rating !== undefined ? <div className={styles.rate}>{p.rating.toFixed(1)} ★</div> : null}
              {compared && p.price === low ? <span className={`${styles.tag} ${styles.tagLow}`}>Lowest price</span> : null}
              {compared && p.rating !== undefined && p.rating === top ? <span className={`${styles.tag} ${styles.tagTop}`}>Top rated</span> : null}
              {maxPrice !== undefined && p.price > maxPrice ? <span className={`${styles.tag} ${styles.tagOver}`}>Over your {usd(maxPrice)}</span> : null}
            </div>
          ) : (
            "—"
          )}
        </td>
      ))}
    </tr>
  );
}

/** Say plainly who sells the product, and with a limit what fits it — the table alone makes them work it out.
 *  Words about "it" need a named product; a price limit alone still says how many stores have offers within it.
 *  `someUnread`: a store could not be read, so "no store sells it" and "only one sells it" speak for the readable ones. */
function summarySentence(summary: OffersSummary | undefined, storeCount: number, over: boolean, someUnread: boolean): string | null {
  if (!summary) return null;
  const { product, sellers } = summary;
  if (sellers.length === 0) return product !== undefined ? `No store ${someUnread ? "I could read " : ""}sells “${product}”.` : null;
  if (over && summary.cheapest && summary.maxPrice !== undefined) {
    return `None is within your ${usd(summary.maxPrice)} limit. The cheapest is ${usd(summary.cheapest.price)} at ${summary.cheapest.store}.`;
  }
  if (summary.within && summary.maxPrice !== undefined) {
    return product !== undefined
      ? `${summary.within.length} of ${sellers.length} ${sellers.length === 1 ? "store sells" : "stores sell"} it within your ${usd(summary.maxPrice)} limit.`
      : `${summary.within.length} of ${sellers.length} ${sellers.length === 1 ? "store has" : "stores have"} offers within your ${usd(summary.maxPrice)} limit.`;
  }
  if (product === undefined) return null;
  if (sellers.length === 1) return someUnread ? `Only ${sellers[0]} sells it among the stores I could read.` : `Only ${sellers[0]} sells it, so there is nothing to compare.`;
  return `${sellers.length} of ${storeCount} stores sell it.`;
}
