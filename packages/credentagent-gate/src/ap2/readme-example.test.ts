// The README's AP2 snippets, verbatim, as a test — "the example IS the DX test". This file is
// also typechecked by `tsc -p tsconfig.test.json` (the package build), so a README example that
// stops compiling against the real types fails the build, not a reader.
//
// Keep each block below in step with the matching block in README.md ("AP2 mandates").
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import express from "express";
import request from "supertest";
import { CredentAgent, DelegatedIntent, publicJwkFromDidDocument, verifyDelegatedPurchase, verifyMandate, VCT, type UcpCheckout } from "../index.js";
import { merchantFor } from "./from-gate.js";
import { testGrant } from "./chain/test-wallet.js";

const ucpCheckout: UcpCheckout = {
  id: "ord_1",
  line_items: [{ id: "li_1", item: { id: "wine", title: "Wine", price: 12400 }, quantity: 1, totals: [{ type: "total", amount: 12400 }] }],
  status: "ready_for_complete",
  currency: "USD",
  totals: [{ type: "total", amount: 12400 }],
  links: [],
};

describe("README — AP2 mandates", () => {
  it("mints, checks, and lets a stranger check from did.json alone", async () => {
    const app = express();
    const MANDATE_SIGNING_KEY = JSON.stringify(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }));

    // ── README block: configure ──
    const credentagent = new CredentAgent({
      walletOrigin: "https://shop.example",
      mandateSigningKey: JSON.parse(MANDATE_SIGNING_KEY), // a PRIVATE P-256 JWK
    });
    credentagent.mount(app); // serves GET /.well-known/did.json

    // ── README block: mint and check ──
    const checkout = await credentagent.ap2.checkout({ checkout: ucpCheckout });
    const mandate = await credentagent.ap2.payment({
      transactionId: checkout.checkoutHash,
      payee: { id: "shop-1", name: "Shop" },
      amount: { amount: 12400, currency: "USD" },
      instrument: { id: "pi_1", type: "card", description: "Visa ••4242" },
    });

    const verdict = await verifyMandate(mandate.token, { publicJwk: credentagent.ap2.publicJwk, expect: VCT.payment });
    expect(verdict.ok).toBe(true);

    // ── README block: anyone else checks it ──
    const doc = (await request(app).get("/.well-known/did.json")).body;
    const theirs = await verifyMandate(mandate.token, { publicJwk: publicJwkFromDidDocument(doc) });
    expect(theirs.ok).toBe(true);
  });

  it("delegated purchases: the agent spends, the merchant verifies", async () => {
    const g = await testGrant();
    const credentagent = new CredentAgent({ walletOrigin: "https://shop.example", mandateSigningKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }) as never });
    const { presentation, disclosures } = g;
    const agentKey = g.agent.privateKey;
    const nonce = "merchant-nonce";
    const shopCheckout: UcpCheckout = { ...ucpCheckout, merchant: merchantFor("https://shop.example"), line_items: [{ id: "li_1", item: { id: "coffee", title: "Coffee", price: 450 }, quantity: 1, totals: [{ type: "total", amount: 450 }] }], totals: [{ type: "total", amount: 450 }] };
    const checkoutJwt = credentagent.ap2.signCheckout(shopCheckout);
    const payee = merchantFor("https://shop.example");
    const instrument = { id: "pi_1", type: "card" };
    const catalogTotal = (cart: UcpCheckout) => cart.line_items.reduce((s, l) => s + l.item.price * l.quantity, 0);

    // ── README block: delegated purchases ──
    const intent = DelegatedIntent.fromWalletPresentation({ presentation, disclosures });
    const proof = await intent.spend({
      agentKey,
      checkoutJwt,
      payment: { payee, amount: { amount: 450, currency: "USD" }, instrument },
      audience: "https://shop.example",
      nonce,
    });

    const verdict = await verifyDelegatedPurchase(proof, {
      audience: "https://shop.example",
      nonce,
      checkoutKey: credentagent.ap2.publicJwk,
      spent: { amount: 0, uses: 0 },
      price: (cart) => catalogTotal(cart),
    });
    expect(verdict.ok).toBe(true);
  });
});
