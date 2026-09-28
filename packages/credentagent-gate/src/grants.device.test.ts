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
    // An SD-JWT `vct` since spec 014 — the rail signs AP2 mandates, not an mdoc presentation.
    expect(signed.mandate?.credentialType).toBe("urn:emvco:dpc:card:1");
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
    await ca.grants._authorizeDevice(gate.id, { boundsHash: "h1", signedAt: "2026-07-28T00:00:00Z", credentialType: "urn:emvco:dpc:card:1", verifiedBy: "gate", trustLevel: "device-signed" });
    const gateAuthed = (await ca.grants.retrieve(gate.id))!;
    expect(gateAuthed.trustLevel).toBe("device-signed");
    expect(gateAuthed.mandate?.verifiedBy).toBe("gate");

    // A stronger, issuer-backed level from an external verifier is relayed verbatim WITH its id.
    const delegated = await ca.grants.create({ merchant: "utopia", budget: 100, perSpend: 30, signing: "device" });
    await ca.grants._authorizeDevice(delegated.id, { boundsHash: "h2", signedAt: "2026-07-28T00:00:00Z", credentialType: "urn:emvco:dpc:card:1", verifiedBy: "upay-verifier", trustLevel: "issuer-verified" });
    const delegatedAuthed = (await ca.grants.retrieve(delegated.id))!;
    expect(delegatedAuthed.trustLevel).toBe("issuer-verified"); // relayed, not the gate's own claim
    expect(delegatedAuthed.mandate?.verifiedBy).toBe("upay-verifier");
  });
});

