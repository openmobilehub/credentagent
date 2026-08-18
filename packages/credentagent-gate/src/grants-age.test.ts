import { describe, it, expect } from "vitest";
import { ageScopeFor, skuAllowed } from "./grants-age.js";

// The demo catalog issue #172 was reported against: Beverages is entirely age-restricted, which
// is exactly why a "$300, Beverages only" grant could spend $0.00 without anyone being told.
const CATALOG = {
  "oak-whiskey": { price: 124, minAge: 21, category: "Beverages", name: "Oak Reserve Whiskey" },
  "celebration-champagne": { price: 89, minAge: 21, category: "Beverages", name: "Celebration Champagne" },
  "energy-drink": { price: 4, minAge: 18, category: "Beverages", name: "Jolt Energy Drink" },
  "drift-mouse": { price: 49, category: "Electronics", name: "Drift Wireless Mouse" },
  coffee: 18, // a bare-price entry — no category, no name, no restriction
};

describe("ageScopeFor() — what a grant's bounds cover, age-wise (#172)", () => {
  it("a CATEGORY grant reports the strictest age in that category and names every restricted item", () => {
    const scope = ageScopeFor({ categories: ["Beverages"] }, CATALOG);
    // 21 wins over the 18+ energy drink — the page must warn at the strictest bar in scope.
    expect(scope.minimumAge).toBe(21);
    expect(scope.items.map((i) => i.sku).sort()).toEqual(["celebration-champagne", "energy-drink", "oak-whiskey"]);
    expect(scope.items.find((i) => i.sku === "oak-whiskey")).toEqual({
      sku: "oak-whiskey",
      name: "Oak Reserve Whiskey",
      price: 124,
      minAge: 21,
    });
  });

  it("a SKU grant looks up only the named products", () => {
    const scope = ageScopeFor({ skus: ["celebration-champagne", "drift-mouse"] }, CATALOG);
    expect(scope.minimumAge).toBe(21);
    expect(scope.items.map((i) => i.sku)).toEqual(["celebration-champagne"]); // the mouse isn't restricted
  });

  it("NO bounds scans the whole catalog — an unbounded grant covers the restricted items too", () => {
    expect(ageScopeFor(undefined, CATALOG).minimumAge).toBe(21);
    expect(ageScopeFor({}, CATALOG).minimumAge).toBe(21);
  });

  it("a clean scope reports NOTHING — the page must not cry wolf", () => {
    expect(ageScopeFor({ categories: ["Electronics"] }, CATALOG)).toEqual({ minimumAge: null, items: [] });
    expect(ageScopeFor({ skus: ["coffee", "drift-mouse"] }, CATALOG)).toEqual({ minimumAge: null, items: [] });
  });

  it("falls back to the sku id when the catalog entry carries no display name", () => {
    const scope = ageScopeFor({ skus: ["gin"] }, { gin: { price: 30, minAge: 21 } });
    expect(scope.items).toEqual([{ sku: "gin", price: 30, minAge: 21 }]); // no `name` invented
  });

  it("is empty for a grant with no catalog to read (fail-closed: warn about nothing you can't see)", () => {
    expect(ageScopeFor({ categories: ["Beverages"] }, undefined)).toEqual({ minimumAge: null, items: [] });
  });

  it("an EMPTY allow list covers nothing — bounds that permit no item disclose no item", () => {
    // `{ skus: [] }` is a real (if useless) bound: skuAllowed refuses every item, so the
    // disclosure must agree rather than falling back to "no bounds ⇒ whole catalog".
    expect(skuAllowed({ skus: [] }, "oak-whiskey", CATALOG)).toBe(false);
    expect(ageScopeFor({ skus: [] }, CATALOG)).toEqual({ minimumAge: null, items: [] });
  });

  it("treats minAge 0 as unrestricted (a threshold must be positive to restrict)", () => {
    expect(ageScopeFor(undefined, { juice: { price: 5, minAge: 0 } })).toEqual({ minimumAge: null, items: [] });
  });
});

describe("skuAllowed() — the ONE bounds predicate the page and the gate share (#172)", () => {
  it("no bounds ⇒ everything; sku OR category matches; anything else is refused", () => {
    expect(skuAllowed(undefined, "oak-whiskey", CATALOG)).toBe(true);
    expect(skuAllowed({ skus: ["coffee"] }, "coffee", CATALOG)).toBe(true);
    expect(skuAllowed({ categories: ["Beverages"] }, "oak-whiskey", CATALOG)).toBe(true);
    expect(skuAllowed({ categories: ["Beverages"] }, "drift-mouse", CATALOG)).toBe(false);
  });

  it("FAIL-CLOSED: an unknown or uncategorized item does not pass category bounds", () => {
    expect(skuAllowed({ categories: ["Beverages"] }, "not-in-catalog", CATALOG)).toBe(false);
    expect(skuAllowed({ categories: ["Beverages"] }, "coffee", CATALOG)).toBe(false); // bare price ⇒ no category
  });
});
