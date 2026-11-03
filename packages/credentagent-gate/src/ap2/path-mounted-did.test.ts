// A store served under a path (walletOrigin `https://shop.example/store`) publishes its key
// where did:web resolution looks for it (#322).
//
// did:web resolves `did:web:shop.example:store` to `https://shop.example/store/did.json` — no
// `.well-known` — and `did:web:shop.example` to the SITE ROOT. A path-stripping proxy exposes
// the app's `/did.json` at the first of those. So the store's identity must carry its path, and
// mount() must serve `/did.json`; otherwise nobody outside the store can check a mandate it signed.
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import express from "express";
import request from "supertest";
import { CredentAgent, publicJwkFromDidDocument, verifyMandate } from "../index.js";

const STORE = "did:web:shop.example:store";

function gateAt(walletOrigin: string) {
  const app = express();
  const mandateSigningKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }) as never;
  const credentagent = new CredentAgent({ walletOrigin, mandateSigningKey });
  credentagent.mount(app);
  return { app, credentagent };
}

/** The JWS header + payload of a mandate's issuer-signed JWT (the part before the first `~`). */
function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split("~")[0].split(".");
  const part = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;
  return { header: part(h), payload: part(p) };
}

const mint = (credentagent: CredentAgent) =>
  credentagent.ap2.payment({
    transactionId: "tx-1",
    payee: { id: "shop-1", name: "Shop" },
    amount: { amount: 12400, currency: "USD" },
    instrument: { id: "pi_1", type: "card", description: "Visa ••4242" },
  });

describe("a path-mounted store's DID document", () => {
  it("is served at /did.json under the store's own path-scoped DID", async () => {
    const { app } = gateAt("https://shop.example/store");
    const res = await request(app).get("/did.json");
    expect(res.status, "mount() must serve /did.json — where did:web resolves a path DID").toBe(200);
    const doc = res.body as { id: string; verificationMethod: Array<{ id: string; controller: string }>; assertionMethod: string[] };
    expect(doc.id).toBe(STORE);
    expect(doc.verificationMethod.map((m) => m.id)).toEqual([`${STORE}#gate-signing-key`, `${STORE}#merchant-checkout-key`]);
    for (const m of doc.verificationMethod) expect(m.controller).toBe(STORE);
    expect(doc.assertionMethod[0]).toBe(`${STORE}#gate-signing-key`);
  });

  // did:web never resolves a path DID at `.well-known`; claiming it would only shadow a host route.
  it("leaves /.well-known/did.json to the host app", async () => {
    const { app } = gateAt("https://shop.example/store");
    app.get("/.well-known/did.json", (_req, res) => res.json({ host: true }));
    expect((await request(app).get("/.well-known/did.json")).body).toEqual({ host: true });
  });

  it("lets a stranger check a mandate it signed from /did.json alone", async () => {
    const { app, credentagent } = gateAt("https://shop.example/store");
    const mandate = await mint(credentagent);
    const { header, payload } = decodeJwt(mandate.token);
    expect(payload.iss).toBe(STORE);
    expect(header.kid).toBe(`${STORE}#gate-signing-key`);

    const doc = (await request(app).get("/did.json")).body;
    const publicJwk = publicJwkFromDidDocument(doc);
    const theirs = await verifyMandate(mandate.token, { publicJwk });
    expect(theirs.ok).toBe(true);

    // The host-only identity names the site root, not this store: a mandate from the store does
    // not check out as one from it.
    const hostOnly = await verifyMandate(mandate.token, { publicJwk: { ...publicJwk, kid: "did:web:shop.example#gate-signing-key" } });
    expect(hostOnly.ok).toBe(false);
    if (!hostOnly.ok) expect(hostOnly.code).toBe("issuer");
  });
});

describe("a store at the site root", () => {
  it("keeps did:web:<host> at /.well-known/did.json", async () => {
    const { app, credentagent } = gateAt("https://shop.example");
    const doc = (await request(app).get("/.well-known/did.json")).body as { id: string };
    expect(doc.id).toBe("did:web:shop.example");
    expect(credentagent.ap2.issuer).toBe("did:web:shop.example");
  });

  // did:web never resolves a root DID at `/did.json`; claiming it would only shadow a host route.
  it("leaves /did.json to the host app", async () => {
    const { app } = gateAt("https://shop.example");
    app.get("/did.json", (_req, res) => res.json({ host: true }));
    expect((await request(app).get("/did.json")).body).toEqual({ host: true });
  });
});
