// The offers card's summary (spec 015 FR-8): the AP2 demo learned that a table alone makes the person
// work out "only one store sells this" or "nothing fits my limit" — so the kit says it, and tells the
// model what to do about it.
import { describe, it, expect } from "vitest";
import { offersCard } from "./offers.js";
import type { StoreOffers } from "./contract.js";

const catalog = (house: number, espresso: number, rating = 4.2) => [
  { id: "house-blend", name: "House Blend, 1 lb bag", price: house, rating },
  { id: "espresso-beans", name: "Espresso Beans, 1 lb bag", price: espresso, rating },
];
const stores: StoreOffers[] = [
  { store: "Acme Coffee Co", url: "https://acme.example", products: catalog(24, 19, 4.1) },
  { store: "BeanBarn", url: "https://beanbarn.example", products: catalog(21, 22, 4.4) },
  { store: "RoastWorks", url: "https://roastworks.example", products: [...catalog(26, 18, 4.6), { id: "cold-brew", name: "Cold Brew Concentrate, 32 oz", price: 14, rating: 4.8 }] },
];

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
});
