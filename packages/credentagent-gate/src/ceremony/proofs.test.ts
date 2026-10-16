// The order proof receipt: each successful proof is kept WITH its order so it outlives
// completion and shows up wherever the completed order is read (the order-status endpoints,
// orders.retrieve, get-order-status). These pin:
//   • re-proving a gate replaces its entry; webhooks get the proofs without credential bytes;
//   • completeOrder copies the order's proofs (then the payment's) onto the completed record,
//     WITHOUT the wallet's raw answer — every read of that record is public by order id (#320);
//   • the credential rail records wallet proofs WITHOUT the raw answer, even with
//     inspectPresentations on (only the presenting browser gets it), and labels the instant demo
//     as instant-demo; a proof on one order never reaches another;
//   • the payment step never hands an earlier proof's raw answer to whoever completes it (#320).
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
    // An untyped caller, or a proof stored before #320, can still carry one.
    const p = { ...entry("Age 21+"), presentation: { format: "mso_mdoc", deviceResponse: "RAW", inspectUrl: "https://tools.multipaz.org/mdocDeviceResponse#RAW" } } as ProofEntry;
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

async function proveAge(server: http.Server, order: string): Promise<{ dr: string; body: { presentation?: { deviceResponse?: string } } }> {
  const rd = (await request(server).get(`/credentagent/credential/request?order=${order}&cred=age`)).body;
  const signed = rd.requests.find((r: { protocol: string }) => r.protocol === "openid4vp-v1-signed");
  const jwk = (jose.decodeJwt(signed.data.request) as { client_metadata: { jwks: { keys: jose.JWK[] } } }).client_metadata.jwks.keys[0];
  const dr = ageDeviceResponse();
  const response = await new jose.CompactEncrypt(new TextEncoder().encode(JSON.stringify({ vp_token: { mdl: [dr] } })))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A128GCM" }).encrypt(await jose.importJWK(jwk, "ECDH-ES"));
  const res = await request(server).post("/credentagent/credential/verify").send({ order, cred: "age", readerContextToken: rd.readerContextToken, result: { protocol: "openid4vp-v1-signed", data: { response } } });
  expect(res.body.verified).toBe(true);
  return { dr, body: res.body };
}

