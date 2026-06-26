// createStorefront() — a runnable storefront in one line.
//
// Stands up the real MCP storefront — the nine shopping tools (six UI-linked to the
// React widget, three plain) + the single-file widget resource + a checkout page —
// over HTTP at /mcp, around an injected catalog. The checkout tool is UNGATED by
// default; call `store.gate(resolve)` to have it surface a `requires` manifest,
// which is exactly where @openmobilehub/attesto-gate mounts on:
//
//   const store = createStorefront();
//   const attesto = new Attesto();
//   attesto.mount(store.app);
//   store.gate((order) => attesto.requirements(order, [ required(age.over(21).when(hasAlcohol)) ]));
//   const { url } = await store.listen(3005);   // → add http://localhost:3005/mcp to Claude / ChatGPT

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  CART_META_KEY,
  CATALOG_META_KEY,
  createOrder,
  getProduct,
  getReviews,
  priceCart,
  SAMPLE_CATALOG,
} from "./index.js";
import type { CartItemInput, Order, PricedCart, Product, Review } from "./index.js";
import { appToolMeta } from "./tool-meta.js";
import { MemoryCartStore, MemoryOrderStore } from "./state.js";
import type { CartStore, OrderStore } from "./state.js";

/** Given a priced order, return the `requires` manifest (or `undefined` = ungated). */
export type GateResolver = (order: Order) => unknown[] | undefined;

export interface StorefrontOptions {
  /** Products to sell. Defaults to the package's `SAMPLE_CATALOG`. */
  catalog?: Product[];
  /** Reviews per product id, backing `get-product-reviews`. */
  reviews?: Record<string, Review[]>;
  /** Origin the checkout links resolve from. Default `http://localhost:<port>`. */
  baseUrl?: string;
  /** Cart store; default in-memory. */
  cartStore?: CartStore;
  /** Completed-order store (read by `get-order-status`); default in-memory. */
  orderStore?: OrderStore<CompletedOrderRecord>;
}

/** A completed-order record `get-order-status` reports (the demo's ceremony writes a richer one). */
export interface CompletedOrderRecord {
  orderId: string;
  total: number;
  currency: string;
  completedAt: string;
}

export interface Storefront {
  app: Express;
  catalog: Product[];
  gate(resolve: GateResolver): void;
  listen(port?: number): Promise<{ url: string; port: number }>;
  mcpServer(): McpServer;
}

// ── widget bundle (single-file html, built by vite into dist/ui/) ───────────

const SKYBRIDGE_MIME = "text/html+skybridge";
const IMAGE_DOMAINS = ["https://picsum.photos", "https://fastly.picsum.photos"];

function bundleCandidates(): string[] {
  return [join(import.meta.dirname, "ui", "mcp-app.html"), join(process.cwd(), "dist", "ui", "mcp-app.html")];
}

// Stamp the resource URI with a short hash of the bundle so hosts re-fetch exactly
// when the widget changes (they cache by URI). "dev" until the bundle is on disk.
function bundleVersion(): string {
  for (const c of bundleCandidates()) {
    try {
      return createHash("sha256").update(readFileSync(c)).digest("hex").slice(0, 8);
    } catch {
      /* try next */
    }
  }
  return "dev";
}

async function loadBundle(): Promise<string> {
  for (const c of bundleCandidates()) {
    try {
      return await readFile(c, "utf-8");
    } catch {
      /* try next */
    }
  }
  throw new Error(`attesto-storefront: widget bundle not found (looked in: ${bundleCandidates().join(", ")})`);
}

