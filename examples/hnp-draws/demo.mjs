// CredentAgent — a pre-approval your AI agent can spend against, but can't abuse.
//
// You pre-approve ONCE; your agent then shops on its own while you sleep. It never holds a
// blank cheque — every purchase is re-checked against your limits and refused if it breaks
// one, in plain terms. Revoke and the next one dies. A demo — no real money moves.
//   Run:  node examples/hnp-draws/demo.mjs
import { DelegatedGate } from "@openmobilehub/credentagent-gate";

// 1. Configure the gate once with your priced catalog.  (Like `new Stripe(key)`.)
const gate = new DelegatedGate({
  catalog: { coffee: 18, wine: { price: 20, minAge: 21 } },
});

// 2. Pre-approve once. Your agent holds the returned grant and shops while you sleep. 😴
const grant = await gate.preApprove({
  merchant: "blue-bottle",
  perOrder: 30, // no single order over $30
  total: 100, //  and $100 total before the grant is spent out
});
console.log("\n🎫  Pre-approved: coffee at blue-bottle, up to $30/order. Off to sleep. 😴\n");

// 3. Your agent spends. Each spend() returns { ok, amount, remaining, reason? } — no throwing.
//    Two real purchases draw the $100 down; the rest are refused, each with a reason.
await attempt("1 coffee", { idempotencyKey: "c1", item: "coffee" });
await attempt("another coffee (new id)", { idempotencyKey: "c2", item: "coffee" });
await attempt("retry c1 (same key — safe)", { idempotencyKey: "c1", item: "coffee" });
await attempt("3 coffees at once", { idempotencyKey: "c3", item: "coffee", quantity: 3 });
await attempt("coffee — different store", { idempotencyKey: "c4", item: "coffee", merchant: "starbucks" });
await attempt("wine — age-restricted", { idempotencyKey: "c5", item: "wine" });
await grant.revoke(); // you change your mind, from your phone
await attempt("1 coffee — after revoke", { idempotencyKey: "c6", item: "coffee" });

// Attempt one purchase and print the verdict (demo output only — not part of the API).
async function attempt(label, purchase) {
  const { ok, amount, remaining, reason } = await grant.spend(purchase);
  const verdict = ok ? `approved — $${remaining} of $100 left` : `refused — ${reason}`;
  console.log(`  ${ok ? "✅" : "⛔"}  ${label.padEnd(26)} $${String(amount).padStart(2)}   ${verdict}`);
}
