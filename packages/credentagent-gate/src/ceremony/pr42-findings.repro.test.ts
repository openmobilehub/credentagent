// PR #42 re-review — REPRODUCTION tests for the confirmed findings.
// Each test asserts the CORRECT (secure) behavior, so on the current branch it FAILS
// RED — that red IS the proof the finding is real. Fix each finding → its test goes GREEN.
//   npx vitest run src/ceremony/pr42-findings.repro.test.ts
import { describe, it, expect } from "vitest";
import { completeOrder, type CompletedRecord, type CompletionContext } from "./completion.js";
import { MemoryVerificationStore } from "../store.js";
import { defineCredential, dcql, gate, authorize, discount } from "../credentials.js";
import type { Credential } from "../types.js";
import type { CeremonyCatalog, CompletionInput } from "./types.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const PRODUCTS: Record<string, { price: number; category?: string; requiresRx?: boolean }> = {
  widget: { price: 10 },
  drill: { price: 50, category: "Licensed" },
  amoxicillin: { price: 30, requiresRx: true },
};

// A ceremony catalog. `dropRequiresRx` simulates a HOST whose CeremonyCatalog.createOrder
// does not forward the custom `requiresRx` field (finding 3).
function makeCatalog(opts: { dropRequiresRx?: boolean } = {}): CeremonyCatalog {
  return {
    createOrder(items, orderId, o) {
      const lines = items.map((it) => {
        const p = PRODUCTS[it.productId] ?? { price: 0 };
        return {
          id: it.productId, name: it.productId, unitPrice: p.price, currency: "USD",
          quantity: it.quantity, lineTotal: p.price * it.quantity,
          ...(p.category ? { category: p.category } : {}),
          ...(p.requiresRx && !opts.dropRequiresRx ? { requiresRx: true } : {}),
        };
      });
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      const disc = o?.loyaltyApplied ? round2(subtotal * 0.1) : 0;
      return {
        id: orderId, lines, itemCount: lines.reduce((s, l) => s + l.quantity, 0),
        subtotal, discount: disc, total: round2(subtotal - disc), currency: "USD",
        createdAt: new Date().toISOString(),
      };
    },
  };
}

function harness(registry: Map<string, Credential>, catalog = makeCatalog()) {
  const records = new Map<string, CompletedRecord>();
  const store = new MemoryVerificationStore();
  const ctx: CompletionContext = {
    catalog,
    verificationStore: store,
    records: { read: async (id) => records.get(id), write: async (rec) => void records.set(rec.orderId, rec) },
    cart: { clear: async () => {} },
    credentialRegistry: registry,
  };
  const input = (items: { productId: string; quantity: number }[], over: Partial<CompletionInput> = {}): CompletionInput => {
    const order = catalog.createOrder(items, "ORD-1", {});
    return { order, mandateId: "m", amount: order.total, currency: "USD", method: "test", gates: [{ gate: "g", pass: true, detail: "" }], ...over };
  };
  return { ctx, records, store, input };
}

// ─── Finding 1 — a custom authorize() credential was NEVER enforced (fail-OPEN) ───
// The fix (chosen in #59): reject a custom `authorize()` effect at the `defineCredential`
// boundary — only `gate()` is wired end-to-end for a custom credential, so an accepted-but-
// unenforced authorize() is a silent fail-open. This converts it into an honest construction
// error (the SAME fail-fast posture as the reserved-id guard). The test therefore asserts the
// REJECTION; on the current branch (no guard) defineCredential accepts it → this expect fails RED.
describe("Finding 1: custom authorize() is rejected at the boundary", () => {
  it("RED = fail-open: defineCredential must reject a custom authorize() (it was never enforced)", () => {
    expect(() =>
      defineCredential({
        id: "manager_approval",
        request: dcql({ docType: "org.example.approval.1", claims: ["approved"] }),
        verify: (c) => c.approved === true,
        effect: authorize(),
        appliesTo: (o) => o.lines.some((l) => l.category === "Licensed"),
        ui: { label: "Manager approval", action: "Get approval" },
      }),
    ).toThrow(/authorize/i);
  });

  it("control: the SAME credential as a gate() IS enforced (proves the asymmetry the guard closes)", async () => {
    const asGate = defineCredential({
      id: "manager_gate",
      request: dcql({ docType: "org.example.approval.1", claims: ["approved"] }),
      verify: (c) => c.approved === true,
      effect: gate(),
      appliesTo: (o) => o.lines.some((l) => l.category === "Licensed"),
      ui: { label: "Manager gate", action: "Get approval" },
    });
    const h = harness(new Map([[asGate.id, asGate]]));
    const res = await completeOrder(h.input([{ productId: "drill", quantity: 1 }]), h.ctx);
    expect(res).toMatchObject({ completed: false, reason: "gate" });
  });
});

