// SPIKE — a 2026-07-28 bridge in front of the running storefront (#174 follow-up).
//
// WHY: we need to know, empirically, what Diego's claude.ai connector client actually speaks —
// protocol era (legacy initialize vs 2026-07-28 stateless), declared capabilities (elicitation?
// URL mode? tasks extension?), and which methods it tries. That answer decides how the grant
// approval can auto-resume without the human prompting.
//
// WHAT: an MCP server on :3006 built on the v2 SDK (speaks BOTH eras), which:
//   1. PROBES — logs every request's era, clientInfo, capabilities, and method to probe.log;
//   2. BRIDGES — mirrors every tool of the real storefront (localhost:3005/mcp) and proxies
//      calls through, so the whole shopping + grants + MRTR doorbell flow keeps working.
//
//   node spike/mcp-2026/serve.mjs                # bridge at http://localhost:3006/mcp
//   TUNNEL_HOST=xxxx.trycloudflare.com node …    # allow the tunnel's Host header
//
// Throwaway spike code — not the shipping surface, not reviewed to the repo bar.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = Number(process.env.PORT ?? 3006);
const UPSTREAM = process.env.UPSTREAM ?? "http://localhost:3005/mcp";
const LOG = join(dirname(fileURLToPath(import.meta.url)), "probe.log");

const probe = (entry) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  appendFileSync(LOG, line + "\n");
  console.log("· probe", line.slice(0, 240));
};

// ── upstream: one shared client session to the real storefront ────────────────
const upstream = new Client({ name: "mcp-2026-bridge", version: "0.0.1" }, { capabilities: {} });
await upstream.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM)));
const { tools } = await upstream.listTools();
console.log(`bridged ${tools.length} tools from ${UPSTREAM}: ${tools.map((t) => t.name).join(", ")}`);

// ── the v2 server: a fresh instance per request (stateless), tools mirrored ───
const shape = (r) => ({
  content: r.content ?? [],
  ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}),
  ...(r.isError ? { isError: true } : {}),
});

/**
 * ROUND 3 — the held doorbell. The probe proved claude.ai's connector runtime today (a) never
 * delivers server-initiated elicitation to the UI, and (b) hard-cancels any tool call at 60s —
 * so parking in an elicitation is out. What the log ALSO proved: the model redials the tool on
 * its own, persistently. So:
 *   • the FIRST awaiting-approval returns immediately (Claude must show the human the link
 *     before they can tap it), with a note telling the model to redial right away;
 *   • every REDIAL (call carrying requestState) holds the line up to 45s — under the 60s kill —
 *     polling the grant every 2s, and returns the instant the human taps in the browser.
 * Model redials + sub-60s holds = approval detected seconds after the tap, no human message.
 * The doorbell discipline is unchanged: status is re-read from the store, never from the client.
 */
const HOLD_MS = 45_000;
const TICK_MS = 2_000;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const REDIAL_NOTE =
  "PENDING — the grant EXISTS but nothing can be spent yet. Send approveUrl to the human, then " +
  "IMMEDIATELY call create-spending-grant again with the EXACT same arguments plus this requestState " +
  "(do not add, remove, or change any other argument). That call holds the line server-side and " +
  "returns the moment the human approves — keep redialing until status changes. Never mint a new " +
  "grant while this one is pending.";

async function createGrantHeld(args, ctx) {
  const call = (a) => upstream.callTool({ name: "create-spending-grant", arguments: a });
  const redial = Boolean(args?.requestState);
  let r = await call(args ?? {});
  let sc = r.structuredContent;

  if (sc?.code === "awaiting-approval" && redial) {
    probe({ kind: "hold", grantId: sc.grantId });
    const t0 = Date.now();
    let status = "pending";
    while (Date.now() - t0 < HOLD_MS && !ctx?.mcpReq?.signal?.aborted && status === "pending") {
      await sleep(TICK_MS);
      try {
        const g = await upstream.callTool({ name: "get-grant-status", arguments: { grantId: sc.grantId } });
        status = g?.structuredContent?.status ?? "pending";
      } catch {
        /* upstream hiccup — next tick retries */
      }
    }
    probe({ kind: "hold-ended", grantId: sc.grantId, after: Date.now() - t0, status });
    // The doorbell — fetch the final view; status comes from the store, not from this bridge.
    r = await call({ ...(args ?? {}), answers: { ...(args?.answers ?? {}), approved: "true" } });
    sc = r.structuredContent;
  }

  // Rewrite the wait note so the model redials immediately instead of inventing sleep loops.
  if (sc?.code === "awaiting-approval") {
    sc = { ...sc, note: REDIAL_NOTE };
    r = { ...r, structuredContent: sc, content: [{ type: "text", text: JSON.stringify(sc) }] };
  }
  probe({ kind: "tool-result", tool: "create-spending-grant", code: sc?.code ?? null, status: sc?.status ?? null, held: redial });
  return shape(r);
}

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: "credentagent-storefront-2026-bridge", version: "0.0.1" });
  // SPIKE: stateless serving means this per-request instance never saw the legacy client's
  // `initialize`, so its declared capabilities are unknown here. probe.log showed the claude.ai
  // session declares `elicitation: {}` (bare = form support, pre-mode rule) — seed that so the
  // form-mode park is reachable. A real implementation would carry this via sessions.
  server.server._clientCapabilities = { elicitation: { form: {} } };
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: fromJsonSchema(t.inputSchema ?? { type: "object" }),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      },
      t.name === "create-spending-grant"
        ? createGrantHeld
        : async (args) => {
            const r = await upstream.callTool({ name: t.name, arguments: args ?? {} });
            probe({ kind: "tool-result", tool: t.name, code: r?.structuredContent?.code ?? null, isError: r?.isError ?? false });
            return shape(r);
          },
    );
  }
  return server;
});

const app = createMcpExpressApp({
  host: "0.0.0.0",
  allowedHosts: [
    "localhost",
    "127.0.0.1",
    `localhost:${PORT}`,
    `127.0.0.1:${PORT}`,
    ...(process.env.TUNNEL_HOST ? [process.env.TUNNEL_HOST] : []),
  ],
});

// The probe: everything the client reveals about itself, before the SDK answers.
app.use("/mcp", (req, _res, next) => {
  const b = req.body ?? {};
  const p = b.params ?? {};
  probe({
    kind: "request",
    http: req.method,
    rpc: b.method ?? null,
    id: b.id ?? null,
    protocolVersion: p.protocolVersion ?? req.headers["mcp-protocol-version"] ?? null,
    clientInfo: p.clientInfo ?? null,
    capabilities: p.capabilities ?? null,
    meta: p._meta ?? null,
    sessionHeader: req.headers["mcp-session-id"] ?? null,
    ua: req.headers["user-agent"] ?? null,
  });
  next();
});

const node = toNodeHandler(handler);
app.all("/mcp", (req, res) => void node(req, res, req.body));

app.listen(PORT, () => {
  console.log(`\n  2026-07-28 bridge → MCP at http://localhost:${PORT}/mcp  (upstream: ${UPSTREAM})`);
  console.log(`  probe log: ${LOG}\n`);
});
