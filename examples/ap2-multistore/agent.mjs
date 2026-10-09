// ap2-multistore/agent.mjs — the AGENT, as an MCP connector for Claude or ChatGPT. A separate process
// from the stores: it imports `/agent` for everything that touches its key, and its key never leaves here.
//
//   STORES=<url>,<url>,<url> node examples/ap2-multistore/agent.mjs   # → http://localhost:4100/mcp
//   (or run up.mjs, which wires the tunnels and starts this for you)
//
// Four tools, the whole story: compare-offers → request-permission → check-permission → buy. The model waits
// for the phone's signature in its own turn (check-permission holds each call, and it calls again while
// pending), so nobody has to type "signed". A fifth tool, watch-permission, belongs to the permission card:
// if the model ended its turn instead of waiting, the card tells the chat once the signature lands.
// The agent holds only PUBLIC data besides its key: the stores' catalogs, the permission the phone
// signed, and the stores' signed carts. The proof it hands a store is checked there, not trusted here.
//
// Three of the tools render a card in the chat (widget/): the offers side by side, the permission with
// a QR code to scan and its live status, and the receipt with what the store checked. Preview the cards
// without a chat at http://localhost:4100/widget?view=offers|permission|receipt|refused.
import express from "express";
import { randomUUID } from "node:crypto";
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
// The signed permissions the agent holds live as long as the process and nothing empties them — fine for a demo;
// a real agent would expire them. The other per-grant maps below are the same.
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

// Grants the MODEL already knows are signed: it saw so itself (check-permission), or the card told the
// chat. The card announces a signature only for a grant not in here — so it announces each one once.
// (Never emptied, like `permissions` above — a demo's shortcut.)
const told = new Set();
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Whether the MODEL is waiting for a grant's signature in its own turn: a check-permission call is open, or
// one (or request-permission) returned less than GRACE_MS ago and the model is about to call again. While it
// waits it will see the signature itself, so the card must stay quiet — a second "go ahead" in the chat
// could send the model to buy twice. Past the grace window, the model has ended its turn: the card speaks.
const GRACE_MS = Number(process.env.AP2_MODEL_GRACE_MS ?? 20_000);
// Both are per grant and never emptied, like `permissions` above — a demo's shortcut.
const openChecks = new Map(); // grantId → check-permission calls in flight
const lastTouch = new Map(); // grantId → when the model last heard "pending" (or got the QR)
const modelIsWaiting = (grantId) => (openChecks.get(grantId) ?? 0) > 0 || Date.now() - (lastTouch.get(grantId) ?? 0) < GRACE_MS;

/** Read a grant at its store, waiting up to `holdMs` for the phone to sign. Once signed, the agent keeps
 *  the signed permission (public data — it spends only with the agent's own key). */
async function awaitSignature(tool, store, grantId, holdMs) {
  const until = Date.now() + holdMs;
  for (;;) {
    const r = await call(`${store}/agent/grants/${encodeURIComponent(grantId)}`);
    if (r.status !== 200) {
      log(tool, `✗ ${nameOf(store)} ${grantId}: ${r.body.error ?? r.status}`);
      return { error: r.body };
    }
    if (r.body.intent) {
      if (!permissions.has(grantId)) log(tool, `${nameOf(store)} ${grantId} signed on the phone (${r.body.trustLevel}) — the agent now holds it`);
      permissions.set(grantId, r.body.intent);
      return { status: r.body.status, trustLevel: r.body.trustLevel };
    }
    if (r.body.status !== "pending") {
      log(tool, `✗ ${nameOf(store)} ${grantId}: ${r.body.status}`);
      return { status: r.body.status };
    }
    if (Date.now() > until) return { status: "pending" };
    await sleep(1500);
  }
}

/** Quote, sign and pay at `store` under a signed permission — the whole purchase, used by `buy` and by a
 *  standing order. `receipt` is the store's answer (verified or refused); `error` means it never got there. */
