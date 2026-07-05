// createStorefront() — a runnable storefront in one line.
//
// Stands up the real MCP storefront — the nine shopping tools (six UI-linked to the
// React widget, three plain) + the single-file widget resource + a checkout page —
// over HTTP at /mcp, around an injected catalog. The checkout tool is UNGATED by
// default; call `store.gate(resolve)` to have it surface a `requires` manifest,
// which is exactly where @openmobilehub/attestomcp-gate mounts on:
//
//   const store = createStorefront();
//   const attestomcp = new AttestoMCP();
//   attestomcp.mount(store.app);
//   store.gate((order) => attestomcp.requirements(order, [ required(age.over(21).when(hasAlcohol)) ]));
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
import express from "express";
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
// Re-export the store contracts so a consumer can type an explicit store (the escape
// hatch) or a custom `StorageProvider` without reaching into an internal module.
export type { CartStore, OrderStore } from "./state.js";
// Composition with @openmobilehub/attestomcp-gate (Context 2): the storefront pre-binds
// the gate's shared `completeOrder` over ITS OWN stores + catalog and publishes the
// ceremony seams on `app.locals.attestomcp`, so `new AttestoMCP().mount(store.app)` wires
// the `/attestomcp/*` rails with zero explicit args (the quickstart). The gate stays an
// optional pairing — only this server module imports it; the pure pricing core
// (`./index.js`) does not.
import {
  completeOrder,
  renderRequirements,
  MemoryVerificationStore,
  type CartItemRef,
  type CeremonyCatalog,
  type CeremonyOrder,
  type CeremonyOrderStore,
  type CompletedRecord,
  type CompletionInput,
  type CompletionResult,
  type RepriceOpts,
  type RenderVerification,
  type VerificationManifestEntry,
  type VerificationRecord,
  type VerificationStore,
} from "@openmobilehub/attestomcp-gate";

/** Given a priced order, return the `requires` manifest (or `undefined` = ungated). */
export type GateResolver = (order: Order) => unknown[] | undefined;

/**
 * A persistence provider that supplies all four stores at once (e.g. `redisStorage(...)`
 * from `@openmobilehub/attestomcp-storefront/redis`). Passed as `StorefrontOptions.storage`
 * so a production deployment gets shared, cross-instance state with one option instead of
 * hand-written adapters. An explicit per-slot store (`cartStore`, `orderStore`, …) still
 * takes precedence over the provider's store for that slot (the custom-backend escape hatch).
 */
export interface StorageProvider {
  cartStore: CartStore;
  createdOrderStore: OrderStore<Order>;
  orderStore: OrderStore<CompletedOrderRecord>;
  verificationStore: VerificationStore;
}

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
  /**
   * Created-but-not-yet-completed orders (read by the checkout page + place-order),
   * keyed by order id. Default in-memory. Inject a shared store (e.g. Redis) on a
   * multi-instance serverless deployment, or the checkout page lands on a cold
   * instance that never saw the order.
   */
  createdOrderStore?: OrderStore<Order>;
  /**
   * Per-order verification state the mounted ceremony writes (age proven / loyalty
   * applied) and this server's `completion` seam reads back to re-price + enforce
   * the age gate. Default in-memory; inject a shared store on a serverless
   * deployment. Published on `app.locals.attestomcp` so `attestomcp.mount(store.app)`
   * wires the rails against the SAME state (Security invariant 4).
   */
  verificationStore?: VerificationStore;
  /**
   * A persistence provider (e.g. `redisStorage({ url, token, namespace })`) that supplies
   * all four stores at once. Optional — omit for the in-memory default. An explicit store
   * above (`cartStore` / `orderStore` / `createdOrderStore` / `verificationStore`) takes
   * precedence over the provider's store for that slot.
   */
  storage?: StorageProvider;
  /**
   * Stable HMAC key for the ceremony's challenge nonce (e.g. `process.env.GATE_SECRET`).
   * Required so an options→verify hop survives an instance split on serverless. When
   * absent, `allowEphemeralKey` defaults true so a single-process dev server / tests
   * just run with a per-process key.
   */
  signingKey?: string;
  /** Allow a per-process ephemeral signing key (default: true unless `signingKey` is set). */
  allowEphemeralKey?: boolean;
  /**
   * Optional demo-mode settlement seam (e.g. on-chain). Throwing GATES completion:
   * a configured-but-failed settle records nothing and leaves the cart intact.
   */
  settle?: (order: CeremonyOrder) => Promise<Record<string, unknown> & { network: string; txId: string; status: string }>;
}

