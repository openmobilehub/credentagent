// Bypass/contract tests for the dc-payment rail (Digital Credentials API +
// OpenID4VP, amount-bound) — US3. The headline control is CT8: a dc-payment
// verify records through the SAME shared `completeOrder` seam as the passkey rail
// (no second completion path — FR-008), with the amount bound + re-derived from
// the injected catalog. Every assertion pins a control and FAILS if it is removed:
//   CT8  — verify completes via the shared completeOrder seam (idempotent,
//          re-priced, cart + per-order verification cleared); a tampered amount or
//          a tampered/unknown order id is REFUSED (invariants 1/2/3).
//   CT11 — the page, the OpenID4VP request descriptor, and the verify receipt all
//          state trust_level "presence-only-demo" (Principle VII / FR-011).
//
// The verify path exercised here is the WORKING presence-only mechanism (the demo's
// instant-demo path, adapted): the disclosed instrument is taken at face value and
// the amount-bound transaction_data is re-derived + re-checked, but the wallet's
// signed mdoc DeviceResponse (issuer/device signatures, JWE-encrypted vp_token) is
// the PR-in-flight crypto — scaffolded in request.ts and refused 501 by the route's
// presentation path.

import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { mountCeremony, resolveOrder, type CeremonyContext, type CeremonySeams } from "../mount.js";
import { completeOrder, type CompletedRecord, type CompletionContext } from "../completion.js";
import { MemoryVerificationStore } from "../../store.js";
import { buildDcMandate, runDcGates } from "./verify.js";
import { buildDcPaymentRequest } from "./request.js";
import { renderDcPaymentPage } from "./page.js";
import type { CeremonyCatalog, CeremonyOrder, CompletionInput } from "../types.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// The catalog is the source of truth for price AND age restriction. oak-whiskey is
// 21+ (minimumAge on the re-priced line); aurora-headphones is unrestricted.
const PRODUCTS: Record<string, { price: number; minimumAge?: number }> = {
  "oak-whiskey": { price: 124, minimumAge: 21 },
  "aurora-headphones": { price: 199 },
};

