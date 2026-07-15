// Bypass/contract tests for the credential-gate rail (age + membership) — the
// GDC-hero MVP (US1). Every assertion pins a security control and FAILS if that
// control is removed:
//   CT4  — age verify succeeds ONLY on the explicit positive claim at the order's
//          threshold; an age_over_18 proof is REFUSED for a 21+ gate (invariant 5).
//   CT9  — an unverified age-restricted order is refused at the rail's verify
//          handler AND at the shared completion seam (`completeOrder`). The demo's
//          place-order + MCP order-completion-tool enforcement is **T014 (deferred)**.
//   CT10 — verifying order A does not unlock order B (per-order verificationStore;
//          never process-global — invariant 4).
//   CT5  — a verified membership applies the discount exactly once; the re-derived
//          line sum / total / bound amount reconcile (invariant 3).
//   CT3  — a tampered/unknown order id is refused; the amount comes from the
//          catalog, never the token (invariant 2).
//   CT11 — the page, the OpenID4VP request descriptor, and the verify receipt all
//          state trust_level "presence-only-demo" (Principle VII / FR-011).
//
// The verify path exercised here is the WORKING presence-only mechanism (the demo's
// instant-demo path, adapted): disclosed claims are trusted WITHOUT cryptographic
// mdoc verification, but the explicit-positive-claim control still runs. The
// OpenID4VP signed-request / JWE-presentation shape is scaffolded alongside
// (request.ts) and is PR-in-flight.

import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { mountCeremony, resolveOrder, type CeremonyContext, type CeremonySeams } from "../mount.js";
import { completeOrder, type CompletedRecord, type CompletionContext } from "../completion.js";
import { MemoryVerificationStore } from "../../store.js";
import { evaluateCredential, requiredAgeForOrder } from "./verify.js";
import { buildCredentialRequest } from "./request.js";
import { renderCredentialPage } from "./page.js";
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

interface Harness {
  app: Express;
  ctx: CeremonyContext;
  verificationStore: MemoryVerificationStore;
  orders: Map<string, CeremonyOrder>;
  seed: (id: string, items: { id: string; quantity: number }[], tamperedTotal?: number) => void;
}

function harness(): Harness {
  const verificationStore = new MemoryVerificationStore();
  const orders = new Map<string, CeremonyOrder>();
  const seams: CeremonySeams = {
    verificationStore,
    orderStore: { read: async (id) => orders.get(id) ?? null },
    catalog,
    completion: async () => ({ completed: true }), // credential routes don't complete; payment does
    signingKey: "stable-test-secret",
  };
  const app = express();
  const ctx = mountCeremony(app as never, seams);
  function seed(id: string, items: { id: string; quantity: number }[], tamperedTotal?: number): void {
    const priced = catalog.createOrder(items.map((i) => ({ productId: i.id, quantity: i.quantity })), id);
    // A hand-edited token can claim any total; resolveOrder must re-price it away.
    orders.set(id, tamperedTotal != null ? { ...priced, total: tamperedTotal, subtotal: tamperedTotal } : priced);
  }
  return { app, ctx, verificationStore, orders, seed };
}

// A completion context over the shared completeOrder seam (the "gate's completion
// seam" half of CT9). Mirrors mount.test.ts's helper.
function completionCtx(verificationStore: MemoryVerificationStore): { ctx: CompletionContext; records: Map<string, CompletedRecord> } {
  const records = new Map<string, CompletedRecord>();
  const ctx: CompletionContext = {
    catalog,
    verificationStore,
    records: { read: async (id) => records.get(id), write: async (rec) => void records.set(rec.orderId, rec) },
    cart: { clear: async () => {} },
  };
  return { ctx, records };
}

const PASSING_GATES = [{ gate: "Amount integrity", pass: true, detail: "" }];
function completionInput(order: CeremonyOrder): CompletionInput {
  return { order, mandateId: "m1", amount: order.total, currency: order.currency, method: "passkey", gates: PASSING_GATES };
}