export function createStorefront(opts: StorefrontOptions = {}): Storefront {
  const catalog = opts.catalog ?? SAMPLE_CATALOG;
  const reviews = opts.reviews;
  const cartStore: CartStore = opts.cartStore ?? new MemoryCartStore();
  const orderStore: OrderStore<CompletedOrderRecord> = opts.orderStore ?? new MemoryOrderStore<CompletedOrderRecord>();
  const createdOrders = new Map<string, Order>(); // created-but-not-completed, for the checkout page
  let resolveGate: GateResolver | undefined;
  let baseUrl = opts.baseUrl?.replace(/\/+$/, "") ?? "";
  let seq = 0;

  const BUNDLE_VERSION = bundleVersion();
  const RESOURCE_URI = `ui://product-picker/mcp-app-${BUNDLE_VERSION}.html`;
  const SKYBRIDGE_URI = `ui://product-picker/mcp-app-${BUNDLE_VERSION}.skybridge.html`;
  // One canonical tool-meta for every UI-linked tool — both host surfaces, with
  // openai/widgetAccessible always on (FR-014).
  const UI_META = appToolMeta({ resourceUri: RESOURCE_URI, skybridgeUri: SKYBRIDGE_URI });

  const app = createMcpExpressApp({ host: "0.0.0.0" });

  // ── cart logic (closure over the injected catalog + the cart store) ───────
  const priceFrom = (cart: Map<string, number>): PricedCart =>
    priceCart([...cart.entries()].map(([productId, quantity]) => ({ productId, quantity })), catalog);
  const readPriced = async (): Promise<PricedCart> => priceFrom(await cartStore.read());
  const addToCart = async (items: CartItemInput[]): Promise<PricedCart> => {
    const cart = await cartStore.read();
    for (const { productId, quantity } of items) {
      if (quantity <= 0) continue;
      cart.set(productId, (cart.get(productId) ?? 0) + quantity);
    }
    await cartStore.write(cart);
    return priceFrom(cart);
  };
  const setQuantity = async (productId: string, quantity: number): Promise<PricedCart> => {
    const cart = await cartStore.read();
    if (quantity <= 0) cart.delete(productId);
    else cart.set(productId, quantity);
    await cartStore.write(cart);
    return priceFrom(cart);
  };
  const removeFromCart = async (productId: string): Promise<PricedCart> => {
    const cart = await cartStore.read();
    cart.delete(productId);
    await cartStore.write(cart);
    return priceFrom(cart);
  };
  // Cart-bearing result, emitted three ways so either host reads it: structuredContent
  // (ChatGPT widget + model), a JSON text block, and _meta (Claude's out-of-band channel).
  const cartResult = (priced: PricedCart): CallToolResult => ({
    structuredContent: { products: catalog, cart: priced } as unknown as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(priced) }],
    _meta: { [CART_META_KEY]: priced },
  });

  function buildServer(): McpServer {
    const server = new McpServer({ name: "attesto-storefront", version: "0.1.0" });

    // ── UI-linked tools (6) — registerAppTool + the canonical UI_META ───────
    registerAppTool(
      server,
      "browse-products",
      { title: "Browse Products", description: "Open an interactive product picker to browse and add products.", inputSchema: {}, annotations: { readOnlyHint: true }, _meta: UI_META },
      async (): Promise<CallToolResult> => {
        const priced = await readPriced();
        return {
          content: [{ type: "text", text: `Opened the product picker (${catalog.length} products). Add items by id with add-to-cart / set-quantity / remove-from-cart; read it with get-cart; check out with checkout.` }],
          structuredContent: { products: catalog, cart: priced },
          _meta: { [CATALOG_META_KEY]: { products: catalog }, [CART_META_KEY]: priced },
        };
      },
    );
    registerAppTool(
      server,
      "add-to-cart",
      { title: "Add to Cart", description: "Add products to the cart by id (quantities add on top).", inputSchema: { items: z.array(z.object({ productId: z.string(), quantity: z.number().int().min(1) })) }, annotations: { readOnlyHint: false }, _meta: UI_META },
      async ({ items }): Promise<CallToolResult> => cartResult(await addToCart(items)),
    );
    registerAppTool(
      server,
      "set-quantity",
      { title: "Set Quantity", description: "Set the exact quantity of a product by id (0 removes).", inputSchema: { productId: z.string(), quantity: z.number().int().min(0) }, annotations: { readOnlyHint: false }, _meta: UI_META },
      async ({ productId, quantity }): Promise<CallToolResult> => cartResult(await setQuantity(productId, quantity)),
    );
    registerAppTool(
      server,
      "remove-from-cart",
      { title: "Remove from Cart", description: "Remove a product from the cart by id.", inputSchema: { productId: z.string() }, annotations: { readOnlyHint: false }, _meta: UI_META },
      async ({ productId }): Promise<CallToolResult> => cartResult(await removeFromCart(productId)),
    );
    registerAppTool(
      server,
      "get-cart",
      { title: "Get Cart", description: "Return the current cart: line items, quantities, total.", inputSchema: {}, annotations: { readOnlyHint: true }, _meta: UI_META },
      async (): Promise<CallToolResult> => cartResult(await readPriced()),
    );
    registerAppTool(
      server,
      "checkout",
      { title: "Checkout", description: "Snapshot the cart into an order and return a checkout link; if gated, also a `requires` manifest of what the buyer must prove on the page.", inputSchema: { items: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive() })).optional() }, annotations: { readOnlyHint: false }, _meta: UI_META },
      async ({ items }): Promise<CallToolResult> => {
        const entries = items?.length ? items : [...(await cartStore.read()).entries()].map(([productId, quantity]) => ({ productId, quantity }));
        if (entries.length === 0) return { content: [{ type: "text", text: "The cart is empty — add items before checking out." }], isError: true };
        const order = createOrder(entries, `ORD-${++seq}`, catalog);
        createdOrders.set(order.id, order);
        const checkoutUrl = `${baseUrl}/checkout?order=${order.id}`;
        const requires = resolveGate?.(order); // ← where Attesto mounts on
        const priced = priceFrom(new Map(entries.map((e) => [e.productId, e.quantity])));
        // Cart-bearing structuredContent (FR-014): a fresh ChatGPT widget instance
        // hydrates the real cart instead of an empty one.
        const payload = { orderId: order.id, checkoutUrl, ...(requires?.length ? { requires } : {}), products: catalog, cart: priced };
        return { structuredContent: payload, content: [{ type: "text", text: JSON.stringify({ orderId: order.id, checkoutUrl, requires: requires ?? [] }) }], _meta: { [CART_META_KEY]: priced } };
      },
    );

    // ── plain tools (3) — registerTool, no widget ───────────────────────────
    server.registerTool(
      "get-product-details",
      { title: "Get Product Details", description: "Return full details for a single product by id.", inputSchema: { productId: z.string() }, annotations: { readOnlyHint: true } },
      async ({ productId }): Promise<CallToolResult> => {
        const product = getProduct(catalog, productId);
        return product
          ? { content: [{ type: "text", text: JSON.stringify(product) }], structuredContent: { product } }
          : { content: [{ type: "text", text: `No product found with id "${productId}".` }], isError: true };
      },
    );
    server.registerTool(
      "get-product-reviews",
      { title: "Get Product Reviews", description: "Return customer reviews for a single product by id.", inputSchema: { productId: z.string() }, annotations: { readOnlyHint: true } },
      async ({ productId }): Promise<CallToolResult> => {
        const r = getReviews(reviews, productId);
        return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: { reviews: r } };
      },
    );
    server.registerTool(
      "get-order-status",
      { title: "Get Order Status", description: "Read-only status of a completed purchase (the buyer completes checkout on the page; this only reports).", inputSchema: { orderId: z.string() }, annotations: { readOnlyHint: true } },
      async ({ orderId }): Promise<CallToolResult> => {
        const order = await orderStore.read(orderId);
        if (!order) return { content: [{ type: "text", text: `Order ${orderId}: pending — the buyer hasn't finished on the checkout page yet.` }], structuredContent: { orderId, status: "pending" } };
        return { content: [{ type: "text", text: JSON.stringify(order) }], structuredContent: { orderId, status: "completed", order } };
      },
    );

    // ── widget resource — two registrations from one bundle ─────────────────
    // Claude / MCP-Apps hosts read RESOURCE_URI; ChatGPT reads the skybridge URI.
    // `data:` in the CSP so the widget's inline SVG image placeholder renders (FR-014).
    registerAppResource(
      server,
      RESOURCE_URI,
      RESOURCE_URI,
      { mimeType: RESOURCE_MIME_TYPE },
      async (): Promise<ReadResourceResult> => ({
        contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: await loadBundle(), _meta: { ui: { csp: { resourceDomains: [...IMAGE_DOMAINS, "data:"], connectDomains: baseUrl ? [baseUrl] : [] } } } }],
      }),
    );
    server.registerResource(
      "product-picker-skybridge",
      SKYBRIDGE_URI,
      { mimeType: SKYBRIDGE_MIME },
      async (): Promise<ReadResourceResult> => ({
        contents: [{ uri: SKYBRIDGE_URI, mimeType: SKYBRIDGE_MIME, text: await loadBundle(), _meta: { "openai/widgetCSP": { connect_domains: baseUrl ? [baseUrl] : [], resource_domains: [...IMAGE_DOMAINS, "data:"] } } }],
      }),
    );

    return server;
  }

  // MCP over streamable HTTP (stateless per request), mirroring the reference server.
  app.all("/mcp", async (req: Request, res: Response) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "error" }, id: null });
    }
  });

  // Minimal checkout page: render the order + what's required, link to the ceremony
  // routes attesto.mount() / the demo provides (this page does NOT run the ceremony).
  app.get("/checkout", (req: Request, res: Response) => {
    const order = createdOrders.get(String(req.query.order ?? ""));
    if (!order) return res.status(404).type("html").send("<h1>Unknown order</h1>");
    const requires = (resolveGate?.(order) ?? []) as Array<{ label?: string; credential?: string; approveUrl?: string }>;
    const reqList = requires.length
      ? `<ul>${requires.map((r) => `<li>${r.approveUrl ? `<a href="${r.approveUrl}">${r.label ?? r.credential}</a>` : (r.label ?? r.credential)}</li>`).join("")}</ul>`
      : "<p>No verification required.</p>";
    res.type("html").send(
      `<!doctype html><meta charset="utf-8"><title>Checkout ${order.id}</title>` +
      `<body style="font-family:system-ui;max-width:32rem;margin:3rem auto">` +
      `<h1>Checkout — ${order.id}</h1>` +
      `<p>${order.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ")} — <b>${order.total} ${order.currency}</b></p>` +
      `<h3>Required to complete</h3>${reqList}` +
      `<form method="post" action="/checkout/place-order"><input type="hidden" name="order" value="${order.id}">` +
      `<button style="padding:.6rem 1rem">Complete purchase (demo)</button></form>` +
      `<p style="color:#888;font-size:.85rem">Demo completion — real fail-closed verification is provided by ` +
      `<code>attesto.mount()</code> + the reference demo's caBLE ceremony.</p></body>`,
    );
  });
  app.post("/checkout/place-order", async (req: Request, res: Response) => {
    const order = createdOrders.get(String(req.body?.order ?? ""));
    if (order) await orderStore.write(order.id, { orderId: order.id, total: order.total, currency: order.currency, completedAt: new Date().toISOString() });
    res.type("html").send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:32rem;margin:3rem auto"><h1>✓ Order placed (demo)</h1><p>You can close this tab.</p></body>`);
  });

  return {
    app,
    catalog,
    mcpServer: buildServer,
    gate(resolve: GateResolver) { resolveGate = resolve; },
    async listen(port = 3005): Promise<{ url: string; port: number }> {
      if (!baseUrl) baseUrl = `http://localhost:${port}`;
      await new Promise<void>((resolve) => { app.listen(port, () => resolve()); });
      return { url: `${baseUrl}/mcp`, port };
    },
  };
}
