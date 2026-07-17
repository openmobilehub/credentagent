// Direct unit tests of the shared completeOrder seam. Until now its controls — every
// deterministic gate must pass, the catalog re-prices (never the token), an age-restricted
// order needs a proven per-order age claim, idempotency, and fail-closed settlement — were
// covered only TRANSITIVELY through the rail suites. These pin them at the seam, each as a
// BYPASS test that fails if its control is removed (Security invariants 1-3 + FR-013).
import { describe, it, expect, vi } from "vitest";
import { completeOrder, type CompletedRecord, type CompletionContext, type SettlementRecordLike } from "./completion.js";
import { MemoryVerificationStore } from "../store.js";
import type { Credential } from "../types.js";
import { professionalLicense, prescription } from "./credential-gate/__fixtures__/customCredential.js";
import type { CeremonyCatalog, CompletionInput } from "./types.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const PRODUCTS: Record<string, { price: number; minimumAge?: number; category?: string; requiresRx?: boolean }> = {
  widget: { price: 10 },
  wine: { price: 20, minimumAge: 21 },
  drill: { price: 50, category: "Licensed" }, // 007: the custom gate's applicable line
  amoxicillin: { price: 30, requiresRx: true }, // 007: keyed on a NON-category field (fail-open repro)
};

const catalog: CeremonyCatalog = {
  createOrder(items, orderId, opts) {
    const lines = items.map((it) => {
      const p = PRODUCTS[it.productId] ?? { price: 0 };
      return { id: it.productId, name: it.productId, unitPrice: p.price, currency: "USD", quantity: it.quantity, lineTotal: p.price * it.quantity, ...(p.minimumAge ? { minimumAge: p.minimumAge } : {}), ...(p.category ? { category: p.category } : {}), ...(p.requiresRx ? { requiresRx: true } : {}) };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const discount = opts?.loyaltyApplied ? round2(subtotal * 0.1) : 0;
    return { id: orderId, lines, itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal, discount, total: round2(subtotal - discount), currency: "USD", createdAt: new Date().toISOString() };
  },
};

// The worked pack + the requiresRx prescription gate come from the shared fixture (T002).
const licenseRegistry = new Map<string, Credential>([[professionalLicense.id, professionalLicense]]);
const rxRegistry = new Map<string, Credential>([[prescription.id, prescription]]);

interface Harness {
  ctx: CompletionContext;
  records: Map<string, CompletedRecord>;
  store: MemoryVerificationStore;
  cleared: { count: number };
  input: (items: { productId: string; quantity: number }[], over?: Partial<CompletionInput>) => CompletionInput;
}

function harness(opts: { settle?: CompletionContext["settle"]; registry?: ReadonlyMap<string, Credential> } = {}): Harness {
  const records = new Map<string, CompletedRecord>();
  const store = new MemoryVerificationStore();
  const cleared = { count: 0 };
  const ctx: CompletionContext = {
    catalog,
    verificationStore: store,
    records: { read: async (id) => records.get(id), write: async (rec) => void records.set(rec.orderId, rec) },
    cart: { clear: async () => void cleared.count++ },
    ...(opts.settle ? { settle: opts.settle } : {}),
    ...(opts.registry ? { credentialRegistry: opts.registry } : {}),
  };
  const input: Harness["input"] = (items, over = {}) => {
    const { order: overOrder, ...rest } = over;
    const order = catalog.createOrder(items, overOrder?.id ?? "ORD-1", {});
    return { order, mandateId: "m", amount: order.total, currency: "USD", method: "test", gates: [{ gate: "g", pass: true, detail: "" }], ...rest };
  };
  return { ctx, records, store, cleared, input };
}

describe("completeOrder — core controls (direct seam tests)", () => {
  it("happy path: gates pass + price matches ⇒ completes, records, clears the cart", async () => {
    const h = harness();
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }]), h.ctx);
    expect(res.completed).toBe(true);
    expect(h.records.get("ORD-1")?.amount).toBe(20);
    expect(h.cleared.count).toBe(1);
  });

  it("BYPASS: a failed gate refuses (reason 'gates'), records nothing, clears nothing", async () => {
    const h = harness();
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { gates: [{ gate: "g", pass: false, detail: "x" }] }), h.ctx);
    expect(res).toMatchObject({ completed: false, reason: "gates" });
    expect(h.records.size).toBe(0);
    expect(h.cleared.count).toBe(0);
  });

  it("BYPASS (invariant 2): a token total that disagrees with the catalog is refused (reason 'reprice')", async () => {
    const h = harness();
    const i = h.input([{ productId: "widget", quantity: 2 }]); // catalog = 20
    const tampered = { ...i, order: { ...i.order, total: 1 } }; // claim 1
    const res = await completeOrder(tampered, h.ctx);
    expect(res).toMatchObject({ completed: false, reason: "reprice" });
    expect(h.records.size).toBe(0);
  });

  it("BYPASS (invariant 1+5): an age-restricted order with NO proven age is refused (reason 'age')", async () => {
    const h = harness();
    const res = await completeOrder(h.input([{ productId: "wine", quantity: 1 }]), h.ctx); // minimumAge 21, store unset
    expect(res).toMatchObject({ completed: false, reason: "age" });
    expect(h.records.size).toBe(0);
  });

  it("the SAME age-restricted order completes once age is proven (so the refusal was the age control)", async () => {
    const h = harness();
    await h.store.write("ORD-1", { ageVerified: true });
    const res = await completeOrder(h.input([{ productId: "wine", quantity: 1 }]), h.ctx);
    expect(res.completed).toBe(true);
    expect(h.records.get("ORD-1")?.amount).toBe(20);
  });

  it("idempotent: a replayed completion echoes the record and settles/records nothing twice", async () => {
    const settle = vi.fn(async () => ({ network: "x", txId: "t1", status: "settled" }) as SettlementRecordLike);
    const h = harness({ settle });
    const first = await completeOrder(h.input([{ productId: "widget", quantity: 2 }]), h.ctx);
    const second = await completeOrder(h.input([{ productId: "widget", quantity: 2 }]), h.ctx);
    expect(first.completed && second.completed).toBe(true);
    expect(settle).toHaveBeenCalledTimes(1); // not re-settled on replay
    expect(h.cleared.count).toBe(1);
  });

  it("FR-013 fail-closed: a thrown settle records NOTHING and leaves the cart intact (authorized-not-settled)", async () => {
    const settle = vi.fn(async () => { throw new Error("chain down"); });
    const h = harness({ settle });
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }]), h.ctx);
    expect(res.completed).toBe(false);
    expect(res.settlementError).toContain("chain down");
    expect(h.records.size).toBe(0);
    expect(h.cleared.count).toBe(0); // cart NOT emptied — the buyer can retry
  });

  it("a successful settle attaches the record, writes completion, and clears the cart", async () => {
    const settle = vi.fn(async () => ({ network: "hedera-testnet", txId: "0.0.1@1", status: "settled" }) as SettlementRecordLike);
    const h = harness({ settle });
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }]), h.ctx);
    expect(res.completed).toBe(true);
    expect(res.settlement?.txId).toBe("0.0.1@1");
    expect(h.records.get("ORD-1")?.settlement?.txId).toBe("0.0.1@1");
    expect(h.cleared.count).toBe(1);
  });
});

