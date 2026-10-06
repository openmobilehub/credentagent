// ap2-multistore/agent.mjs — the AGENT, as an MCP connector for Claude or ChatGPT. A separate process
// from the stores: it imports `/agent` for everything that touches its key, and its key never leaves here.
//
//   STORES=<url>,<url>,<url> node examples/ap2-multistore/agent.mjs   # → http://localhost:4100/mcp
//   (or run up.mjs, which wires the tunnels and starts this for you)
//
// Four tools, the whole story: compare-offers → request-permission → check-permission → buy.
// The agent holds only PUBLIC data besides its key: the stores' catalogs, the permission the phone
// signed, and the stores' signed carts. The proof it hands a store is checked there, not trusted here.
//
// Three of the tools render a card in the chat (widget/): the offers side by side, the permission with
// a QR code to scan and its live status, and the receipt with what the store checked. Preview the cards
// without a chat at http://localhost:4100/widget?view=offers|permission|receipt|refused.
import express from "express";
import { z } from "zod";
import { McpServer, createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { AgentKey, DelegatedIntent } from "@openmobilehub/credentagent-gate/agent";
import { createWidget, previewResult, qrDataUrl } from "./widget/serve.mjs";

const PORT = Number(process.env.BASE_PORT ?? 4100);
const STORES = (process.env.STORES ?? [1, 2, 3].map((n) => `http://localhost:${PORT + n}`).join(",")).split(",").map((s) => s.trim().replace(/\/$/, ""));

// A real agent loads a stored key: AgentKey.fromJwk(JSON.parse(process.env.AGENT_KEY)).
const agentKey = process.env.AGENT_KEY ? AgentKey.fromJwk(JSON.parse(process.env.AGENT_KEY)) : AgentKey.generate();
const permissions = new Map(); // grantId → the signed permission (plain JSON from the phone)
const widget = createWidget();

const call = async (url, body) => {
  const res = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
// `note` is what the model reads first; `data` is the card's input. `widgetOnly` (the QR image) reaches the card, not the model.
const result = (data, { note, isError, widgetOnly } = {}) => ({
  content: [{ type: "text", text: `${note ? `${note}\n\n` : ""}${JSON.stringify(data, null, 2)}` }],
  structuredContent: data,
  ...(widgetOnly ? { _meta: widgetOnly } : {}),
  ...(isError ? { isError } : {}),
});
const storeUrl = z.string().describe("the store's url, exactly as compare-offers returned it");

// One terminal line per tool call, so a live demo shows how far each step got. A call the chat host
// blocks before it reaches this process (ChatGPT's safety layer does, for `buy`) prints nothing at all.
const names = new Map(); // store url → the name the store itself reported
const nameOf = (url) => names.get(url) ?? url;
const usd = (dollars) => `$${Number(dollars).toFixed(2)}`;
const log = (tool, line) => console.log(`  [agent] ${tool.padEnd(18)} ${line}`);

function buildServer() {
  const server = new McpServer({ name: "credentagent-ap2-agent", version: "0.0.0" });
  widget.register(server);

  registerAppTool(server, "compare-offers", {
    title: "Compare offers",
    description: "Read every store's catalog (price + rating per product). Use it first, then pick the store with the best price-to-rating balance for what the person wants, and say why.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    _meta: widget.meta("Reading the stores…", "Compared the stores"),
  }, async () => {
    const stores = await Promise.all(STORES.map(async (url) => {
      try { return { url, ...(await call(`${url}/agent/catalog`)).body }; } catch (err) { return { url, error: err.message }; }
    }));
    for (const s of stores) if (s.store) names.set(s.url, s.store);
    const down = stores.filter((s) => !s.store).map((s) => s.url);
    log("compare-offers", `read ${stores.length - down.length} of ${stores.length} stores${down.length ? ` — unreachable: ${down.join(", ")}` : ""}`);
    return result({ view: "offers", stores }, {
      note: "The person sees these offers side by side in a card. Don't re-list them; say which store you pick and why, in a sentence or two.",
    });
  });

  registerAppTool(server, "request-permission", {
    title: "Request a spending permission",
    description:
      "Ask the person for a spending permission at ONE store, naming exact products and limits. The person sees a card with a QR code: " +
      "they scan it with their phone and SIGN the permission with their wallet. Nothing can be bought until they do. Then call check-permission.",
    inputSchema: {
      store: storeUrl,
      skus: z.array(z.string()).min(1).describe("product ids the permission covers"),
      budget: z.number().positive().describe("total budget in USD"),
      perSpend: z.number().positive().describe("max per purchase in USD"),
      description: z.string().describe("one plain sentence the person will see before signing"),
      why: z.string().describe("one sentence: why this store won the comparison (shown to the person)"),
    },
    _meta: widget.meta("Preparing the permission…", "Waiting for your signature"),
  }, async ({ store, skus, budget, perSpend, description, why }) => {
    const r = await call(`${store}/agent/grants`, { agentKey: agentKey.publicJwk, skus, budget, perSpend, description });
    if (r.status !== 200) {
      log("request-permission", `✗ ${nameOf(store)}: ${r.body.error ?? r.status}`);
      return result(r.body, { isError: true });
    }
    names.set(store, r.body.store);
    log("request-permission", `${r.body.store} · ${r.body.products.join(", ")} · ${usd(perSpend)} a purchase · ${usd(budget)} total → waiting for the phone (${r.body.grantId})`);
    const data = {
      view: "permission", store: r.body.store, storeUrl: store, merchantId: r.body.merchantId, grantId: r.body.grantId,
      approveUrl: r.body.approveUrl, products: r.body.products, budget, perSpend, description, why, status: r.body.status,
    };
    return result(data, {
      note: "The person sees a card with a QR code for approveUrl. Ask them to scan it with their phone and sign; also give them the link. Then call check-permission.",
      widgetOnly: { "ap2/qr": await qrDataUrl(r.body.approveUrl) },
    });
  });

  // No card of its own — the permission card calls it to show "signed" live (hence widgetAccessible for ChatGPT).
  server.registerTool("check-permission", {
    title: "Check the permission",
    description: "Wait (up to ~45 s) for the person to sign the permission on their phone. When it is signed the agent keeps it and can buy.",
    inputSchema: z.object({ store: storeUrl, grantId: z.string() }),
    annotations: { readOnlyHint: true },
    _meta: { "openai/widgetAccessible": true },
  }, async ({ store, grantId }) => {
    const until = Date.now() + 45_000;
    for (;;) {
      const r = await call(`${store}/agent/grants/${encodeURIComponent(grantId)}`);
      if (r.status !== 200) {
        log("check-permission", `✗ ${nameOf(store)} ${grantId}: ${r.body.error ?? r.status}`);
        return result(r.body, { isError: true });
      }
      if (r.body.intent) {
        if (!permissions.has(grantId)) log("check-permission", `${nameOf(store)} ${grantId} signed on the phone (${r.body.trustLevel}) — the agent now holds it`);
        permissions.set(grantId, r.body.intent);
        return result({ status: r.body.status, trustLevel: r.body.trustLevel }, { note: "Signed on the phone. The agent now holds this permission and can buy." });
      }
      if (r.body.status !== "pending" || Date.now() > until) {
        if (r.body.status !== "pending") log("check-permission", `✗ ${nameOf(store)} ${grantId}: ${r.body.status}`);
        return result({ status: r.body.status }, { note: r.body.status === "pending" ? "Not signed yet — call again." : "Not authorized." });
      }
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  });

  registerAppTool(server, "buy", {
    title: "Buy",
    description: "Buy at the store under a signed permission. The store quotes and signs the cart, the agent signs the purchase with its own key, the store verifies everything and answers.",
    inputSchema: {
      store: storeUrl,
      grantId: z.string(),
      items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive().optional() })).min(1),
    },
    _meta: widget.meta("Paying…", "The store answered"),
  }, async ({ store, grantId, items }) => {
    log("buy", `→ ${nameOf(store)}: ${items.map((i) => `${i.quantity ?? 1} × ${i.sku}`).join(", ")}`);
    const intent = permissions.get(grantId);
    if (!intent) {
      log("buy", `✗ no signed permission held for ${grantId}`);
      return result({ error: "No signed permission held for this grant — call check-permission first." }, { isError: true });
    }
    const quote = await call(`${store}/agent/quote`, { grantId, items });
    if (quote.status !== 200) {
      log("buy", `✗ ${nameOf(store)} would not quote: ${quote.body.error ?? quote.status}`);
      return result(quote.body, { isError: true });
    }
    const { checkoutJwt, payee, amount, audience, nonce } = quote.body;
    let proof;
    try {
      proof = await DelegatedIntent.fromWalletPresentation(intent).spend({
        agentKey, checkoutJwt, payment: { payee, amount, instrument: { id: "demo-instrument-0001", type: "card" } }, audience, nonce,
      });
    } catch (err) {
      // spend() refuses only a permission this agent's key cannot spend; the limits are the store's to check.
      log("buy", `✗ the agent can't spend this permission: ${err.message}`);
      return result({ view: "receipt", ok: false, store: quote.body.store, reason: "The agent can't spend this permission with its key", detail: err.message });
    }
    // A refusal is the store's answer, not a tool failure: the card shows it and the model explains it.
    const r = await call(`${store}/agent/purchase`, { proof, nonce });
    log("buy", r.body.ok
      ? `✓ ${r.body.order.store} verified the purchase · ${usd(r.body.order.amount / 100)} (${r.body.order.id})`
      : `✗ ${r.body.store ?? nameOf(store)} refused: ${r.body.reason ?? r.body.detail}`);
    return result({ view: "receipt", ...r.body }, { note: "The person sees the store's answer in a card. Summarize it in one sentence." });
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
// The cards outside a chat, with sample data: /widget?view=offers|permission|receipt|refused.
app.get("/widget", (_req, res) => res.type("html").send(widget.page));
app.get("/preview.json", async (req, res) => res.json(await previewResult(String(req.query.view ?? "offers"))));
app.listen(PORT, () => {
  console.log(`\nap2-multistore agent → MCP at http://localhost:${PORT}/mcp`);
  console.log(`  public key x=${agentKey.publicJwk.x.slice(0, 12)}… (the private half stays in this process)`);
  console.log(`  chat cards preview: http://localhost:${PORT}/widget?view=offers`);
  console.log(`  stores: ${STORES.join("  ")}\n`);
});
