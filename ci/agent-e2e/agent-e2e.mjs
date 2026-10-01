// Agent-in-the-loop E2E — a REAL Claude agent drives the deployed MCP storefront, unaided.
//
//   CLAUDE_CODE_OAUTH_TOKEN=... node ci/agent-e2e/agent-e2e.mjs    # token from `claude setup-token`
//   node ci/agent-e2e/agent-e2e.mjs                                # locally: uses your Claude Code login
//   E2E_MCP_URL=https://credentagent.ai/marketplace-dev/mcp        # aim at the dev twin (default: prod demo)
//
// Why this exists: the deterministic smokes call known endpoints with known payloads. They can
// never catch the failure class that matters most for an MCP product — "an agent can no longer
// figure out our tools" (a reworded description, a changed manifest shape, a confusing refusal).
// This harness gives Claude ONE plain-language task and then asserts on FACTS IN THE TOOL TRACE
// (via the shared, parse-based `runAssertions`) — never on prose, so agent nondeterminism can't
// flake it. The assertions live in ./assertions.mjs.
//
// The agent runs on the Claude Agent SDK (Claude Code as a library), so it authenticates with the
// same CLAUDE_CODE_OAUTH_TOKEN as the automated PR review — no separate API key or bill. It sees
// ONLY the storefront's MCP tools: built-in tools are off and no local settings are loaded.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { runAssertions } from "./assertions.mjs";

// Target the deployed MCP storefront. `E2E_MCP_URL` is the override (e.g. the dev twin at
// credentagent-demo-dev running main's unpublished source); `MCP_URL` stays accepted for
// back-compat; default is the prod demo, so the nightly workflow needs no env at all.
const MCP_URL = process.env.E2E_MCP_URL ?? process.env.MCP_URL ?? "https://credentagent.ai/marketplace/mcp";
const MODEL = "claude-opus-4-8";
const MCP_PREFIX = "mcp__storefront__";

const TASK =
  "You are shopping at this store for me. Buy the Oak Reserve Whiskey. " +
  "Get as far as you can on your own, then tell me exactly what I (the human) must do to complete the purchase, " +
  "including any verification requirements. Do not pretend steps succeeded if they require me.";

// Extract the text of a tool_result block (usually a single JSON text block).
const resultText = (block) =>
  Array.isArray(block.content)
    ? block.content.filter((x) => x.type === "text").map((x) => x.text).join("")
    : typeof block.content === "string"
      ? block.content
      : "";

// ── run the agent ─────────────────────────────────────────────────────────────
const toolNames = [];
const rawOutputs = [];
let result;

for await (const msg of query({
  prompt: TASK,
  options: {
    model: MODEL,
    mcpServers: { storefront: { type: "http", url: MCP_URL } },
    strictMcpConfig: true, // only the storefront — ignore any other MCP config on the machine
    tools: [], // no built-in tools (Bash, Read, WebFetch, …): the store's tools are the whole surface
    allowedTools: ["mcp__storefront"], // auto-approve every storefront tool
    permissionMode: "dontAsk", // anything else is denied, never prompted (no human in CI)
    settingSources: [], // don't load user/project settings, CLAUDE.md or skills
    maxTurns: 30,
  },
})) {
  const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
  if (msg.type === "assistant") {
    for (const block of content) {
      if (block.type === "tool_use") toolNames.push(block.name.replace(MCP_PREFIX, ""));
    }
  } else if (msg.type === "user") {
    for (const block of content) {
      if (block.type === "tool_result") rawOutputs.push(resultText(block));
    }
  } else if (msg.type === "result") {
    result = msg;
  }
}

if (!result || result.subtype !== "success" || result.is_error) {
  console.error(`agent run did not complete: ${result?.subtype ?? "no result"}`, result?.errors ?? result?.result ?? "");
  process.exit(1);
}

const failures = runAssertions({ toolNames, rawOutputs, finalText: result.result, mcpUrl: MCP_URL, model: MODEL });
process.exit(failures === 0 ? 0 : 1);