// ── CT4 — explicit positive claim at the order's threshold ───────────────────

describe("CT4 — age verify succeeds ONLY on age_over_21 === true for a 21+ gate", () => {
  it("evaluateCredential passes a 21+ gate on age_over_21 === true", () => {
    const r = evaluateCredential("age", { age_over_21: true }, { minimumAge: 21 });
    expect(r.verified).toBe(true);
    expect(r.trust_level).toBe("presence-only-demo");
  });

  it("REFUSES an age_over_18 proof for a 21+ gate (no sub-threshold acceptance)", () => {
    const r = evaluateCredential("age", { age_over_18: true }, { minimumAge: 21 });
    expect(r.verified).toBe(false); // FAILS if the gate accepted 18+ for a 21+ restriction
  });

  it("REFUSES a token-present-but-false claim (age_over_21 === false)", () => {
    expect(evaluateCredential("age", { age_over_21: false }, { minimumAge: 21 }).verified).toBe(false);
  });

  it("the verify handler refuses an age_over_18 proof and does NOT mark the order verified", async () => {
    const h = harness();
    h.seed("ORD-A", [{ id: "oak-whiskey", quantity: 1 }]);
    const res = await request(h.app).post("/credentagent/credential/verify").send({ order: "ORD-A", cred: "age", claims: { age_over_18: true } });
    expect(res.body.verified).toBe(false);
    expect(await h.verificationStore.read("ORD-A")).toBeUndefined(); // not marked ⇒ completion stays blocked
  });

  it("the verify handler accepts age_over_21 and writes a positive per-order claim at the threshold", async () => {
    const h = harness();
    h.seed("ORD-A", [{ id: "oak-whiskey", quantity: 1 }]);
    const res = await request(h.app).post("/credentagent/credential/verify").send({ order: "ORD-A", cred: "age", claims: { age_over_21: true } });
    expect(res.body.verified).toBe(true);
    expect((await h.verificationStore.read("ORD-A"))?.ageVerified).toBe(true);
  });
});

// ── CT9 — enforce on the verify handler AND the shared completion seam ────────

describe("CT9 — an unverified age-restricted order is refused (every package path)", () => {
  it("the shared completeOrder seam refuses an age-restricted order with no age claim (reason 'age')", async () => {
    const vs = new MemoryVerificationStore();
    const { ctx, records } = completionCtx(vs);
    const order = catalog.createOrder([{ productId: "oak-whiskey", quantity: 1 }], "ORD-A");
    const res = await completeOrder(completionInput(order), ctx);
    expect(res.completed).toBe(false);
    expect(res.reason).toBe("age"); // FAILS if completion stopped re-deriving the age restriction
    expect(records.size).toBe(0); // nothing recorded
  });

  it("the shared completeOrder seam completes once the order carries a positive age claim", async () => {
    const vs = new MemoryVerificationStore();
    await vs.write("ORD-A", { ageVerified: true });
    const { ctx, records } = completionCtx(vs);
    const order = catalog.createOrder([{ productId: "oak-whiskey", quantity: 1 }], "ORD-A");
    const res = await completeOrder(completionInput(order), ctx);
    expect(res.completed).toBe(true);
    expect(records.get("ORD-A")?.amount).toBe(124);
  });

  it("an unrestricted order completes without any age claim (the gate only fires when it applies)", async () => {
    const vs = new MemoryVerificationStore();
    const { ctx } = completionCtx(vs);
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-B");
    expect((await completeOrder(completionInput(order), ctx)).completed).toBe(true);
  });

  // NOTE: the demo's POST /checkout/place-order and the MCP order-completion tool
  // are the OTHER two completion paths CT9 covers. Wiring the demo to consume this
  // rail (and re-deriving the same refusal there) is T014 — deferred by design so
  // the demo suite stays green; tracked, not skipped.
});