// ── HNP delegated-draw branch (005 FR-006/009) — bypass tests, each control-dependent.
import { MemoryRevocationStore } from "./revocation.js";
import { sealIntent, signDraw, generateDelegate, type IntentBounds, type Draw } from "./mandate.js";

async function drawFixture(over: Partial<IntentBounds> = {}) {
  const { privateKey, delegate } = await generateDelegate();
  const intent = await sealIntent({
    type: "credentagent.IntentBounds/v0",
    merchants: ["utopia-marketplace"],
    currency: "USD",
    maxAmount: 120,
    totalAmount: 120,
    stepUpOver: 500,
    delegate,
    mayPresent: [],
    presence: "delegated",
    trust_level: "issuer-verified (demo PKI)",
    ...over,
  });
  const mkDraw = (amount: number, pspTransactionId = "tx_1") =>
    signDraw(
      { type: "credentagent.Draw/v0", intentId: intent.intentId, paymentMandateId: "d", merchant: "utopia-marketplace", amount, currency: "USD", pspTransactionId },
      privateKey,
    );
  return { intent, mkDraw, privateKey, delegate };
}

describe("completeOrder — HNP delegated-draw branch (bypass tests)", () => {
  it("in-bounds draw completes: delegationId written, settle NOT called", async () => {
    const settle = vi.fn(async () => ({ network: "demo", txId: "x", status: "ok" }) as SettlementRecordLike);
    const h = harness({ settle });
    const rev = new MemoryRevocationStore();
    const { intent, mkDraw } = await drawFixture();
    const draw = await mkDraw(20); // 2 widgets @ 10
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw } }), { ...h.ctx, revocation: rev });
    expect(res.completed).toBe(true);
    expect(res.delegationId).toBe(intent.intentId);
    expect(h.records.get("ORD-1")?.delegationId).toBe(intent.intentId);
    expect(settle).not.toHaveBeenCalled(); // ← settlement suppression is the control (FR-014)
  });

  it("BYPASS: an over-cap draw submitted DIRECTLY to completeOrder is refused, nothing recorded", async () => {
    const h = harness();
    const rev = new MemoryRevocationStore();
    const { intent, mkDraw } = await drawFixture({ maxAmount: 15 });
    const draw = await mkDraw(20);
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw } }), { ...h.ctx, revocation: rev });
    expect(res.completed).toBe(false);
    expect(res.reason).toBe("draw");
    expect(res.refusals?.some((r) => r.code === "over-cap")).toBe(true);
    expect(h.records.size).toBe(0);
  });

  it("BYPASS: a tampered-signature draw is refused", async () => {
    const h = harness();
    const rev = new MemoryRevocationStore();
    const { intent, mkDraw } = await drawFixture();
    const draw = { ...(await mkDraw(20)), amount: 5 } as Draw; // edit after signing
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw } }), { ...h.ctx, revocation: rev });
    expect(res.completed).toBe(false);
    expect(res.refusals?.some((r) => r.code === "signature")).toBe(true);
  });

  it("BYPASS: a revoked grant is refused (revocation is the control)", async () => {
    const h = harness();
    const rev = new MemoryRevocationStore();
    const { intent, mkDraw } = await drawFixture();
    rev.revoke(intent.intentId);
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw: await mkDraw(20) } }), { ...h.ctx, revocation: rev });
    expect(res.completed).toBe(false);
    expect(res.refusals?.[0]?.code).toBe("revoked");
  });

  it("TOCTOU: revocation landing before the seam's own check still refuses", async () => {
    const h = harness();
    const rev = new MemoryRevocationStore();
    const { intent, mkDraw } = await drawFixture();
    const draw = await mkDraw(20);
    // Simulate a revoke that lands between an upstream rail-verify and completeOrder: the
    // seam re-checks isRevoked itself, so it refuses regardless of any prior pass.
    rev.revoke(intent.intentId);
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw } }), { ...h.ctx, revocation: rev });
    expect(res.completed).toBe(false);
    expect(res.refusals?.[0]?.code).toBe("revoked");
  });

  it("FAIL-CLOSED: an unreachable revocation store refuses (never fail-open)", async () => {
    const h = harness();
    const throwing = { isRevoked: () => { throw new Error("down"); }, revoke() {}, revokeSubject() {}, priorDraws() { return []; }, commitDraw() { return { ok: true } as const; } };
    const { intent, mkDraw } = await drawFixture();
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw: await mkDraw(20) } }), { ...h.ctx, revocation: throwing });
    expect(res.completed).toBe(false);
    expect(res.refusals?.[0]?.code).toBe("revocation-unavailable");
  });

  it("FAIL-CLOSED: a draw with no revocation store configured is refused", async () => {
    const h = harness();
    const { intent, mkDraw } = await drawFixture();
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw: await mkDraw(20) } }), h.ctx);
    expect(res.completed).toBe(false);
    expect(res.refusals?.[0]?.code).toBe("revocation-unavailable");
  });

  it("ATOMIC single-use: two draws (one pspTransactionId, two order ids) ⇒ exactly one completes", async () => {
    const h = harness();
    const rev = new MemoryRevocationStore();
    const { intent, mkDraw } = await drawFixture();
    const a = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, order: { id: "ORD-A" } as CompletionInput["order"], draw: { intent, draw: await mkDraw(20, "tx_same") } }), { ...h.ctx, revocation: rev });
    const b = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, order: { id: "ORD-B" } as CompletionInput["order"], draw: { intent, draw: await mkDraw(20, "tx_same") } }), { ...h.ctx, revocation: rev });
    expect([a.completed, b.completed].filter(Boolean)).toHaveLength(1);
    const loser = a.completed ? b : a;
    // Two layers defend single-use: run sequentially, checkDraw's replay guard catches the
    // reused pspTransactionId (priorDraws now holds the winner) BEFORE commitDraw; a true
    // concurrent race that clears checkDraw is then stopped by the atomic commitDraw
    // ("consumed"). Either refusal proves single-use held.
    expect(["replay", "consumed"]).toContain(loser.refusals?.[0]?.code);
  });

  it("AGE NON-DELEGABLE: an age-restricted cart via a draw is refused step-up even with ageVerified set", async () => {
    const h = harness();
    const rev = new MemoryRevocationStore();
    h.store.write("ORD-1", { ageVerified: true } as never); // even WITH a snapshot…
    const { intent, mkDraw } = await drawFixture({ maxAmount: 100 });
    const draw = await mkDraw(20); // 1 wine @ 20
    const res = await completeOrder(h.input([{ productId: "wine", quantity: 1 }], { amount: 20, draw: { intent, draw } }), { ...h.ctx, revocation: rev });
    expect(res.completed).toBe(false);
    expect(res.refusals?.[0]?.code).toBe("step-up"); // …a grant NEVER completes an age gate
  });

  it("ATOMIC cumulative cap: an over-total verdict from commitDraw refuses at the seam", async () => {
    // The store makes the cap decision atomically (Codex P1). If commitDraw reports the
    // committed sum would breach the cap, the seam must refuse — not complete.
    const h = harness();
    const { intent, mkDraw } = await drawFixture();
    const capBreaching = { isRevoked: () => false, revoke() {}, revokeSubject() {}, priorDraws() { return []; }, commitDraw() { return { ok: false, reason: "over-total" } as const; } };
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw: await mkDraw(20) } }), { ...h.ctx, revocation: capBreaching });
    expect(res.completed).toBe(false);
    expect(res.refusals?.[0]?.code).toBe("over-total");
    expect(h.records.size).toBe(0);
  });

  it("BYPASS: draw.amount ≠ catalog re-priced total is refused (grant never carries the price)", async () => {
    const h = harness();
    const rev = new MemoryRevocationStore();
    const { intent, mkDraw } = await drawFixture();
    const draw = await mkDraw(10); // signs amount 10, but 2 widgets re-price to 20
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 10, draw: { intent, draw } }), { ...h.ctx, revocation: rev });
    expect(res.completed).toBe(false);
    expect(res.reason).toBe("draw");
  });
});

