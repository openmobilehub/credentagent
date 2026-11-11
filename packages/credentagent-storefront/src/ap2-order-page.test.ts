// A delegated order's page: the AP2 payload as JSON, plus a receipt that links it. Demo-only.
// The payload route reads the full record; EVERY other reader (the widget's order-status poll,
// get-order-status) must keep the agent's raw signed chains out of what it returns.
import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { CredentAgent, devSimulateWalletSignature } from "@openmobilehub/credentagent-gate";
import { AgentKey, DelegatedIntent } from "@openmobilehub/credentagent-gate/agent";
import { createStorefront } from "./server.js";

const HOST = "shop.example";
const ORIGIN = `http://${HOST}`;

/** A storefront with grants wired, and one real agent-signed purchase recorded through it. */
async function storeWithOnePurchase() {
  const agentKey = AgentKey.generate();
  const credentagent = new CredentAgent({ walletOrigin: ORIGIN, catalog: { coffee: { price: 18, category: "Beverages" } }, gateSecret: "stable-test-secret" });
  const store = createStorefront({ baseUrl: ORIGIN, grants: credentagent.grants, merchant: "utopia", allowEphemeralKey: true });
  credentagent.mount(store.app);
  credentagent.grants.serve(store.app);
  const app: Express = store.app;
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
  return { app, orderId: r.body.receipt.orderId as string };
}

describe("GET /checkout/order-payload", () => {
  it("returns the decoded AP2 payload with the trust level", async () => {
    const { app, orderId } = await storeWithOnePurchase();
    const r = await request(app).get(`/checkout/order-payload?orderId=${orderId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ trustLevel: "presence-only-demo" });
    expect(r.body.intent.checkout.vct).toBe("mandate.checkout.open.1");
    expect(r.body.checkout.vct).toBe("mandate.checkout.1");
    expect(r.body.payment.vct).toBe("mandate.payment.1");
  });

  it("is 404 for an order that has no AP2 payload", async () => {
    const { app } = await storeWithOnePurchase();
    expect((await request(app).get("/checkout/order-payload?orderId=ord_nope")).status).toBe(404);
  });
});

describe("GET /checkout/order", () => {
  it("renders the receipt with the AP2 payload section, the honesty line and the JSON link", async () => {
    const { app, orderId } = await storeWithOnePurchase();
    const r = await request(app).get(`/checkout/order?orderId=${orderId}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("AP2 payload");
    expect(r.text).toContain(`/checkout/order-payload?orderId=${orderId}`);
    expect(r.text).toContain("mandate.checkout.open.1");
    expect(r.text).toContain("presence-only-demo");
    expect(r.text).not.toContain("issuer-verified");
  });

  it("is 404 for an order that has no AP2 payload", async () => {
    const { app } = await storeWithOnePurchase();
    expect((await request(app).get("/checkout/order?orderId=ord_nope")).status).toBe(404);
  });
});

describe("every other reader keeps the agent's raw chains out", () => {
  it("order-status returns the order without the signed chains", async () => {
    const { app, orderId } = await storeWithOnePurchase();
    const r = await request(app).get(`/checkout/order-status?orderId=${orderId}`);
    expect(r.body.completed).toBe(true);
    expect(r.body.order.orderId).toBe(orderId);
    expect(JSON.stringify(r.body)).not.toContain("~~");
    expect(r.body.order.ap2).toBeUndefined();
  });
});