/**
 * A completed-order record the widget poll + `get-order-status` read. The standalone
 * demo `place-order` writes the lean shape (orderId/amount/currency/method/completedAt);
 * the mounted ceremony's shared `completeOrder` writes the richer one (mandate id,
 * gate outcomes, instrument, settlement) — both satisfy this superset so the poll
 * reads either.
 */
export interface CompletedOrderRecord {
  orderId: string;
  amount: number;
  currency: string;
  method: string;
  completedAt: string;
  mandateId?: string;
  instrument?: unknown;
  gates?: { gate: string; pass: boolean; detail: string }[];
  settlement?: unknown;
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
// Product images are self-contained `data:` URIs (added to the CSP below); picsum
// stays allowlisted in case a custom catalog uses remote images.
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
  throw new Error(`attestomcp-storefront: widget bundle not found (looked in: ${bundleCandidates().join(", ")})`);
}

// Derive this server's public origin from the incoming request. Proxies (Vercel,
// tunnels) set x-forwarded-*; fall back to the Host header. Lets the storefront
// build absolute checkout URLs at any origin when baseUrl wasn't configured.
export function originFromRequest(req: Request): string {
  const fwd = (name: string): string | undefined =>
    (req.headers[name] as string | undefined)?.split(",")[0]?.trim();
  const proto = fwd("x-forwarded-proto") ?? req.protocol ?? "http";
  const host = fwd("x-forwarded-host") ?? (req.headers.host as string | undefined);
  return host ? `${proto}://${host}`.replace(/\/+$/, "") : "";
}

// Re-home a mounted-ceremony approve link (`/attestomcp/*`) onto THIS server's origin —
// the same base the checkout link uses — so the gate links and the checkout link
// share an origin (the rails are registered on this same app). Links to any other
// path (e.g. a developer's external wallet origin) pass through untouched.
function homeApproveUrl(approveUrl: string, base: string): string {
  try {
    const u = new URL(approveUrl, "http://re-home.invalid");
    if (u.pathname.startsWith("/attestomcp/")) return `${base}${u.pathname}${u.search}`;
  } catch {
    /* not URL-shaped — leave as-is */
  }
  return approveUrl;
}

// Re-home every `/attestomcp/*` approveUrl in a `requires` manifest onto `base`.
function homeRequires(requires: unknown[], base: string): unknown[] {
  return requires.map((e) => {
    const entry = e as { approveUrl?: unknown };
    return typeof entry.approveUrl === "string"
      ? { ...entry, approveUrl: homeApproveUrl(entry.approveUrl, base) }
      : e;
  });
}

