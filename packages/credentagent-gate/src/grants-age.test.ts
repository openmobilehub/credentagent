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

describe("ageScopeFor() — the age-restricted products a grant NAMES (#172)", () => {
  it("looks up the named products, and reports the strictest age among them", () => {
    const scope = ageScopeFor({ skus: ["oak-whiskey", "energy-drink", "drift-mouse"] }, CATALOG);
    // 21 wins over the 18+ energy drink — the page must state the strictest bar it will enforce.
    expect(scope.minimumAge).toBe(21);
    expect(scope.items.map((i) => i.sku)).toEqual(["oak-whiskey", "energy-drink"]); // the mouse isn't restricted
    expect(scope.items[0]).toEqual({ sku: "oak-whiskey", name: "Oak Reserve Whiskey", price: 124, minAge: 21 });
  });

  // The whole point of dropping the forecast (#175 pins the exact product before the link exists):
  // a grant that names no product must not guess what its category MIGHT contain. A page warning
  // about an item nobody chose is wrong the moment the catalog changes.
  it("does NOT guess: a category grant, or an unbounded one, names no product and reports nothing", () => {
    expect(ageScopeFor({ categories: ["Beverages"] }, CATALOG)).toEqual({ minimumAge: null, items: [] });
    expect(ageScopeFor(undefined, CATALOG)).toEqual({ minimumAge: null, items: [] });
    expect(ageScopeFor({}, CATALOG)).toEqual({ minimumAge: null, items: [] });
  });

  it("a named product that is unrestricted reports NOTHING — the page must not cry wolf", () => {
    expect(ageScopeFor({ skus: ["coffee", "drift-mouse"] }, CATALOG)).toEqual({ minimumAge: null, items: [] });
  });

  it("a named sku this catalog doesn't price says nothing about age", () => {
    expect(ageScopeFor({ skus: ["not-in-catalog"] }, CATALOG)).toEqual({ minimumAge: null, items: [] });
  });

  it("falls back to the sku id when the catalog entry carries no display name", () => {
    const scope = ageScopeFor({ skus: ["gin"] }, { gin: { price: 30, minAge: 21 } });
    expect(scope.items).toEqual([{ sku: "gin", price: 30, minAge: 21 }]); // no `name` invented
  });

  it("is empty for a grant with no catalog to read (fail-closed: warn about nothing you can't see)", () => {
    expect(ageScopeFor({ skus: ["oak-whiskey"] }, undefined)).toEqual({ minimumAge: null, items: [] });
  });

  it("treats minAge 0 as unrestricted (a threshold must be positive to restrict)", () => {
    expect(ageScopeFor({ skus: ["juice"] }, { juice: { price: 5, minAge: 0 } })).toEqual({ minimumAge: null, items: [] });
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
