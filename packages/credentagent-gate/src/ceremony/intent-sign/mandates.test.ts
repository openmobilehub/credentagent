// A category-bounded grant names no products. Putting its empty `skus` list into AP2's
// `checkout.line_items` said "nothing may be bought" — the constraint's own meaning — for a
// grant the human had approved for a whole category. Found on a device: the wallet's consent
// screen showed "Checkout line items: (none)".
import { describe, expect, it } from "vitest";
import { openMandatesForGrant } from "./mandates.js";
import { generateDelegate } from "../mandate.js";
import type { IntentBoundsInput } from "./bounds.js";

/** A REAL P-256 agent key — the same reason as in `presentation.test.ts`. */
const { delegate: DELEGATE } = await generateDelegate();
const EXP = 4102444800;

function bounds(over: Partial<IntentBoundsInput> = {}): IntentBoundsInput {
  return {
    grantId: "grant_abc",
    merchant: "utopia",
    budget: 200,
    perSpend: 130,
    createdAt: "2026-01-01T00:00:00.000Z",
    nonce: "n",
    ...over,
  };
}

const build = (allowedSkus: string[], over: Partial<IntentBoundsInput> = {}) =>
  openMandatesForGrant({ bounds: bounds(over), origin: "https://shop.example", delegate: DELEGATE, exp: EXP, allowedSkus });

describe("what a grant's mandates say may be bought", () => {
  it("carries the RESOLVED products, not the bounds' own (possibly empty) sku list", () => {
    // The grant is bounded by category and names no skus; the catalog scan resolved two.
    const [checkout] = build(["coffee", "espresso-machine"], { allow: { categories: ["Beverages"] } });
    const lineItems = (checkout.constraints as { type: string; items?: { acceptable_items: { id: string }[] }[] }[])
      .find((c) => c.type === "checkout.line_items");
    // One requirement per allowed product — the simplest case of UCP's "these items, this many".
    expect(lineItems?.items?.flatMap((r) => r.acceptable_items.map((i) => i.id))).toEqual(["coffee", "espresso-machine"]);
  });

  // BYPASS-adjacent: an empty list is not a tighter bound, it is a WRONG one. The approve page
  // told the human what they could buy; a mandate authorizing nothing contradicts it, and the
  // grant would be unspendable for a reason nobody could see.
  it("refuses to mint when nothing resolves, rather than authorize nothing", () => {
    expect(() => build([], { allow: { categories: ["Nonexistent"] } })).toThrow(/authorize nothing/);
  });
});
