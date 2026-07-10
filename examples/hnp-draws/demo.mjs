// See the HNP "doorman" (PR #41) in action — no web page needed.
//
// Follow the pre-approval's JOURNEY between three parties:
//   1. YOU (phone)        — pre-approve once, then hand the mandate to your agent.
//   2. YOUR AGENT         — HOLDS the mandate; later signs draws and presents them.
//   3. THE GATE (server)  — stores NO mandate; re-checks each presented draw and decides.
//
// Key idea: the gate never keeps the mandate. The agent carries it and re-presents it
// (mandate + a freshly signed draw) on every purchase; the gate only keeps a small ledger
// (what's been revoked / already drawn) and re-verifies from scratch each time.
//   node examples/hnp-draws/demo.mjs
import {
  sealIntent,
  generateDelegate,
  signDraw,
  completeOrder,
  MemoryRevocationStore,
  MemoryVerificationStore,
} from "@openmobilehub/credentagent-gate";

// ── a tiny catalog: coffee $18, wine $20 (age-restricted) ────────────────────
const PRODUCTS = { coffee: { price: 18 }, wine: { price: 20, minimumAge: 21 } };
const catalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => {
      const p = PRODUCTS[it.productId];
      return { id: it.productId, name: it.productId, unitPrice: p.price, currency: "USD", quantity: it.quantity, lineTotal: p.price * it.quantity, ...(p.minimumAge ? { minimumAge: p.minimumAge } : {}) };
    });
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: items.length, subtotal: total, discount: 0, total, currency: "USD", createdAt: new Date().toISOString() };
  },
};
// Merchant scope uses CANONICAL MACHINE IDS (a domain here), never display names — the
// scope check is an exact match, so this is an identifier, not the brand "Blue Bottle".
const BLUE_BOTTLE = "blue-bottle.example";
const STARBUCKS = "starbucks.example";

// ═════════════════════════════════════════════════════════════════════════════
// PARTY 3 — THE GATE (the merchant's server). It holds a LEDGER (revocation +
// single-use + per-order state) and the catalog — but NOT the mandate itself.
// ═════════════════════════════════════════════════════════════════════════════
const gate = {
  ledger: new MemoryRevocationStore(), // what's revoked / already drawn — the only state it keeps
  ctx: null,
};
gate.ctx = { catalog, verificationStore: new MemoryVerificationStore(), revocation: gate.ledger, records: new Map() };
gate.ctx.records = { store: new Map(), read(id) { return this.store.get(id); }, write(r) { this.store.set(r.orderId, r); } };
// The gate's one job: given a presented (mandate + signed draw), re-check and decide.
gate.receiveDraw = async (order, amount, presented) =>
  completeOrder({ order, mandateId: presented.draw.paymentMandateId, amount, currency: "USD", method: "delegated", gates: [{ gate: "draw", pass: true, detail: "" }], draw: presented }, gate.ctx);

// ═════════════════════════════════════════════════════════════════════════════
// STEP 1 — YOU pre-approve once (the phone ceremony, faked here), then HAND the
// mandate to your agent. After this line you can go to sleep.
// ═════════════════════════════════════════════════════════════════════════════
const { privateKey, delegate } = await generateDelegate();
const mandate = await sealIntent({
  type: "credentagent.IntentBounds/v0",
  naturalLanguageDescription: "Reorder Blue Bottle coffee, up to $40 total, this month",
  merchants: [BLUE_BOTTLE],
  currency: "USD",
  maxAmount: 40,
  totalAmount: 40,
  stepUpOver: 500,
  intentExpiry: "2026-07-31T23:59:59Z",
  delegate,
  mayPresent: [],
  presence: "delegated-demo",
  trust_level: "server-issued-demo",
});

// PARTY 2 — YOUR AGENT. It now HOLDS the mandate (+ the delegate key to sign draws).
// This is where the mandate "went": onto the agent, which carries it from here on.
const agent = { holds: mandate, key: privateKey };

console.log(`\n🎫  STEP 1 — YOU minted ONE pre-approval and handed it to your agent:`);
console.log(`    "${mandate.naturalLanguageDescription}"`);
console.log(`    id ${mandate.intentId.slice(0, 22)}…  ·  presence=${mandate.presence}  trust=${mandate.trust_level}`);
console.log(`    → the AGENT now holds it. The GATE holds nothing yet. You can go to sleep 😴\n`);

// The agent makes ONE draw: it signs a purchase referencing the mandate it holds, then
// PRESENTS (its held mandate + the signed draw) to the gate. tx ids are per-purchase.
let n = 0;
async function agentBuys(label, { items, merchant, amount, pspTransactionId }) {
  const order = catalog.createOrder(items, `ORD-${++n}`);
  const signed = await signDraw(
    { type: "credentagent.Draw/v0", intentId: agent.holds.intentId, paymentMandateId: `d${n}`, merchant, amount, currency: "USD", pspTransactionId },
    agent.key,
  );
  // ↓↓↓ the mandate travels here — the agent PRESENTS { its mandate, this draw } to the gate.
  const presented = { intent: agent.holds, draw: signed };
  const res = await gate.receiveDraw(order, amount, presented);
  const tag = `[${pspTransactionId}] ${label}`;
  if (res.completed) console.log(`✅  ${tag}\n     → gate COMPLETED it (delegationId ${res.delegationId.slice(0, 16)}… · no real money moved)\n`);
  else console.log(`⛔  ${tag}\n     → gate REFUSED it: ${res.refusals.map((r) => r.code).join(", ")}\n`);
}

console.log("─".repeat(72));
console.log("STEP 2 — while you're away, the AGENT presents draws; the GATE re-checks each\n");
await agentBuys("reorder 1 bag of coffee ($18) from blue-bottle", { items: [{ productId: "coffee", quantity: 1 }], merchant: BLUE_BOTTLE, amount: 18, pspTransactionId: "tx_1" });
await agentBuys("re-submit tx_1 — the SAME transaction again (double-spend)", { items: [{ productId: "coffee", quantity: 1 }], merchant: BLUE_BOTTLE, amount: 18, pspTransactionId: "tx_1" });
await agentBuys("a $54 cart — 3 bags — over the $40 cap", { items: [{ productId: "coffee", quantity: 3 }], merchant: BLUE_BOTTLE, amount: 54, pspTransactionId: "tx_2" });
await agentBuys("a purchase at a DIFFERENT store (starbucks, not approved)", { items: [{ productId: "coffee", quantity: 1 }], merchant: STARBUCKS, amount: 18, pspTransactionId: "tx_3" });
await agentBuys("buy WINE (age-restricted) on this coffee pre-approval", { items: [{ productId: "wine", quantity: 1 }], merchant: BLUE_BOTTLE, amount: 20, pspTransactionId: "tx_4" });

console.log("🔴  STEP 3 — you revoke the pre-approval from your phone (the gate's ledger flips)…\n");
gate.ledger.revoke(agent.holds.intentId); // the agent still HOLDS the mandate — but the gate now refuses it
await agentBuys("another coffee reorder, after revocation", { items: [{ productId: "coffee", quantity: 1 }], merchant: BLUE_BOTTLE, amount: 18, pspTransactionId: "tx_5" });
console.log("─".repeat(72));
console.log("\nThe agent kept holding the mandate the whole time — the GATE decided every draw.");
console.log("1 legit draw through, 5 refused with reasons, 0 real money moved.\n");
