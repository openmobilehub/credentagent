// Repro: grant.spend() with NO idempotencyKey — does a 2nd, different purchase replay the 1st?
// Run from the repo root: node docs/reviews/2026-10-agent-purchases/repros/missing-idempotency-key.mjs
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const ca = new CredentAgent({ catalog: { coffee: 5, tea: 3 } });
const grant = await ca.grants.create({ merchant: "shop.example", budget: 100, perSpend: 30, signing: "page" });
console.log("approved:", await ca.grants._authorize(grant.id), "status:", grant.status);

const a = await grant.spend({ items: [{ sku: "coffee" }] }); // no idempotencyKey
console.log("spend #1 (coffee):", JSON.stringify(a));
console.log("usage after #1:   ", JSON.stringify(await grant.usage()));

const b = await grant.spend({ items: [{ sku: "tea" }] }); // different item, no idempotencyKey
console.log("spend #2 (tea):   ", JSON.stringify(b));
console.log("usage after #2:   ", JSON.stringify(await grant.usage()));

// Also via a freshly retrieved handle (the documented process-boundary handle, same record)
const g2 = await ca.grants.retrieve(grant.id);
const c = await g2.spend({ items: [{ sku: "tea", qty: 2 }] });
console.log("spend #3 (2x tea, retrieved handle):", JSON.stringify(c));
console.log("usage after #3:   ", JSON.stringify(await grant.usage()));

// Explicit undefined and null keys behave the same?
const d = await grant.spend({ idempotencyKey: undefined, items: [{ sku: "tea" }] });
console.log("spend #4 (key: undefined):", JSON.stringify(d));

// Control: same flow with distinct keys charges each purchase
const ctl = await ca.grants.create({ merchant: "shop.example", budget: 100, perSpend: 30, signing: "page" });
await ca.grants._authorize(ctl.id);
console.log("control #1:", JSON.stringify(await ctl.spend({ idempotencyKey: "k1", items: [{ sku: "coffee" }] })));
console.log("control #2:", JSON.stringify(await ctl.spend({ idempotencyKey: "k2", items: [{ sku: "tea" }] })));
console.log("control usage:", JSON.stringify(await ctl.usage()));

const u = await grant.usage();
const bug = b.ok === true && b.replayed === true && b.amount === a.amount && u.spent === a.amount;
console.log("\nBUG REPRODUCED:", bug);
