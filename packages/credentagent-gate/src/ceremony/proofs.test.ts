// The order proof receipt (spec docs/superpowers/specs/2026-09-27-order-proof-receipt-design.md):
// each successful proof is kept WITH its order so it outlives completion and can be shown
// afterwards. These pin:
//   • re-proving a gate replaces its entry; webhooks get the proofs without credential bytes;
//   • completeOrder copies the order's proofs (then the payment's) onto the completed record;
//   • the credential rail records wallet proofs (bytes only with inspectPresentations) and
//     labels the instant demo as instant-demo; a proof on one order never reaches another;
//   • GET /credentagent/orders/:id/proof answers for completed + pending orders, 404 otherwise.
import { describe, it, expect } from "vitest";
import express from "express";
import http from "node:http";
import request from "supertest";
import * as jose from "jose";
import { Encoder, Tag } from "cbor-x";
import { upsertProof, withoutPresentations, type ProofEntry } from "./proofs.js";
import { completeOrder, type CompletedRecord } from "./completion.js";
import { mountCeremony } from "./mount.js";
import { INSPECTOR_URL } from "./inspect.js";
import { MemoryVerificationStore } from "../store.js";
import type { CeremonyCatalog } from "./types.js";

const catalog: CeremonyCatalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => ({ id: it.productId, name: it.productId, unitPrice: 10, currency: "USD", quantity: it.quantity, lineTotal: 10 * it.quantity }));
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal: total, discount: 0, total, currency: "USD" };
  },
};

const entry = (gate: string, extra: Partial<ProofEntry> = {}): ProofEntry => ({
  gate, rail: "credential", trust_level: "presence-only-demo", checks: [], presentedAt: "2026-09-27T00:00:00.000Z", ...extra,
});

describe("proof helpers", () => {
  it("upsertProof appends, and re-proving a gate replaces its entry", () => {
    const a = upsertProof(undefined, entry("Age 21+"));
    const b = upsertProof(a, entry("Membership"));
    const c = upsertProof(b, entry("Age 21+", { rail: "instant-demo" }));
    expect(c.map((p) => [p.gate, p.rail])).toEqual([["Membership", "credential"], ["Age 21+", "instant-demo"]]);
  });

  it("withoutPresentations drops the credential bytes and keeps everything else", () => {
    const p = entry("Age 21+", { presentation: { format: "mso_mdoc", deviceResponse: "RAW", inspectUrl: "https://tools.multipaz.org/mdocDeviceResponse#RAW" } });
    expect(withoutPresentations([p])).toEqual([entry("Age 21+")]);
    expect(Object.keys(withoutPresentations([p])![0]).sort()).toEqual(["checks", "gate", "presentedAt", "rail", "trust_level"]);
    expect(withoutPresentations(undefined)).toBeUndefined();
  });
});

// ── An express store on ONE port (origin-bound gates agree across requests) + a simulated wallet.
const enc = new Encoder({ useRecords: false, variableMapSize: true, useTag259ForMaps: false });
function ageDeviceResponse(): string {
  const isi = enc.encode({ digestID: 0, random: Buffer.alloc(16), elementIdentifier: "age_over_21", elementValue: true });
  return Buffer.from(enc.encode({ version: "1.0", documents: [{ docType: "org.iso.18013.5.1.mDL", issuerSigned: { nameSpaces: { "org.iso.18013.5.1": [new Tag(isi, 24)] } } }], status: 0 })).toString("base64url");
}
const ageCatalog: CeremonyCatalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => ({ id: it.productId, name: it.productId, unitPrice: 124, currency: "USD", quantity: it.quantity, lineTotal: 124 * it.quantity, minimumAge: 21 }));
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal: total, discount: 0, total, currency: "USD" };
  },
};

function storeHarness(inspectPresentations: boolean) {
  const verificationStore = new MemoryVerificationStore();
  const records = new Map<string, CompletedRecord>();
  const orders = new Map(["W1", "W2"].map((id) => [id, ageCatalog.createOrder([{ productId: "whiskey", quantity: 1 }], id)]));
  const app = express();
  mountCeremony(app as never, {
    verificationStore, catalog: ageCatalog, signingKey: "stable-test-secret", inspectPresentations,
    orderStore: { read: async (id) => orders.get(id) ?? null },
    completion: (input) => completeOrder(input, { catalog: ageCatalog, verificationStore, records: { read: (id) => records.get(id), write: (r) => void records.set(r.orderId, r) } }),
  });
  return { server: http.createServer(app), verificationStore, records };
}

