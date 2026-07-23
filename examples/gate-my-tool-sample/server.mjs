// gate-my-tool-sample — the `gate-my-tool` skill's target: one UNGATED tool.
//
//   npm run build --workspaces                       # build the packages once
//   node examples/gate-my-tool-sample/server.mjs     # serve release-records over stdio
//
// `release-records` performs a consequential disclosure with NO consent gate —
// deliberately. This server is the "before" in the before/after demo: ask your
// coding agent to run the `gate-my-tool` skill ("gate my release-records tool")
// and it becomes refuse-until-proven, plus a load-bearing bypass test.
// (Identity-first: nothing here is a purchase — no cart, no checkout.)

import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// The consequential action: release a subject's record summary.
export function releaseRecords(subject) {
  return { released: true, subject, records: [`record:${subject}:summary`] };
}

/** Build the MCP server (exported so a test can drive it in-memory). */
export function buildServer() {
  const server = new McpServer({ name: "gate-my-tool-sample", version: "0.1.0" });
  server.registerTool(
    "release-records",
    {
      description: "Release a subject's record summary — a consequential action.",
      inputSchema: { subject: z.string() },
    },
    async ({ subject }) => ({
      content: [{ type: "text", text: `Released records for ${subject}.` }],
      structuredContent: releaseRecords(subject),
    }),
  );
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildServer().connect(new StdioServerTransport());
  console.error("gate-my-tool-sample: release-records served over stdio (UNGATED — run the gate-my-tool skill)");
}