// ── CT10 — per-order isolation (state keyed by order id, never global) ────────

describe("CT10 — verifying order A does not unlock order B", () => {
  it("an age claim on ORD-A leaves ORD-B's age-restricted completion refused", async () => {
    const h = harness();
    h.seed("ORD-A", [{ id: "oak-whiskey", quantity: 1 }]);
    h.seed("ORD-B", [{ id: "oak-whiskey", quantity: 1 }]);
    await request(h.app).post("/credentagent/credential/verify").send({ order: "ORD-A", cred: "age", claims: { age_over_21: true } });

    expect((await h.verificationStore.read("ORD-A"))?.ageVerified).toBe(true);
    expect(await h.verificationStore.read("ORD-B")).toBeUndefined(); // B never unlocked

    const { ctx } = completionCtx(h.verificationStore);
    const orderB = catalog.createOrder([{ productId: "oak-whiskey", quantity: 1 }], "ORD-B");
    expect((await completeOrder(completionInput(orderB), ctx)).reason).toBe("age");
  });
});

// ── CT5 — membership applies the discount exactly once; amounts reconcile ─────

describe("CT5 — a verified membership applies the discount once and amounts reconcile", () => {
  it("verifying membership marks the order and re-derives the discounted total once (line sum / total reconcile)", async () => {
    const h = harness();
    h.seed("ORD-M", [{ id: "aurora-headphones", quantity: 1 }]);

    // Undiscounted baseline.
    expect((await resolveOrder(h.ctx, "ORD-M"))?.total).toBe(199);

    const res = await request(h.app).post("/credentagent/credential/verify").send({ order: "ORD-M", cred: "membership", claims: { membership_number: "M-2231" } });
    expect(res.body.verified).toBe(true);
    expect((await h.verificationStore.read("ORD-M"))?.loyalty).toMatchObject({ applied: true, membershipNumber: "M-2231" });

    const order = await resolveOrder(h.ctx, "ORD-M");
    expect(order).not.toBeNull();
    expect(order!.discount).toBeCloseTo(19.9); // 10% of 199
    // Reconciliation (invariant 3): subtotal == Σ lineTotals, total == subtotal − discount.
    const lineSum = round2(order!.lines.reduce((s, l) => s + l.lineTotal, 0));
    expect(order!.subtotal).toBe(lineSum);
    expect(order!.total).toBeCloseTo(round2(lineSum - order!.discount));

    // Applied EXACTLY once — re-deriving does not stack a second discount.
    const again = await resolveOrder(h.ctx, "ORD-M");
    expect(again!.total).toBeCloseTo(order!.total);

    // The discounted total survives the completion re-price (no path refuses it).
    const { ctx } = completionCtx(h.verificationStore);
    const completion = await completeOrder(completionInput(order!), ctx);
    expect(completion.completed).toBe(true);
  });
});

// ── CT3 — tampered/unknown order id refused; amount from the catalog ──────────

describe("CT3 — a tampered/unknown order id is refused; the amount comes from the catalog", () => {
  it("the page route 404s an unknown order id", async () => {
    const h = harness();
    const res = await request(h.app).get("/credentagent/credential").query({ order: "ORD-UNKNOWN", cred: "age" });
    expect(res.status).toBe(404);
  });

  it("the verify handler refuses an unknown order id (400)", async () => {
    const h = harness();
    const res = await request(h.app).post("/credentagent/credential/verify").send({ order: "ORD-UNKNOWN", cred: "age", claims: { age_over_21: true } });
    expect(res.status).toBe(400);
    expect(res.body.verified).toBe(false);
  });

  it("re-prices a hand-edited (tampered) stored total from the catalog, never the token", async () => {
    const h = harness();
    h.seed("ORD-T", [{ id: "oak-whiskey", quantity: 1 }], /* tamperedTotal */ 1);
    const order = await resolveOrder(h.ctx, "ORD-T");
    expect(order?.total).toBe(124); // catalog wins over the $1 the token claimed
    // The page reflects the catalog amount, not the token's.
    const page = await request(h.app).get("/credentagent/credential").query({ order: "ORD-T", cred: "age" });
    expect(page.status).toBe(200);
    expect(page.text).toContain("124");
  });

  it("requiredAgeForOrder re-derives the threshold from the catalog-priced lines", async () => {
    const h = harness();
    h.seed("ORD-T", [{ id: "oak-whiskey", quantity: 1 }], 1);
    const order = await resolveOrder(h.ctx, "ORD-T");
    expect(requiredAgeForOrder(order!)).toBe(21);
    const unrestricted = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-U");
    expect(requiredAgeForOrder(unrestricted)).toBeNull();
  });
});

