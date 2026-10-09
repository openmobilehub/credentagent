// ap2-multistore/agent.mjs — the AGENT, as an MCP connector for Claude or ChatGPT. A separate process
// from the stores: it imports `/agent` for everything that touches its key, and its key never leaves here.
//
//   STORES=<url>,<url>,<url> node examples/ap2-multistore/agent.mjs   # → http://localhost:4100/mcp
//   (or run up.mjs, which wires the tunnels and starts this for you)
//
// Four tools, the whole story: compare-offers → request-permission → check-permission → buy. The model waits
// for the phone's signature in its own turn (check-permission holds each call, and it calls again while
// pending), so nobody has to type "signed". The card kit adds a fifth, credentagent-permission-status, which
// belongs to the permission card: if the model ended its turn instead of waiting, the card tells the chat
// once the signature lands.
// The agent holds only PUBLIC data besides its key: the stores' catalogs, the permission the phone
// signed, and the stores' signed carts. The proof it hands a store is checked there, not trusted here.
//
// Three of the tools render a card in the chat, and the cards come from the SDK's card kit
// (`@openmobilehub/credentagent-gate/cards`): the offers side by side, the permission with a QR code to
// scan and its live status, and the receipt with what the store checked. Preview the cards without a chat
// at http://localhost:4100/widget?view=offers|only-one|over-limit|permission|permission-signed|receipt|refused.
import express from "express";
import { z } from "zod";
import { McpServer, createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
import { AgentKey, DelegatedIntent } from "@openmobilehub/credentagent-gate/agent";
import { createCards } from "@openmobilehub/credentagent-gate/cards";

const PORT = Number(process.env.BASE_PORT ?? 4100);
const STORES = (process.env.STORES ?? [1, 2, 3].map((n) => `http://localhost:${PORT + n}`).join(",")).split(",").map((s) => s.trim().replace(/\/$/, ""));

// A real agent loads a stored key: AgentKey.fromJwk(JSON.parse(process.env.AGENT_KEY)).
const agentKey = process.env.AGENT_KEY ? AgentKey.fromJwk(JSON.parse(process.env.AGENT_KEY)) : AgentKey.generate();
const permissions = new Map(); // grantId → the signed permission (plain JSON from the phone)
const trusts = new Map(); // grantId → what the store said its purchases are verified at — never defaulted here

const call = async (url, body) => {
  const res = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

// The chat cards come from the SDK's card kit: the offers, the permission with its QR code and live
// status, and the receipt. The kit reads a permission's status from the store that issued it.
const cards = createCards({
  readPermission: async ({ grantId, store }) => {
    const r = await call(`${store.url}/agent/grants/${encodeURIComponent(grantId)}`);
    if (r.status !== 200) throw new Error(r.body.error ?? `HTTP ${r.status}`);
    return r.body; // { status, trustLevel, intent? } — the signed intent comes back from waitForSignature
  },
  modelGraceMs: Number(process.env.AP2_MODEL_GRACE_MS ?? 20_000),
});

// `note` is what the model reads first; `data` is what it is about.
const result = (data, { note, isError } = {}) => ({
  content: [{ type: "text", text: `${note ? `${note}\n\n` : ""}${JSON.stringify(data, null, 2)}` }],
  structuredContent: data,
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
  cards.register(server);

  server.registerTool("compare-offers", {
    title: "Compare offers",
    description:
      "Read every store's catalog (price + rating per product). Pass `product` when the person names one, to see which stores sell it. " +
      "Use it first, then pick the store with the best price-to-rating balance for what the person wants, and say why.",
    inputSchema: z.object({
      product: z.string().optional().describe("a product id or words from its name, e.g. \"cold brew\" — omit to read whole catalogs"),
      maxPrice: z.number().positive().optional().describe("the most the person will pay for one, in USD, when they gave a limit"),
    }),
    annotations: { readOnlyHint: true },
    _meta: cards.toolMeta({ invoking: "Reading the stores…", invoked: "Compared the stores" }),
  }, async ({ product, maxPrice }) => {
    const stores = await Promise.all(STORES.map(async (url) => {
      try { return { url, ...(await call(`${url}/agent/catalog`)).body }; } catch (err) { return { url, error: err.message }; }
    }));
    for (const s of stores) if (s.store) names.set(s.url, s.store);
    const down = stores.filter((s) => !s.store).map((s) => s.url);
    // The kit narrows every catalog to the named product (a store that does not sell it keeps its column,
    // empty), says which stores sell it and which offers fit the person's limit, and writes the note.
    const card = cards.offers({ stores, product, maxPrice });
    const { summary } = card.structuredContent;
    log("compare-offers", `read ${stores.length - down.length} of ${stores.length} stores${summary?.product ? ` — "${summary.product}" sold by ${summary.sellers.length ? summary.sellers.join(", ") : "none"}` : ""}${summary?.within ? `, ${summary.within.length} within $${summary.maxPrice}` : ""}${down.length ? ` — unreachable: ${down.join(", ")}` : ""}`);
    return card;
  });

  server.registerTool("request-permission", {
    title: "Request a spending permission",
    description:
      "Ask the person for a spending permission at ONE store, naming exact products and limits. The person sees a card with a QR code: " +
      "they scan it with their phone and SIGN the permission with their wallet. Nothing can be bought until they do. Then, in the same turn, " +
      "call check-permission — it waits for the signature — and buy as soon as it says authorized.",
    inputSchema: z.object({
      store: storeUrl,
      skus: z.array(z.string()).min(1).describe("product ids the permission covers"),
      budget: z.number().positive().describe("total budget in USD"),
      perSpend: z.number().positive().describe("max per purchase in USD"),
      description: z.string().describe("one plain sentence the person will see before signing"),
      why: z.string().describe("one sentence: why this store won the comparison (shown to the person)"),
    }),
    _meta: cards.toolMeta({ invoking: "Preparing the permission…", invoked: "Waiting for your signature" }),
  }, async ({ store, skus, budget, perSpend, description, why }) => {
    const r = await call(`${store}/agent/grants`, { agentKey: agentKey.publicJwk, skus, budget, perSpend, description });
    if (r.status !== 200) {
      log("request-permission", `✗ ${nameOf(store)}: ${r.body.error ?? r.status}`);
      return result(r.body, { isError: true });
    }
    names.set(store, r.body.store);
    trusts.set(r.body.grantId, r.body.trustLevel);
    log("request-permission", `${r.body.store} · ${r.body.products.join(", ")} · ${usd(perSpend)} a purchase · ${usd(budget)} total → waiting for the phone (${r.body.grantId})`);
    return cards.permission(
      {
        grantId: r.body.grantId, store: { name: r.body.store, url: store, merchantId: r.body.merchantId },
        approveUrl: r.body.approveUrl, products: r.body.products, limits: { perPurchase: perSpend, total: budget },
        why, trustLevel: r.body.trustLevel,
      },
      {
        note:
          "The person sees a card with a QR code for approveUrl. In one short sentence, ask them to scan it with their phone and sign " +
          "(give them the link too). Then, WITHOUT ending your turn, call check-permission right away: it waits up to 45 s for the " +
          "signature. While it says pending, call it again. When it says authorized, call buy. Don't ask the person to confirm they signed.",
      },
    );
  });

  server.registerTool("check-permission", {
    title: "Check the permission",
    description:
      "Wait (up to ~45 s per call) for the person to sign the permission on their phone. Call it right after request-permission, and " +
      "again while it says pending — in the same turn. When it says authorized, the agent holds the permission: call buy.",
    inputSchema: z.object({ store: storeUrl, grantId: z.string() }),
    annotations: { readOnlyHint: true },
  }, async ({ store, grantId }) => {
    let r;
    try {
      r = await cards.waitForSignature(grantId); // holds up to 45 s, and tells the card the model is waiting
    } catch (err) {
      log("check-permission", `✗ ${nameOf(store)} ${grantId}: ${err.message}`);
      return result({ error: err.message }, { isError: true });
    }
    if (r.status === "unknown") return result({ error: "Unknown permission — call request-permission first." }, { isError: true });
    if (r.status === "authorized") {
      // The signed permission is public data the agent can carry — it spends only with its own key.
      if (!permissions.has(grantId)) log("check-permission", `${nameOf(store)} ${grantId} signed on the phone (${r.trustLevel}) — the agent now holds it`);
      permissions.set(grantId, r.intent);
      return result({ status: r.status, trustLevel: r.trustLevel }, { note: "Signed on the phone. The agent now holds this permission: call buy now." });
    }
    if (r.status !== "pending") log("check-permission", `✗ ${nameOf(store)} ${grantId}: ${r.status}`);
    return result({ status: r.status }, {
      note: r.status === "pending"
        ? "Not signed yet — the person is signing on their phone. Call check-permission again now; don't end your turn."
        : "Not authorized.",
    });
  });

  server.registerTool("buy", {
    title: "Buy",
    description: "Buy at the store under a signed permission. The store quotes and signs the cart, the agent signs the purchase with its own key, the store verifies everything and answers.",
    inputSchema: z.object({
      store: storeUrl,
      grantId: z.string(),
      items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive().optional() })).min(1),
    }),
    _meta: cards.toolMeta({ invoking: "Paying…", invoked: "The store answered" }),
  }, async ({ store, grantId, items }) => {
    log("buy", `→ ${nameOf(store)}: ${items.map((i) => `${i.quantity ?? 1} × ${i.sku}`).join(", ")}`);
    const intent = permissions.get(grantId);
    const trustLevel = trusts.get(grantId);
    if (!intent || !trustLevel) {
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
      return cards.receipt({ ok: false, store: quote.body.store, code: "agent-key", reason: "The agent can't spend this permission with its key", detail: err.message, trustLevel });
    }
    // A refusal is the store's answer, not a tool failure: the card shows it and the model explains it.
    const r = await call(`${store}/agent/purchase`, { proof, nonce });
    log("buy", r.body.ok
      ? `✓ ${r.body.order.store} verified the purchase · ${usd(r.body.order.total)} (${r.body.order.id})`
      : `✗ ${r.body.store ?? nameOf(store)} refused: ${r.body.reason ?? r.body.detail}`);
    return cards.receipt(r.body, { note: "The person sees the store's answer in a card. Summarize it in one sentence." });
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
// The cards outside a chat, with sample data: /widget?view=offers|only-one|over-limit|permission|permission-signed|receipt|refused.
app.get("/widget", (_req, res) => res.type("html").send(cards.html));
app.listen(PORT, () => {
  console.log(`\nap2-multistore agent → MCP at http://localhost:${PORT}/mcp`);
  console.log(`  public key x=${agentKey.publicJwk.x.slice(0, 12)}… (the private half stays in this process)`);
  console.log(`  chat cards preview: http://localhost:${PORT}/widget?view=offers`);
  console.log(`  stores: ${STORES.join("  ")}\n`);
});