const catalog: CeremonyCatalog = {
  createOrder(items, orderId, opts) {
    const lines = items.map((it) => {
      const p = PRODUCTS[it.productId] ?? { price: 0 };
      return {
        id: it.productId,
        name: it.productId,
        unitPrice: p.price,
        currency: "USD",
        quantity: it.quantity,
        lineTotal: p.price * it.quantity,
        ...(p.minimumAge ? { minimumAge: p.minimumAge } : {}),
      };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const discount = opts?.loyaltyApplied ? round2(subtotal * 0.1) : 0;
    const total = round2(subtotal - discount);
    return { id: orderId, lines, itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal, discount, total, currency: "USD", createdAt: new Date().toISOString() };
  },
};

// A canonical presence-only payment credential the instant-demo button discloses.
const DEMO_CLAIMS = {
  issuer_name: "Demo Bank",
  payment_instrument_id: "pi-77AABBCC",
  masked_account_reference: "•••• 4242",
  holder_name: "Demo Buyer",
  expiry_date: "2032-09-01",
};

interface Harness {
  app: Express;
  ctx: CeremonyContext;
  verificationStore: MemoryVerificationStore;
  orders: Map<string, CeremonyOrder>;
  records: Map<string, CompletedRecord>;
  seed: (id: string, items: { id: string; quantity: number }[], tamperedTotal?: number) => void;
  cartClears: () => number;
  writes: () => number;
}

// The dc-payment route's completion seam is the SHARED completeOrder bound to a
// CompletionContext — IDENTICAL to what the passkey rail uses (CT8 / FR-008). Wiring
// it here proves there is no second completion code path.
function harness(): Harness {
  const verificationStore = new MemoryVerificationStore();
  const orders = new Map<string, CeremonyOrder>();
  const records = new Map<string, CompletedRecord>();
  let cartClears = 0;
  let writes = 0;
  const completionCtx: CompletionContext = {
    catalog,
    verificationStore,
    records: {
      read: async (id) => records.get(id),
      write: async (rec) => void (records.set(rec.orderId, rec), writes++),
    },
    cart: { clear: async () => void cartClears++ },
  };
  const seams: CeremonySeams = {
    verificationStore,
    orderStore: { read: async (id) => orders.get(id) ?? null },
    catalog,
    completion: (input) => completeOrder(input, completionCtx), // ← the shared seam
    signingKey: "stable-test-secret",
  };
  const app = express();
  const ctx = mountCeremony(app as never, seams);
  function seed(id: string, items: { id: string; quantity: number }[], tamperedTotal?: number): void {
    const priced = catalog.createOrder(items.map((i) => ({ productId: i.id, quantity: i.quantity })), id);
    orders.set(id, tamperedTotal != null ? { ...priced, total: tamperedTotal, subtotal: tamperedTotal } : priced);
  }
  return { app, ctx, verificationStore, orders, records, seed, cartClears: () => cartClears, writes: () => writes };
}

const localhost = { rpID: "127.0.0.1", origin: "http://127.0.0.1" };

// ── CT8 — records through the SAME shared completeOrder seam ──────────────────

describe("CT8 — a dc-payment verify completes via the shared completeOrder seam", () => {
  it("records the order (method dc-payment), clears the cart, and clears per-order verification", async () => {
    const h = harness();
    h.seed("ORD-D1", [{ id: "aurora-headphones", quantity: 1 }]);
    // Some unrelated per-order state that completion must clear on success.
    await h.verificationStore.write("ORD-D1", { loyalty: { applied: false, membershipNumber: null } });

    const order = await resolveOrder(h.ctx, "ORD-D1");
    const res = await request(h.app)
      .post("/attesto/dc-payment/verify")
      .send({ order: "ORD-D1", amount: order!.total, claims: DEMO_CLAIMS });

    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
    expect(res.body.gates.every((g: { pass: boolean }) => g.pass)).toBe(true);

    const recorded = h.records.get("ORD-D1");
    expect(recorded?.amount).toBe(199); // amount re-derived from the catalog
    expect(recorded?.method).toBe("dc-payment");
    expect(recorded?.mandateId).toBe(res.body.mandate.id);
    expect(h.cartClears()).toBe(1); // cart emptied through the shared seam
    expect(await h.verificationStore.read("ORD-D1")).toBeUndefined(); // per-order verification cleared
  });

  it("is idempotent — a replayed verify echoes the record and writes/settles nothing twice", async () => {
    const h = harness();
    h.seed("ORD-D2", [{ id: "aurora-headphones", quantity: 1 }]);
    const order = await resolveOrder(h.ctx, "ORD-D2");
    const body = { order: "ORD-D2", amount: order!.total, claims: DEMO_CLAIMS };

    const first = await request(h.app).post("/attesto/dc-payment/verify").send(body);
    expect(first.body.completed).toBe(true);
    expect(h.writes()).toBe(1);

    const replay = await request(h.app).post("/attesto/dc-payment/verify").send(body);
    expect(replay.body.completed).toBe(true);
    expect(h.writes()).toBe(1); // no second write — FAILS if completion stopped being idempotent
    expect(h.records.size).toBe(1);
  });

  it("the mandate amount is bound to the catalog total and carries a re-derived transaction_data hash", async () => {
    const h = harness();
    h.seed("ORD-D3", [{ id: "aurora-headphones", quantity: 2 }]); // 398
    const order = await resolveOrder(h.ctx, "ORD-D3");
    const res = await request(h.app)
      .post("/attesto/dc-payment/verify")
      .send({ order: "ORD-D3", amount: order!.total, claims: DEMO_CLAIMS });
    expect(res.body.mandate.payment.amount).toBe(398);
    const amountGate = res.body.gates.find((g: { gate: string }) => g.gate === "Amount binding");
    expect(amountGate.pass).toBe(true);
    expect(res.body.mandate.userAuthorization.transactionDataHash).toEqual(expect.any(String));
  });
});

// ── CT8 — amount binding is load-bearing (tampered amount / id refused) ───────

describe("CT8 — a tampered amount or order id is refused (amount re-derived from the catalog)", () => {
  it("refuses a tampered (under-)amount — the amount-binding gate fails and NOTHING is recorded", async () => {
    const h = harness();
    h.seed("ORD-T1", [{ id: "aurora-headphones", quantity: 1 }]); // catalog total 199
    const res = await request(h.app)
      .post("/attesto/dc-payment/verify")
      .send({ order: "ORD-T1", amount: 1, claims: DEMO_CLAIMS }); // claims $1 for a $199 item
    expect(res.body.completed).toBe(false);
    expect(res.body.gates.find((g: { gate: string }) => g.gate === "Amount binding").pass).toBe(false);
    expect(h.records.size).toBe(0); // FAILS if the gate trusted the presented amount
  });

  it("re-prices a hand-edited (tampered) stored total from the catalog, never the token", async () => {
    const h = harness();
    h.seed("ORD-T2", [{ id: "aurora-headphones", quantity: 1 }], /* tamperedTotal */ 1);
    const order = await resolveOrder(h.ctx, "ORD-T2");
    expect(order?.total).toBe(199); // catalog wins over the $1 the token claimed
    // Authorizing the catalog amount completes; the $1 the token claimed is refused.
    const ok = await request(h.app).post("/attesto/dc-payment/verify").send({ order: "ORD-T2", amount: 199, claims: DEMO_CLAIMS });
    expect(ok.body.completed).toBe(true);
    const bad = harness();
    bad.seed("ORD-T2", [{ id: "aurora-headphones", quantity: 1 }], 1);
    const refused = await request(bad.app).post("/attesto/dc-payment/verify").send({ order: "ORD-T2", amount: 1, claims: DEMO_CLAIMS });
    expect(refused.body.completed).toBe(false);
  });

  it("the verify handler refuses an unknown order id (400) — the amount has no catalog source", async () => {
    const h = harness();
    const res = await request(h.app).post("/attesto/dc-payment/verify").send({ order: "ORD-UNKNOWN", amount: 199, claims: DEMO_CLAIMS });
    expect(res.status).toBe(400);
    expect(res.body.completed).toBeFalsy();
  });

  it("the page route 404s an unknown order id", async () => {
    const h = harness();
    const res = await request(h.app).get("/attesto/dc-payment").query({ order: "ORD-UNKNOWN" });
    expect(res.status).toBe(404);
  });
});

// ── CT8 — the shared seam also enforces the age gate (one completion path) ────

describe("CT8 — the shared completion seam refuses an unverified age-restricted order", () => {
  it("an age-restricted order with no proven age claim is refused even with a valid payment", async () => {
    const h = harness();
    h.seed("ORD-AGE", [{ id: "oak-whiskey", quantity: 1 }]); // 21+ item
    const order = await resolveOrder(h.ctx, "ORD-AGE");
    const res = await request(h.app).post("/attesto/dc-payment/verify").send({ order: "ORD-AGE", amount: order!.total, claims: DEMO_CLAIMS });
    expect(res.body.completed).toBe(false); // shared seam re-derives the age restriction
    expect(h.records.size).toBe(0);
  });

  it("the same order completes once a positive per-order age claim exists", async () => {
    const h = harness();
    h.seed("ORD-AGE2", [{ id: "oak-whiskey", quantity: 1 }]);
    await h.verificationStore.write("ORD-AGE2", { ageVerified: true });
    const order = await resolveOrder(h.ctx, "ORD-AGE2");
    const res = await request(h.app).post("/attesto/dc-payment/verify").send({ order: "ORD-AGE2", amount: order!.total, claims: DEMO_CLAIMS });
    expect(res.body.completed).toBe(true);
    expect(h.records.get("ORD-AGE2")?.amount).toBe(124);
  });
});

// ── CT8 — the discounted total reconciles on the dc-payment path (invariant 3) ─

describe("CT8 — a membership-discounted order authorizes the discounted total (no path divergence)", () => {
  it("the bound amount equals the re-derived discounted total and completes", async () => {
    const h = harness();
    h.seed("ORD-M", [{ id: "aurora-headphones", quantity: 1 }]);
    await h.verificationStore.write("ORD-M", { loyalty: { applied: true, membershipNumber: "M-2231" } });
    const order = await resolveOrder(h.ctx, "ORD-M");
    expect(order!.total).toBeCloseTo(179.1); // 199 − 10%
    const res = await request(h.app).post("/attesto/dc-payment/verify").send({ order: "ORD-M", amount: order!.total, claims: DEMO_CLAIMS });
    expect(res.body.completed).toBe(true);
    expect(res.body.mandate.payment.amount).toBeCloseTo(179.1);
  });
});

// ── Presence-only honesty (CT11) + the scaffolded signed-presentation path ────

describe("CT11 — page / request descriptor / receipt all state presence-only-demo", () => {
  it("the rendered page states trust_level presence-only-demo (not a real safety control)", () => {
    const html = renderDcPaymentPage({ order: "ORD-A", total: 199, currency: "USD", lines: [{ name: "aurora-headphones", quantity: 1, lineTotal: 199, currency: "USD" }] });
    expect(html).toContain("presence-only-demo");
  });

  it("the OpenID4VP request descriptor is fenced presence-only-demo, marked scaffold/in-flight, and carries the amount-bound transaction_data", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-A");
    const req = buildDcPaymentRequest(order, localhost);
    expect(req.trust_level).toBe("presence-only-demo");
    expect(req.status).toBe("scaffold-in-flight");
    expect(req.dcql_query.credentials.length).toBeGreaterThan(0);
    expect(req.transaction_data.length).toBeGreaterThan(0);
  });

  it("the verify receipt (mandate) carries trust_level presence-only-demo", async () => {
    const h = harness();
    h.seed("ORD-H", [{ id: "aurora-headphones", quantity: 1 }]);
    const order = await resolveOrder(h.ctx, "ORD-H");
    const res = await request(h.app).post("/attesto/dc-payment/verify").send({ order: "ORD-H", amount: order!.total, claims: DEMO_CLAIMS });
    expect(res.body.mandate.trust_level).toBe("presence-only-demo");
  });

  it("the encrypted wallet-presentation path is scaffolded — 501 pointing at the presence-only path", async () => {
    const h = harness();
    h.seed("ORD-P", [{ id: "aurora-headphones", quantity: 1 }]);
    const res = await request(h.app).post("/attesto/dc-payment/verify").send({ order: "ORD-P", presentation: "<jwe>" });
    expect(res.status).toBe(501);
    expect(res.body.trust_level).toBe("presence-only-demo");
    expect(h.records.size).toBe(0);
  });
});

// ── The four gates are re-derived, not trusted (unit-level) ───────────────────

describe("runDcGates — re-derives the binding; no trusted `verified` flag", () => {
  it("passes all four gates for a faithful presence-only mandate", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-G");
    const mandate = buildDcMandate({ order, origin: localhost, claims: DEMO_CLAIMS, presentedAmount: order.total });
    const gates = runDcGates(mandate, localhost);
    expect(gates).toHaveLength(4);
    expect(gates.every((g) => g.pass)).toBe(true);
  });

  it("fails amount binding when the presented amount diverges from the re-derived payable", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-G");
    const mandate = buildDcMandate({ order, origin: localhost, claims: DEMO_CLAIMS, presentedAmount: 1 });
    const gate = runDcGates(mandate, localhost).find((g) => g.gate === "Amount binding");
    expect(gate?.pass).toBe(false);
  });

  it("fails subject binding when the disclosed instrument id is absent", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-G");
    const mandate = buildDcMandate({ order, origin: localhost, claims: { ...DEMO_CLAIMS, payment_instrument_id: undefined }, presentedAmount: order.total });
    const subject = runDcGates(mandate, localhost).find((g) => g.gate === "Subject binding");
    expect(subject?.pass).toBe(false);
  });

  it("fails the expiry gate for a past expiry_date", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-G");
    const mandate = buildDcMandate({ order, origin: localhost, claims: { ...DEMO_CLAIMS, expiry_date: "2000-01-01" }, presentedAmount: order.total });
    const exp = runDcGates(mandate, localhost).find((g) => g.gate === "Credential not expired");
    expect(exp?.pass).toBe(false);
  });

  it("fails the payee binding when the request origin/RP-ID does not match", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-G");
    const mandate = buildDcMandate({ order, origin: localhost, claims: DEMO_CLAIMS, presentedAmount: order.total });
    const gate = runDcGates(mandate, { rpID: "evil.example", origin: "https://evil.example" }).find((g) => g.gate === "Amount binding");
    expect(gate?.pass).toBe(false); // payee bound to the issuing origin, not the attacker's
  });
});
