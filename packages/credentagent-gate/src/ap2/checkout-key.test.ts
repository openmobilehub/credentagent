// Spec 014, FR-6: the merchant quotes carts with its OWN key, distinct from the key that issues
// mandates, and the `kid` makes the distinction visible. A quoted cart and an issued mandate are
// different statements; a signature must not be readable as the other one.
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import express from "express";
import request from "supertest";
import { CredentAgent } from "../client.js";
import { Ap2Issuer } from "./issue.js";
import { CHECKOUT_KEY_FRAGMENT, KEY_FRAGMENT, publicJwkFromDidDocument, resolveSigningKey, type PrivateJwkP256 } from "./keys.js";
import { signCompactJwt, verifyCompactJwt } from "./jwt.js";
import type { UcpCheckout } from "./types.js";
import { lineItemsProblem, MAX_CART_UNITS } from "../index.js";

const ORIGIN = "https://shop.example";
const privateJwk = () =>
  generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }) as unknown as PrivateJwkP256;

const cart: UcpCheckout = {
  id: "ord_1",
  merchant: { id: "shop.example", name: "Shop" },
  line_items: [{ id: "li_1", item: { id: "coffee", title: "Coffee", price: 450 }, quantity: 1, totals: [{ type: "total", amount: 450 }] }],
  status: "ready_for_complete",
  currency: "USD",
  totals: [{ type: "total", amount: 450 }],
  links: [],
};

describe("the merchant's checkout key (FR-6)", () => {
  it("signs carts under its own kid, apart from the mandate key", () => {
    const ap2 = new Ap2Issuer(resolveSigningKey(ORIGIN));
    expect(ap2.checkoutPublicJwk.kid).toBe(`did:web:shop.example#${CHECKOUT_KEY_FRAGMENT}`);
    expect(ap2.publicJwk.kid).toBe(`did:web:shop.example#${KEY_FRAGMENT}`);
    expect(ap2.checkoutPublicJwk.x).not.toBe(ap2.publicJwk.x);

    const quote = ap2.signCheckout(cart);
    expect(verifyCompactJwt(quote, ap2.checkoutPublicJwk)).toEqual(cart);
  });

  it("refuses a cart signed with the MANDATE key — only the checkout key quotes carts (bypass)", () => {
    const mandateKey = resolveSigningKey(ORIGIN);
    const ap2 = new Ap2Issuer(mandateKey);
    const wrongRole = signCompactJwt(cart, mandateKey.privateKey, mandateKey.kid);
    expect(verifyCompactJwt(wrongRole, ap2.checkoutPublicJwk)).toBeUndefined();
  });

  it("refuses a cart whose kid names the other role, even when the signature is good (bypass)", () => {
    const checkoutKey = resolveSigningKey(ORIGIN, undefined, CHECKOUT_KEY_FRAGMENT);
    const mislabelled = signCompactJwt(cart, checkoutKey.privateKey, `did:web:shop.example#${KEY_FRAGMENT}`);
    expect(verifyCompactJwt(mislabelled, checkoutKey.publicJwk)).toBeUndefined();
  });

  it("refuses the same key configured for both roles (bypass)", () => {
    const shared = resolveSigningKey(ORIGIN);
    expect(() => new Ap2Issuer(shared, { checkoutKey: shared })).toThrow(/different key/);
    const one = privateJwk();
    expect(() => new CredentAgent({ walletOrigin: ORIGIN, mandateSigningKey: one, checkoutSigningKey: one })).toThrow(/different key/);
    expect(() => new CredentAgent({ walletOrigin: ORIGIN, mandateSigningKey: one, checkoutSigningKey: privateJwk() })).not.toThrow();
  });

  it("fills in this gate's merchant, and refuses a cart that names another", () => {
    const credentagent = new CredentAgent({ walletOrigin: ORIGIN });
    const { merchant: _none, ...unnamed } = cart;
    void _none;
    const signed = verifyCompactJwt<UcpCheckout>(credentagent.ap2.signCheckout(unnamed), credentagent.ap2.checkoutPublicJwk);
    expect(signed?.merchant).toEqual(credentagent.ap2.merchant);
    expect(credentagent.ap2.merchant).toMatchObject({ id: "shop.example" });
    expect(() => credentagent.ap2.signCheckout({ ...cart, merchant: { id: "other.example", name: "Other" } })).toThrow(
      /signs as shop.example/,
    );
  });

  // #286: a line of quantity −1 lowers the total without breaking any limit. The store that quotes
  // the cart is the first place to refuse it — a cart it never signs, no agent can pay for.
  it("refuses to quote a line that is not a real purchase — quantity below 1, or no positive price (bypass)", () => {
    const ap2 = new Ap2Issuer(resolveSigningKey(ORIGIN));
    const coffee = cart.line_items[0];
    const tea = { ...coffee, id: "li_2", item: { id: "tea", title: "Tea", price: 950 }, totals: [{ type: "total" as const, amount: 950 }] };
    for (const bad of [
      { ...tea, quantity: -1, totals: [{ type: "total" as const, amount: -950 }] },
      { ...tea, quantity: 0, totals: [{ type: "total" as const, amount: 0 }] },
      { ...tea, quantity: 1.5 },
      { ...tea, item: { ...tea.item, price: 0 } },
      { ...tea, item: { ...tea.item, price: -950 } },
      { ...tea, totals: [{ type: "total" as const, amount: -950 }] },
      { ...tea, totals: [] },
    ]) {
      expect(() => ap2.signCheckout({ ...cart, line_items: [coffee, bad] })).toThrow(/line li_2/);
      // The pre-check a store answers 400 with is the same rule, word for word.
      expect(lineItemsProblem([coffee, bad])).toMatch(/^line li_2/);
    }
    const bulk = { ...tea, quantity: MAX_CART_UNITS, totals: [{ type: "total" as const, amount: 950 * MAX_CART_UNITS }] };
    expect(() => ap2.signCheckout({ ...cart, line_items: [coffee, bulk] })).toThrow(/units/);
    expect(() => ap2.signCheckout({ ...cart, line_items: [coffee, tea] })).not.toThrow();
    expect(lineItemsProblem([coffee, tea])).toBeUndefined();
  });

  it("publishes both keys at /.well-known/did.json — the mandate key first", async () => {
    const credentagent = new CredentAgent({ walletOrigin: ORIGIN, mandateSigningKey: privateJwk(), checkoutSigningKey: privateJwk() });
    const app = express();
    credentagent.mount(app);
    const doc = (await request(app).get("/.well-known/did.json")).body;

    // A reader that takes the first assertion method still gets the mandate key, as before.
    expect(publicJwkFromDidDocument(doc)).toMatchObject({ x: credentagent.ap2.publicJwk.x });
    const checkoutKid = credentagent.ap2.checkoutPublicJwk.kid!;
    const published = publicJwkFromDidDocument(doc, checkoutKid);
    expect(published).toMatchObject({ x: credentagent.ap2.checkoutPublicJwk.x, kid: checkoutKid });
    expect(verifyCompactJwt(credentagent.ap2.signCheckout(cart), published)).toEqual(cart);
  });
});
