import { describe, it, expect } from "vitest";
import {
  priceCart,
  createOrder,
  requiredAgeForLines,
  SAMPLE_CATALOG,
  LOYALTY_DISCOUNT_PCT,
  type Product,
} from "./index.js";

const catalog: Product[] = SAMPLE_CATALOG;

describe("priceCart", () => {
  it("prices known items and collects unknown ids (does not throw)", () => {
    const c = priceCart(
      [{ productId: "aurora-headphones", quantity: 2 }, { productId: "ghost", quantity: 1 }],
      catalog,
    );
    expect(c.itemCount).toBe(2);
    expect(c.subtotal).toBe(398);
    expect(c.total).toBe(398);
    expect(c.unknownIds).toEqual(["ghost"]);
    expect(c.hasAgeRestricted).toBe(false);
  });

  it("flags age-restricted carts", () => {
    const c = priceCart([{ productId: "oak-whiskey", quantity: 1 }], catalog);
    expect(c.hasAgeRestricted).toBe(true);
  });

  it("applies the loyalty discount and keeps line sum, subtotal and total in agreement", () => {
    const c = priceCart([{ productId: "oak-whiskey", quantity: 1 }], catalog, { loyaltyApplied: true });
    expect(c.subtotal).toBe(124);
    expect(c.discount).toBe(round2(124 * (LOYALTY_DISCOUNT_PCT / 100)));
    expect(c.total).toBe(round2(c.subtotal - c.discount));
    // the line sum still reconciles with subtotal (amount-binding invariant)
    expect(c.lines.reduce((s, l) => s + l.lineTotal, 0)).toBe(c.subtotal);
  });

  it("honors a per-call discount percent override", () => {
    const c = priceCart([{ productId: "aurora-headphones", quantity: 1 }], catalog, {
      loyaltyApplied: true,
      loyaltyDiscountPct: 25,
    });
    expect(c.discount).toBe(round2(199 * 0.25));
  });

  it("ignores non-positive quantities", () => {
    const c = priceCart([{ productId: "aurora-headphones", quantity: 0 }], catalog);
    expect(c.lines).toHaveLength(0);
  });

  // Regression (PR #42 review — finding 2). The gate package's flagship prescription example
  // keys `appliesTo` on `requiresRx`, but priceCart forwards a fixed field set and drops it, so
  // the gate can never apply on the reference storefront — an Rx product checks out unproven while
  // the README claims "enforced end-to-end". priceCart must forward requiresRx onto the priced line
  // (and Product must carry it) for the documented example to be enforceable end-to-end.
  it("forwards requiresRx from the product onto the priced line (finding 2)", () => {
    const rxCatalog: Product[] = [
      { id: "amoxicillin", name: "Amoxicillin 500mg", price: 30, currency: "USD", image: "", category: "Pharmacy", description: "Rx antibiotic", requiresRx: true },
    ];
    const c = priceCart([{ productId: "amoxicillin", quantity: 1 }], rxCatalog);
    expect(c.lines[0].requiresRx).toBe(true);
  });

  // finding 2 (deeper): forward ANY custom catalog attribute, not just the predefined ones,
  // so a custom `defineCredential` `appliesTo` can key on any product field. Without generic
  // forwarding, a bespoke attribute (`region`, `licenseTier`) is dropped and its gate never
  // applies — the same fail-open class as requiresRx, for arbitrary fields.
  it("forwards ANY custom catalog attribute onto the priced line (finding 2, deeper)", () => {
    const customCatalog: Product[] = [
      { id: "vintage", name: "Vintage Bottle", price: 90, currency: "USD", image: "", category: "Beverages", description: "x", region: "EU", licenseTier: "gold" },
    ];
    const c = priceCart([{ productId: "vintage", quantity: 1 }], customCatalog);
    expect(c.lines[0].region).toBe("EU");
    expect(c.lines[0].licenseTier).toBe("gold");
    // display/pricing fields are NOT forwarded raw — `price` becomes `unitPrice`.
    expect(c.lines[0].price).toBeUndefined();
    expect(c.lines[0].image).toBeUndefined();
    expect(c.lines[0].unitPrice).toBe(90);
  });
});

describe("requiredAgeForLines", () => {
  it("returns the strictest age, or null", () => {
    expect(requiredAgeForLines([{ id: "oak-whiskey" }], catalog)).toBe(21);
    expect(requiredAgeForLines([{ id: "aurora-headphones" }], catalog)).toBeNull();
  });
});

describe("createOrder", () => {
  it("snapshots a priced cart into an order", () => {
    const o = createOrder([{ productId: "oak-whiskey", quantity: 1 }], "ORD-1", catalog);
    expect(o.id).toBe("ORD-1");
    expect(o.total).toBe(124);
    expect(o.lines[0].id).toBe("oak-whiskey");
    expect(typeof o.createdAt).toBe("string");
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
