// "Buy the black court sneakers, US 10" — a spending grant pinned to ONE product (#174).
//
// The human is about to walk away. Before the agent can hand them a link to approve, it has to
// know WHAT it is being trusted to buy — brand, model, size, colour. So `create-spending-grant`
// answers with QUESTIONS instead of a link, and mints the grant only once the product is pinned.
// Even then the flow stays open: one last round waits for the human's tap at the approve page.
// The agent's re-check HOLDS the line server-side (up to `approvalHoldMs`, default 45s — just
// under claude.ai's 60s tool-call kill) and returns the moment the tap lands; its answer is only
// a doorbell — approval is re-read from the server's own record, never taken from what the agent
// says. That's MCP's multi round-trip request pattern:
//   https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr
//
//   node examples/grant-exact-product.mjs        (after: npm run build:packages)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const credentagent = new CredentAgent({
  walletOrigin: "http://localhost:3005",
  catalog: { "court-sneakers": { price: 95, category: "Apparel" }, "drift-mouse": { price: 49, category: "Electronics" } },
});

const store = createStorefront({ grants: credentagent.grants, merchant: "utopia" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const agent = new Client({ name: "shopping-agent", version: "1.0.0" });
await Promise.all([store.mcpServer().connect(serverTransport), agent.connect(clientTransport)]);

const call = async (args) => (await agent.callTool({ name: "create-spending-grant", arguments: args })).structuredContent;

// ── Round 1: the human's words name a product, but not WHICH pair ────────────────
const bounds = { budget: 200, perSpend: 120, item: "sneakers" };
const asked = await call(bounds);
console.log("① agent asks for a grant → no link yet:", asked.code);
for (const q of asked.questions) console.log(`   ${q.message}  ${JSON.stringify(q.fields[0].options)}`);

// ── The agent puts the questions to the human, who picks ─────────────────────────
const answers = { size: "US 10", colour: "Black" };
console.log("② the human answers:", answers);

// ── Round 2: same arguments + the state, verbatim → the grant exists, still PENDING ──
// The flow STAYS OPEN (one more round): the store hands over the approve link and waits
// for the human's tap before it will call the grant done.
const grant = await call({ ...bounds, requestState: asked.requestState, answers });
console.log("③ grant pinned to:", grant.item.name, grant.item.selections, "→ allow:", grant.allow);
console.log("   send this to the human:", grant.approveUrl);

// ── The redial HOLDS the line while the human taps Approve in the browser ────────
// (The approve page calls this same seam.) The agent's own answer authorizes nothing:
// status is re-read from the grant store — the redial just waits for the tap to land.
setTimeout(() => void credentagent.grants._authorize(grant.grantId), 800); // the tap, mid-hold
const t0 = Date.now();
const live = await call({ ...bounds, requestState: grant.requestState, answers: { approved: "true" } });
console.log(`④ held redial resolves t+${((Date.now() - t0) / 1000).toFixed(1)}s:      `, live.status);

const bought = (await agent.callTool({ name: "spend-from-grant", arguments: { grantId: grant.grantId, productId: "court-sneakers" } })).structuredContent;
console.log("⑤ unattended spend on the approved pair:", bought.ok ? `ok, $${bought.amount}` : bought.code);

const sneaky = (await agent.callTool({ name: "spend-from-grant", arguments: { grantId: grant.grantId, productId: "drift-mouse" } })).structuredContent;
console.log("⑥ unattended spend on something else:   ", sneaky.ok ? "ok — BUG" : `refused (${sneaky.code})`);

// A hand-edited requestState is refused rather than believed — it is client-controlled input.
const [, payload, sig] = asked.requestState.split(".");
const edited = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
edited.answers = { size: "US 12", colour: "White" };
const forged = `mrtr1.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${sig}`;
const refused = await call({ ...bounds, requestState: forged });
console.log("⑦ forged requestState:                  ", refused.approveUrl ? "minted — BUG" : `refused (${refused.code})`);

await agent.close();
process.exit(0);
