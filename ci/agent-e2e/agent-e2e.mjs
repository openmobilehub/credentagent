// Agent-in-the-loop E2E — a REAL Claude agent drives the deployed MCP storefront, unaided.
//
//   ANTHROPIC_API_KEY=... node ci/agent-e2e/agent-e2e.mjs
//   MCP_URL=https://credentagent-demo.vercel.app/mcp   # override the target (default: prod demo)
//
// Why this exists: the deterministic smokes call known endpoints with known payloads. They can
// never catch the failure class that matters most for an MCP product — "an agent can no longer
// figure out our tools" (a reworded description, a changed manifest shape, a confusing refusal).
// This harness gives Claude ONE plain-language task and then asserts on FACTS IN THE TOOL TRACE
// (via the shared, parse-based `runAssertions`) — never on prose, so agent nondeterminism can't
// flake it. Its ChatGPT twin is agent-e2e-openai.mjs; both share ./assertions.mjs.
//
// The Messages API's MCP connector executes the MCP tools server-side: one request, no client
// plumbing. `pause_turn` is resumed per the API contract.

import Anthropic from "@anthropic-ai/sdk";
import { runAssertions } from "./assertions.mjs";

const MCP_URL = process.env.MCP_URL ?? "https://credentagent-demo.vercel.app/mcp";
const MODEL = "claude-opus-4-8";
const MAX_CONTINUATIONS = 5;

const client = new Anthropic(); // ANTHROPIC_API_KEY from env

const TASK =
  "You are shopping at this store for me. Buy the Oak Reserve Whiskey. " +
  "Get as far as you can on your own, then tell me exactly what I (the human) must do to complete the purchase, " +
  "including any verification requirements. Do not pretend steps succeeded if they require me.";

// Extract the text of an mcp_tool_result block (usually a single JSON text block).
const resultText = (block) =>
  Array.isArray(block.content)
    ? block.content.filter((x) => x.type === "text").map((x) => x.text).join("")
    : typeof block.content === "string"
      ? block.content
      : "";

// ── run the agent ─────────────────────────────────────────────────────────────
let messages = [{ role: "user", content: TASK }];
let response;
const toolNames = [];
const rawOutputs = [];

for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
  response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    betas: ["mcp-client-2025-11-20"],
    mcp_servers: [{ type: "url", url: MCP_URL, name: "storefront" }],
    tools: [{ type: "mcp_toolset", mcp_server_name: "storefront" }],
    messages,
  });

  for (const block of response.content) {
    if (block.type.includes("mcp_tool_use")) toolNames.push(block.name);
    if (block.type.includes("mcp_tool_result")) rawOutputs.push(resultText(block));
  }

  if (response.stop_reason !== "pause_turn") break;
  // Server-side tool loop paused — append the assistant turn as-is and re-send to resume.
  messages = [...messages, { role: "assistant", content: response.content }];
}

const finalText = response.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("\n");

const failures = runAssertions({ toolNames, rawOutputs, finalText, mcpUrl: MCP_URL, model: MODEL });
process.exit(failures === 0 ? 0 : 1);
