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

  it("a CATEGORY grant scans that category, and marks the answer as a forecast", () => {
    const scope = ageScopeFor({ categories: ["Beverages"] }, CATALOG);
    expect(scope.minimumAge).toBe(21); // 21 wins over the 18+ energy drink
    expect(scope.items.map((i) => i.sku).sort()).toEqual(["celebration-champagne", "energy-drink", "oak-whiskey"]);
    // `from` is what lets the page say "what this category holds today" instead of promising a
    // closed list — the distinction the reviewer asked for.
    expect(scope.from).toBe("scanned");
  });

  it("an UNBOUNDED grant scans the whole store — it can buy anything, so it discloses everything", () => {
    expect(ageScopeFor(undefined, CATALOG)).toMatchObject({ minimumAge: 21, from: "scanned" });
    expect(ageScopeFor({}, CATALOG)).toMatchObject({ minimumAge: 21, from: "scanned" });
  });

  it("a scan never lists something the bounds could not buy anyway", () => {
    // Beverages-only must not surface the Electronics mouse, restricted or not. The scan reuses
    // the spend-time predicate, so the disclosure and the enforcement cannot disagree.
    const scope = ageScopeFor({ categories: ["Beverages"] }, CATALOG);
    expect(scope.items.map((i) => i.sku)).not.toContain("drift-mouse");
  });

  it("a scope with nothing restricted reports NOTHING — the page must not cry wolf", () => {
    expect(ageScopeFor({ skus: ["coffee", "drift-mouse"] }, CATALOG)).toMatchObject({ minimumAge: null, items: [] });
    expect(ageScopeFor({ categories: ["Electronics"] }, CATALOG)).toMatchObject({ minimumAge: null, items: [] });
  });

  it("a named sku this catalog doesn't price says nothing about age", () => {
    expect(ageScopeFor({ skus: ["not-in-catalog"] }, CATALOG)).toMatchObject({ minimumAge: null, items: [] });
  });

  it("falls back to the sku id when the catalog entry carries no display name", () => {
    const scope = ageScopeFor({ skus: ["gin"] }, { gin: { price: 30, minAge: 21 } });
    expect(scope.items).toEqual([{ sku: "gin", price: 30, minAge: 21 }]); // no `name` invented
  });

  it("is empty for a grant with no catalog to read (fail-closed: warn about nothing you can't see)", () => {
    expect(ageScopeFor({ skus: ["oak-whiskey"] }, undefined)).toMatchObject({ minimumAge: null, items: [] });
    expect(ageScopeFor({ categories: ["Beverages"] }, undefined)).toMatchObject({ minimumAge: null, items: [] });
  });

  it("treats minAge 0 as unrestricted (a threshold must be positive to restrict)", () => {
    expect(ageScopeFor({ skus: ["juice"] }, { juice: { price: 5, minAge: 0 } })).toMatchObject({ minimumAge: null, items: [] });
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
