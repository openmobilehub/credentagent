// An MCP client that speaks MRTR — the other half of the multi round-trip pattern (#174).
//
// Our servers answer "I need more information" with an `input_required` result. Nothing that
// ships today knows what to do with it: neither @modelcontextprotocol/sdk@1.29 nor the hosts
// built on it implement the draft pattern. So here is a client that DOES, end to end:
//
//   1. it declares the `elicitation` capability, which is what earns it `inputRequests` at all;
//   2. it reads the questions off the `input_required` result and puts them to the human;
//   3. it retries the SAME tool call with `inputResponses` + the `requestState`, verbatim,
//      as REQUEST-LEVEL params — next to `name` and `arguments`, where the spec puts them.
//
//   node examples/hnp-on-claude/serve.mjs                    # terminal 1: the store
//   node examples/mrtr-client.mjs                            # terminal 2: this client (asks you)
//   ANSWERS='{"size":"US 10","colour":"Black"}' node examples/mrtr-client.mjs   # unattended
//   MCP_URL=https://your-store/mcp node examples/mrtr-client.mjs
//
// https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr
import { createInterface } from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3005/mcp";
const ITEM = process.env.ITEM ?? "sneakers";
const SCRIPTED = process.env.ANSWERS ? JSON.parse(process.env.ANSWERS) : null;
const MAX_ROUNDS = 5;

// `elicitation` is the capability that says "I can put a question to my human". A server that
// honours the spec sends `inputRequests` only to a client that declared it (server requirement 7).
const client = new Client({ name: "mrtr-sample-client", version: "1.0.0" }, { capabilities: { elicitation: {} } });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

const ask = SCRIPTED
  ? async (_message, field) => SCRIPTED[field] // unattended: answer from the scripted map
  : (() => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return async (message, field, options) => {
        const menu = options?.length ? ` [${options.join(" / ")}]` : "";
        return (await rl.question(`   ${message}${menu}\n   > `)).trim();
      };
    })();

/** Turn one `elicitation/create` request into the client's `ElicitResult`. */
async function elicit(request) {
  const { message, requestedSchema } = request.params;
  const content = {};
  for (const [field, schema] of Object.entries(requestedSchema.properties)) {
    const answer = await ask(message, field, schema.enum);
    if (!answer) return { action: "decline" }; // the human can always refuse — say so honestly
    content[field] = answer;
  }
  return { action: "accept", content };
}

// ── the round trip ────────────────────────────────────────────────────────────
const args = { budget: 200, perSpend: 120, item: ITEM };
let requestState;
let inputResponses;
let result;

for (let round = 1; round <= MAX_ROUNDS; round++) {
  // Each retry is an INDEPENDENT request (its own JSON-RPC id — the SDK assigns one) carrying
  // everything the server needs: the original arguments, the answers, and the opaque state.
  result = await client.request(
    {
      method: "tools/call",
      params: { name: "create-spending-grant", arguments: args, ...(requestState ? { requestState, inputResponses } : {}) },
    },
    CallToolResultSchema,
  );

  if (result.resultType !== "input_required") break;
  const view = result.structuredContent ?? {};

  // The LAST round is the human's tap at the approve page. Unattended, there is no human to
  // tap it — print the link and stop. (Interactively, open the link, approve, then answer:
  // the reply is only a doorbell — the store re-reads its own record before saying "authorized".)
  if (view.code === "awaiting-approval" && SCRIPTED) break;

  console.log(
    view.code === "awaiting-approval"
      ? `\n── round ${round}: the grant EXISTS (pending) — the store is waiting for the human's tap ──`
      : `\n── round ${round}: the store needs more before it will mint a grant ──`,
  );
  inputResponses = {};
  for (const [key, request] of Object.entries(result.inputRequests)) {
    inputResponses[key] = await elicit(request);
    if (SCRIPTED) console.log(`   ${request.params.message} → ${JSON.stringify(inputResponses[key])}`);
  }
  requestState = result.requestState; // echoed back VERBATIM; never inspected, never edited
}

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

await client.close();
process.exit(0);
