// Repro #2: a custom gate() credential registered on CredentAgent is NOT enforced when a
// store-held grant (credentagent.grants) is spent, while the human-present path refuses.
//
//   node docs/reviews/2026-10-agent-purchases/repros/custom-gate-skipped.mjs   (from the worktree root, after build)
import express from "express";
import { CredentAgent, defineCredential, dcql, gate, required, completeOrder, MemoryVerificationStore } from "@openmobilehub/credentagent-gate";

// A custom hard gate that applies to ONE sku (keyed by line id, so it fires on ANY priced line,
// including the grant engine's lines, which do not carry `category`).
const prescription = defineCredential({
  id: "prescription",
  request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
  verify: (c) => c.rx_valid === true,
  effect: gate(),
  appliesTo: (order) => order.lines.some((l) => l.id === "amoxicillin"),
  ui: { label: "Prescription", action: "Verify prescription" },
});

const credentagent = new CredentAgent({
  walletOrigin: "http://localhost:3999",
  catalog: { amoxicillin: { price: 42, category: "Pharmacy" }, ibuprofen: 8 },
  credentials: [prescription], // declared up front — the README's fail-closed recommendation
});

const registry = credentagent.registry; // TS-private, readable at runtime
console.log("[setup] CredentAgent registry holds:", [...registry.keys()]);

// ── A) Human-NOT-present: a page-approved grant that allows amoxicillin ─────────────
const grant = await credentagent.grants.create({
  merchant: "pharmacy", budget: 100, perSpend: 50, allow: { skus: ["amoxicillin"] }, signing: "page",
});
const approved = await credentagent.grants._authorize(grant.id); // the human's one Approve tap
console.log("[A] grant authorized:", approved, "status:", grant.status);
const spendA = await grant.spend({ idempotencyKey: "rx-1", items: [{ sku: "amoxicillin" }] });
console.log("[A] grant.spend(amoxicillin) WITHOUT a prescription proof ->", JSON.stringify(spendA));

// Root-cause probe: the grant engine's CompletionContext has no credentialRegistry.
const rec = credentagent.grants.records.get(grant.id);
const engineCtx = rec.engine.ctx;
console.log("[A] grant engine ctx keys:", Object.keys(engineCtx), "-> has credentialRegistry?", "credentialRegistry" in engineCtx);

// ── B) Human-present: the SAME sku through the shared completion seam, with the client's registry ──
// B1: orders.serve's instant-demo place path (the direct POST) for an order whose policy requires it.
const app = express();
credentagent.orders.serve(app);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const port = server.address().port;
const created = await credentagent.orders.create({
  order: { id: "ord-hp-1", total: 42, currency: "USD", lines: [{ id: "amoxicillin", unitPrice: 42, quantity: 1, lineTotal: 42, currency: "USD" }] },
  policy: [required(prescription)],
});
const placeRes = await fetch(`http://127.0.0.1:${port}/credentagent/orders/${encodeURIComponent(created.id)}/place`, { method: "POST" });
console.log("[B1] orders instant-demo POST /place for amoxicillin ->", placeRes.status);
server.close();

// B2: the shared completeOrder seam the rails call, with the client's registry, no proof -> refused.
const records = new Map();
const catalog = {
  createOrder(refs, orderId) {
    const lines = refs.map(({ productId, quantity }) => ({ id: productId, unitPrice: 42, quantity, lineTotal: 42 * quantity, currency: "USD" }));
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: refs.length, subtotal, discount: 0, total: subtotal, currency: "USD" };
  },
};
const hpOrder = catalog.createOrder([{ productId: "amoxicillin", quantity: 1 }], "hp-2");
const hp = await completeOrder(
  { order: hpOrder, mandateId: "m-hp", amount: 42, currency: "USD", method: "passkey", gates: [] },
  { catalog, verificationStore: new MemoryVerificationStore(), records: { read: (id) => records.get(id), write: (r) => void records.set(r.orderId, r) }, credentialRegistry: registry },
);
console.log("[B2] human-present completeOrder(amoxicillin, registry wired, no proof) ->", JSON.stringify(hp));

// ── C) Counterfactual: wire the client's registry into the grant engine (no tracked file edited) ──
const grant2 = await credentagent.grants.create({
  merchant: "pharmacy", budget: 100, perSpend: 50, allow: { skus: ["amoxicillin"] }, signing: "page",
});
await credentagent.grants._authorize(grant2.id);
credentagent.grants.records.get(grant2.id).engine.ctx.credentialRegistry = registry; // the missing wire
const spendC = await grant2.spend({ idempotencyKey: "rx-2", items: [{ sku: "amoxicillin" }] });
console.log("[C] same spend with registry wired into the engine ctx ->", JSON.stringify(spendC));

const bug = spendA.ok === true && placeRes.status === 403 && hp.completed === false && spendC.ok === false;
console.log(bug
  ? "\nREPRODUCED: the grant spend completed an order a registered custom gate() blocks; the human-present path refuses it, and wiring the registry into the grant engine makes the spend refuse."
  : "\nNOT REPRODUCED (see lines above).");
process.exit(bug ? 1 : 0);
