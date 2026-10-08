// Spec 014, FR-5: the agent holds its own key. The merchant creates a grant naming only the
// agent's PUBLIC key, the person signs it on their phone, and the agent spends the signed
// permission — at a merchant that checks it with `verifyDelegatedPurchase`. The gate never
// generates, holds or spends with the agent's key.
//
// The first test is the acceptance example: two halves, two imports. The merchant half imports the
// package root; the agent half imports `/agent`. Nothing crosses between them but public data.
import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { CredentAgent } from "./client.js";
import { verifyDelegatedPurchase } from "./index.js";
import { AgentKey, DelegatedIntent } from "./agent.js";
import { devSimulateWalletSignature, type SimulateOptions } from "./ceremony/intent-sign/simulate.js";
import { merchantFor } from "./ap2/from-gate.js";
import type { UcpCheckout } from "./ap2/types.js";

const CATALOG = { coffee: { price: 18, category: "Beverages" }, tea: { price: 12, category: "Beverages" } };
const HOST = "shop.example";
const ORIGIN = `http://${HOST}`;

function merchant() {
  const credentagent = new CredentAgent({ walletOrigin: ORIGIN, catalog: CATALOG, gateSecret: "stable-test-secret" });
  const app = express();
  app.use(express.json());
  credentagent.grants.serve(app);
  return { credentagent, app };
}

/** The person signs the grant on their phone — the real rail, a simulated wallet. `wallet` makes
 *  that wallet behave like a particular real one (e.g. how it types its key binding). */
async function signOnPhone(app: Express, id: string, wallet: Pick<SimulateOptions, "overrideKbTyp"> = {}) {
  const req = await request(app).get(`/credentagent/grants/${id}/sign/request`).set("Host", HOST);
  expect(req.status).toBe(200);
  const oid = req.body as { requests: { data: { request: string } }[]; dcql_query: unknown; readerContextToken: string };
  const result = await devSimulateWalletSignature({
    request: { request: oid.requests[0].data.request, dcql_query: oid.dcql_query as never },
    origin: ORIGIN,
    ...wallet,
  });
  return request(app)
    .post(`/credentagent/grants/${id}/sign/verify`)
    .set("Host", HOST)
    .send({ readerContextToken: oid.readerContextToken, result });
}

const coffeeCart = (): UcpCheckout => ({
  id: "ord_1",
  merchant: merchantFor(ORIGIN, "utopia"),
  line_items: [
    { id: "li_1", item: { id: "coffee", title: "Coffee", price: 1800 }, quantity: 1, totals: [{ type: "total", amount: 1800 }] },
  ],
  status: "ready_for_complete",
  currency: "USD",
  totals: [{ type: "total", amount: 1800 }],
  links: [],
});

/** A signed grant whose key the agent holds — merchant side and agent side, apart. */
async function signedAgentGrant() {
  const agentKey = AgentKey.generate(); // AGENT process
  const { credentagent, app } = merchant(); // MERCHANT process — it receives only the public key
  const created = await credentagent.grants.create({
    merchant: "utopia",
    budget: 200,
    perSpend: 30,
    allow: { skus: ["coffee"] },
    agentKey: agentKey.publicJwk,
  });
  const signed = await signOnPhone(app, created.id);
  expect(signed.body).toMatchObject({ ok: true, status: "authorized" });
  const grant = (await credentagent.grants.retrieve(created.id))!;
  return { agentKey, credentagent, grant };
}

