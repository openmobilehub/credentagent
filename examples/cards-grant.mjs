// Show a spending grant as a card in Claude and ChatGPT, from your own MCP server (spec 015).
//
// An MCP server that is not createStorefront() serves the card kit's grant card with `createCards()` and
// the gate's own grants: `grantView(grant)` turns a grant into the card's data, so there is no projection
// to write. Four tools: create one, show it, spend from it (model-only), and Revoke, the one tool the
// card's own button may call.
//
//   npm run build:packages
//   node examples/cards-grant.mjs                       # → http://localhost:3010/mcp
//   cloudflared tunnel --url http://localhost:3010      # then add <tunnel URL>/mcp as a connector
//                                                       # (restart with PUBLIC_URL=<tunnel URL> so Approve works)
//
// Ask Claude: "create a grant of $100 for drinks, then show it". Press Approve on the card, ask again to
// show the grant, then press Revoke. Preview every card without a chat: http://localhost:3010/cards
//
// Demo only: grants live in this process's memory, shared by everyone who connects.
import { randomUUID } from "node:crypto";
import { McpServer, createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { z } from "zod";
import { CredentAgent, grantView } from "@openmobilehub/credentagent-gate";
import { createCards } from "@openmobilehub/credentagent-gate/cards";

const PORT = Number(process.env.PORT ?? 3010);
const origin = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");

const credentagent = new CredentAgent({
  walletOrigin: origin,
  catalog: { coffee: { price: 18, category: "Beverages" }, headphones: { price: 40, category: "Electronics" } },
});

const cards = createCards({ tools: { revoke: "revoke-grant" } }); // once per process

const grantId = z.object({ grantId: z.string() });

function buildServer() {
  const server = new McpServer({ name: "cards-grant", version: "1.0.0" });
  cards.register(server); // the card page for Claude and ChatGPT

  // Only the model calls these (the default of toolMeta()): a script in a card can never reach them.
  server.registerTool(
    "create-grant",
    { description: "Create a spending grant the person approves once on a page, then show it as a card.", inputSchema: z.object({ budget: z.number().positive(), perSpend: z.number().positive(), category: z.string().default("Beverages") }), _meta: cards.toolMeta() },
    async ({ budget, perSpend, category }) => {
      const grant = await credentagent.grants.create({ merchant: "Utopia", budget, perSpend, allow: { categories: [category] }, signing: "page" });
      return cards.grant(await grantView(grant));
    },
  );

  server.registerTool("get-grant", { description: "Show a spending grant as a card.", inputSchema: grantId, _meta: cards.toolMeta() }, async ({ grantId }) => {
    const grant = await credentagent.grants.retrieve(grantId);
    if (!grant) return { isError: true, content: [{ type: "text", text: "No such grant." }] };
    return cards.grant(await grantView(grant));
  });

  server.registerTool(
    "spend-from-grant",
    { description: "Spend one coffee ($18) from an approved grant, then show the grant.", inputSchema: grantId, _meta: cards.toolMeta() },
    async ({ grantId }) => {
      const grant = await credentagent.grants.retrieve(grantId);
      if (!grant) return { isError: true, content: [{ type: "text", text: "No such grant." }] };
      const door = await grant.spend({ idempotencyKey: randomUUID(), items: [{ sku: "coffee" }] });
      return cards.grant(await grantView(await credentagent.grants.retrieve(grantId)), { note: door.ok ? "Spent $18." : `Refused: ${door.code}.` });
    },
  );

  // The card's Revoke button calls this one, so it opts in. It returns the grant as a card, which then reads "revoked".
  server.registerTool(
    "revoke-grant",
    { description: "Revoke a spending grant so the agent can't spend from it again.", inputSchema: grantId, _meta: cards.toolMeta({ callableFromCard: true }) },
    async ({ grantId }) => {
      const grant = await credentagent.grants.retrieve(grantId);
      if (!grant) return { isError: true, content: [{ type: "text", text: "No such grant." }] };
      await grant.revoke();
      console.log(`  revoke-grant called for ${grantId}`);
      return cards.grant(await grantView(await credentagent.grants.retrieve(grantId)));
    },
  );
  return server;
}

const app = createMcpExpressApp({ host: "0.0.0.0" });
credentagent.grants.serve(app); // the approve page a pending card's Approve and Decline buttons open

const serveModern = toNodeHandler(createMcpHandler(() => buildServer(), { legacy: "reject", maxSubscriptions: 0 }));
app.all("/mcp", async (req, res) => {
  if (!(await isLegacyRequest(await toWebRequest(req, req.body), req.body))) return serveModern(req, res, req.body);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => void transport.close());
  await buildServer().connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/cards", (_req, res) => res.type("html").send(cards.html)); // preview: /cards?view=grant-product

app.listen(PORT, () => {
  console.log(`\n  MCP server   → ${origin}/mcp  (listening on :${PORT})`);
  console.log(`  Card preview → http://localhost:${PORT}/cards\n`);
});