// ── US2 (007): completeOrder enforces every applicable custom gate() credential ──
// Each is a BYPASS test: it FAILS if the registry sweep is removed from completeOrder.
describe("completeOrder — custom gate() enforcement (007, US2 / invariant 1)", () => {
  it("BYPASS: an applicable custom gate() with no proven verification is refused (reason 'gate'), records nothing", async () => {
    const h = harness({ registry: licenseRegistry });
    const res = await completeOrder(h.input([{ productId: "drill", quantity: 1 }]), h.ctx); // Licensed line, verifiedGates unset
    expect(res).toMatchObject({ completed: false, reason: "gate" }); // FAILS if the sweep is removed → wrongly completes
    expect(h.records.size).toBe(0);
    expect(h.cleared.count).toBe(0);
  });

  it("the SAME order completes once the custom gate is verified (so the refusal was the gate control)", async () => {
    const h = harness({ registry: licenseRegistry });
    await h.store.write("ORD-1", { verifiedGates: { professional_license: true } });
    const res = await completeOrder(h.input([{ productId: "drill", quantity: 1 }]), h.ctx);
    expect(res.completed).toBe(true);
    expect(h.records.get("ORD-1")?.amount).toBe(50);
  });

  it("per-order scoping (invariant 4): a gate verified for ORD-A does NOT complete ORD-B (same credential)", async () => {
    const h = harness({ registry: licenseRegistry });
    await h.store.write("ORD-A", { verifiedGates: { professional_license: true } });
    const orderB = catalog.createOrder([{ productId: "drill", quantity: 1 }], "ORD-B");
    const res = await completeOrder({ order: orderB, mandateId: "m", amount: orderB.total, currency: "USD", method: "test", gates: [{ gate: "g", pass: true, detail: "" }] }, h.ctx);
    expect(res).toMatchObject({ completed: false, reason: "gate" }); // B never unlocked by A
  });

  it("a NON-applicable custom gate does not block (appliesTo false on the re-priced order)", async () => {
    const h = harness({ registry: licenseRegistry });
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 1 }]), h.ctx); // no Licensed line
    expect(res.completed).toBe(true);
  });

  it("F3/FR-009: a custom gate() composed with a loyalty discount does not disturb amount binding", async () => {
    const h = harness({ registry: licenseRegistry });
    // Licensed drill (50) + loyalty applied ⇒ discount 5 ⇒ total 45; custom gate proven.
    await h.store.write("ORD-1", { verifiedGates: { professional_license: true }, loyalty: { applied: true, membershipNumber: "M-1" } });
    const order = catalog.createOrder([{ productId: "drill", quantity: 1 }], "ORD-1", { loyaltyApplied: true });
    const lineSum = round2(order.lines.reduce((s, l) => s + l.lineTotal, 0));
    expect(order.subtotal).toBe(lineSum);
    expect(order.total).toBe(round2(lineSum - order.discount)); // 45
    const res = await completeOrder({ order, mandateId: "m", amount: order.total, currency: "USD", method: "test", gates: [{ gate: "g", pass: true, detail: "" }] }, h.ctx);
    expect(res.completed).toBe(true);
    expect(h.records.get("ORD-1")?.amount).toBe(45); // custom gate coexists with the discount, amount reconciles
  });

  it("no registry ⇒ the custom sweep no-ops (additive): an applicable-gate order still completes", async () => {
    const h = harness(); // no registry wired
    const res = await completeOrder(h.input([{ productId: "drill", quantity: 1 }]), h.ctx);
    expect(res.completed).toBe(true); // the sweep only runs when a registry is injected
  });

  it("BYPASS (fail-open): a gate keyed on a NON-category field (requiresRx) is enforced, not skipped", async () => {
    const h = harness({ registry: rxRegistry });
    // amoxicillin's re-priced line carries requiresRx; the prescription gate applies but is
    // unproven. This FAILS (order wrongly completes) if the sweep evaluates appliesTo against
    // a lossy projection that drops requiresRx — the fail-open Diego reported.
    const res = await completeOrder(h.input([{ productId: "amoxicillin", quantity: 1 }]), h.ctx);
    expect(res).toMatchObject({ completed: false, reason: "gate" });
    expect(h.records.size).toBe(0);
  });

  it("the SAME requiresRx order completes once the prescription is proven for it", async () => {
    const h = harness({ registry: rxRegistry });
    await h.store.write("ORD-1", { verifiedGates: { prescription: true } });
    const res = await completeOrder(h.input([{ productId: "amoxicillin", quantity: 1 }]), h.ctx);
    expect(res.completed).toBe(true);
  });
});

