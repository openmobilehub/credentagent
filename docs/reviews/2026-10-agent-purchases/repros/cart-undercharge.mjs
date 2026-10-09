// Repro for: "grant.spend({items}) prices only items[0] and reads only qty → multi-item cart undercharged"
// Run from repo root: node docs/reviews/2026-10-agent-purchases/repros/cart-undercharge.mjs
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const credentagent = new CredentAgent({
  walletOrigin: "http://localhost:3005",
  catalog: { coffee: { price: 4.5, category: "Beverages" }, tea: { price: 3, category: "Beverages" } },
});

async function fresh() {
  const g = await credentagent.grants.create({ merchant: "m", budget: 100, perSpend: 50, signing: "page" });
  const ok = await credentagent.grants._authorize(g.id);
  return { g: await credentagent.grants.retrieve(g.id), ok };
}

const cases = [
  ["A: 2 coffee + 1 tea, `quantity` field", [{ sku: "coffee", quantity: 2 }, { sku: "tea", quantity: 1 }]],
  ["B: 2 coffee + 1 tea, `qty` field", [{ sku: "coffee", qty: 2 }, { sku: "tea", qty: 1 }]],
  ["C: single line 2 coffee, `qty` field", [{ sku: "coffee", qty: 2 }]],
  ["D: single line 2 coffee, `quantity` field (not in SpendItems type)", [{ sku: "coffee", quantity: 2 }]],
];

for (const [label, items] of cases) {
  const { g, ok } = await fresh();
  const s = await g.spend({ idempotencyKey: "k-" + label[0], items });
  const u = await g.usage();
  console.log(`${label}\n   authorized=${ok} status=${g.status} spend=${JSON.stringify(s)}\n   usage=${JSON.stringify(u)}`);
}
process.exit(0);
