// The README's AP2 snippets, verbatim, as a test — "the example IS the DX test". This file is
// also typechecked by `tsc -p tsconfig.test.json` (the package build), so a README example that
// stops compiling against the real types fails the build, not a reader.
//
// Keep each block below in step with the matching block in README.md ("AP2 mandates").
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import express from "express";
import request from "supertest";
import { CredentAgent, publicJwkFromDidDocument, verifyDelegatedPurchase, verifyMandate, VCT, type UcpCheckout } from "../index.js";
import { merchantFor } from "./from-gate.js";
import { AgentKey, DelegatedIntent } from "../agent.js";
import { devSimulateWalletSignature } from "../ceremony/intent-sign/simulate.js";

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

  it("delegated purchases: two processes — the merchant opens a grant, the agent spends it, the merchant verifies", async () => {
    const ORIGIN = "http://shop.example";
    const catalog = { coffee: { price: 4.5 }, tea: { price: 3 } };
    const credentagent = new CredentAgent({ walletOrigin: ORIGIN, catalog, gateSecret: "stable-test-secret" });
    const app = express();
    app.use(express.json());
    credentagent.grants.serve(app);
    const AGENT_KEY = JSON.stringify(AgentKey.generate().exportPrivateJwk());
    const agentPublicJwk = AgentKey.fromJwk(JSON.parse(AGENT_KEY)).publicJwk; // what the agent sends the merchant
    const sendToUser = (_url: string) => undefined;
    const catalogTotal = (cart: UcpCheckout) => cart.line_items.reduce((s, l) => s + catalog[l.item.id as keyof typeof catalog].price * 100 * l.quantity, 0);
    const nonce = "merchant-nonce";

    // ── README block: MERCHANT — open a grant naming the agent's PUBLIC key ──
    const grant = await credentagent.grants.create({
      merchant: "utopia", budget: 200, perSpend: 50,
      allow: { skus: ["coffee", "tea"] },
      agentKey: agentPublicJwk, // agentKey.publicJwk, as the agent sent it
    });
    sendToUser(grant.approveUrl); // the person signs on their phone

    // The person signs — the real rail, a simulated wallet.
    const req = await request(app).get(`/credentagent/grants/${grant.id}/sign/request`).set("Host", "shop.example");
    const result = await devSimulateWalletSignature({ request: { request: req.body.requests[0].data.request, dcql_query: req.body.dcql_query }, origin: ORIGIN });
    await request(app).post(`/credentagent/grants/${grant.id}/sign/verify`).set("Host", "shop.example").send({ readerContextToken: req.body.readerContextToken, result });
    const signedIntent = (await credentagent.grants.retrieve(grant.id))!.mandate!.intent!;

    const ucpCheckout: UcpCheckout = { ...{ id: "ord_1", status: "ready_for_complete", currency: "USD", links: [] }, merchant: merchantFor(ORIGIN, "utopia"), line_items: [{ id: "li_1", item: { id: "coffee", title: "Coffee", price: 450 }, quantity: 1, totals: [{ type: "total", amount: 450 }] }], totals: [{ type: "total", amount: 450 }] };
    // What the agent receives — the quote, as the merchant block below sends it.
    let quoted: { checkoutJwt: string; nonce: string } | undefined;
    const sendToAgent = (msg: { checkoutJwt: string; nonce: string }) => (quoted = msg);
    const spentAt = new Map<string, { amount: number; uses: number }>();
    const ledger = {
      spent: (id: string) => spentAt.get(id) ?? { amount: 0, uses: 0 },
      record: (id: string, paid: { amount: number }) => spentAt.set(id, { amount: ledger.spent(id).amount + paid.amount, uses: ledger.spent(id).uses + 1 }),
    };

    // ── README block: MERCHANT — quote the cart ──
    sendToAgent({ checkoutJwt: credentagent.ap2.signCheckout(ucpCheckout), nonce }); // the quote
    const { checkoutJwt } = quoted!;
    const instrument = { id: "demo-instrument-0001", type: "card" };

    // ── README block: AGENT — the `/agent` entry point ──
    const agentKey = AgentKey.fromJwk(JSON.parse(AGENT_KEY)); // or AgentKey.generate()
    const intent = DelegatedIntent.fromWalletPresentation(signedIntent); // plain JSON — keep it
    const proof = await intent.spend({
      agentKey,
      checkoutJwt, // the cart, as the merchant quoted it
      instrument, // how it pays — the payee and the amount are the cart's own
      audience: ORIGIN, // the merchant, and the nonce it issued
      nonce,
    });

    // ── README block: MERCHANT — one call per purchase ──
    const verdict = await verifyDelegatedPurchase(proof, {
      trust: "presence-only-demo", // REQUIRED: nothing yet proves a person set these limits (#14)
      audience: ORIGIN,
      nonce,
      checkoutKey: credentagent.ap2.checkoutPublicJwk, // the key that quoted the cart
      spent: (permissionId) => ledger.spent(permissionId), // what THIS store already spent under it
      price: (cart) => catalogTotal(cart), // YOUR catalog, in minor units — it decides
    });
    if (verdict.ok) ledger.record(verdict.permissionId, verdict.payment.payment_amount);
    else console.error(verdict.code, verdict.violations);
    expect(verdict.ok).toBe(true);
    expect(ledger.spent(intent.permissionId)).toEqual({ amount: 450, uses: 1 });
  });
});
