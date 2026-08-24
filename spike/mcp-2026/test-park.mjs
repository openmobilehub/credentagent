// SPIKE test — simulate Diego's claude.ai client: declares form elicitation, NEVER submits the
// form. The human only taps Approve in the browser. PASS = the parked tool call resolves on its
// own with status "authorized".
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BRIDGE = process.env.BRIDGE ?? "http://localhost:3006/mcp";
const UPSTREAM_HTTP = process.env.UPSTREAM_HTTP ?? "http://localhost:3005";

const c = new Client({ name: "sim-claude", version: "0" }, { capabilities: { elicitation: {} } });
c.setRequestHandler(ElicitRequestSchema, (req) => {
  console.log("← elicitation/create:", JSON.stringify(req.params.message).slice(0, 140));
  return new Promise(() => {}); // the human ignores the form — they're busy tapping in the browser
});
await c.connect(new StreamableHTTPClientTransport(new URL(BRIDGE)));

const args = { budget: 200, perSpend: 120, item: "sneakers" };
const r1 = (await c.callTool({ name: "create-spending-grant", arguments: args })).structuredContent;
console.log("round1:", r1.code, r1.questions?.map((q) => q.key));

const t0 = Date.now();
const pending = c.callTool(
  { name: "create-spending-grant", arguments: { ...args, requestState: r1.requestState, answers: { size: "US 10", colour: "Black" } } },
  undefined,
  { timeout: 120_000 },
);

// 3s later, the "human" taps Approve in the browser (the approve page's POST).
setTimeout(async () => {
  const lines = readFileSync(new URL("./probe.log", import.meta.url), "utf8").trim().split("\n");
  const park = lines.map((l) => JSON.parse(l)).reverse().find((e) => e.kind === "park");
  console.log(`… human taps Approve for ${park.grantId} (t+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await fetch(`${UPSTREAM_HTTP}/credentagent/grants/${park.grantId}/approve`, { method: "POST" });
}, 3000);

const done = (await pending).structuredContent;
console.log(`RESOLVED t+${((Date.now() - t0) / 1000).toFixed(1)}s → status: ${done.status} | code: ${done.code ?? "none"} | note: ${(done.note ?? "").slice(0, 60)}`);
process.exit(done.status === "authorized" ? 0 : 1);