// ── Draw-path hardening (PR #41 review): the delegated-draw branch must run the SAME custom-
// gate sweep as the HP path, bind currency to the order, and echo delegationId on replay. ──
describe("completeOrder — draw path hardening (PR #41 review)", () => {
  it("BYPASS: a draw over a cart with an unproven custom gate() is refused step-up (draw can't skip the sweep)", async () => {
    const h = harness({ registry: licenseRegistry });
    const rev = new MemoryRevocationStore();
    const { intent, mkDraw } = await drawFixture({ maxAmount: 100 });
    const draw = await mkDraw(50); // drill @ 50 — a professional_license gate() line, unproven
    const res = await completeOrder(h.input([{ productId: "drill", quantity: 1 }], { amount: 50, draw: { intent, draw } }), { ...h.ctx, revocation: rev });
    expect(res.completed).toBe(false); // FAILS (wrongly completes) if the draw branch skips the sweep
    expect(res.refusals?.[0]?.code).toBe("step-up");
    expect(h.records.size).toBe(0);
  });

  it("BYPASS: a draw whose currency ≠ the re-priced order currency is refused (USD grant can't settle a EUR cart)", async () => {
    const h = harness();
    const rev = new MemoryRevocationStore();
    const { privateKey, delegate } = await generateDelegate();
    const intent = await sealIntent({
      type: "credentagent.IntentBounds/v0", merchants: ["utopia-marketplace"], currency: "EUR",
      maxAmount: 120, totalAmount: 120, stepUpOver: 500, delegate, mayPresent: [],
      presence: "delegated", trust_level: "issuer-verified (demo PKI)",
    } as Omit<IntentBounds, "intentId">);
    // checkDraw passes (draw EUR == intent EUR), amount 20 == widget×2, but the order re-prices in USD.
    const draw = await signDraw({ type: "credentagent.Draw/v0", intentId: intent.intentId, paymentMandateId: "d", merchant: "utopia-marketplace", amount: 20, currency: "EUR", pspTransactionId: "tx_eur" }, privateKey);
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw } }), { ...h.ctx, revocation: rev });
    expect(res.completed).toBe(false); // FAILS (settles EUR on USD) without the order-currency bind
    expect(res.refusals?.[0]?.code).toBe("currency-mismatch");
  });

  it("an idempotent replay of a completed draw echoes the delegationId audit link", async () => {
    const h = harness();
    const rev = new MemoryRevocationStore();
    const { intent, mkDraw } = await drawFixture();
    const draw = await mkDraw(20);
    const first = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw } }), { ...h.ctx, revocation: rev });
    expect(first.delegationId).toBe(intent.intentId);
    const replay = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw } }), { ...h.ctx, revocation: rev });
    expect(replay.completed).toBe(true);
    expect(replay.delegationId).toBe(intent.intentId); // dropped on the echo before the fix
  });
});

