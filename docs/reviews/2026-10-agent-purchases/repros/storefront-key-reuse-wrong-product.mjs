// Repro: spend-from-grant reuses an idempotency key with a DIFFERENT product.
// Local only: boots createStorefront with grants on localhost, drives it with a real MCP client.
//   node docs/reviews/2026-10-agent-purchases/repros/storefront-key-reuse-wrong-product.mjs
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { SAMPLE_CATALOG } from "@openmobilehub/credentagent-storefront";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const PORT = Number(process.env.PORT ?? 3987);
const BASE = `http://localhost:${PORT}`;
const grantCatalog = Object.fromEntries(
  SAMPLE_CATALOG.map((p) => [p.id, { price: p.price, category: p.category, ...(p.minimumAge ? { minAge: p.minimumAge } : {}) }]),
);
const credentagent = new CredentAgent({ walletOrigin: BASE, catalog: grantCatalog });
const store = createStorefront({ grants: credentagent.grants, merchant: "Utopia" });
credentagent.grants.serve(store.app);
await store.listen(PORT);

const mcp = new Client({ name: "key-reuse-repro", version: "0.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const raw = (name, args) => mcp.callTool({ name, arguments: args });
const pick = (sc) => ({ spend: sc.spend, remaining: sc.remaining, spent: sc.spent });

// Merchant-wide (no allow bounds), page-signed grant: both A and B are in bounds.
const created = (await raw("create-spending-grant", { budget: 500, perSpend: 150, signing: "page" })).structuredContent;
const id = created.id;
const ap = await fetch(`${BASE}/credentagent/grants/${id}/approve`, { method: "POST" });
const status = (await raw("get-grant-status", { grantId: id })).structuredContent;
console.log("grant", id, "approve HTTP", ap.status, "status", status.status, "remaining", status.remaining);

// 1) key k1, product A = drift-mouse ($49)
const r1 = await raw("spend-from-grant", { grantId: id, productId: "drift-mouse", idempotencyKey: "k1" });
console.log("\n[1] k1 + drift-mouse ($49)");
console.log("  structuredContent:", JSON.stringify(pick(r1.structuredContent)));
console.log("  text spend field :", JSON.stringify(JSON.parse(r1.content[0].text).spend));

// 2) SAME key k1, product B = lumen-desk-lamp ($59)
const r2 = await raw("spend-from-grant", { grantId: id, productId: "lumen-desk-lamp", idempotencyKey: "k1" });
console.log("\n[2] k1 + lumen-desk-lamp ($59)  <- key reuse, different product");
console.log("  structuredContent:", JSON.stringify(pick(r2.structuredContent)));
console.log("  text spend field :", JSON.stringify(JSON.parse(r2.content[0].text).spend));
console.log("  isError:", r2.isError ?? false);

// Ground truth: what was actually charged?
const after = (await raw("get-grant-status", { grantId: id })).structuredContent;
console.log("\nground truth after both calls: remaining", after.remaining, "spent", after.spent);
const keys = Object.keys(after).filter((k) => /spend|purchase|history|ledger|draw/i.test(k));
for (const k of keys) console.log("  ", k, JSON.stringify(after[k]));

const s2 = r2.structuredContent.spend;
const faulty = s2?.productId === "lumen-desk-lamp" && s2?.ok === true && s2?.amount === 49;
console.log(`\nVERDICT: second call reports productId=${s2?.productId} ok=${s2?.ok} amount=${s2?.amount} replayed=${s2?.replayed}; ` +
  `lamp actually charged? ${after.remaining === 451 ? "NO (only the $49 mouse was charged)" : "remaining=" + after.remaining}`);
console.log(faulty ? "FAULT REPRODUCED: a purchase of lumen-desk-lamp is reported (ok:true) that never happened." : "fault NOT reproduced");

// Side check: SAME key k1 with a product over the per-spend cap. The storefront's live pre-checks
// run BEFORE the gate's idempotency cache, so this returns a fresh refusal, not the k1 replay.
const r3 = await raw("spend-from-grant", { grantId: id, productId: "aurora-headphones", idempotencyKey: "k1" });
console.log("\n[3] k1 + aurora-headphones ($199 > perSpend 150):", JSON.stringify(r3.structuredContent.spend));

await mcp.close();
process.exit(0);
