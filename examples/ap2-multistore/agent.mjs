// ap2-multistore/agent.mjs — the AGENT, as an MCP connector for Claude. A separate process from the
// stores: it imports `/agent` for everything that touches its key, and its key never leaves here.
//
//   STORES=<url>,<url>,<url> node examples/ap2-multistore/agent.mjs   # → http://localhost:4100/mcp
//   (or run up.mjs, which wires the tunnels and starts this for you)
//
// Four tools, the whole story: compare-offers → request-permission → check-permission → buy.
// The agent holds only PUBLIC data besides its key: the stores' catalogs, the permission the phone
// signed, and the stores' signed carts. The proof it hands a store is checked there, not trusted here.
import express from "express";
import { z } from "zod";
import { McpServer, createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { AgentKey, DelegatedIntent } from "@openmobilehub/credentagent-gate/agent";

const PORT = Number(process.env.PORT ?? 4100);
const STORES = (process.env.STORES ?? "http://localhost:4101,http://localhost:4102,http://localhost:4103").split(",").map((s) => s.trim().replace(/\/$/, ""));

// A real agent loads a stored key: AgentKey.fromJwk(JSON.parse(process.env.AGENT_KEY)).
const agentKey = process.env.AGENT_KEY ? AgentKey.fromJwk(JSON.parse(process.env.AGENT_KEY)) : AgentKey.generate();
const permissions = new Map(); // grantId → the signed permission (plain JSON from the phone)

const call = async (url, body) => {
  const res = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const result = (data, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data, ...(isError ? { isError } : {}) });
const storeUrl = z.string().describe("the store's url, exactly as compare-offers returned it");

function buildServer() {
  const server = new McpServer({ name: "credentagent-ap2-agent", version: "0.0.0" });

  server.registerTool("compare-offers", {
    title: "Compare offers",
    description: "Read every store's catalog (price + rating per product). Use it first, then pick the store with the best price-to-rating balance for what the person wants, and say why.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => {
    const stores = await Promise.all(STORES.map(async (url) => {
      try { return { url, ...(await call(`${url}/agent/catalog`)).body }; } catch (err) { return { url, error: err.message }; }
    }));
    return result({ stores });
  });

  server.registerTool("request-permission", {
    title: "Request a spending permission",
    description:
      "Ask the person for a spending permission at ONE store, naming exact products and limits. Returns an approveUrl: give it to the person — " +
      "they open it on their phone and SIGN the permission with their wallet. Nothing can be bought until they do. Then call check-permission.",
    inputSchema: z.object({
      store: storeUrl,
      skus: z.array(z.string()).min(1).describe("product ids the permission covers"),
      budget: z.number().positive().describe("total budget in USD"),
      perSpend: z.number().positive().describe("max per purchase in USD"),
      description: z.string().describe("one plain sentence the person will see before signing"),
    }),
  }, async ({ store, skus, budget, perSpend, description }) => {
    const r = await call(`${store}/agent/grants`, { agentKey: agentKey.publicJwk, skus, budget, perSpend, description });
    return result(r.body, r.status !== 200);
  });

  server.registerTool("check-permission", {
    title: "Check the permission",
    description: "Wait (up to ~45 s) for the person to sign the permission on their phone. When it is signed the agent keeps it and can buy.",
    inputSchema: z.object({ store: storeUrl, grantId: z.string() }),
    annotations: { readOnlyHint: true },
  }, async ({ store, grantId }) => {
    const until = Date.now() + 45_000;
    for (;;) {
      const r = await call(`${store}/agent/grants/${encodeURIComponent(grantId)}`);
      if (r.status !== 200) return result(r.body, true);
      if (r.body.intent) {
        permissions.set(grantId, r.body.intent);
        return result({ status: r.body.status, trustLevel: r.body.trustLevel, note: "Signed on the phone. The agent now holds this permission and can buy." });
      }
      if (r.body.status !== "pending" || Date.now() > until) return result({ status: r.body.status, note: r.body.status === "pending" ? "Not signed yet — call again." : "Not authorized." });
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  });

  server.registerTool("buy", {
    title: "Buy",
    description: "Buy at the store under a signed permission. The store quotes and signs the cart, the agent signs the purchase with its own key, the store verifies everything and answers.",
    inputSchema: z.object({
      store: storeUrl,
      grantId: z.string(),
      items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive().optional() })).min(1),
    }),
  }, async ({ store, grantId, items }) => {
    const intent = permissions.get(grantId);
    if (!intent) return result({ error: "No signed permission held for this grant — call check-permission first." }, true);
    const quote = await call(`${store}/agent/quote`, { grantId, items });
    if (quote.status !== 200) return result(quote.body, true);
    const { checkoutJwt, payee, amount, audience, nonce } = quote.body;
    let proof;
    try {
      proof = await DelegatedIntent.fromWalletPresentation(intent).spend({
        agentKey, checkoutJwt, payment: { payee, amount, instrument: { id: "demo-instrument-0001", type: "card" } }, audience, nonce,
      });
    } catch (err) {
      return result({ ok: false, refusedBy: "agent", detail: err.message }, true);
    }
    const r = await call(`${store}/agent/purchase`, { proof, nonce });
    return result(r.body, r.status !== 200);
  });

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
const serveModern = toNodeHandler(createMcpHandler(() => buildServer(), { legacy: "reject", maxSubscriptions: 0 }));
app.all("/mcp", async (req, res) => {
  if (!(await isLegacyRequest(await toWebRequest(req, req.body), req.body))) return serveModern(req, res, req.body);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless: a fresh transport per request
  res.on("close", () => { void transport.close(); });
  await buildServer().connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.listen(PORT, () => {
  console.log(`\nap2-multistore agent → MCP at http://localhost:${PORT}/mcp`);
  console.log(`  public key x=${agentKey.publicJwk.x.slice(0, 12)}… (the private half stays in this process)`);
  console.log(`  stores: ${STORES.join("  ")}\n`);
});
