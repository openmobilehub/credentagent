// Resolving a human's words to ONE catalog product — and, when the words don't, saying so.

import { describe, it, expect } from "vitest";
import { matchProducts, prefillVariants, validSelections, missingVariants, describeChoice } from "./product-match.js";
import { SAMPLE_CATALOG } from "./index.js";
import type { Product } from "./index.js";

const byId = (id: string) => SAMPLE_CATALOG.find((p) => p.id === id)!;

describe("matchProducts", () => {
  it("resolves a product named in the human's own words", () => {
    expect(matchProducts(SAMPLE_CATALOG, "Oak Reserve Whiskey Collection")).toEqual({ kind: "one", product: byId("oak-whiskey") });
    expect(matchProducts(SAMPLE_CATALOG, "the black court sneakers in US 10")).toEqual({ kind: "one", product: byId("court-sneakers") });
    expect(matchProducts(SAMPLE_CATALOG, "a whiskey")).toEqual({ kind: "one", product: byId("oak-whiskey") });
  });

  it("reports a TIE instead of silently picking one", () => {
    const m = matchProducts(SAMPLE_CATALOG, "wireless");
    expect(m.kind).toBe("many");
    if (m.kind !== "many") return;
    expect(m.candidates.map((p) => p.id).sort()).toEqual(["aurora-headphones", "drift-mouse"]);
  });

  it("reports NONE rather than matching on a stray descriptive word", () => {
    expect(matchProducts(SAMPLE_CATALOG, "a llama saddle").kind).toBe("none");
    expect(matchProducts(SAMPLE_CATALOG, "please buy me one").kind).toBe("none");
    // "black" only appears in prose/options — it must not drag in a product on its own.
    expect(matchProducts(SAMPLE_CATALOG, "black").kind).toBe("none");
  });
});

describe("variant choices", () => {
  const sneakers = byId("court-sneakers");

  it("pre-fills the choices the human already made in words", () => {
    expect(prefillVariants(sneakers, "black court sneakers, US 10")).toEqual({ size: "US 10", colour: "Black" });
  });

  it("leaves an AMBIGUOUS choice open rather than guessing", () => {
    expect(prefillVariants(sneakers, "black or white court sneakers")).toEqual({});
  });

  it("drops an off-menu selection instead of honouring it", () => {
    expect(validSelections(sneakers, { size: "US 10", colour: "Neon" })).toEqual({ size: "US 10" });
    expect(validSelections(sneakers, { size: "us 10" })).toEqual({ size: "US 10" }); // case-insensitive
  });

  it("lists what is still unchosen", () => {
    expect(missingVariants(sneakers, { size: "US 10" }).map((v) => v.name)).toEqual(["colour"]);
    expect(missingVariants(byId("oak-whiskey"), {})).toEqual([]);
  });

  it("describes exactly what the human is approving", () => {
    expect(describeChoice(sneakers, { size: "US 10", colour: "Black" })).toBe("Cascade Court Sneakers — US 10, Black ($95.00)");
    expect(describeChoice(byId("oak-whiskey"), {})).toBe("Oak Reserve Whiskey Collection ($124.00)");
  });

  it("ignores a malformed variants declaration on a custom catalog", () => {
    const bogus = { id: "x", name: "X", price: 1, currency: "USD", image: "", category: "C", description: "", variants: "nope" } as unknown as Product;
    expect(missingVariants(bogus, {})).toEqual([]);
    expect(prefillVariants(bogus, "anything")).toEqual({});
  });
});