async function purchase(tool, store, grantId, items) {
  log(tool, `→ ${nameOf(store)}: ${items.map((i) => `${i.quantity ?? 1} × ${i.sku}`).join(", ")}`);
  const intent = permissions.get(grantId);
  if (!intent) {
    log(tool, `✗ no signed permission held for ${grantId}`);
    return { error: { error: "No signed permission held for this grant — call check-permission first." } };
  }
  const quote = await call(`${store}/agent/quote`, { grantId, items });
  if (quote.status !== 200) {
    log(tool, `✗ ${nameOf(store)} would not quote: ${quote.body.error ?? quote.status}`);
    return { error: quote.body };
  }
  const { checkoutJwt, payee, amount, audience, nonce } = quote.body;
  let proof;
  try {
    proof = await DelegatedIntent.fromWalletPresentation(intent).spend({
      agentKey, checkoutJwt, payment: { payee, amount, instrument: { id: "demo-instrument-0001", type: "card" } }, audience, nonce,
    });
  } catch (err) {
    // spend() refuses only a permission this agent's key cannot spend; the limits are the store's to check.
    log(tool, `✗ the agent can't spend this permission: ${err.message}`);
    return { receipt: { view: "receipt", ok: false, store: quote.body.store, reason: "The agent can't spend this permission with its key", detail: err.message } };
  }
  const r = await call(`${store}/agent/purchase`, { proof, nonce });
  log(tool, r.body.ok
    ? `✓ ${r.body.order.store} verified the purchase · ${usd(r.body.order.amount / 100)} (${r.body.order.id})`
    : `✗ ${r.body.store ?? nameOf(store)} refused: ${r.body.reason ?? r.body.detail}`);
  return { receipt: { view: "receipt", ...r.body } };
}

// Scenario 2(b): standing orders — "buy it when the price drops to $X", carried out with the person gone.
// The agent checks the store's price every PRICE_POLL_MS and spends the signed permission once it fits.
const PRICE_POLL_MS = Number(process.env.AP2_PRICE_POLL_MS ?? 3000);
const ORDER_TTL_MS = 30 * 60_000;
const standing = new Map(); // orderId → order; finished orders stay listed and are never emptied, like `permissions` above
const stateOf = (o) => `${o.status}:${o.lastPrice ?? ""}`;
const publicOrder = ({ timer, ...o }) => o;

async function leaveStandingOrder(store, grantId, sku, maxPrice) {
  const order = {
    orderId: `so_${randomUUID().slice(0, 8)}`, store, storeName: nameOf(store), grantId, sku, product: sku,
    maxPrice, status: "watching", lastPrice: null, startedAt: new Date().toISOString(),
  };
  standing.set(order.orderId, order);
  log("buy-when-price-drops", `${order.storeName} · ${sku} at ≤ ${usd(maxPrice)} → watching (${order.orderId})`);
  const tick = async () => {
    if (order.status !== "watching") return;
    if (Date.now() - Date.parse(order.startedAt) > ORDER_TTL_MS) { order.status = "expired"; clearInterval(order.timer); return; }
    let quote;
    try { quote = (await call(`${store}/agent/price/${encodeURIComponent(sku)}`)).body; } catch { return; } // unreachable for a moment: next tick
    if (typeof quote?.price !== "number") return;
    order.product = quote.name; order.lastPrice = quote.price;
    if (quote.price > maxPrice) return;
    order.status = "buying";
    clearInterval(order.timer);
    log("buy-when-price-drops", `${order.storeName} dropped ${quote.name} to ${usd(quote.price)} — buying, with the person away (${order.orderId})`);
    const r = await purchase("buy-when-price-drops", store, grantId, [{ sku }]);
    order.receipt = r.receipt ?? null;
    order.status = r.receipt?.ok ? "bought" : "refused";
    if (!r.receipt?.ok) order.reason = r.receipt?.reason ?? r.error?.error ?? "the purchase did not go through";
  };
  order.timer = setInterval(tick, PRICE_POLL_MS);
  await tick(); // the first look happens now, so the card opens with today's price
  return publicOrder(order);
}

