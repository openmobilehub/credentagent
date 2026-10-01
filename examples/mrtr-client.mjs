// An MCP 2026-07-28 client — the other half of the multi round-trip pattern (#174).
//
// Our store answers "I need more information" with an `input_required` result. On MCP
// 2026-07-28 the SDK's client handles the round trips itself: it puts each embedded question
// to the elicitation handler below, then retries the SAME tool call with the answers and the
// server's `requestState`, verbatim. All this client does is:
//
//   1. pin the 2026-07-28 revision and declare `elicitation` — what earns it `inputRequests`;
//   2. answer each question (from you, or from a scripted map);
//   3. make ONE `callTool` — the SDK drives every round until the store has a final answer.
//
//   node examples/hnp-on-claude/serve.mjs                    # terminal 1: the store
//   node examples/mrtr-client.mjs                            # terminal 2: this client (asks you)
//   ANSWERS='{"size":"US 10","colour":"Black"}' node examples/mrtr-client.mjs   # unattended
//   MCP_URL=https://your-store/mcp node examples/mrtr-client.mjs
//
// https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
import { createInterface } from "node:readline/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3005/mcp";
const ITEM = process.env.ITEM ?? "sneakers";
const SCRIPTED = process.env.ANSWERS ? JSON.parse(process.env.ANSWERS) : null;

const client = new Client(
  { name: "mrtr-sample-client", version: "1.0.0" },
  { capabilities: { elicitation: {} }, versionNegotiation: { mode: { pin: "2026-07-28" } } },
);

const rl = SCRIPTED ? null : createInterface({ input: process.stdin, output: process.stdout });
const ask = async (message, field, options) => {
  if (SCRIPTED) return SCRIPTED[field];
  const menu = options?.length ? ` [${options.join(" / ")}]` : "";
  return (await rl.question(`   ${message}${menu}\n   > `)).trim();
};

// Every question the store embeds lands here — the client's side of `elicitation/create`. The SDK
// fulfils a round's questions concurrently; one human answers them one at a time, so queue them.
let turn = Promise.resolve();
client.setRequestHandler("elicitation/create", (request) => (turn = turn.then(() => answer(request.params))));

async function answer({ message, requestedSchema }) {
  const fields = Object.entries(requestedSchema.properties);
  // The LAST round is the human's tap at the approve page. Unattended, there is no human to
  // tap it — decline, and the store answers with the pending grant and its link. (Interactively,
  // open the link, approve, then answer: the reply is only a doorbell — the store re-reads its
  // own record before saying "authorized".)
  if (SCRIPTED && fields.some(([field]) => field === "approved")) return { action: "decline" };

  console.log(`\n── the store asks ──`);
  const content = {};
  for (const [field, schema] of fields) {
    const answer = await ask(message, field, schema.enum);
    if (!answer) return { action: "decline" }; // the human can always refuse — say so honestly
    content[field] = schema.type === "boolean" ? /^(y|yes|true)$/i.test(answer) : answer;
    if (SCRIPTED) console.log(`   ${message} → ${JSON.stringify(answer)}`);
  }
  return { action: "accept", content };
}

await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
const result = await client.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 120, item: ITEM } });

const view = result.structuredContent ?? {};
if (view.status === "authorized") {
  console.log(`\n✅ AUTHORIZED — ${view.item?.name} ${JSON.stringify(view.item?.selections ?? {})}`);
  console.log(`   it may buy: ${JSON.stringify(view.allow)}  ·  budget $${view.budget}, $${view.perSpend} per purchase`);
  console.log(`   the agent can now spend-from-grant while the human is away.`);
} else if (view.approveUrl) {
  console.log(`\n⏳ grant pinned to: ${view.item?.name} ${JSON.stringify(view.item?.selections ?? {})} — status ${view.status}`);
  console.log(`   it may buy: ${JSON.stringify(view.allow)}  ·  budget $${view.budget}, $${view.perSpend} per purchase`);
  console.log(`   send this to the human — nothing spends until they approve:\n   ${view.approveUrl}`);
} else {
  console.log(`\n⛔ no grant was created: ${view.code ?? "unknown"} — ${view.note ?? ""}`);
}

rl?.close();
await client.close();
process.exit(0);
