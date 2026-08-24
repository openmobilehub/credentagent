// SPIKE test — the held doorbell, as claude.ai will drive it: first awaiting-approval returns
// immediately (link visible), the redial holds; the human taps Approve mid-hold; PASS = the
// redial resolves with "authorized" on its own, seconds after the tap.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BRIDGE = process.env.BRIDGE ?? "http://localhost:3006/mcp";
const UPSTREAM_HTTP = process.env.UPSTREAM_HTTP ?? "http://localhost:3005";

const c = new Client({ name: "sim-claude", version: "0" }, { capabilities: {} });
await c.connect(new StreamableHTTPClientTransport(new URL(BRIDGE)));

const args = { budget: 200, perSpend: 120, item: "sneakers" };
const r1 = (await c.callTool({ name: "create-spending-grant", arguments: args })).structuredContent;
const r2 = (await c.callTool({ name: "create-spending-grant", arguments: { ...args, requestState: r1.requestState, answers: { size: "US 10", colour: "Black" } } })).structuredContent;
console.log("mint:", r2.code, "| status:", r2.status, "| note redial?", /IMMEDIATELY/.test(r2.note ?? ""));
if (r2.code !== "awaiting-approval") process.exit(1);

// The model redials at once; the human taps Approve 5s into the hold.
const t0 = Date.now();
setTimeout(() => {
  console.log(`… human taps Approve (t+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  fetch(`${UPSTREAM_HTTP}/credentagent/grants/${r2.grantId}/approve`, { method: "POST" });
}, 5000);
const done = (
  await c.callTool(
    { name: "create-spending-grant", arguments: { ...args, requestState: r2.requestState, answers: { approved: "true" } } },
    undefined,
    { timeout: 55_000 },
  )
).structuredContent;
console.log(`REDIAL RESOLVED t+${((Date.now() - t0) / 1000).toFixed(1)}s → status: ${done.status}`);
process.exit(done.status === "authorized" ? 0 : 1);
