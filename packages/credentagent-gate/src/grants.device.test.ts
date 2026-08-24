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
    expect(signed.mandate?.credentialDoctype).toBe("org.multipaz.payment.sca.1");
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
  // THE DEFAULT IS A SIGNATURE. Approving a grant is a wallet signature unless the caller asks for
  // the weaker door BY NAME. A regression here is silent and severe: every grant created without an
  // explicit `signing` would fall back to click-to-approve, and no other test would notice — they
  // all pass `signing` explicitly. This is the one test that pins the fallback itself.
  it("defaults to DEVICE signing — a grant nobody configured cannot be click-approved", async () => {
    const ca = new CredentAgent({ walletOrigin: ORIGIN, catalog: CATALOG });
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30 });
    expect(g.signing).toBe("device");

    // The page door is shut for it, so the default cannot be side-stepped by the old button.
    expect(await ca.grants._authorize(g.id)).toBe(false);
    expect((await ca.grants.retrieve(g.id))?.status).toBe("pending");

    // …and "page" still works when ASKED for, so demos/CI keep a phone-free path.
    const opted = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, signing: "page" });
    expect(opted.signing).toBe("page");
    expect(await ca.grants._authorize(opted.id)).toBe(true);
  });

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
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, signing: "page" }); // page mode, asked for by name
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
    const g = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, signing: "page" });
    const pageRes = await request(app).get(`/credentagent/grants/${g.id}`).set("Host", HOST);
    expect(pageRes.text).toContain("Approve this spending grant?");
    expect(pageRes.text).not.toContain("Sign with your wallet");
  });

  it("a page-mode grant's /sign endpoints 404 (device-only)", async () => {
    const ca = makeAgent();
    const app = serve(ca);
    const g: Grant = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, signing: "page" });
    const res = await request(app).get(`/credentagent/grants/${g.id}/sign/request`).set("Host", HOST);
    expect(res.status).toBe(404);
  });

  // FR-4 provenance: a device grant reports the trust level its VERIFY BACKEND attested, with the
  // attestor recorded — the gate never upgrades or rewrites it. The in-gate backend attests
  // "device-signed" / "gate"; a delegated backend (fast-follow) would attest a stronger, issuer-backed
  // level, relayed verbatim. This pins _authorizeDevice to relay whatever evidence it is handed.
  it("_authorizeDevice relays the attested trustLevel + verifiedBy VERBATIM (no self-judgment)", async () => {
    const ca = makeAgent();
    // In-gate evidence.
    const gate = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, signing: "device" });
    await ca.grants._authorizeDevice(gate.id, { boundsHash: "h1", signedAt: "2026-07-28T00:00:00Z", credentialDoctype: "org.multipaz.payment.sca.1", verifiedBy: "gate", trustLevel: "device-signed" });
    const gateAuthed = (await ca.grants.retrieve(gate.id))!;
    expect(gateAuthed.trustLevel).toBe("device-signed");
    expect(gateAuthed.mandate?.verifiedBy).toBe("gate");

    // A stronger, issuer-backed level from an external verifier is relayed verbatim WITH its id.
    const delegated = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, signing: "device" });
    await ca.grants._authorizeDevice(delegated.id, { boundsHash: "h2", signedAt: "2026-07-28T00:00:00Z", credentialDoctype: "org.multipaz.payment.sca.1", verifiedBy: "upay-verifier", trustLevel: "issuer-verified" });
    const delegatedAuthed = (await ca.grants.retrieve(delegated.id))!;
    expect(delegatedAuthed.trustLevel).toBe("issuer-verified"); // relayed, not the gate's own claim
    expect(delegatedAuthed.mandate?.verifiedBy).toBe("upay-verifier");
  });
});