function buildServer() {
  const server = new McpServer({ name: "credentagent-ap2-agent", version: "0.0.0" });
  widget.register(server);

  registerAppTool(server, "compare-offers", {
    title: "Compare offers",
    description:
      "Read every store's catalog (price + rating per product). Pass `product` when the person names one, to see which stores sell it. " +
      "Use it first, then pick the store with the best price-to-rating balance for what the person wants, and say why.",
    inputSchema: {
      product: z.string().optional().describe("a product id or words from its name, e.g. \"cold brew\" — omit to read whole catalogs"),
      maxPrice: z.number().positive().optional().describe("the most the person will pay for one, in USD, when they gave a limit"),
    },
    annotations: { readOnlyHint: true },
    _meta: widget.meta("Reading the stores…", "Compared the stores"),
  }, async ({ product, maxPrice }) => {
    let stores = await Promise.all(STORES.map(async (url) => {
      try { return { url, ...(await call(`${url}/agent/catalog`)).body }; } catch (err) { return { url, error: err.message }; }
    }));
    for (const s of stores) if (s.store) names.set(s.url, s.store);
    const down = stores.filter((s) => !s.store).map((s) => s.url);
    // A named product narrows every catalog to it. A store that does not sell it keeps its column, empty —
    // "only one store sells this" is something the person should see, not infer.
    const wanted = product?.trim().toLowerCase();
    const matches = (p) => p.id === wanted || p.name.toLowerCase().includes(wanted);
    if (wanted) stores = stores.map((s) => (s.products ? { ...s, products: s.products.filter(matches) } : s));
    const sellers = stores.filter((s) => s.products?.length).map((s) => s.store);
    // Scenario 2(a): with a limit, say which offers fit it — and, when none does, what the cheapest costs.
    const offers = stores.flatMap((s) => (s.products ?? []).map((p) => ({ store: s.store, price: p.price })));
    const cheapest = offers.reduce((a, b) => (b.price < (a?.price ?? Infinity) ? b : a), undefined);
    const within = maxPrice === undefined ? undefined : [...new Set(offers.filter((o) => o.price <= maxPrice).map((o) => o.store))];
    const summary = wanted ? { product, sellers, ...(maxPrice !== undefined ? { maxPrice, within, cheapest } : {}) } : undefined;
    log("compare-offers", `read ${stores.length - down.length} of ${stores.length} stores${wanted ? ` — "${product}" sold by ${sellers.length ? sellers.join(", ") : "none"}` : ""}${within ? `, ${within.length} within $${maxPrice}` : ""}${down.length ? ` — unreachable: ${down.join(", ")}` : ""}`);
    const note =
      wanted && sellers.length === 0 ? `No store sells "${product}". Say so; don't request a permission.`
      : within && within.length === 0
        ? `No offer is within the person's maximum of ${usd(maxPrice)}: the cheapest is ${usd(cheapest.price)} at ${cheapest.store}. Don't request a permission ` +
          "and don't buy now. Tell them that, and offer two options: a higher limit (a new permission they sign on their phone), or " +
          "buying it automatically once the price drops to their limit (request-permission with waitForPrice: true, then buy-when-price-drops)."
      : wanted && sellers.length === 1 ? `Only ${sellers[0]} sells it — no comparison to make. Say so in a sentence, then request the permission there.`
      : "The person sees these offers side by side in a card. Don't re-list them; say which store you pick and why, in a sentence or two.";
    return result({ view: "offers", stores, ...(summary ? { summary } : {}) }, { note });
  });

  registerAppTool(server, "request-permission", {
    title: "Request a spending permission",
    description:
      "Ask the person for a spending permission at ONE store, naming exact products and limits. The person sees a card with a QR code: " +
      "they scan it with their phone and SIGN the permission with their wallet. Nothing can be bought until they do. Then, in the same turn, " +
      "call check-permission — it waits for the signature — and buy as soon as it says authorized.",
    inputSchema: {
      store: storeUrl,
      skus: z.array(z.string()).min(1).describe("product ids the permission covers"),
      budget: z.number().positive().describe("total budget in USD"),
      perSpend: z.number().positive().describe("max per purchase in USD"),
      description: z.string().describe("one plain sentence the person will see before signing"),
      why: z.string().describe("one sentence: why this store won the comparison (shown to the person)"),
      waitForPrice: z.boolean().optional().describe("true when the person asked to buy once the price drops to their limit (then call buy-when-price-drops)"),
    },
    _meta: widget.meta("Preparing the permission…", "Waiting for your signature"),
  }, async ({ store, skus, budget, perSpend, description, why, waitForPrice }) => {
    const r = await call(`${store}/agent/grants`, { agentKey: agentKey.publicJwk, skus, budget, perSpend, description, waitForPrice });
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
    lastTouch.set(r.body.grantId, Date.now()); // the model has the QR and is about to wait for the signature
    return result(data, {
      note:
        "The person sees a card with a QR code for approveUrl. In one short sentence, ask them to scan it with their phone and sign " +
        "(give them the link too). Then, WITHOUT ending your turn, call check-permission right away: it waits up to 45 s for the " +
        "signature. While it says pending, call it again. When it says authorized, call buy. Don't ask the person to confirm they signed.",
      widgetOnly: { "ap2/qr": await qrDataUrl(r.body.approveUrl) },
    });
  });

  server.registerTool("check-permission", {
    title: "Check the permission",
    description:
      "Wait (up to ~45 s per call) for the person to sign the permission on their phone. Call it right after request-permission, and " +
      "again while it says pending — in the same turn. When it says authorized, the agent holds the permission: call buy.",
    inputSchema: z.object({ store: storeUrl, grantId: z.string() }),
    annotations: { readOnlyHint: true },
  }, async ({ store, grantId }) => {
    openChecks.set(grantId, (openChecks.get(grantId) ?? 0) + 1);
    let r;
    try {
      r = await awaitSignature("check-permission", store, grantId, 45_000);
      if (r.status === "authorized") told.add(grantId); // the model knows now — the card must not announce it
    } finally {
      openChecks.set(grantId, openChecks.get(grantId) - 1);
      lastTouch.set(grantId, Date.now()); // a model that hears "pending" calls again within the grace window
    }
    if (r.error) return result(r.error, { isError: true });
    if (r.status !== "authorized") {
      return result({ status: r.status }, {
        note: r.status === "pending"
          ? "Not signed yet — the person is signing on their phone. Call check-permission again now; don't end your turn."
          : "Not authorized.",
      });
    }
    return result({ status: r.status, trustLevel: r.trustLevel }, { note: "Signed on the phone. The agent now holds this permission: call buy now." });
  });

  // The permission card's own watch. Visibility "app": the card calls it, the model never sees it. It waits
  // like check-permission and decides `announce` — the FALLBACK for a model that ended its turn instead of
  // waiting. Once signed: if the model already knows, nothing to say (final). If the model is still waiting
  // in its turn, it will see the signature itself, so stay quiet; the answer is not final yet, and the card
  // asks again. Otherwise announce, exactly ONCE per grant, so a redrawn, reloaded or duplicated card never
  // posts it twice and a second "go ahead" never sends the model to buy twice.
  server.registerTool("watch-permission", {
    title: "Watch the permission (card only)",
    description: "Used by the permission card to follow the phone signature. The model uses check-permission instead.",
    inputSchema: z.object({ store: storeUrl, grantId: z.string() }),
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  }, async ({ store, grantId }) => {
    const r = await awaitSignature("watch-permission", store, grantId, 25_000);
    if (r.error) return result(r.error, { isError: true });
    const signed = { status: r.status, ...(r.trustLevel ? { trustLevel: r.trustLevel } : {}) };
    if (r.status !== "authorized") return result({ ...signed, announce: false, final: r.status !== "pending" });
    const until = Date.now() + 20_000;
    while (!told.has(grantId) && modelIsWaiting(grantId) && Date.now() < until) await sleep(500);
    if (told.has(grantId)) return result({ ...signed, announce: false, final: true });
    if (modelIsWaiting(grantId)) return result({ ...signed, announce: false, final: false });
    told.add(grantId);
    log("watch-permission", `${nameOf(store)} ${grantId} → the model stopped waiting; the card tells the chat it is signed`);
    return result({ ...signed, announce: true, final: true });
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
    const p = await purchase("buy", store, grantId, items);
    if (p.error) return result(p.error, { isError: true });
    // A refusal is the store's answer, not a tool failure: the card shows it and the model explains it.
    return result(p.receipt, { note: "The person sees the store's answer in a card. Summarize it in one sentence." });
  });

  // Scenario 2(b): buy later, when the price drops — with the person gone. The agent watches the store's price
  // and spends the permission the person already signed (made with `waitForPrice`) the moment it fits.
  registerAppTool(server, "buy-when-price-drops", {
    title: "Buy when the price drops",
    description:
      "Leave a standing order: the agent watches the store's price and buys under the signed permission as soon as the price is at or " +
      "below maxPrice, without the person. The permission must already be signed (request-permission with waitForPrice: true, then " +
      "check-permission). Returns at once; ask standing-orders later to see whether it bought.",
    inputSchema: {
      store: storeUrl,
      grantId: z.string(),
      sku: z.string().describe("the product id to buy, one unit"),
      maxPrice: z.number().positive().describe("buy once the price is at or below this, in USD — the permission's per-purchase limit"),
    },
    _meta: widget.meta("Leaving the order…", "Watching the price"),
  }, async ({ store, grantId, sku, maxPrice }) => {
    if (!permissions.has(grantId)) return result({ error: "No signed permission held for this grant — call check-permission first." }, { isError: true });
    const order = await leaveStandingOrder(store, grantId, sku, maxPrice);
    return result({ view: "standing-order", ...order }, {
      note: `The agent is watching ${order.storeName}'s price for ${order.product} and will buy it once it is ${usd(maxPrice)} or less, ` +
        "without the person. Tell them that in one sentence; they can leave. They can ask later whether it bought.",
    });
  });

  server.registerTool("standing-orders", {
    title: "Standing orders",
    description: "List the agent's standing orders (buy when the price drops) and whether each one bought yet.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true },
  }, async () => result({ orders: [...standing.values()].map(publicOrder) }));

  // The standing-order card's own watch (visibility "app"): holds up to ~25 s for the order to change.
  server.registerTool("watch-standing-order", {
    title: "Watch a standing order (card only)",
    description: "Used by the standing-order card to follow the order. The model uses standing-orders instead.",
    inputSchema: z.object({ orderId: z.string(), seen: z.string().optional() }),
    annotations: { readOnlyHint: true },
    _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
  }, async ({ orderId, seen }) => {
    const until = Date.now() + 25_000;
    let o = standing.get(orderId);
    while (o && stateOf(o) === seen && Date.now() < until) { await sleep(500); o = standing.get(orderId); }
    return o ? result(publicOrder(o)) : result({ error: "no such order" }, { isError: true });
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
