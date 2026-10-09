// The offers card's summary (spec 015 FR-8): the AP2 demo learned that a table alone makes the person
// work out "only one store sells this" or "nothing fits my limit" — so the kit says it, and tells the
// model what to do about it.
import { describe, it, expect } from "vitest";
import { offersCard } from "./offers.js";
import type { Offer, StoreOffers } from "./contract.js";

const catalog = (house: number, espresso: number, rating = 4.2) => [
  { id: "house-blend", name: "House Blend, 1 lb bag", price: house, rating },
  { id: "espresso-beans", name: "Espresso Beans, 1 lb bag", price: espresso, rating },
];
const stores: StoreOffers[] = [
  { store: "Acme Coffee Co", url: "https://acme.example", products: catalog(24, 19, 4.1) },
  { store: "BeanBarn", url: "https://beanbarn.example", products: catalog(21, 22, 4.4) },
  { store: "RoastWorks", url: "https://roastworks.example", products: [...catalog(26, 18, 4.6), { id: "cold-brew", name: "Cold Brew Concentrate, 32 oz", price: 14, rating: 4.8 }] },
];

const sideBySide =
  "The person sees these offers side by side in a card. Don't re-list them; say which store you pick and why, in a sentence or two.";

describe("offersCard", () => {
  it("without a product: the whole catalogs, no summary, and the model is told not to re-list them", () => {
    const { data, note } = offersCard({ stores });
    expect(data).toEqual({ kind: "credentagent.offers", stores });
    expect(note).toBe("The person sees these offers side by side in a card. Don't re-list them; say which store you pick and why, in a sentence or two.");
  });

  it("a named product narrows every catalog; a store that does not sell it keeps its column, empty", () => {
    const { data } = offersCard({ stores, product: "cold brew" });
    expect(data.stores.map((s) => ("products" in s ? s.products.map((p) => p.id) : s.error))).toEqual([[], [], ["cold-brew"]]);
    expect(data.summary).toEqual({ product: "cold brew", sellers: ["RoastWorks"] });
  });

  it("matches a product id as well as words from its name", () => {
    expect(offersCard({ stores, product: "espresso-beans" }).data.summary?.sellers).toEqual(["Acme Coffee Co", "BeanBarn", "RoastWorks"]);
    expect(offersCard({ stores, product: "House BLEND" }).data.summary?.sellers).toEqual(["Acme Coffee Co", "BeanBarn", "RoastWorks"]);
  });

  it("only one seller: nothing to compare", () => {
    expect(offersCard({ stores, product: "cold brew" }).note).toBe("Only RoastWorks sells it — no comparison to make. Say so in a sentence, then request the permission there.");
  });

  it("no seller: say so, and don't ask for a permission", () => {
    const { data, note } = offersCard({ stores, product: "matcha" });
    expect(data.summary).toEqual({ product: "matcha", sellers: [] });
    expect(note).toBe('No store sells "matcha". Say so; don\'t request a permission.');
  });

  it("with a limit: which stores fit it", () => {
    expect(offersCard({ stores, product: "espresso", maxPrice: 19 }).data.summary).toEqual({
      product: "espresso",
      sellers: ["Acme Coffee Co", "BeanBarn", "RoastWorks"],
      maxPrice: 19,
      within: ["Acme Coffee Co", "RoastWorks"],
      cheapest: { store: "RoastWorks", price: 18 },
    });
  });

  it("nothing within the limit: the cheapest, and no permission, no purchase", () => {
    const { data, note } = offersCard({ stores, product: "espresso", maxPrice: 15 });
    expect(data.summary?.within).toEqual([]);
    expect(note).toBe(
      "No offer is within the person's maximum of $15.00: the cheapest is $18.00 at RoastWorks. Don't request a permission and don't buy. " +
        "Tell them that, and that buying it would need a higher limit, which means signing a new permission on their phone.",
    );
  });

  it("a store that could not be read stays in the data and is no seller", () => {
    const { data } = offersCard({ stores: [...stores, { url: "https://down.example", error: "fetch failed" }], product: "house" });
    expect(data.stores.at(-1)).toEqual({ url: "https://down.example", error: "fetch failed" });
    expect(data.summary?.sellers).toEqual(["Acme Coffee Co", "BeanBarn", "RoastWorks"]);
  });

  it("a limit without a product still says nothing fits, and asks for no permission", () => {
    const { data, note } = offersCard({ stores, maxPrice: 10 });
    expect(data.summary?.product).toBeUndefined();
    expect(data.summary?.within).toEqual([]);
    expect(data.summary?.cheapest).toEqual({ store: "RoastWorks", price: 14 });
    expect(note).toBe(
      "No offer is within the person's maximum of $10.00: the cheapest is $14.00 at RoastWorks. Don't request a permission and don't buy. " +
        "Tell them that, and that buying it would need a higher limit, which means signing a new permission on their phone.",
    );
  });

  it("a limit without a product that some offers fit: those stores are listed, and the note is the default", () => {
    const { data, note } = offersCard({ stores, maxPrice: 19 });
    expect(data.summary?.within).toEqual(["Acme Coffee Co", "RoastWorks"]);
    expect(data.summary?.cheapest).toEqual({ store: "RoastWorks", price: 14 });
    expect(note).toBe(sideBySide);
  });

  it("a limit without a product, one store only: the note does not say 'only X sells it', since no product was named", () => {
    const { note } = offersCard({ stores: [stores[2]], maxPrice: 25 });
    expect(note).toBe(sideBySide);
  });

  it("a limit without a product and no catalog at all: no 'no store sells' note, since no product was named", () => {
    const { note } = offersCard({ stores: [{ store: "Empty", url: "https://empty.example", products: [] }], maxPrice: 10 });
    expect(note).toBe(sideBySide);
  });

  it("within lists each store once, even when two of its offers fit the limit", () => {
    expect(offersCard({ stores, maxPrice: 25 }).data.summary?.within).toEqual(["Acme Coffee Co", "BeanBarn", "RoastWorks"]);
  });

  it("a product of only spaces names nothing: no product summary, and the catalogs are not narrowed", () => {
    const { data } = offersCard({ stores, product: "  " });
    expect(data.summary).toBeUndefined();
    expect(data.stores).toEqual(stores);
  });

  it("a tie for cheapest keeps the first store", () => {
    const tied: StoreOffers[] = [
      { store: "First", url: "https://first.example", products: [{ id: "tea", name: "Tea, 20 bags", price: 5 }] },
      { store: "Second", url: "https://second.example", products: [{ id: "tea", name: "Tea, 20 bags", price: 5 }] },
    ];
    expect(offersCard({ stores: tied, product: "tea", maxPrice: 10 }).data.summary?.cheapest).toEqual({ store: "First", price: 5 });
  });

  it("a price the store sent as a numeric string is shown in dollars", () => {
    const stringPriced: StoreOffers[] = [
      { store: "Acme Coffee Co", url: "https://acme.example", products: [{ id: "tea", name: "Tea, 20 bags", price: "12" as unknown as number }] },
    ];
    const { note } = offersCard({ stores: stringPriced, product: "tea", maxPrice: 10 });
    expect(note).toContain("the cheapest is $12.00 at Acme Coffee Co.");
  });

  it("prices a store sent as numeric strings are compared as numbers, in the data, the summary and the note", () => {
    const priced = (price: string): Offer => ({ id: "tea", name: "Tea, 20 bags", price: price as unknown as number, rating: "4.5" as unknown as number });
    const sent: StoreOffers[] = [
      { store: "Twelve", url: "https://twelve.example", products: [priced("12")] },
      { store: "Nine", url: "https://nine.example", products: [priced("9")] },
    ];
    const { data } = offersCard({ stores: sent, maxPrice: 20 });
    expect(data.summary?.cheapest).toEqual({ store: "Nine", price: 9 }); // as strings, "9" < "12" is false and $12 would win
    expect(data.summary?.within).toEqual(["Twelve", "Nine"]);
    const nine = data.stores[1];
    expect("products" in nine && nine.products[0]).toEqual({ id: "tea", name: "Tea, 20 bags", price: 9, rating: 4.5 });
    expect(typeof ("products" in nine && nine.products[0].price)).toBe("number");
  });

  it("the summary names the product as typed, without the spaces around it", () => {
    expect(offersCard({ stores, product: "  cold brew " }).data.summary).toEqual({ product: "cold brew", sellers: ["RoastWorks"] });
  });

  describe("a store that could not be read is never counted as a store that does not sell it", () => {
    const down: StoreOffers = { url: "https://down.example", error: "fetch failed" };

    it("only one readable seller: the note says it is only among the stores that could be read", () => {
      const { note } = offersCard({ stores: [stores[2], down], product: "cold brew" });
      expect(note).toBe(
        "Only RoastWorks sells it among the stores I could read (1 could not be read) — say so in a sentence, then request the permission there.",
      );
    });

    it("no readable seller: the note does not say that no store sells it", () => {
      const { note } = offersCard({ stores: [stores[0], down, { url: "https://down2.example", error: "timeout" }], product: "matcha" });
      expect(note).toBe('No store I could read sells "matcha" (2 could not be read). Say so; don\'t request a permission.');
    });

    it("with every store readable the notes stay as they were", () => {
      expect(offersCard({ stores: [stores[2]], product: "cold brew" }).note).toBe("Only RoastWorks sells it — no comparison to make. Say so in a sentence, then request the permission there.");
      expect(offersCard({ stores: [stores[0]], product: "matcha" }).note).toBe('No store sells "matcha". Say so; don\'t request a permission.');
    });
  });
});
