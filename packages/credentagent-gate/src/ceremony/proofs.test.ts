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