// A device grant's signature must describe exactly what the agent can spend on — no more.
//
// `spend()` refuses an age-restricted line with `step-up` unless the sealed proof covers it
// (issue #172). So a mandate that LISTS a 21+ product for a grant nobody proved an age for asks
// the human to sign "your agent may buy the whiskey" while the gate refuses that purchase every
// single time. The signature would overclaim, and the human would have no way to know.
//
// These pin the reverse: the mandate carries the age-covered products and nothing else, and the
// page says so before the signature is given.
describe("a device grant signs only what spend() would honour (#172)", () => {
  /** The `checkout.line_items` allow-list inside the `delegate` transaction_data the page sends.
   *  Delegate SD-JWT §7.1 carries the mandate as an array disclosure — `[salt, value]` — so the
   *  value is read back out of it the way the wallet does before it renders the consent screen.
   *  The constraint holds one REQUIREMENT per allowed product, so the ids come from those. */
  async function signedLineItems(app: Express, id: string): Promise<string[]> {
    const res = await request(app).get(`/credentagent/grants/${id}/sign/request`).set("Host", HOST);
    expect(res.status).toBe(200);
    const b64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString()) as unknown;
    const claims = b64(res.body.requests[0].data.request.split(".")[1]) as { transaction_data: string[] };
    const entry = b64(claims.transaction_data[0]) as { delegate_payload_disclosure: string };
    const [, checkout] = b64(entry.delegate_payload_disclosure) as [
      string,
      { constraints: { type: string; items?: { acceptable_items: { id: string }[] }[] }[] },
    ];
    const lineItems = checkout.constraints.find((c) => c.type === "checkout.line_items")!.items!;
    return lineItems.flatMap((r) => r.acceptable_items.map((i) => i.id));
  }

  /** A pending device grant over the whole Beverages category (coffee + the 21+ wine). */
  async function beveragesGrant(ca: CredentAgent): Promise<Grant> {
    return ca.grants.create({ merchant: "utopia", budget: 200, perSpend: 130, allow: { categories: ["Beverages"] }, signing: "device" });
  }

  // BYPASS (the `ageProofCovers` filter in `_allowedSkusFor`): delete it and this goes red —
  // every unproved grant would be signed over a mandate naming items it can never buy.
  it("BYPASS: with NO age proof, the 21+ sku is absent from what the wallet is asked to sign", async () => {
    const ca = makeAgent();
    const g = await beveragesGrant(ca);
    expect(await signedLineItems(serve(ca), g.id)).toEqual(["coffee"]);
  });

  // BYPASS (the threshold comparison inside `ageProofCovers`): an 18+ proof is not a 21+ proof,
  // and the mandate must not quietly promote it.
  it("BYPASS: an 18+ proof does not put the 21+ sku into the mandate", async () => {
    const ca = makeAgent();
    const g = await beveragesGrant(ca);
    expect(await ca.grants._recordAgeProof(g.id, { provenAge: 18 })).toBe(true);
    expect(await signedLineItems(serve(ca), g.id)).toEqual(["coffee"]);
  });

  // The positive half — without it the filter could simply drop everything and still "pass".
  it("proving 21+ BEFORE signing puts the item back into the mandate", async () => {
    const ca = makeAgent();
    const g = await beveragesGrant(ca);
    expect(await ca.grants._recordAgeProof(g.id, { provenAge: 21 })).toBe(true);
    expect(await signedLineItems(serve(ca), g.id)).toEqual(["coffee", "wine"]);
  });

  it("the signing page names what is being withheld, and the button says which choice it is", async () => {
    const ca = makeAgent();
    const g = await beveragesGrant(ca);
    const res = await request(serve(ca)).get(`/credentagent/grants/${g.id}`).set("Host", HOST);
    expect(res.text).toContain("Sign without them");
    expect(res.text).toContain("21+ items above are not part of this signature");
  });

  it("once the age is proved the page drops the caveat and offers a plain signature", async () => {
    const ca = makeAgent();
    const g = await beveragesGrant(ca);
    await ca.grants._recordAgeProof(g.id, { provenAge: 21 });
    const res = await request(serve(ca)).get(`/credentagent/grants/${g.id}`).set("Host", HOST);
    expect(res.text).toContain(">Sign with your wallet</button>");
    expect(res.text).not.toContain("Sign without them");
  });

  // A grant whose EVERY product is age-restricted has nothing to authorize until the age step is
  // done: `_allowedSkusFor` resolves to an empty list, and minting a mandate from it would say
  // "nothing may be bought" while looking like a grant. So the rail refuses and the page does not
  // offer a signature it cannot produce.
  describe("a grant where EVERYTHING is age-restricted", () => {
    const BAR = { wine: { price: 21, minAge: 21, category: "Beverages" }, whiskey: { price: 60, minAge: 21, category: "Beverages" } };
    const bar = () => new CredentAgent({ walletOrigin: ORIGIN, catalog: BAR, gateSecret: "stable-test-secret" });

    it("BYPASS: the signature is not offered, and the rail refuses to mint the mandate", async () => {
      const ca = bar();
      const app = serve(ca);
      const g = await ca.grants.create({ merchant: "utopia", budget: 200, perSpend: 130, signing: "device" });

      const page = await request(app).get(`/credentagent/grants/${g.id}`).set("Host", HOST);
      expect(page.text).toContain(`<button id="go-dc" class="btn btn-primary" disabled>Sign with your wallet</button>`);
      expect(page.text).toContain("Prove your age above and this becomes signable");

      // Hiding a button is not enforcement (invariant 1) — the rail refuses on its own. And it
      // refuses as 409 naming the age step, not 404 "unknown grant": the grant plainly exists,
      // and saying otherwise sent people looking for a missing record.
      const req = await request(app).get(`/credentagent/grants/${g.id}/sign/request`).set("Host", HOST);
      expect(req.status).toBe(409);
      expect(req.body.error).toMatch(/age proof/);
      expect((await ca.grants.retrieve(g.id))!.status).toBe("pending");
    });

    it("proving the age makes the very same grant signable", async () => {
      const ca = bar();
      const app = serve(ca);
      const g = await ca.grants.create({ merchant: "utopia", budget: 200, perSpend: 130, signing: "device" });
      expect(await ca.grants._recordAgeProof(g.id, { provenAge: 21 })).toBe(true);

      const page = await request(app).get(`/credentagent/grants/${g.id}`).set("Host", HOST);
      expect(page.text).toContain(`<button id="go-dc" class="btn btn-primary">Sign with your wallet</button>`);

      const verifyRes = await signOverHttp(app, g.id);
      expect(verifyRes.body.ok).toBe(true);
      expect((await ca.grants.retrieve(g.id))!.status).toBe("authorized");
    });
  });
});

// AP2 names the agent's key in the mandates' `cnf`, and the human's wallet signature covers
// those bytes — so on a device grant the key has to exist BEFORE they are asked, and the engine
// sealed afterwards has to be given that same key.
//
// The keypair is minted at `grants.create()` and handed to `preApprove` at authorization. Mint a
// fresh one at authorization instead, and everything still works: the grant seals, the engine
// spends, every draw verifies — against a key nobody ever authorized. The human approved one
// spending authority and the server is using a different one, and no other test can see it,
// because both halves of the replacement agree with each other.
describe("the key the human signed for is the key the engine spends with", () => {
  /** The `cnf.jwk` inside the mandates the wallet is asked to sign — what the human authorizes. */
  async function signedCnf(app: Express, id: string): Promise<unknown> {
    const res = await request(app).get(`/credentagent/grants/${id}/sign/request`).set("Host", HOST);
    expect(res.status).toBe(200);
    const b64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString()) as unknown;
    const claims = b64(res.body.requests[0].data.request.split(".")[1]) as { transaction_data: string[] };
    const entry = b64(claims.transaction_data[0]) as { delegate_payload_disclosure: string };
    const [, mandate] = b64(entry.delegate_payload_disclosure) as [string, { cnf: { jwk: unknown } }];
    return mandate.cnf.jwk;
  }

  // BYPASS (the `delegateKeys` handoff in `_authorizeDevice`): delete it and `preApprove` mints
  // its own key, so this comparison fails — and nothing else in the suite moves.
  it("BYPASS: the sealed engine's agent key is the one named in the signed mandate's cnf", async () => {
    const ca = makeAgent();
    const app = serve(ca);
    const g = await ca.grants.create({ merchant: "utopia", budget: 200, perSpend: 130, allow: { categories: ["Beverages"] }, signing: "device" });

    const authorized = await signedCnf(app, g.id);
    expect(authorized).toMatchObject({ kty: "EC", crv: "P-256" });

    const verifyRes = await signOverHttp(app, g.id);
    expect(verifyRes.body.ok).toBe(true);
    expect((await ca.grants.retrieve(g.id))!.status).toBe("authorized");

    expect(ca.grants._engineDelegateFor(g.id)).toEqual(authorized);
  });
});

