// Drive the store as an AGENT would, over real MCP against the tunnel. Steps 1–3 of the
// end-to-end: browse → create a grant → prove it cannot spend before the wallet signs.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const B = "https://investigator-cave-kenny-assistant.trycloudflare.com";
const c = new Client({ name: "agent", version: "1.0.0" });
await c.connect(new StreamableHTTPClientTransport(new URL(`${B}/mcp`)));
const call = async (n, a = {}) => (await c.callTool({ name: n, arguments: a })).structuredContent;

const cat = await call("browse-products");
const items = cat.products ?? cat.items ?? [];
console.log("1. catalog:");
for (const p of items) console.log(`     ${p.id.padEnd(24)} $${String(p.price).padStart(3)}  ${p.category}${p.minimumAge ? "  (21+)" : ""}`);

// NOTE: no `signing` argument — the default must be a wallet signature.
const g = await call("create-spending-grant", {
  budget: 200, perSpend: 130, products: ["drift-mouse"],
  description: "Buy me a drift-mouse while I'm away — up to $200.",
});
console.log(`\n2. created ${g.id}`);
console.log(`     status=${g.status} · trustLevel=${g.trustLevel} · bounds: $${g.budget} total / $${g.perSpend} per buy / only ${g.allow.skus.join(",")}`);
console.log(`     note: ${g.note}`);

const before = await call("spend-from-grant", { grantId: g.id, productId: "drift-mouse" });
console.log(`\n3. spend BEFORE any signature → ok=${before.spend.ok} code=${before.spend.code}`);

const page = await (await fetch(g.approveUrl)).text();
const shows = [...new Set(page.match(/Sign with your wallet|✓ Approve|✗ Deny/g) ?? [])];
console.log(`\n4. approveUrl serves: ${shows.join(" | ")}`);
console.log(`\n   SIGN THIS ON THE PHONE:\n   ${g.approveUrl}\n`);
await c.close();
