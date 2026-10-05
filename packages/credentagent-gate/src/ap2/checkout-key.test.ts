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

const ORIGIN = "https://shop.example";
const privateJwk = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }) as unknown as PrivateJwkP256;

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

  it("REFUSES a cart signed with the MANDATE key — only the checkout key quotes carts (bypass)", () => {
    const mandateKey = resolveSigningKey(ORIGIN);
    const ap2 = new Ap2Issuer(mandateKey);
    const wrongRole = signCompactJwt(cart, mandateKey.privateKey, mandateKey.kid);
    expect(verifyCompactJwt(wrongRole, ap2.checkoutPublicJwk)).toBeUndefined();
  });

  it("REFUSES a cart whose kid names the other role, even when the signature is good (bypass)", () => {
    const checkoutKey = resolveSigningKey(ORIGIN, undefined, CHECKOUT_KEY_FRAGMENT);
    const mislabelled = signCompactJwt(cart, checkoutKey.privateKey, `did:web:shop.example#${KEY_FRAGMENT}`);
    expect(verifyCompactJwt(mislabelled, checkoutKey.publicJwk)).toBeUndefined();
  });

  it("REFUSES the same key configured for both roles (bypass)", () => {
    const one = privateJwk();
    expect(() => new CredentAgent({ walletOrigin: ORIGIN, mandateSigningKey: one, checkoutSigningKey: one })).toThrow(/different key/);
    expect(() => new CredentAgent({ walletOrigin: ORIGIN, mandateSigningKey: one, checkoutSigningKey: privateJwk() })).not.toThrow();
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
