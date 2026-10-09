import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OffersCard } from "./OffersCard";
import { previewResult } from "../preview";
import { offersCard } from "../../offers";
import type { OffersCardData } from "../../contract";

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
    const stores = (previewResult("offers")!.structuredContent as OffersCardData).stores;
    const html = renderToStaticMarkup(<OffersCard data={offersCard({ stores, maxPrice: 20 }).data} />);
    expect(html).toContain("stores have offers within your $20.00 limit");
  });

  it("renders a store's words as text, never as markup", () => {
    const data: OffersCardData = { kind: "credentagent.offers", stores: [{ store: "<b>Evil</b>", url: "https://e.example", products: [{ id: "x", name: "<img src=x>", price: 1 }] }] };
    const html = renderToStaticMarkup(<OffersCard data={data} />);
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    expect(html).not.toContain("<img src=x>");
  });
});