export function createStorefront(opts: StorefrontOptions = {}): Storefront {
  const catalog = opts.catalog ?? SAMPLE_CATALOG;
  const reviews = opts.reviews;
  // Per-slot store resolution: an explicit store wins, else the `storage` provider's
  // store for that slot (e.g. `redisStorage(...)`), else the in-memory default. Keeping
  // the in-memory fallback last means zero-config stays unchanged (no `storage` → memory).
  const cartStore: CartStore = opts.cartStore ?? opts.storage?.cartStore ?? new MemoryCartStore();
  const orderStore: OrderStore<CompletedOrderRecord> =
    opts.orderStore ?? opts.storage?.orderStore ?? new MemoryOrderStore<CompletedOrderRecord>();
  // Created-but-not-completed orders, for the checkout page + place-order. A store
  // (not a process Map) so it can be shared across serverless instances.
  const createdOrderStore: OrderStore<Order> =
    opts.createdOrderStore ?? opts.storage?.createdOrderStore ?? new MemoryOrderStore<Order>();
  // Per-order verification state shared with the mounted ceremony (the rails write
  // it; the completion seam below reads it back to re-price + enforce the age gate).
  const verificationStore: VerificationStore =
    opts.verificationStore ?? opts.storage?.verificationStore ?? new MemoryVerificationStore();
  let resolveGate: GateResolver | undefined;
  let baseUrl = opts.baseUrl?.replace(/\/+$/, "") ?? "";

  const BUNDLE_VERSION = bundleVersion();
  const RESOURCE_URI = `ui://product-picker/mcp-app-${BUNDLE_VERSION}.html`;
  const SKYBRIDGE_URI = `ui://product-picker/mcp-app-${BUNDLE_VERSION}.skybridge.html`;
  // One canonical tool-meta for every UI-linked tool — both host surfaces, with
  // openai/widgetAccessible always on (FR-014).
  const UI_META = appToolMeta({ resourceUri: RESOURCE_URI, skybridgeUri: SKYBRIDGE_URI });

  const app = createMcpExpressApp({ host: "0.0.0.0" });
  // place-order accepts the order id from either a JSON fetch (the shared checkout
  // page's instant-demo method) or an x-www-form-urlencoded form post; the SDK app
  // only parses JSON, so add a urlencoded parser too or a form post's `req.body.order`
  // is undefined and completion is never recorded.
  app.use(express.urlencoded({ extended: false }));

  // ── AttestoMCP ceremony seams (Context 2) ──────────────────────────────────────
  // Pre-bound so `new AttestoMCP().mount(store.app)` wires the `/attestomcp/*` rails with
  // ZERO explicit args — it reads these off `app.locals.attestomcp` (see the quickstart).
  // The catalog re-prices server-side (the amount source of truth — invariant 2); the
  // completion seam is the gate's shared `completeOrder` bound over THIS server's
  // stores, so a finished ceremony records the order + clears the cart the SAME way
  // get-order-status / the order-status poll read.
  const ceremonyCatalog: CeremonyCatalog = {
    createOrder: (items: CartItemRef[], orderId: string, repriceOpts?: RepriceOpts): CeremonyOrder =>
      createOrder(items, orderId, catalog, { ageVerified: repriceOpts?.ageVerified, loyaltyApplied: repriceOpts?.loyaltyApplied }),
  };
  const ceremonyOrderStore: CeremonyOrderStore = {
    // A storefront Order is structurally a CeremonyOrder; resolveOrder re-prices it
    // from the catalog regardless, recovering only the line items + id (CT3).
    read: (orderId: string) => createdOrderStore.read(orderId),
  };
  const completion = (input: CompletionInput): Promise<CompletionResult> =>
    completeOrder(input, {
      catalog: ceremonyCatalog,
      verificationStore,
      records: {
        read: async (orderId: string) => ((await orderStore.read(orderId)) ?? undefined) as CompletedRecord | undefined,
        write: async (record: CompletedRecord) => { await orderStore.write(record.orderId, record); },
      },
      cart: { clear: async () => { await cartStore.write(new Map()); } },
      ...(opts.settle ? { settle: opts.settle } : {}),
    });
  app.locals.attestomcp = {
    orderStore: ceremonyOrderStore,
    verificationStore,
    catalog: ceremonyCatalog,
    completion,
    // signingKey survives an instance split; default to an ephemeral per-process key
    // for a single-process dev server / tests when none is configured.
    ...(opts.signingKey ? { signingKey: opts.signingKey } : {}),
    allowEphemeralKey: opts.allowEphemeralKey ?? !opts.signingKey,
  };

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
    const server = new McpServer({ name: "attestomcp-storefront", version: "0.1.0" });

    // ── UI-linked tools (6) — registerAppTool + the canonical UI_META ───────
    registerAppTool(
      server,
      "browse-products",
      {
        title: "Browse Products",
        description:
          "Show the storefront catalog as an interactive visual product picker (a grid with images). " +
          "Call this whenever the user asks what you sell, what's available, to see/show/browse products, or " +
          "to shop — it renders the grid for them. Prefer it over describing the catalog in text.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
        _meta: UI_META,
      },
      async (): Promise<CallToolResult> => {
        const priced = await readPriced();
        return {
          content: [
            {
              type: "text",
              text:
                `The product picker is now showing the catalog visually to the user (${catalog.length} products in a grid with images). ` +
                `Do NOT re-list the products as text — they can see them. Briefly invite them to pick items or tell you what to add. ` +
                `Adjust the cart by id with add-to-cart / set-quantity / remove-from-cart; check out with checkout.`,
            },
          ],
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
        // Random id (not a per-instance counter): two serverless instances must
        // not both mint "ORD-1" for different carts.
        const order = createOrder(entries, `ORD-${Math.random().toString(36).slice(2, 8)}`, catalog);
        await createdOrderStore.write(order.id, order);
        const checkoutUrl = `${baseUrl}/checkout?order=${order.id}`;
        // ← where AttestoMCP mounts on. Re-home any /attestomcp/* approve link onto this
        // server's origin, so the gate links share the checkout link's base.
        const rawRequires = resolveGate?.(order);
        const requires = rawRequires ? homeRequires(rawRequires, baseUrl) : undefined;
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
    // Self-derive the public origin from the first request so checkout URLs are
    // absolute behind any proxy (Vercel, a tunnel) with zero config — without it,
    // `${baseUrl}/checkout` would be relative and the widget's `new URL()` throws.
    if (!baseUrl) baseUrl = originFromRequest(req);
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

  // The checkout page: the ONE shared three-gate page (renderRequirements), so the
  // storefront and the committed demo render the same polished checkout (T030). This
  // page LINKS to the ceremony routes attestomcp.mount() registered (re-homed onto this
  // origin, in policy order, payment last); it does NOT run the ceremony — completion
  // happens on the mounted /attestomcp/* rails, which enforce the gates fail-closed.
  app.get("/checkout", async (req: Request, res: Response) => {
    const created = await createdOrderStore.read(String(req.query.order ?? ""));
    if (!created) return res.status(404).type("html").send("<h1>Unknown order</h1>");

    // Read THIS order's verification (per order id — never global; Security
    // invariant 4) so the page reflects what the buyer has proven so far, and
    // re-price from the catalog with it (the discount opts in only once membership
    // is presented — never trust the token's total; invariant 2/3).
    const v = ((await verificationStore.read(created.id)) ?? {}) as VerificationRecord;
    const ageVerified = v.ageVerified === true;
    const loyaltyApplied = v.loyalty?.applied === true;
    const order = ceremonyCatalog.createOrder(
      created.lines.map((l) => ({ productId: l.id, quantity: l.quantity })),
      created.id,
      { ageVerified, loyaltyApplied },
    );

    // A revisit of an already-completed order shows the paid state instead of the
    // payment methods.
    const done = (await orderStore.read(created.id)) ?? null;

    // Resolve + re-home the manifest onto this server's mounted routes (each gate
    // carries its OWN approveUrl — the renderer is route-agnostic). Resolve against
    // the created order (the policy reads line ids + minimumAge — the re-priced
    // `order` carries the same lines; the discounted total shows via `order` below).
    const requires = homeRequires(resolveGate?.(created) ?? [], baseUrl) as VerificationManifestEntry[];
    const verification: RenderVerification = { ageVerified, loyaltyApplied };
    const paid = done ? { amount: done.amount, currency: done.currency, method: done.method } : null;

    // An UNGATED storefront has no payment gate, so the manifest carries no
    // `authorize` entry the renderer could derive a Pay CTA from — keep a simple
    // instant-demo complete path (POST the order id to /checkout/place-order). A
    // GATED order has NO such bypass: completion goes through the fail-closed payment
    // gate (the manifest's `authorize` approveUrl → the renderer's single Pay CTA).
    const ungated = requires.length === 0;
    const orderQ = encodeURIComponent(order.id);
    const payment = ungated
      ? {
          methods: [
            { value: "demo", name: `Complete purchase (demo) — ${order.total} ${order.currency}`, desc: "No real charge — records the order and clears the cart.", placeOrder: true },
          ],
          placeOrderPath: "/checkout/place-order",
          orderToken: order.id,
        }
      : // A GATED order: offer the same payment methods the demo does — the headline
        // passkey rail (authorize on-device; settles on-chain via x402 on Hedera) and
        // the cross-device wallet rail — both mounted by attestomcp.mount(), both completing
        // through the fail-closed gate (no bypass). Without this the renderer falls back
        // to a single Pay CTA from the manifest and the x402/Hedera passkey option never shows.
        {
          methods: [
            { value: "passkey", name: "Pay with x402 Hedera · Passkey", desc: "Authorize with this device's passkey — payment settles on-chain via the x402 protocol (test network).", href: `/attestomcp/passkey?order=${orderQ}`, checked: true },
            { value: "dc-payment", name: "Cross-device wallet", desc: "Scan a QR and approve with your phone's passkey or wallet — also x402 on Hedera.", href: `/attestomcp/dc-payment?order=${orderQ}` },
          ],
        };

    res.type("html").send(renderRequirements(order, requires, verification, { ...(payment ? { payment } : {}), paid }));
  });
  app.post("/checkout/place-order", async (req: Request, res: Response) => {
    const order = await createdOrderStore.read(String(req.body?.order ?? ""));
    if (order) {
      // Security invariant 1 — enforce gates on EVERY completion path, not just the
      // rendered page. This instant-demo path completes WITHOUT a device ceremony, so
      // it is only ever valid for an UNGATED order. A gated order (age / payment
      // requirements) MUST complete through the fail-closed payment gate; refuse it
      // here server-side. The checkout page only offers this button for ungated
      // orders, but a DIRECT POST of a gated order id would otherwise bypass the gate
      // entirely — e.g. an age-restricted order completing with no age proof. Hiding
      // the button is not enforcement.
      if ((resolveGate?.(order) ?? []).length > 0) {
        res.status(403).type("html").send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:32rem;margin:3rem auto"><h1>Verification required</h1><p>This order has age / payment requirements — complete it through checkout. It can't be placed from the instant-demo path.</p></body>`);
        return;
      }
      await orderStore.write(order.id, { orderId: order.id, amount: order.total, currency: order.currency, method: "demo", completedAt: new Date().toISOString() });
      await cartStore.write(new Map()); // completion empties the cart
    }
    res.type("html").send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:32rem;margin:3rem auto"><h1>✓ Order placed (demo)</h1><p>You can close this tab — the storefront will update.</p></body>`);
  });

  // The widget polls this after checkout to learn when the buyer finished on the page
  // (MCP has no server→client push). It then shows the confirmation + clears its cart.
  app.get("/checkout/order-status", async (req: Request, res: Response) => {
    // The widget iframe polls this cross-origin; allow it (simple GET → no preflight).
    res.setHeader("Access-Control-Allow-Origin", "*");
    const orderId = typeof req.query.orderId === "string" ? req.query.orderId : "";
    const order = orderId ? await orderStore.read(orderId) : null;
    res.json({ completed: !!order, order });
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
