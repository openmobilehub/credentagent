// Agent-in-the-loop E2E — a REAL OpenAI/ChatGPT agent drives the deployed MCP storefront, unaided.
//
//   OPENAI_API_KEY=... node ci/agent-e2e/agent-e2e-openai.mjs
//   E2E_MCP_URL=https://credentagent-demo-dev.vercel.app/mcp   # aim at the dev twin (default: prod demo)
//   OPENAI_MODEL=gpt-4o                                        # override the model (default: gpt-4o)
//
// The cross-provider twin of agent-e2e.mjs: same plain-language task, same parse-based assertions
// (shared ./assertions.mjs) — but the agent is ChatGPT via OpenAI's Responses API, whose hosted MCP
// tool connects to our /mcp server-side (the analogue of Anthropic's MCP connector). Proving a
// NON-Claude agent can complete the flow is the point: the consent layer is agent-agnostic, and this
// catches the same "an agent can no longer figure out our tools" failure class no scripted test can.

import OpenAI from "openai";
import { runAssertions } from "./assertions.mjs";

// Target the deployed MCP storefront. `E2E_MCP_URL` is the override (e.g. the dev twin at
// credentagent-demo-dev running main's unpublished source); `MCP_URL` stays accepted for
// back-compat; default is the prod demo, so the nightly workflow needs no env at all.
const MCP_URL = process.env.E2E_MCP_URL ?? process.env.MCP_URL ?? "https://credentagent-demo.vercel.app/mcp";
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o";

const client = new OpenAI(); // OPENAI_API_KEY from env

const TASK =
  "You are shopping at this store for me. Buy the Oak Reserve Whiskey. " +
  "Get as far as you can on your own, then tell me exactly what I (the human) must do to complete the purchase, " +
  "including any verification requirements. Do not pretend steps succeeded if they require me.";

// ── run the agent ─────────────────────────────────────────────────────────────
// The Responses API runs the MCP tool loop server-side and returns a flat `output` array; tool
// calls arrive as `mcp_call` items (name + arguments + output-as-a-JSON-string).
const response = await client.responses.create({
  model: MODEL,
  input: TASK,
  tools: [{ type: "mcp", server_label: "storefront", server_url: MCP_URL, require_approval: "never" }],
});

const calls = (response.output ?? []).filter((o) => o.type === "mcp_call");
const toolNames = calls.map((o) => o.name);
const rawOutputs = calls.map((o) => (typeof o.output === "string" ? o.output : JSON.stringify(o.output ?? o.error ?? "")));
const finalText = response.output_text ?? "";

// OpenAI's hosted MCP tool truncates long tool outputs in the returned trace, so the checkout
// manifest is often cut off — count tool-drivability + no-fabrication as regressions, report the
// manifest checks for visibility only (Claude's full-trace harness asserts those end-to-end).
const failures = runAssertions({ toolNames, rawOutputs, finalText, mcpUrl: MCP_URL, model: MODEL, strictManifest: false });
process.exit(failures === 0 ? 0 : 1);
