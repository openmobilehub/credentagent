// Agent-in-the-loop E2E — a REAL Claude agent drives the deployed MCP storefront, unaided.
//
//   ANTHROPIC_API_KEY=... node ci/agent-e2e/agent-e2e.mjs
//   MCP_URL=https://credentagent-demo.vercel.app/mcp   # override the target (default: prod demo)
//
// Why this exists: the deterministic smokes call known endpoints with known payloads. They can
// never catch the failure class that matters most for an MCP product — "an agent can no longer
// figure out our tools" (a reworded description, a changed manifest shape, a confusing refusal).
// This harness gives Claude ONE plain-language task and then asserts on FACTS IN THE TOOL TRACE
// (which tools ran, what the manifest said) — never on prose, so agent nondeterminism can't flake it.
//
// The Messages API's MCP connector executes the MCP tools server-side: one request, no client
// plumbing. `pause_turn` is resumed per the API contract.

import Anthropic from "@anthropic-ai/sdk";

const MCP_URL = process.env.MCP_URL ?? "https://credentagent-demo.vercel.app/mcp";
const MODEL = "claude-opus-4-8";
const MAX_CONTINUATIONS = 5;

const client = new Anthropic(); // ANTHROPIC_API_KEY from env

const TASK =
  "You are shopping at this store for me. Buy the Oak Reserve Whiskey. " +
  "Get as far as you can on your own, then tell me exactly what I (the human) must do to complete the purchase, " +
  "including any verification requirements. Do not pretend steps succeeded if they require me.";

// ── run the agent ─────────────────────────────────────────────────────────────
let messages = [{ role: "user", content: TASK }];
let response;
const trace = { toolUses: [], toolResults: [] };

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
    if (block.type.includes("mcp_tool_use")) trace.toolUses.push({ name: block.name, input: block.input });
    if (block.type.includes("mcp_tool_result")) trace.toolResults.push(JSON.stringify(block.content ?? ""));
  }

  if (response.stop_reason !== "pause_turn") break;
  // Server-side tool loop paused — append the assistant turn as-is and re-send to resume.
  messages = [...messages, { role: "assistant", content: response.content }];
}

const finalText = response.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("\n");
const resultsBlob = trace.toolResults.join("\n");

// ── assertions: facts from the trace, never vibes ─────────────────────────────
let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
};

console.log(`\nagent-e2e against ${MCP_URL} (model ${MODEL})`);
console.log(`tool calls made by the agent: ${trace.toolUses.map((t) => t.name).join(" → ") || "(none)"}\n`);

check(
  "the agent could use the store at all (≥1 MCP tool call)",
  trace.toolUses.length > 0,
);
check(
  "the agent reached checkout unaided",
  trace.toolUses.some((t) => t.name.toLowerCase().includes("checkout")),
);
check(
  "the checkout surfaced the AGE gate to the agent (credential:age, minAge 21)",
  resultsBlob.includes('"credential":"age"') && resultsBlob.includes('"minAge":21'),
);
check(
  "the honesty label survived to the agent-facing wire (presence-only-demo)",
  resultsBlob.includes("presence-only-demo"),
);
check(
  "no tool result claimed the gated order completed (nothing to hallucinate from)",
  !resultsBlob.includes('"completed":true'),
);
check(
  "the agent told the human about the 21+ requirement",
  /21|age/i.test(finalText),
  "final message never mentioned the age requirement",
);

// DX telemetry (logged, not asserted): how much work did the agent need?
console.log(`\n[dx] tool calls: ${trace.toolUses.length} · continuations: ${messages.length - 1} · output tokens: ${response.usage.output_tokens}`);

console.log(failures === 0 ? "\nALL AGENT-E2E CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
if (failures > 0) {
  console.log("\n--- final agent message (for debugging) ---\n" + finalText.slice(0, 1500));
}
process.exit(failures === 0 ? 0 : 1);