// ── CT11 — presence-only honesty on every surface ────────────────────────────

describe("CT11 — page / request descriptor / receipt all state presence-only-demo", () => {
  it("the rendered page states trust_level presence-only-demo (not a real safety control)", () => {
    const html = renderCredentialPage({ kind: "age", order: "ORD-A", minimumAge: 21, total: 124, currency: "USD" });
    expect(html).toContain("presence-only-demo");
  });

  it("the OpenID4VP request descriptor is fenced presence-only-demo and carries a REAL signed request + DCQL", async () => {
    const req = await buildCredentialRequest("age", { rpID: "shop.example", origin: "https://shop.example" }, "stable-test-secret", { minimumAge: 21 });
    expect(req.trust_level).toBe("presence-only-demo");
    // The request is now a REAL ES256-signed OpenID4VP JWT (three base64url segments),
    // not a scaffold descriptor — the crypto is real; only the issuer trust anchor is fenced.
    expect(req.protocol).toBe("openid4vp-v1-signed");
    expect(req.request.split(".").length).toBe(3);
    expect(req.readerContextToken.length).toBeGreaterThan(0);
    expect(req.dcql_query.credentials.length).toBeGreaterThan(0);
  });

  it("the verify receipt carries trust_level presence-only-demo", async () => {
    const h = harness();
    h.seed("ORD-A", [{ id: "oak-whiskey", quantity: 1 }]);
    const res = await request(h.app).post("/credentagent/credential/verify").send({ order: "ORD-A", cred: "age", claims: { age_over_21: true } });
    expect(res.body.trust_level).toBe("presence-only-demo");
  });
});

// ── #46 — the credential-gate rail is order-derived, no phantom Age on the membership page ──
// The deleted membership branch hardcoded { label: "Age", done: true }; the age branch
// hardcoded a Membership step. The rail now derives from the order. Fails against the old code.
function credRailLabels(html: string): string[] {
  return [...html.matchAll(/rail-label">([^<]+)</g)].map((m) => m[1]);
}

describe("#46 — credential-gate rail reflects the order (no phantom steps)", () => {
  it("the MEMBERSHIP gate page on a non-age order shows Membership · Pay — no hardcoded Age ✓", async () => {
    const h = harness();
    h.seed("ORD-NOAGE", [{ id: "aurora-headphones", quantity: 1 }]); // no age line, no discount
    const res = await request(h.app).get("/credentagent/credential").query({ order: "ORD-NOAGE", cred: "membership" });
    expect(credRailLabels(res.text)).toEqual(["Membership", "Pay"]);
    expect(res.text).not.toContain('rail-label">Age'); // old membership branch showed Age done:true
  });

  it("the AGE gate page on an age order shows Age · Pay — no hardcoded Membership step", async () => {
    const h = harness();
    h.seed("ORD-AGE", [{ id: "oak-whiskey", quantity: 1 }]); // 21+, no discount
    const res = await request(h.app).get("/credentagent/credential").query({ order: "ORD-AGE", cred: "age" });
    expect(credRailLabels(res.text)).toEqual(["Age", "Pay"]); // old age branch showed Age·Membership·Pay
  });
});
