// `inspectPresentations` — the opt-in that hands the wallet's decrypted ISO mdoc
// DeviceResponse back to the page that presented it, with a link that opens it in an
// independent inspector (tools.multipaz.org decodes it in the browser; nothing is
// uploaded). These pin:
//   • OFF by default — a verify response never carries the raw DeviceResponse unless the
//     host opted in (it can hold personal data from a real ID).
//   • ON — the credential rail (OpenID4VP) and dc-payment rail return exactly the bytes
//     the wallet presented, plus the inspector link; a REFUSED proof still returns it
//     (that's when a developer most wants to look at it); the instant-demo path has no
//     presentation to show.
//   • The honesty axis is unchanged: trust_level stays presence-only-demo.
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import * as jose from "jose";
import { Encoder, Tag } from "cbor-x";
import { mountCeremony, type CeremonySeams } from "./mount.js";
import { MemoryVerificationStore } from "../store.js";
import { firstDeviceResponse, inspectionResponse, presentationForInspection, INSPECTOR_URL, X509_URL, VERIFIER_URL } from "./inspect.js";
import { renderCredentialPage } from "./credential-gate/page.js";
import type { CeremonyCatalog, CeremonyOrder } from "./types.js";

const enc = new Encoder({ useRecords: false, variableMapSize: true, useTag259ForMaps: false });
const cbor = (v: unknown): Buffer => enc.encode(v);

