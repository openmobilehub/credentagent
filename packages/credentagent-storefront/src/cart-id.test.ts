// The cart id a session-less (MCP 2026-07-28) conversation keeps. It round-trips through the client,
// so every REFUSES test here is a bypass test: an invented or edited id never names a cart.
import { describe, it, expect } from "vitest";
import { cartIds } from "./cart-id.js";

const ids = cartIds("test-secret");

describe("cart ids", () => {
  it("recognizes an id it issued", () => {
    expect(ids.verify(ids.mint())).toBe(true);
  });

  it("issues a different id every time", () => {
    const minted = new Set(Array.from({ length: 50 }, () => ids.mint()));
    expect(minted.size).toBe(50);
  });

  it("REFUSES an id the agent made up — two conversations inventing the same id must not share a cart", () => {
    for (const invented of ["cart_1", "cart_abc", `cart_${"A".repeat(22)}_${"A".repeat(22)}`]) {
      expect(ids.verify(invented)).toBe(false);
    }
  });

  it("REFUSES an issued id with its random part edited", () => {
    const [, random, tag] = ids.mint().split("_");
    const edited = `cart_${random.startsWith("A") ? "B" : "A"}${random.slice(1)}_${tag}`;
    expect(ids.verify(edited)).toBe(false);
  });

  it("REFUSES an id issued by another store", () => {
    expect(ids.verify(cartIds("someone-elses-secret").mint())).toBe(false);
  });

  it("REFUSES things that aren't cart ids", () => {
    for (const junk of ["", "cart1.abc.def", "not an id", "cart__"]) expect(ids.verify(junk)).toBe(false);
  });
});