// Found on a phone, not in a test: the grant record kept the signed terms and the public view
// dropped them, because `view()` rebuilds `mandate` field by field. A caller asking "what did I
// authorize?" got a digest and nothing else. This pins the whole path — signed on the wire,
// stored on the record, readable from `retrieve()`.
describe("a signed grant can say what it authorized, not just that something was signed", () => {
  it("carries the AP2 mandates the wallet signed all the way to retrieve()", async () => {
    const ca = makeAgent();
    const app = serve(ca);
    const g = await ca.grants.create({ merchant: "utopia", budget: 200, perSpend: 130, allow: { categories: ["Beverages"] }, signing: "device" });
    expect((await signOverHttp(app, g.id)).body.ok).toBe(true);

    const mandates = (await ca.grants.retrieve(g.id))!.mandate!.mandates!;
    expect(mandates).toHaveLength(2);

    // The terms a human would want back: what may be bought, and the per-purchase ceiling.
    const constraints = mandates.flatMap((m) => m.constraints as Array<{ type: string; items?: Array<{ acceptable_items: Array<{ id: string }> }>; max?: number }>);
    const lineItems = constraints.find((c) => c.type === "checkout.line_items")!;
    expect(lineItems.items!.flatMap((r) => r.acceptable_items.map((i) => i.id))).toEqual(["coffee"]);
    expect(constraints.find((c) => c.type === "payment.amount_range")!.max).toBe(13000);
  });
});

// `allow: { categories: [...] }` is evaluated against the LIVE catalog, so a category grant
// widens every time the catalog does. On a page-approved grant that is the intended behaviour —
// nobody signed a list of products. On a device-signed grant it is not: the wallet signed
// `checkout.line_items`, a concrete set, and a product stocked afterwards is not in it.
//
// So a device grant is bounded by both, and the narrower one wins.
describe("a device grant may only buy what its mandate actually names", () => {
  it("BYPASS: a product added to an allowed category AFTER signing cannot be bought", async () => {
    // A catalog this test owns, so it can grow it mid-flight the way a real one does.
    const catalog: Record<string, { price: number; category: string }> = {
      coffee: { price: 18, category: "Beverages" },
    };
    const ca = new CredentAgent({ walletOrigin: ORIGIN, catalog, gateSecret: "stable-test-secret" });
    const app = serve(ca);
    const g = await ca.grants.create({ merchant: "utopia", budget: 200, perSpend: 130, allow: { categories: ["Beverages"] }, signing: "device" });

    expect((await signOverHttp(app, g.id)).body.ok).toBe(true);

    // The shop stocks a new Beverage. It is inside the grant's `allow` bounds — and outside
    // everything the human's wallet signed.
    catalog.matcha = { price: 12, category: "Beverages" };

    const authorized = (await ca.grants.retrieve(g.id))!;
    const signed = await authorized.spend({ idempotencyKey: "order-signed", items: [{ sku: "coffee" }] });
    expect(signed.ok).toBe(true);

    const unsigned = await authorized.spend({ idempotencyKey: "order-unsigned", items: [{ sku: "matcha" }] });
    expect(unsigned.ok).toBe(false);
    if (!unsigned.ok) expect(unsigned.code).toBe("not-allowed");
  });

  // The same grant approved through the PAGE seam has no signature over a product list, so it
  // keeps the live-catalog behaviour. Without this, narrowing device grants could be mistaken
  // for narrowing every grant.
  it("a PAGE-approved grant still follows the live catalog", async () => {
    const catalog: Record<string, { price: number; category: string }> = {
      coffee: { price: 18, category: "Beverages" },
    };
    const ca = new CredentAgent({ walletOrigin: ORIGIN, catalog, gateSecret: "stable-test-secret" });
    const g = await ca.grants.create({ merchant: "utopia", budget: 200, perSpend: 130, allow: { categories: ["Beverages"] }, signing: "page" });
    expect(await ca.grants._authorize(g.id)).toBe(true);

    catalog.matcha = { price: 12, category: "Beverages" };
    const authorized = (await ca.grants.retrieve(g.id))!;
    expect((await authorized.spend({ idempotencyKey: "page-1", items: [{ sku: "matcha" }] })).ok).toBe(true);
  });
});