async function proveAge(server: http.Server, order: string): Promise<string> {
  const rd = (await request(server).get(`/credentagent/credential/request?order=${order}&cred=age`)).body;
  const signed = rd.requests.find((r: { protocol: string }) => r.protocol === "openid4vp-v1-signed");
  const jwk = (jose.decodeJwt(signed.data.request) as { client_metadata: { jwks: { keys: jose.JWK[] } } }).client_metadata.jwks.keys[0];
  const dr = ageDeviceResponse();
  const response = await new jose.CompactEncrypt(new TextEncoder().encode(JSON.stringify({ vp_token: { mdl: [dr] } })))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A128GCM" }).encrypt(await jose.importJWK(jwk, "ECDH-ES"));
  const res = await request(server).post("/credentagent/credential/verify").send({ order, cred: "age", readerContextToken: rd.readerContextToken, result: { protocol: "openid4vp-v1-signed", data: { response } } });
  expect(res.body.verified).toBe(true);
  return dr;
}

describe("the credential rail records its proof on the order", () => {
  it("a wallet proof is kept with its presentation when inspectPresentations is on — and only on THAT order", async () => {
    const h = storeHarness(true);
    const dr = await proveAge(h.server, "W1");
    const [p] = (await h.verificationStore.read("W1"))!.proofs!;
    expect(p).toMatchObject({ gate: "Age 21+", rail: "credential", trust_level: "presence-only-demo", presentation: { deviceResponse: dr, inspectUrl: `${INSPECTOR_URL}#${dr}` } });
    expect(p.checks[0]).toMatchObject({ pass: true });
    expect(await h.verificationStore.read("W2")).toBeUndefined(); // invariant 4: no cross-order bleed
  });

  it("without the flag the proof is kept but carries no credential bytes", async () => {
    const h = storeHarness(false);
    await proveAge(h.server, "W1");
    expect((await h.verificationStore.read("W1"))!.proofs![0]).not.toHaveProperty("presentation");
  });

  it("the instant demo is recorded as instant-demo, never as a wallet proof", async () => {
    const h = storeHarness(true);
    await request(h.server).post("/credentagent/credential/verify").send({ order: "W1", cred: "age", claims: { age_over_21: true } });
    const [p] = (await h.verificationStore.read("W1"))!.proofs!;
    expect(p.rail).toBe("instant-demo");
    expect(p).not.toHaveProperty("presentation");
  });
});

describe("completeOrder keeps the proofs", () => {
  it("copies the order's credential proofs + the payment proof into the completed record, then clears verification", async () => {
    const verificationStore = new MemoryVerificationStore();
    await verificationStore.write("O1", { proofs: [entry("Membership")] });
    const records = new Map<string, CompletedRecord>();
    const order = catalog.createOrder([{ productId: "mug", quantity: 1 }], "O1");
    const out = await completeOrder(
      { order, mandateId: "m1", amount: 10, currency: "USD", method: "dc-payment", gates: [], proof: entry("Pay (USD)", { rail: "dc-payment" }) },
      { catalog, verificationStore, records: { read: (id) => records.get(id), write: (r) => void records.set(r.orderId, r) } },
    );
    expect(out.completed).toBe(true);
    expect(records.get("O1")?.proofs?.map((p) => p.gate)).toEqual(["Membership", "Pay (USD)"]);
    expect(await verificationStore.read("O1")).toBeUndefined();
  });

  it("writes no proofs field when nothing was proven", async () => {
    const records = new Map<string, CompletedRecord>();
    const order = catalog.createOrder([{ productId: "mug", quantity: 1 }], "O2");
    await completeOrder({ order, mandateId: "m", amount: 10, currency: "USD", method: "passkey", gates: [] },
      { catalog, verificationStore: new MemoryVerificationStore(), records: { read: (id) => records.get(id), write: (r) => void records.set(r.orderId, r) } });
    expect(records.get("O2")).toBeDefined();
    expect(records.get("O2")).not.toHaveProperty("proofs");
  });
});
