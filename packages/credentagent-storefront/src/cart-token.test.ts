// The cart token a session-less (MCP 2026-07-28) client carries. It round-trips through the
// client, so every REFUSES test here is a bypass test: an edited or forged token never opens.
import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { cartTokens } from "./cart-token.js";

const carts = cartTokens("test-secret");
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

describe("cart tokens", () => {
  it("round-trips a cart", () => {
    const cart = new Map([["court-sneakers", 1], ["drift-mouse", 2]]);
    expect(carts.open(carts.mint(cart))).toEqual(cart);
  });

  it("round-trips an empty cart", () => {
    expect(carts.open(carts.mint(new Map()))).toEqual(new Map());
  });

  it("REFUSES a token whose contents were edited — the signature no longer matches", () => {
    const [prefix, , sig] = carts.mint(new Map([["court-sneakers", 1]])).split(".");
    const edited = `${prefix}.${b64([["oak-whiskey", 50]])}.${sig}`;
    expect(carts.open(edited)).toBeNull();
  });

  it("REFUSES a token minted with another store's secret", () => {
    const foreign = cartTokens("someone-elses-secret").mint(new Map([["court-sneakers", 1]]));
    expect(carts.open(foreign)).toBeNull();
  });

  it("REFUSES things that aren't cart tokens", () => {
    for (const junk of ["", "cart1", "cart1..", "mrtr1.abc.def", "cart1.a.b.c", "not a token at all"]) {
      expect(carts.open(junk)).toBeNull();
    }
  });

  it("carries ids and quantities only, and refuses anything else even when signed", () => {
    // Correctly signed (mintRaw), so only the shape check can refuse these…
    expect(carts.open(mintRaw([["court-sneakers", 1]]))).toEqual(new Map([["court-sneakers", 1]])); // …as this well-formed one shows
    for (const lines of [[["court-sneakers", 0]], [["court-sneakers", -1]], [["court-sneakers", 1.5]], [[42, 1]], { a: 1 }]) {
      const token = mintRaw(lines);
      expect(carts.open(token)).toBeNull();
    }
  });
});

// Build a correctly-signed token around an arbitrary payload, mirroring cart-token.ts's MAC, so the
// test above proves the SHAPE check refuses it (not the signature check).
function mintRaw(lines: unknown): string {
  const key = createHmac("sha256", "test-secret").update("credentagent/cart-token/v1").digest();
  const payload = b64(lines);
  const mac = createHmac("sha256", key).update(`cart1.${payload}`).digest().toString("base64url");
  return `cart1.${payload}.${mac}`;
}