const catalog: CeremonyCatalog = {
  createOrder(items, orderId) {
    const prices: Record<string, { price: number; minimumAge?: number }> = { "oak-whiskey": { price: 124, minimumAge: 21 } };
    const lines = items.map((it) => {
      const p = prices[it.productId] ?? { price: 0 };
      return { id: it.productId, name: it.productId, unitPrice: p.price, currency: "USD", quantity: it.quantity, lineTotal: p.price * it.quantity, ...(p.minimumAge ? { minimumAge: p.minimumAge } : {}) };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal, discount: 0, total: subtotal, currency: "USD" };
  },
};

function harness(inspectPresentations?: boolean) {
  const orders = new Map<string, CeremonyOrder>();
  const seams: CeremonySeams = {
    verificationStore: new MemoryVerificationStore(),
    orderStore: { read: async (id) => orders.get(id) ?? null },
    catalog,
    completion: async () => ({ completed: true }),
    signingKey: "stable-test-secret",
    ...(inspectPresentations !== undefined ? { inspectPresentations } : {}),
  };
  const app = express();
  mountCeremony(app as never, seams);
  orders.set("ORD-1", catalog.createOrder([{ productId: "oak-whiskey", quantity: 1 }], "ORD-1"));
  return app;
}

// A synthetic ISO 18013-5 DeviceResponse disclosing one element (the wire structure
// is real; there is no issuer signature — same fixture shape as presentation.test.ts).
function deviceResponseB64(namespace: string, elementId: string, value: unknown): string {
  const isi = cbor({ digestID: 0, random: Buffer.alloc(16), elementIdentifier: elementId, elementValue: value });
  const dr = cbor({
    version: "1.0",
    documents: [{ docType: "org.iso.18013.5.1.mDL", issuerSigned: { nameSpaces: { [namespace]: [new Tag(isi, 24)] } } }],
    status: 0,
  });
  return Buffer.from(dr).toString("base64url");
}

async function walletEncrypt(requestJwt: string, vpToken: unknown): Promise<string> {
  const payload = jose.decodeJwt(requestJwt) as { client_metadata: { jwks: { keys: jose.JWK[] } } };
  const pub = await jose.importJWK(payload.client_metadata.jwks.keys[0], "ECDH-ES");
  return await new jose.CompactEncrypt(new TextEncoder().encode(JSON.stringify({ vp_token: vpToken })))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A128GCM" })
    .encrypt(pub);
}

// Drive the credential rail end to end: fetch the real signed request, have the
// simulated wallet answer it, POST the answer to /verify.
async function presentAge(app: express.Express, over21: boolean) {
  const rd = (await request(app).get("/credentagent/credential/request?order=ORD-1&cred=age")).body;
  const signed = rd.requests.find((r: { protocol: string }) => r.protocol === "openid4vp-v1-signed");
  const dr = deviceResponseB64("org.iso.18013.5.1", "age_over_21", over21);
  const response = await walletEncrypt(signed.data.request, { mdl: [dr] });
  const res = await request(app).post("/credentagent/credential/verify").send({
    order: "ORD-1", cred: "age", readerContextToken: rd.readerContextToken,
    result: { protocol: "openid4vp-v1-signed", data: { response } },
  });
  return { dr, body: res.body };
}

describe("inspectPresentations — credential rail", () => {
  it("is OFF by default: a verified presentation returns no raw DeviceResponse", async () => {
    const { body } = await presentAge(harness(), true);
    expect(body.verified).toBe(true);
    expect(body).not.toHaveProperty("presentation");
    expect(JSON.stringify(body)).not.toContain("deviceResponse");
  });

  it("stays off when explicitly false", async () => {
    const { body } = await presentAge(harness(false), true);
    expect(body).not.toHaveProperty("presentation");
  });

  it("ON: returns exactly the presented DeviceResponse + an inspector link; trust_level unchanged", async () => {
    const { dr, body } = await presentAge(harness(true), true);
    expect(body.verified).toBe(true);
    expect(body.trust_level).toBe("presence-only-demo");
    expect(body.presentation).toEqual({
      format: "mso_mdoc",
      deviceResponse: dr,
      inspectUrl: `${INSPECTOR_URL}#${dr}`,
    });
  });

  it("ON: a REFUSED proof still returns the presentation (the case a developer wants to inspect)", async () => {
    const { dr, body } = await presentAge(harness(true), false);
    expect(body.verified).toBe(false);
    expect(body.presentation?.deviceResponse).toBe(dr);
  });

  it("ON: the instant-demo path has no wallet presentation to show", async () => {
    const res = await request(harness(true)).post("/credentagent/credential/verify").send({ order: "ORD-1", cred: "age", claims: { age_over_21: true } });
    expect(res.body.verified).toBe(true);
    expect(res.body).not.toHaveProperty("presentation");
  });
});

describe("inspectPresentations — dc-payment rail", () => {
  async function presentPayment(app: express.Express) {
    const rd = (await request(app).get("/credentagent/dc-payment/request?order=ORD-1")).body;
    const dpc = deviceResponseB64("org.multipaz.payment.sca.1", "payment_instrument_id", "pi-1");
    const response = await walletEncrypt(rd.request, { dpc: [dpc] });
    const res = await request(app).post("/credentagent/dc-payment/verify").send({
      order: "ORD-1", readerContextToken: rd.readerContextToken,
      result: { protocol: "openid4vp-v1-signed", data: { response } },
    });
    return { dpc, body: res.body };
  }

  it("is OFF by default", async () => {
    const { body } = await presentPayment(harness());
    expect(body.mandate).toBeDefined();
    expect(body).not.toHaveProperty("presentation");
  });

  it("ON: returns the presented DeviceResponse + inspector link", async () => {
    const { dpc, body } = await presentPayment(harness(true));
    expect(body.presentation).toEqual({ format: "mso_mdoc", deviceResponse: dpc, inspectUrl: `${INSPECTOR_URL}#${dpc}` });
  });
});

describe("inspectionResponse — the one door a verify result leaves through", () => {
  const out = { verified: true, trust_level: "presence-only-demo" as const, deviceResponse: "RAW" };

  it("always strips the raw deviceResponse when off (the grant-age rail answers through this with false)", () => {
    expect(inspectionResponse(out, false)).toEqual({ verified: true, trust_level: "presence-only-demo" });
    expect(inspectionResponse(out, undefined)).not.toHaveProperty("deviceResponse");
  });

  it("swaps it for `presentation` only when on", () => {
    expect(inspectionResponse(out, true)).toEqual({ verified: true, trust_level: "presence-only-demo", presentation: presentationForInspection("RAW") });
  });
});

describe("firstDeviceResponse — every vp_token shape the wallets send", () => {
  it("reads { id: string }, { id: [string] }, and [string]", () => {
    expect(firstDeviceResponse({ mdl: "AAA" })).toBe("AAA");
    expect(firstDeviceResponse({ mdl: ["BBB"] })).toBe("BBB");
    expect(firstDeviceResponse(["CCC"])).toBe("CCC");
  });

  it("returns undefined for an empty / malformed token (never throws)", () => {
    expect(firstDeviceResponse(undefined)).toBeUndefined();
    expect(firstDeviceResponse({})).toBeUndefined();
    expect(firstDeviceResponse({ mdl: [42] })).toBeUndefined();
  });

  it("presentationForInspection points at the Multipaz DeviceResponse viewer, payload in the #fragment", () => {
    const p = presentationForInspection("o2d2ZXJzaW9u");
    expect(INSPECTOR_URL).toBe("https://tools.multipaz.org/mdocDeviceResponse");
    // The fragment never leaves the browser — the inspector decodes locally.
    expect(p.inspectUrl).toBe("https://tools.multipaz.org/mdocDeviceResponse#o2d2ZXJzaW9u");
  });

  it("adds the issuer certificate (x5chain leaf from issuerAuth) as a Multipaz X.509 viewer link", () => {
    const cert = Buffer.from("30820101-fake-der-leaf");
    const issuerAuth = [cbor({ 1: -7 }), new Map([[33, cert]]), cbor({}), Buffer.alloc(64)]; // COSE_Sign1; header 33 = x5chain
    const dr = Buffer.from(cbor({ version: "1.0", documents: [{ docType: "org.iso.18013.5.1.mDL", issuerSigned: { nameSpaces: {}, issuerAuth } }], status: 0 })).toString("base64url");
    expect(presentationForInspection(dr).issuerCertUrl).toBe(`${X509_URL}#${cert.toString("base64url")}`);
    // x5chain as an array (leaf + chain) → the leaf.
    const chained = [issuerAuth[0], new Map([[33, [cert, Buffer.from("ca")]]]), issuerAuth[2], issuerAuth[3]];
    const dr2 = Buffer.from(cbor({ version: "1.0", documents: [{ docType: "x", issuerSigned: { issuerAuth: chained } }], status: 0 })).toString("base64url");
    expect(presentationForInspection(dr2).issuerCertUrl).toBe(`${X509_URL}#${cert.toString("base64url")}`);
  });

  it("no issuerAuth (a synthetic credential) or unparseable bytes → no issuer link, never a throw", () => {
    expect(presentationForInspection(deviceResponseB64("ns", "age_over_21", true))).not.toHaveProperty("issuerCertUrl");
    expect(presentationForInspection("not-cbor!!")).not.toHaveProperty("issuerCertUrl");
  });
});

describe("inspect link on the consent page", () => {
  it("the credential page knows how to render the link, with the honest trust note", () => {
    const html = renderCredentialPage({ kind: "age", order: "ORD-1" });
    expect(html).toContain("showInspectLink(out.presentation)");
    expect(html).toContain("Inspect this presentation");
    // The other Multipaz Tools: who signed it, and an independent signature check.
    expect(html).toContain("Issuer certificate");
    expect(html).toContain(VERIFIER_URL);
    expect(html).toContain("does not check the issuer signature");
  });
});
