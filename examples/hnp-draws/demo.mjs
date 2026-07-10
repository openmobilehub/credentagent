// CredentAgent — a pre-approval your AI agent can spend against, but can't abuse.
//
// You approve ONCE ("reorder my coffee, up to $30 an order"); your agent then shops on
// its own while you sleep. It never holds a blank cheque — the gate re-checks every
// purchase against your limits and refuses any that break them. Revoke, the next dies.
//
// A demo — no real money moves. Run:  node examples/hnp-draws/demo.mjs

// ── THE SHOP — what your agent can buy, and the gate's price for each ──────────
const BLUE_BOTTLE = "blue-bottle.example", STARBUCKS = "starbucks.example";
const PRICE = { coffee: 18, wine: 20 }; // dollars; the GATE sets these, not the agent
const MIN_AGE = { wine: 21 };           // wine is 21+

// ── THE STORY — reads top-to-bottom like plain English (machinery is below) ───
async function story() {
  // Pre-approve once, in plain words. Then go to sleep. 😴
  const agent = await preApprove("Reorder coffee from Blue Bottle — up to $30 an order.", {
    store: BLUE_BOTTLE, perOrder: 30, perMonth: 100,
  });

  // Your agent shops on its own — it names an item + quantity; the gate prices it and
  // re-checks it against your limits. (Prices are the SHOP's, defined just above.)
  await agent.buy({ charge: "c1", item: "coffee" });                   // ✅  $18 — within your $30 cap
  await agent.buy({ charge: "c1", item: "coffee" });                   // ⛔  reused charge id — the same payment, twice
  await agent.buy({ charge: "c2", item: "coffee", quantity: 3 });      // ⛔  3 × $18 = $54 — over your $30 cap
  await agent.buy({ charge: "c3", item: "coffee", store: STARBUCKS }); // ⛔  a store you never approved
  await agent.buy({ charge: "c4", item: "wine" });                     // ⛔  wine is 21+ — age is never delegable
  agent.revoke();                                                      // change your mind, from your phone
  await agent.buy({ charge: "c5", item: "coffee" });                   // ⛔  the grant is dead
}

// ── PLUMBING — the real API, wired once. Skip on a first read ─────────────────
import { sealIntent, generateDelegate, signDraw, completeOrder, MemoryRevocationStore } from "@openmobilehub/credentagent-gate";

const REASON = {
  replay: "the same payment, twice",
  "over-cap": "over your per-order cap",
  "out-of-scope": "a store you never approved",
  "step-up": "age-restricted — needs you there in person",
  revoked: "you revoked this grant",
};

// The gate re-prices each draw from its OWN catalog rather than trusting the agent's figure
// (in production the two are separate — that mismatch is what catches a lying agent; this
// demo shares one catalog, so it never diverges). It keeps only a ledger (revoked /
// already-drawn); it never stores your grant.
const orders = new Map();
const gate = {
  catalog: {
    createOrder: (items, id) => ({
      id,
      lines: items.map(({ productId, quantity }) => ({ id: productId, quantity, minimumAge: MIN_AGE[productId] })),
      total: items.reduce((sum, { productId, quantity }) => sum + PRICE[productId] * quantity, 0),
    }),
  },
  revocation: new MemoryRevocationStore(),
  // Delegated draws carry no live-verification state; the shared completion path still
  // reads/clears this seam, so a no-op stub satisfies it.
  verificationStore: { read: () => undefined, write() {}, clear() {} },
  records: { read: (id) => orders.get(id), write: (r) => orders.set(r.orderId, r) },
};

const outcomes = [];
let seq = 0;

// Mint ONE grant (your intent + a delegate key) and hand it to your agent.
async function preApprove(sentence, { store, perOrder, perMonth }) {
  const { privateKey, delegate } = await generateDelegate();
  const grant = await sealIntent({
    type: "credentagent.IntentBounds/v0", naturalLanguageDescription: sentence,
    merchants: [store], currency: "USD", maxAmount: perOrder, totalAmount: perMonth,
    delegate, presence: "delegated-demo", trust_level: "server-issued-demo",
  });
  const menu = Object.entries(PRICE).map(([i, p]) => `${i} $${p}${MIN_AGE[i] ? ` (${MIN_AGE[i]}+)` : ""}`).join(" · ");
  console.log(`\n🎫  You pre-approved once:  “${sentence}”`);
  console.log(`    Shop (the gate's prices): ${menu}`);
  console.log(`    Your agent holds the grant; the gate stores nothing. Off to sleep. 😴\n`);
  return {
    buy: (purchase) => buy(grant, privateKey, purchase),
    revoke: () => { gate.revocation.revoke(grant.intentId); console.log(`\n🔴  You revoked the grant from your phone.\n`); },
  };
}

// Your agent signs ONE draw against the grant and presents it; the gate decides.
async function buy(grant, key, { charge, item, quantity = 1, store = grant.merchants[0] }) {
  const order = gate.catalog.createOrder([{ productId: item, quantity }], `ORD-${++seq}`);
  const draw = await signDraw(
    { type: "credentagent.Draw/v0", intentId: grant.intentId, paymentMandateId: charge, merchant: store, amount: order.total, currency: "USD", pspTransactionId: charge },
    key,
  );
  const { completed, refusals } = await completeOrder(
    { order, mandateId: charge, amount: order.total, currency: "USD", method: "delegated", gates: [], draw: { intent: grant, draw } },
    gate,
  );
  outcomes.push(completed);
  const line = `${charge}  ${quantity} ${item} @ ${store.replace(".example", "")}`.padEnd(28) + `$${order.total}`.padStart(4);
  const why = REASON[refusals?.[0]?.code] ?? refusals?.[0]?.code ?? "refused";
  console.log(completed ? `  ✅  ${line}   approved (no real money moved)` : `  ⛔  ${line}   refused — ${why}`);
}

// Run the story now that every helper and constant above is defined.
await story();
const ok = outcomes.filter(Boolean).length;
console.log(`\n  ${ok} purchase through · ${outcomes.length - ok} refused, each with a reason · $0 real money moved.\n`);
