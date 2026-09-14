import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const B = "https://investigator-cave-kenny-assistant.trycloudflare.com";
const c = new Client({ name: "probe", version: "1.0.0" });
await c.connect(new StreamableHTTPClientTransport(new URL(`${B}/mcp`)));
for (const id of ["grant_21d5dee1a84d454f", "grant_56f8943b5e9d4d43", "grant_9dbc52c538384669"]) {
  const r = await c.callTool({ name: "get-grant-status", arguments: { grantId: id } });
  const g = r.structuredContent;
  console.log(`${id}: ${g.error ?? `${g.status} · ${g.trustLevel}`}`);
}
await c.close();
