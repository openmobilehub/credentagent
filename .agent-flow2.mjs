import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const B = "https://investigator-cave-kenny-assistant.trycloudflare.com";
const ID = "grant_21d5dee1a84d454f";
const c = new Client({ name: "agent", version: "1.0.0" });
await c.connect(new StreamableHTTPClientTransport(new URL(`${B}/mcp`)));
const call = async (n, a = {}) => (await c.callTool({ name: n, arguments: a })).structuredContent;
const g = await call("get-grant-status", { grantId: ID });
console.log(`status=${g.status} · trustLevel=${g.trustLevel} · spent $${g.spent}/${g.budget}`);
if (g.status === "authorized") {
  const s = await call("spend-from-grant", { grantId: ID, productId: "drift-mouse" });
  console.log(`5. spend drift-mouse → ok=${s.spend.ok} ${s.spend.code ?? ""} · remaining $${s.remaining}`);
  const w = await call("spend-from-grant", { grantId: ID, productId: "oak-whiskey" });
  console.log(`6. spend oak-whiskey → ok=${w.spend.ok} code=${w.spend.code}`);
}
await c.close();
