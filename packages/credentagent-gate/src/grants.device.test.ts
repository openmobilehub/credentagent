// Device-signed grants (spec 012) at the grants + rail level. These pin the FR-3/4/5
// integration and the FR-6 bypass controls:
//   • FR-3 — a device grant NEVER authorizes through the page-approve seam; only a
//            verified device signature seals it.
//   • FR-4 — a signed device grant reports trustLevel "device-signed" with verifiedBy
//            provenance; a page grant NEVER reports "device-signed" (bypass e).
//   • FR-5 — a device grant's spend carries the mandate ref { id, boundsHash }.
//   • FR-6(d) — a spend on an unsigned device grant is refused not-authorized.
//   • e2e — create(device) → /sign/request → SIMULATED wallet → /sign/verify →
//            authorized(device-signed) → spend traces to the signed mandate.
import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { CredentAgent } from "./client.js";
import { devSimulateWalletSignature } from "./ceremony/intent-sign/simulate.js";
import type { Grant } from "./grants.js";

const CATALOG = {
  coffee: { price: 18, category: "Beverages" },
  wine: { price: 21, minAge: 21, category: "Beverages" },
  headphones: { price: 40, category: "Electronics" },
};

// A fixed origin so the simulated wallet and the server agree on the session transcript.
const HOST = "shop.example";
const ORIGIN = `http://${HOST}`;

function makeAgent(): CredentAgent {
  return new CredentAgent({ walletOrigin: ORIGIN, catalog: CATALOG, gateSecret: "stable-test-secret" });
}

/** Boot an express app with the grants routes served. */
function serve(ca: CredentAgent): Express {
  const app = express();
  app.use(express.json());
  ca.grants.serve(app);
  return app;
}

/** Drive the full HTTP sign ceremony for a device grant and return the /verify body. */
async function signOverHttp(app: Express, id: string, simOver: Record<string, unknown> = {}) {
  const reqRes = await request(app).get(`/credentagent/grants/${id}/sign/request`).set("Host", HOST);
  expect(reqRes.status).toBe(200);
  const oid = reqRes.body as { requests: { data: { request: string } }[]; dcql_query: unknown; readerContextToken: string };
  const result = await devSimulateWalletSignature({
    request: { request: oid.requests[0].data.request, dcql_query: oid.dcql_query as never },
    origin: ORIGIN,
    ...simOver,
  });
  return request(app)
    .post(`/credentagent/grants/${id}/sign/verify`)
    .set("Host", HOST)
    .send({ readerContextToken: oid.readerContextToken, result });
}

describe("device-signed grants — e2e over the served HTTP rail", () => {
  it("create(device) → sign → authorized(device-signed) → spend carries the mandate ref", async () => {
    const ca = makeAgent();
    const app = serve(ca);
    const g = await ca.grants.create({ merchant: "utopia", budget: 200, perSpend: 130, allow: { categories: ["Beverages"] }, signing: "device" });
    expect(g.signing).toBe("device");
    expect(g.status).toBe("pending");
    expect(g.approveUrl).toContain(`/credentagent/grants/${g.id}`);

    // The approveUrl serves the SIGNING page (not the click-to-approve page).
    const pageRes = await request(app).get(`/credentagent/grants/${g.id}`).set("Host", HOST);
    expect(pageRes.text).toContain("Sign with your wallet");
    expect(pageRes.text).toContain("device-signed");

    const verifyRes = await signOverHttp(app, g.id);
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.ok).toBe(true);
    expect(verifyRes.body.trustLevel).toBe("device-signed");
    expect(verifyRes.body.verifiedBy).toBe("gate");

    const signed = (await ca.grants.retrieve(g.id))!;
    expect(signed.status).toBe("authorized");
    expect(signed.trustLevel).toBe("device-signed"); // FR-4
    expect(signed.mandate?.credentialDoctype).toBe("org.openwallet.payment.1");
    expect(signed.mandate?.verifiedBy).toBe("gate");
    expect(typeof signed.mandate?.boundsHash).toBe("string");

    // FR-5: the spend traces to the signed Intent Mandate.
    const spend = await signed.spend({ idempotencyKey: "buy-1", items: [{ sku: "coffee" }] });
    expect(spend.ok).toBe(true);
    if (spend.ok) {
      expect(spend.mandate).toBeDefined();
      expect(spend.mandate!.boundsHash).toBe(signed.mandate!.boundsHash);
      expect(spend.mandate!.id).toMatch(/^int_/);
    }
  });

  it("refuses a signature made over a DIFFERENT nonce (cross-request replay)", async () => {
    const ca = makeAgent();
    const app = serve(ca);
    const g = await ca.grants.create({ merchant: "utopia", budget: 200, perSpend: 130, signing: "device" });
    const res = await signOverHttp(app, g.id, { overrideNonce: "not-this-request" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect((await ca.grants.retrieve(g.id))!.status).toBe("pending"); // stays pending
  });
});

describe("device-signed grants — FR-3/6 controls", () => {
  // BYPASS (d) — a device grant NEVER authorizes via the page approve seam, and an unsigned
  // device grant cannot spend. Delete `_authorize`'s `signing === "device"` guard and the
  // first assertion goes red (the page seam would seal a device grant with no signature).
  it("BYPASS (d): the page approve seam cannot authorize a device grant; unsigned → cannot spend", async () => {
    const ca = makeAgent();
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, signing: "device" });
    // Simulate a click on the old approve button (the page-approve seam).
    const sealed = await ca.grants._authorize(g.id);
    expect(sealed).toBe(false); // refused — device grants only sign
    expect((await ca.grants.retrieve(g.id))!.status).toBe("pending");
    const spend = await (await ca.grants.retrieve(g.id))!.spend({ idempotencyKey: "x", items: [{ sku: "coffee" }] });
    expect(spend.ok).toBe(false);
    if (!spend.ok) expect(spend.code).toBe("not-authorized");
  });

  // BYPASS (e) — a PAGE-mode grant never reports device-signed. Delete the type distinction
  // (make page mode share the device trust level) and this goes red.
  it("BYPASS (e): a page-mode grant never reports trustLevel device-signed", async () => {
    const ca = makeAgent();
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 }); // signing defaults to "page"
    expect(g.signing).toBe("page");
    await ca.grants._authorize(g.id);
    const authed = (await ca.grants.retrieve(g.id))!;
    expect(authed.status).toBe("authorized");
    expect(authed.trustLevel).toBe("server-issued-demo");
    expect(authed.trustLevel).not.toBe("device-signed");
    expect(authed.mandate).toBeUndefined();
  });

  it("a page-mode grant's approveUrl still serves the click-to-approve page (unchanged)", async () => {
    const ca = makeAgent();
    const app = serve(ca);
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    const pageRes = await request(app).get(`/credentagent/grants/${g.id}`).set("Host", HOST);
    expect(pageRes.text).toContain("Approve this spending grant?");
    expect(pageRes.text).not.toContain("Sign with your wallet");
  });

  it("a page-mode grant's /sign endpoints 404 (device-only)", async () => {
    const ca = makeAgent();
    const app = serve(ca);
    const g: Grant = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    const res = await request(app).get(`/credentagent/grants/${g.id}/sign/request`).set("Host", HOST);
    expect(res.status).toBe(404);
  });
});