// ─── Finding 2 — the sweep enforces the whole instance registry, not this order's policy ───
describe("Finding 2: registry-scoped sweep (over-enforcement → deadlock)", () => {
  const globalGate = defineCredential({
    id: "global_gate",
    request: dcql({ docType: "org.example.x.1", claims: ["ok"] }),
    verify: (c) => c.ok === true,
    effect: gate(),
    ui: { label: "x", action: "y" },
  });

  it("RED = deadlock: a plain order whose policy never required global_gate must complete", async () => {
    // `global_gate` sits in the shared registry (another order resolved it), but it is NOT in
    // THIS order's policy — modeled by an empty `policyCredentialIds`, exactly what `orders.serve`
    // supplies from the created order's stored policy. The fixed sweep scopes to that policy, so a
    // gate this order never required cannot block it. Pre-fix (registry-wide sweep), global_gate's
    // absent `appliesTo` makes it "apply" to the widget order → unprovable → deadlock → RED.
    const h = harness(new Map([[globalGate.id, globalGate]]));
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 1 }], { policyCredentialIds: [] }), h.ctx);
    expect(res.completed).toBe(true);
  });

  it("control: a gate that IS in this order's policy still blocks (scoping didn't disable enforcement)", async () => {
    const h = harness(new Map([[globalGate.id, globalGate]]));
    const res = await completeOrder(h.input([{ productId: "widget", quantity: 1 }], { policyCredentialIds: ["global_gate"] }), h.ctx);
    expect(res).toMatchObject({ completed: false, reason: "gate" });
  });
});

// ─── Finding 3 — a lossy host ceremony-catalog re-opens the gate (fail-OPEN) ───
describe("Finding 3: appliesTo drift on a host catalog that drops a custom field", () => {
  const prescription = defineCredential({
    id: "prescription",
    request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
    verify: (c) => c.rx_valid === true,
    effect: gate(),
    appliesTo: (o) => o.lines.some((l) => l.requiresRx),
    ui: { label: "Prescription", action: "Verify" },
  });

  it("control: a catalog that FORWARDS requiresRx refuses an unproven Rx order (gate works)", async () => {
    const h = harness(new Map([[prescription.id, prescription]]), makeCatalog());
    const res = await completeOrder(h.input([{ productId: "amoxicillin", quantity: 1 }]), h.ctx);
    expect(res).toMatchObject({ completed: false, reason: "gate" });
  });

  it("RED = fail-open: a lossy completion catalog can't strip requiresRx off the resolved order", async () => {
    // The rail resolves a FAITHFUL order (requiresRx present — resolveOrder re-attaches it from the
    // stored order), THEN completion re-prices through a lossy host catalog that drops the field.
    // The fix re-attaches the dropped attribute from the faithful input order, so the prescription
    // gate still applies. Pre-fix the lossy re-price hides requiresRx → gate skipped → completes
    // unproven → RED. (Modeling both catalogs as lossy would leave NO faithful source at all — the
    // resolveOrder-level fix, exercised by the orders-serve integration test in orders-serve.test.ts.)
    const faithful = harness(new Map([[prescription.id, prescription]]), makeCatalog());
    const input = faithful.input([{ productId: "amoxicillin", quantity: 1 }]); // input.order carries requiresRx
    const lossyCtx = { ...faithful.ctx, catalog: makeCatalog({ dropRequiresRx: true }) };
    const res = await completeOrder(input, lossyCtx);
    expect(res.completed).toBe(false);
  });
});

// ─── Finding 4 — a custom discount() credential applied no discount (inert) ───
// Same fix as finding 1: reject a custom `discount()` effect at the `defineCredential` boundary.
// A custom discount() was accepted and verified but wired to nothing (success recorded a proven
// gate, not an applied discount), so it silently charged full price. Rejecting it at construction
// converts the inert bug into an honest error until a custom discount is wired through re-pricing.
describe("Finding 4: custom discount() is rejected at the boundary", () => {
  it("RED = inert: defineCredential must reject a custom discount() (it applied no discount)", () => {
    expect(() =>
      defineCredential({
        id: "member_discount",
        request: dcql({ docType: "org.example.member.1", claims: ["member"] }),
        verify: (c) => c.member === true,
        effect: discount({ percent: 10 }),
        ui: { label: "Member", action: "Verify" },
      }),
    ).toThrow(/discount/i);
  });
});
