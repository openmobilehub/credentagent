import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OffersCard } from "./OffersCard";
import { previewResult } from "../preview";
import { offersCard } from "../../offers";
import type { OffersCardData, OffersInput } from "../../contract";

const threeStores = (previewResult("offers")!.structuredContent as OffersCardData).stores;
const cardFor = (input: Partial<OffersInput>): string => renderToStaticMarkup(<OffersCard data={offersCard({ stores: threeStores, ...input }).data} />);
const occurrences = (html: string, text: string): number => html.split(text).length - 1;
const render = (view: string): string => renderToStaticMarkup(<OffersCard data={previewResult(view)!.structuredContent as OffersCardData} />);

describe("OffersCard", () => {
  it("shows every store's offers side by side, with the lowest price and the top rating tagged", () => {
    const html = render("offers");
    expect(html).toContain("Compared 3 stores");
    expect(html).toContain("Offers, read live from each store");
    for (const store of ["Acme Coffee Co", "BeanBarn", "RoastWorks"]) expect(html).toContain(store);
    expect(html).toContain("$21.00");
    expect(html).toContain("Lowest price");
    expect(html).toContain("Top rated");
    expect(html).toContain("The agent picks one store, then asks you to sign a permission for it on your phone.");
  });

  it("only one seller: says there is nothing to compare, and tags nothing", () => {
    const html = render("only-one");
    expect(html).toContain("Only RoastWorks sells it, so there is nothing to compare.");
    expect(html).not.toContain("Lowest price");
    expect(html).not.toContain("Top rated");
  });

  it("over the limit: says what the cheapest costs, tags every offer, and asks for nothing", () => {
    const html = render("over-limit");
    expect(html).toContain("None is within your $15.00 limit. The cheapest is $18.00 at RoastWorks.");
    expect(html).toContain("Over your $15.00");
    expect(html).toContain("Nothing within your limit, so nothing to sign. Buying it would need a higher limit, signed on your phone.");
  });

  it("a price limit with no product named still says what fits it", () => {
    expect(cardFor({ maxPrice: 20 })).toContain("stores have offers within your $20.00 limit");
  });

  it("no store sells the product: says so, and shows no table", () => {
    const html = cardFor({ product: "matcha" });
    expect(html).toContain("No store sells “matcha”.");
    expect(html).not.toContain("<table");
    expect(html).toContain("Nothing to buy, so nothing to sign.");
  });

  it("a product some stores sell within the limit: says how many, and tags only the offers over it", () => {
    const html = cardFor({ product: "espresso", maxPrice: 19 });
    expect(html).toContain("2 of 3 stores sell it within your $19.00 limit.");
    expect(occurrences(html, "Over your $19.00")).toBe(1); // BeanBarn's $22 only
  });

  it("several stores sell the product and there is no limit: says how many of the stores sell it", () => {
    expect(cardFor({ product: "house" })).toContain("3 of 3 stores sell it.");
  });

  it("says \"1 store\", not \"1 stores\"", () => {
    const html = renderToStaticMarkup(<OffersCard data={offersCard({ stores: [threeStores[2]] }).data} />);
    expect(html).toContain("Compared 1 store");
    expect(html).not.toContain("Compared 1 stores");
  });

  describe("a store that could not be read", () => {
    const down = { url: "https://down.example", error: "fetch failed" };
    const unreadable = (n: number, input: Partial<OffersInput>): string =>
      renderToStaticMarkup(<OffersCard data={offersCard({ stores: [threeStores[2], ...Array.from({ length: n }, () => down)], ...input }).data} />);

    it("is counted, and the sentence says it only speaks for the stores that could be read", () => {
      const html = unreadable(1, { product: "cold brew" });
      expect(html).toContain("Couldn&#x27;t read 1 store.");
      expect(html).toContain("Only RoastWorks sells it among the stores I could read.");
      expect(html).toContain("Compared 1 store"); // only the readable one is in the table
      expect(html).not.toContain("so there is nothing to compare");
    });

    it("no readable seller: does not claim that no store sells it", () => {
      const html = unreadable(2, { product: "matcha" });
      expect(html).toContain("No store I could read sells “matcha”.");
      expect(html).toContain("Couldn&#x27;t read 2 stores.");
      expect(html).not.toContain("No store sells");
    });

    it("with no summary, it is still said, right after the heading", () => {
      expect(unreadable(1, {})).toContain("Couldn&#x27;t read 1 store.");
    });

    it("with every store readable, there is nothing to say about it", () => {
      expect(cardFor({ product: "cold brew" })).not.toContain("Couldn&#x27;t read");
    });
  });

  it("renders a store's words as text, never as markup", () => {
    const data: OffersCardData = { kind: "credentagent.offers", stores: [{ store: "<b>Evil</b>", url: "https://e.example", products: [{ id: "x", name: "<img src=x>", price: 1 }] }] };
    const html = renderToStaticMarkup(<OffersCard data={data} />);
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    expect(html).not.toContain("<img src=x>");
  });
});