describe("a grant whose key the agent holds (FR-5)", () => {
  it("is signed on the phone, spent by the agent, and verified by the merchant", async () => {
    const { agentKey, credentagent, grant } = await signedAgentGrant();
    expect(grant.status).toBe("authorized");
    expect(grant.presence).toBe("delegated");

    // AGENT — keeps the permission, spends it on one purchase.
    const intent = DelegatedIntent.fromWalletPresentation(grant.mandate!.intent!);
    const quote = credentagent.ap2.signCheckout(coffeeCart()); // the merchant's quote, as the agent receives it
    const proof = await intent.spend({
      agentKey,
      checkoutJwt: quote,
      instrument: { id: "demo-instrument-0001", type: "card" },
      audience: ORIGIN,
      nonce: "merchant-nonce",
    });

    // MERCHANT — one call.
    const verdict = await verifyDelegatedPurchase(proof, {
      trust: "presence-only-demo",
      audience: ORIGIN,
      nonce: "merchant-nonce",
      checkoutKey: credentagent.ap2.checkoutPublicJwk,
      spent: { amount: 0, uses: 0 },
      price: (cart) => cart.line_items.reduce((sum, l) => sum + CATALOG[l.item.id as keyof typeof CATALOG].price * 100 * l.quantity, 0),
    });
    expect(verdict).toMatchObject({ ok: true, trust_level: "presence-only-demo" });
  });

  it("the phone signs a permission naming the AGENT's key — the gate makes none of its own (bypass)", async () => {
    const { agentKey, grant } = await signedAgentGrant();
    const intent = DelegatedIntent.fromWalletPresentation(grant.mandate!.intent!);
    expect(intent.openCheckout.cnf.jwk).toEqual(agentKey.publicJwk);
    expect(intent.openPayment.cnf.jwk).toEqual(agentKey.publicJwk);
    expect(grant.agentKey).toEqual(agentKey.publicJwk);
  });

  it("refuses to spend through the gate's own door — the gate has no key to spend it with (bypass)", async () => {
    const { grant } = await signedAgentGrant();
    expect(await grant.spend({ idempotencyKey: "k1", items: [{ sku: "coffee" }] })).toEqual({ ok: false, code: "agent-held-key" });
  });

  it("refuses an agent PRIVATE key — the gate must never hold it (bypass)", async () => {
    const { credentagent } = merchant();
    const leaked = AgentKey.generate().exportPrivateJwk();
    await expect(
      credentagent.grants.create({ merchant: "utopia", budget: 200, perSpend: 30, allow: { skus: ["coffee"] }, agentKey: leaked as never }),
    ).rejects.toThrow(/PUBLIC key/);
  });

  it("refuses an agent key on a page-approved grant — a click binds nothing to a key", async () => {
    const { credentagent } = merchant();
    await expect(
      credentagent.grants.create({
        merchant: "utopia",
        budget: 200,
        perSpend: 30,
        signing: "page",
        agentKey: AgentKey.generate().publicJwk,
      }),
    ).rejects.toThrow(/signing: "device"/);
  });

  it("refuses to authorize without the signed permission — there would be nothing to spend (bypass)", async () => {
    const { credentagent } = merchant();
    const g = await credentagent.grants.create({
      merchant: "utopia",
      budget: 200,
      perSpend: 30,
      allow: { skus: ["coffee"] },
      agentKey: AgentKey.generate().publicJwk,
    });
    const mandates = [{ constraints: [{ type: "checkout.line_items", items: [{ acceptable_items: [{ id: "coffee" }] }] }] }];
    const evidence = {
      boundsHash: "h",
      signedAt: new Date().toISOString(),
      credentialType: "com.emvco.dpc",
      verifiedBy: "gate",
      trustLevel: "device-signed" as const,
      mandates,
    };
    expect(await credentagent.grants._authorizeDevice(g.id, evidence)).toBe(false);
    expect((await credentagent.grants.retrieve(g.id))!.status).toBe("pending");
  });

  it("shows the signed permission only on a grant the agent's key spends", async () => {
    const { credentagent, app } = merchant();
    const g = await credentagent.grants.create({
      merchant: "utopia",
      budget: 200,
      perSpend: 30,
      allow: { skus: ["coffee"] },
      signing: "device",
    });
    expect((await signOnPhone(app, g.id)).body).toMatchObject({ ok: true });
    const gateHeld = (await credentagent.grants.retrieve(g.id))!;
    expect(gateHeld.mandate?.mandates).toBeDefined();
    expect(gateHeld.mandate?.intent).toBeUndefined();
    expect(gateHeld.agentKey).toBeUndefined();
  });

  // A real wallet (Multipaz) typed its key binding `kb+sd-jwt` while the mandates it signed
  // name the agent's key. Delegate SD-JWT §5.1.4 makes that hop a KB-SD-JWT+KB, `kb+sd-jwt+kb`, and
  // the merchant's chain verifier refuses anything else. The signing page used to accept it and show
  // "signed"; every merchant then refused the purchase, after the person had left.
  it("refuses at signing a wallet hop typed terminal (`kb+sd-jwt`) — the grant stays pending (bypass)", async () => {
    const { credentagent, app } = merchant();
    const g = await credentagent.grants.create({
      merchant: "utopia",
      budget: 200,
      perSpend: 30,
      allow: { skus: ["coffee"] },
      agentKey: AgentKey.generate().publicJwk,
    });
    const signed = await signOnPhone(app, g.id, { overrideKbTyp: "kb+sd-jwt" });
    expect(signed.status).toBe(400);
    expect(signed.body).toMatchObject({ ok: false, reason: expect.stringContaining("kb+sd-jwt+kb") });
    expect(signed.body.reason).toContain("§5.1.4");
    const after = (await credentagent.grants.retrieve(g.id))!;
    expect(after.status).toBe("pending");
    expect(after.mandate?.intent).toBeUndefined();
  });

  // The other half: what the check spares. The same grant, typed `kb+sd-jwt+kb`, authorizes — and
  // the permission it hands the agent is one a merchant's `verifyDelegatedPurchase` accepts.
  it("authorizes the same grant when the wallet types its hop `kb+sd-jwt+kb`", async () => {
    const { credentagent, app } = merchant();
    const g = await credentagent.grants.create({
      merchant: "utopia",
      budget: 200,
      perSpend: 30,
      allow: { skus: ["coffee"] },
      agentKey: AgentKey.generate().publicJwk,
    });
    expect((await signOnPhone(app, g.id, { overrideKbTyp: "kb+sd-jwt+kb" })).body).toMatchObject({ ok: true, status: "authorized" });
  });
});

describe("a grant that leaves `signing` out is a device grant", () => {
  it("can start its phone ceremony — it was minted the key the wallet signs over", async () => {
    const { credentagent, app } = merchant();
    const g = await credentagent.grants.create({ merchant: "utopia", budget: 200, perSpend: 30, allow: { skus: ["coffee"] } });
    expect(g.signing).toBe("device");
    expect((await request(app).get(`/credentagent/grants/${g.id}/sign/request`).set("Host", HOST)).status).toBe(200);
  });
});