// ── TOCTOU (PR #41 review): a revoke landing AFTER the seam's fast isRevoked pre-check (during
// checkDraw's async crypto) must still be caught at the atomic commitDraw — else it completes. ─
describe("completeOrder — draw TOCTOU: revoke mid-completion is caught atomically", () => {
  it("BYPASS: a grant revoked after the pre-check is refused at commit, not completed in-flight", async () => {
    const h = harness();
    const { intent, mkDraw } = await drawFixture();
    const draw = await mkDraw(20);
    const real = new MemoryRevocationStore();
    real.revoke(intent.intentId); // the grant IS revoked...
    // ...but the seam's upfront isRevoked read RACES and misses it (the revoke landed during
    // checkDraw's await). Delegate everything to the real store EXCEPT isRevoked → false.
    const racing = {
      isRevoked: async () => false,
      revoke: (id: string) => real.revoke(id),
      revokeSubject: (s: string) => real.revokeSubject(s),
      priorDraws: (id: string) => real.priorDraws(id),
      commitDraw: (id: string, d: Parameters<typeof real.commitDraw>[1], o: Parameters<typeof real.commitDraw>[2]) => real.commitDraw(id, d, o),
    };
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 2 }], { amount: 20, draw: { intent, draw } }), { ...h.ctx, revocation: racing });
    expect(res.completed).toBe(false); // completes in-flight if commitDraw doesn't re-check revocation
    expect(res.refusals?.[0]?.code).toBe("revoked");
    expect(h.records.size).toBe(0);
  });
});
