// The AP2 payload a delegated order's page shows: the four mandates, decoded, and nothing else.
// Demo-only (the page says so): it exists so a reviewer can see that the payload that reached the
// server is AP2 — the open mandates the wallet signed, the closed ones the agent signed.
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { CredentAgent } from "../client.js";
import { AgentKey, DelegatedIntent } from "../agent.js";
import { devSimulateWalletSignature } from "../ceremony/intent-sign/simulate.js";
import { ap2PayloadView } from "./payload-view.js";
import { VCT } from "./types.js";

const HOST = "shop.example";
const ORIGIN = `http://${HOST}`;

/** One real purchase through the routes; returns the `ap2` record the store wrote for it. */
async function onePurchase() {
  const agentKey = AgentKey.generate();
  const credentagent = new CredentAgent({ walletOrigin: ORIGIN, catalog: { coffee: { price: 18, category: "Beverages" } }, gateSecret: "stable-test-secret" });
  const written = new Map<string, { ap2: Parameters<typeof ap2PayloadView>[0] }>();
  const app = express();
  app.use(express.json());
  app.locals.credentagent = { completedOrderStore: { write: async (id: string, v: never) => void written.set(id, v) } };
  credentagent.grants.serve(app);
  const g = await credentagent.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, allow: { skus: ["coffee"] }, agentKey: agentKey.publicJwk });
  const sreq = (await request(app).get(`/credentagent/grants/${g.id}/sign/request`).set("Host", HOST)).body;
  const result = await devSimulateWalletSignature({ request: { request: sreq.requests[0].data.request, dcql_query: sreq.dcql_query }, origin: ORIGIN });
  await request(app).post(`/credentagent/grants/${g.id}/sign/verify`).set("Host", HOST).send({ readerContextToken: sreq.readerContextToken, result });
  const base = `/credentagent/grants/${g.id}`;
  const q = (await request(app).post(`${base}/purchases`).set("Host", HOST).send({ sku: "coffee" })).body.quote;
  const intent = (await request(app).get(`${base}/delegation`).set("Host", HOST)).body.intent;
  const proof = await DelegatedIntent.fromWalletPresentation(intent).spend({ agentKey, checkoutJwt: q.checkoutJwt, instrument: { id: "demo-instrument-0001", type: "card" }, audience: q.audience, nonce: q.nonce });
  const r = await request(app).post(`${base}/purchases/${q.nonce}/proof`).set("Host", HOST).send({ proof });
  expect(r.body.ok).toBe(true);
  return [...written.values()][0].ap2;
}

describe("ap2PayloadView", () => {
  it("returns the four mandates decoded, tagged by their AP2 type", async () => {
    const view = ap2PayloadView(await onePurchase());
    expect(view.intent.checkout.vct).toBe(VCT.openCheckout);
    expect(view.intent.payment.vct).toBe(VCT.openPayment);
    expect(view.checkout.vct).toBe(VCT.checkout);
    expect(view.payment.vct).toBe(VCT.payment);
    expect(view.payment).toMatchObject({ payment_amount: { amount: 1800, currency: "USD" } });
    expect(view.trustLevel).toBe("presence-only-demo");
  });

  it("carries the limits the wallet signed on the open payment mandate", async () => {
    const view = ap2PayloadView(await onePurchase());
    expect(Array.isArray(view.intent.payment.constraints)).toBe(true);
    expect((view.intent.payment.constraints as unknown[]).length).toBeGreaterThan(0);
  });

  it("exposes no claim outside the mandates (the credential at the root of the chain stays out)", async () => {
    const rec = await onePurchase();
    // Smuggle an extra claim into the root credential's disclosures: a view that rendered the
    // credential, instead of only the mandates, would show it.
    const extra = Buffer.from(JSON.stringify(["salt", "favorite_color", "ultramarine-7731"])).toString("base64url");
    const poisoned = { ...rec, proof: { checkout: rec.proof.checkout.replace("~", `~${extra}~`), payment: rec.proof.payment.replace("~", `~${extra}~`) } };
    const text = JSON.stringify(ap2PayloadView(poisoned));
    expect(text).not.toContain("ultramarine-7731");
    expect(text).not.toContain("favorite_color");
    expect(Object.keys(ap2PayloadView(poisoned)).sort()).toEqual(["checkout", "intent", "payment", "trustLevel"]);
  });
});
