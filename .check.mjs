import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "p", version: "1.0.0" });
await c.connect(new StreamableHTTPClientTransport(new URL("https://investigator-cave-kenny-assistant.trycloudflare.com/mcp")));
for (const id of ["grant_962e69a2200c48e5"]) {
  const g = (await c.callTool({ name: "get-grant-status", arguments: { grantId: id } })).structuredContent;
  console.log(id, "→", g.error ?? `${g.status} · ${g.trustLevel}`);
}
await c.close();