describe("the credential rail records its proof on the order", () => {
  it("REFUSES to store the wallet's raw answer on the order, even with inspectPresentations on (#320) — only the presenting browser gets it", async () => {
    // The verification record is read back by order id alone: the payment step reads it, and
    // anyone with the order id can open the payment page. So the bytes go back in THIS response
    // and nowhere else; the receipt keeps what was checked.
    const h = storeHarness(true);
    const { dr, body } = await proveAge(h.server, "W1");
    expect(body.presentation?.deviceResponse).toBe(dr); // the presenting browser can Inspect
    const record = (await h.verificationStore.read("W1"))!;
    expect(record.proofs![0]).toMatchObject({ gate: "Age 21+", rail: "credential", trust_level: "presence-only-demo" });
    expect(record.proofs![0].checks[0]).toMatchObject({ pass: true });
    expect(record.proofs![0]).not.toHaveProperty("presentation");
    expect(JSON.stringify(record)).not.toContain(dr);
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

const DEMO_INSTRUMENT = { issuer_name: "Demo Bank", payment_instrument_id: "pi-1", masked_account_reference: "•••• 4242", holder_name: "Demo", expiry_date: "2032-09-01" };

describe("payment rails add their proof", () => {
  it("age wallet proof + instant-demo payment → the completed record lists both, in order", async () => {
    const h = storeHarness(true);
    await proveAge(h.server, "W1");
    const pay = await request(h.server).post("/credentagent/dc-payment/verify").send({ order: "W1", amount: 124, claims: DEMO_INSTRUMENT });
    expect(pay.body.completed).toBe(true);
    const proofs = h.records.get("W1")!.proofs!;
    expect(proofs.map((p) => [p.gate, p.rail])).toEqual([["Age 21+", "credential"], ["Pay (USD)", "instant-demo"]]);
    expect(proofs[0]).not.toHaveProperty("presentation"); // #320: the completed order never keeps the bytes
    expect(proofs[1]).not.toHaveProperty("presentation");
    expect(proofs[1].checks.length).toBeGreaterThan(0);
  });

  it("REFUSES to hand an earlier proof's raw answer to whoever completes the payment (#320) — the block lists it, unlinked", async () => {
    // The attack: the shopper proves their age with a real wallet, then anyone with the order id
    // opens the payment page and taps the instant demo. They must get the receipt, not the
    // shopper's credential.
    const h = storeHarness(true);
    const { dr } = await proveAge(h.server, "W1");
    const pay = await request(h.server).post("/credentagent/dc-payment/verify").send({ order: "W1", amount: 124, claims: DEMO_INSTRUMENT });
    expect(pay.body.completed).toBe(true);
    const html: string = pay.body.proofsHtml;
    expect(html).toContain("What was proven");
    expect(html).toContain("Age 21+");
    expect(html).toContain("Pay (USD)");
    expect(html).not.toContain(INSPECTOR_URL);
    expect(JSON.stringify(pay.body)).not.toContain(dr);
  });

  it("REFUSES to hand out a raw answer an order stored before #320 still holds", async () => {
    // A verification record written before the fix (an abandoned cart on a persistent store) can
    // still carry the bytes. Completing that order must not return them.
    const h = storeHarness(true);
    const presentation = { format: "mso_mdoc" as const, deviceResponse: "LEGACY-RAW", inspectUrl: `${INSPECTOR_URL}#LEGACY-RAW` };
    await h.verificationStore.write("W1", { ageVerified: true, proofs: [{ ...entry("Age 21+"), presentation } as ProofEntry] });
    const pay = await request(h.server).post("/credentagent/dc-payment/verify").send({ order: "W1", amount: 124, claims: DEMO_INSTRUMENT });
    expect(pay.body.completed).toBe(true);
    expect(pay.body.proofsHtml).toContain("Age 21+");
    expect(JSON.stringify(pay.body)).not.toContain("LEGACY-RAW");
    expect(JSON.stringify(h.records.get("W1"))).not.toContain("LEGACY-RAW");
  });

  it("no proofs block until the order completes", async () => {
    const h = storeHarness(true);
    const pay = await request(h.server).post("/credentagent/dc-payment/verify").send({ order: "W1", amount: 124, claims: DEMO_INSTRUMENT });
    expect(pay.body.completed).toBe(false); // age not proven → refused
    expect(pay.body).not.toHaveProperty("proofsHtml");
  });
});

describe("completeOrder keeps the proofs", () => {
  it("REFUSES to copy the wallet's raw answer onto the completed record (#320)", async () => {
    const verificationStore = new MemoryVerificationStore();
    // An untyped caller (or a record stored before #320) hands completeOrder the bytes anyway.
    const presentation = { format: "mso_mdoc" as const, deviceResponse: "RAW", inspectUrl: `${INSPECTOR_URL}#RAW` };
    await verificationStore.write("O3", { proofs: [{ ...entry("Age 21+"), presentation } as ProofEntry] });
    const records = new Map<string, CompletedRecord>();
    const order = catalog.createOrder([{ productId: "mug", quantity: 1 }], "O3");
    const out = await completeOrder(
      { order, mandateId: "m3", amount: 10, currency: "USD", method: "dc-payment", gates: [], proof: { ...entry("Pay (USD)", { rail: "dc-payment" }), presentation } as ProofEntry },
      { catalog, verificationStore, records: { read: (id) => records.get(id), write: (r) => void records.set(r.orderId, r) } },
    );
    expect(out.completed).toBe(true);
    expect(records.get("O3")?.proofs).toEqual([entry("Age 21+"), entry("Pay (USD)", { rail: "dc-payment" })]);
    expect(JSON.stringify(records.get("O3"))).not.toContain("RAW");
  });

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
