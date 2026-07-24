// createStorefront() — a runnable storefront in one line.
//
// Stands up the real MCP storefront — the nine shopping tools (six UI-linked to the
// React widget, three plain) + the single-file widget resource + a checkout page —
// over HTTP at /mcp, around an injected catalog. The checkout tool is UNGATED by
// default; call `store.gate(resolve)` to have it surface a `requires` manifest,
// which is exactly where @openmobilehub/credentagent-gate mounts on:
//
//   const store = createStorefront();
//   const credentagent = new CredentAgent();
//   credentagent.mount(store.app);
//   store.gate((order) => credentagent.requirements(order, [ required(age.over(21).when(hasAlcohol)) ]));
//   const { url } = await store.listen(3005);   // → add http://localhost:3005/mcp to Claude / ChatGPT

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { randomBytes } from "node:crypto";
import express from "express";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  CART_META_KEY,
  CATALOG_META_KEY,
  createOrder,
  getProduct,
  getReviews,
  isCatalogSource,
  priceCart,
  SAMPLE_CATALOG,
  staticCatalog,
} from "./index.js";
import type { CartItemInput, CatalogSource, Order, PricedCart, Product, Review } from "./index.js";
// Re-export the catalog contract so a consumer can type a custom dynamic source without
// reaching into the pure model module.
export type { CatalogSource } from "./index.js";
import { appToolMeta } from "./tool-meta.js";
import { MemoryCartStore, MemoryOrderStore } from "./state.js";
import type { CartStore, OrderStore } from "./state.js";
// Re-export the store contracts so a consumer can type an explicit store (the escape
// hatch) or a custom `StorageProvider` without reaching into an internal module.
export type { CartStore, OrderStore } from "./state.js";
// Composition with @openmobilehub/credentagent-gate (Context 2): the storefront pre-binds
// the gate's shared `completeOrder` over ITS OWN stores + catalog and publishes the
// ceremony seams on `app.locals.credentagent`, so `new CredentAgent().mount(store.app)` wires
// the `/credentagent/*` rails with zero explicit args (the quickstart). The gate stays an
// optional pairing — only this server module imports it; the pure pricing core
// (`./index.js`) does not.
import {
  completeOrder,
  issueCartMandate,
  verifyCartMandate,
  decodeCartMandateParam,
  renderRequirements,
  MemoryVerificationStore,
  type CartItemRef,
  type Credential,
  type CeremonyCatalog,
  type CeremonyOrder,
  type CeremonyOrderStore,
  type CompletedRecord,
  type CompletionInput,
  type CompletionResult,
  type DelegatedVerifier,
  type RepriceOpts,
  type RenderVerification,
  type VerificationManifestEntry,
  type VerificationRecord,
  type VerificationStore,
} from "@openmobilehub/credentagent-gate";

/** Given a priced order, return the `requires` manifest (or `undefined` = ungated). */
export type GateResolver = (order: Order) => unknown[] | undefined;

/**
 * A persistence provider that supplies all four stores at once (e.g. `redisStorage(...)`
 * from `@openmobilehub/credentagent-storefront/redis`). Passed as `StorefrontOptions.storage`
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
  /**
   * Products to sell. Defaults to the package's `SAMPLE_CATALOG`. Pass a plain `Product[]`
   * for the zero-config static catalog, or a {@link CatalogSource} (e.g.
   * `firestoreCatalog(...)` from `@openmobilehub/credentagent-storefront/firestore`) for a
   * live, editable catalog the module loads + caches server-side. Prices and age
   * thresholds always re-derive from this catalog server-side (Security invariant 2).
   */
  catalog?: Product[] | CatalogSource;
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
   * deployment. Published on `app.locals.credentagent` so `credentagent.mount(store.app)`
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
   * Opt-in (default false): carry the created order in a signed Cart Mandate on the
   * checkout link (`?order=<id>&cart=<base64url>`) instead of a `createdOrderStore`
   * write, so a checkout survives an instance split with no shared created-order store
   * (gate FR-007). Forces a concrete `signingKey` (generated if none) so the mandate the
   * checkout tool issues is the one the gate rails verify. Verification + completion
   * state still use their stores.
   */
  statelessOrders?: boolean;
  /**
   * Opt-in (default false): serve `/mcp` with a **stateless** Streamable-HTTP transport —
   * a fresh transport per request, no `Mcp-Session-Id`, nothing kept in per-instance memory.
   * Multi-instance serverless (e.g. Vercel) has no session affinity, so the default stateful
   * transport (a per-instance session map) rejects a follow-up request that lands on another
   * instance with `No valid session`. Enable this on such deploys. Trade-off: no per-session
   * server cart — tools that need the cart must receive it explicitly (the widget's checkout
   * passes its on-screen `items`), and `extra.sessionId` is absent so cart tools fall back to
   * a shared key. Pair with `statelessOrders` for a fully instance-independent checkout.
   */
  statelessMcp?: boolean;
  /**
   * Optional demo-mode settlement seam (e.g. on-chain). Throwing GATES completion:
   * a configured-but-failed settle records nothing and leaves the cart intact.
   */
  settle?: (order: CeremonyOrder) => Promise<Record<string, unknown> & { network: string; txId: string; status: string }>;
  /**
   * Optional external verifier/processor (008, #60). Pass one — e.g. a Multipaz-verifier +
   * UPay adapter — and `new CredentAgent().mount(store.app)` serves the delegated ceremony:
   * the SAME `gate()` policy runs a real, issuer-trust-verified, amount-bound payment, with
   * only the verification/settlement backend moved in. Published on `app.locals.credentagent`
   * so the zero-arg `mount()` picks it up. Omit ⇒ the built-in presence-only rails, unchanged.
   */
  verifier?: DelegatedVerifier;
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
  /** The current catalog. Static source: the injected array; dynamic source: last-known-good. */
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
  throw new Error(`credentagent-storefront: widget bundle not found (looked in: ${bundleCandidates().join(", ")})`);
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

/**
 * A stable, opaque signature of an order's verification state (#73). The checkout page
 * bakes the current one (`statusRevision`) and `/checkout/order-status` returns it; when
 * they differ, a step was made elsewhere (age verified, loyalty applied) and the standing
 * tab reloads to mirror it — not only on final completion (#63). Changes iff a tracked
 * field changes; order-insensitive across custom gates.
 */
export function verificationRevision(v: VerificationRecord | null | undefined): string {
  const age = v?.ageVerified === true ? 1 : 0;
  const loyalty = v?.loyalty?.applied === true ? 1 : 0;
  const gates = Object.keys(v?.verifiedGates ?? {}).sort().join(",");
  return `a${age}|l${loyalty}|g:${gates}`;
}

// Re-home a mounted-ceremony approve link (`/credentagent/*`) onto THIS server's origin —
// the same base the checkout link uses — so the gate links and the checkout link
// share an origin (the rails are registered on this same app). Links to any other
// path (e.g. a developer's external wallet origin) pass through untouched.
function homeApproveUrl(approveUrl: string, base: string): string {
  try {
    const u = new URL(approveUrl, "http://re-home.invalid");
    if (u.pathname.startsWith("/credentagent/")) return `${base}${u.pathname}${u.search}`;
  } catch {
    /* not URL-shaped — leave as-is */
  }
  return approveUrl;
}

// Re-home every `/credentagent/*` approveUrl in a `requires` manifest onto `base`, and
// (statelessOrders) append the `cart` param so each gate rail page can reconstruct the
// order from the signed mandate rather than a store read.
function homeRequires(requires: unknown[], base: string, cart?: string | null): unknown[] {
  return requires.map((e) => {
    const entry = e as { approveUrl?: unknown };
    if (typeof entry.approveUrl !== "string") return e;
    let approveUrl = homeApproveUrl(entry.approveUrl, base);
    if (cart) approveUrl += `${approveUrl.includes("?") ? "&" : "?"}cart=${cart}`;
    return { ...entry, approveUrl };
  });
}

export function createStorefront(opts: StorefrontOptions = {}): Storefront {
  // Normalize the catalog into a CatalogSource: a plain array (or the default) is wrapped
  // in a static source; a dynamic source (e.g. `firestoreCatalog(...)`) is used as-is. Every
  // catalog read below goes through `source.current()` — the last-known-good snapshot the
  // prime middleware keeps warm — so the SYNCHRONOUS re-price paths (incl. the gate's
  // ceremony `createOrder`) re-derive prices/ages server-side (invariant 2) with no gate change.
  const source: CatalogSource = isCatalogSource(opts.catalog)
    ? opts.catalog
    : staticCatalog(opts.catalog ?? SAMPLE_CATALOG);
  const reviews = opts.reviews;
  // Per-slot store resolution: an explicit store wins, else the `storage` provider's
  // store for that slot (e.g. `redisStorage(...)`), else the in-memory default. Keeping
  // the in-memory fallback last means zero-config stays unchanged (no `storage` → memory).
  const cartStore: CartStore = opts.cartStore ?? opts.storage?.cartStore ?? new MemoryCartStore();
  // orderId → sessionId, recorded at checkout so the completion path (browser / place-order,
  // which has no MCP session) can clear the RIGHT session's cart. In-memory, so on
  // multi-instance serverless it shares the stateful-session limitation (needs sticky
  // sessions); elsewhere it's best-effort and the cart simply isn't cleared.
  const orderSessions = new Map<string, string>();
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

  // statelessOrders (gate FR-007): the signed Cart Mandate is the created-order transport.
  // The storefront must OWN a concrete signing key (not the gate's ephemeral one) so the
  // mandate the checkout tool issues is the one the gate rails verify.
  //
  // That key MUST be STABLE across instances — statelessOrders exists to survive an
  // instance split, and a per-process random key would make a mandate minted on instance A
  // fail to verify on instance B (defeating the whole feature). So fail fast unless the host
  // provides a `signingKey`, OR explicitly opts into an ephemeral per-process key
  // (single-process dev / tests) — mirroring the gate's `allowEphemeralKey` escape hatch.
  const statelessOrders = opts.statelessOrders ?? false;
  const statelessMcp = opts.statelessMcp ?? false;
  if (statelessOrders && !opts.signingKey && !opts.allowEphemeralKey) {
    throw new Error(
      "[credentagent-storefront] statelessOrders requires a stable `signingKey` so a cart mandate minted on " +
        "one instance verifies on another. Pass { signingKey } (e.g. process.env.GATE_SECRET), or " +
        "{ allowEphemeralKey: true } for a single-process dev server / tests.",
    );
  }
  const signingKey = opts.signingKey ?? (statelessOrders ? randomBytes(32).toString("hex") : undefined);

  // Issue + base64url-encode a Cart Mandate for a priced order (the checkout link's `cart`).
  const cartParamFor = (order: Order): string => {
    const mandate = issueCartMandate(
      { orderId: order.id, lines: order.lines.map((l) => ({ id: l.id, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: l.lineTotal })), currency: order.currency, total: order.total },
      signingKey as string,
    );
    return Buffer.from(JSON.stringify(mandate)).toString("base64url");
  };
  const withCart = (url: string, cart?: string | null): string =>
    cart ? `${url}${url.includes("?") ? "&" : "?"}cart=${cart}` : url;

  // Resolve a created order by id: from a VERIFIED cart mandate (statelessOrders, no store
  // read) or the createdOrderStore. Fails closed — a forged/tampered/expired mandate → null.
  const resolveCreated = async (orderId: string, cartRaw?: unknown): Promise<Order | null> => {
    if (statelessOrders && cartRaw !== undefined) {
      const verdict = verifyCartMandate(decodeCartMandateParam(cartRaw), orderId, signingKey as string);
      if (!verdict.ok) return null;
      return createOrder(verdict.mandate.lines.map((l) => ({ productId: l.id, quantity: l.quantity })), orderId, source.current());
    }
    return (await createdOrderStore.read(orderId)) ?? null;
  };

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

  // Prime the catalog before EVERY route runs — including the `/credentagent/*` ceremony
  // rails a consumer mounts later (registered after this middleware, so this runs first).
  // Awaiting the TTL-cached load means every synchronous `source.current()` below reads a
  // warm, server-side re-derived snapshot. A cold/unreachable load FAILS CLOSED (503, no
  // handler runs) rather than serving an empty catalog (Security invariant 2). The static
  // default resolves instantly and never fails, so the zero-config path is unchanged.
  app.use((_req: Request, res: Response, next) => {
    source.load().then(
      () => next(),
      () => res.status(503).type("text").send("Catalog temporarily unavailable."),
    );
  });

  // ── CredentAgent ceremony seams (Context 2) ──────────────────────────────────────
  // Pre-bound so `new CredentAgent().mount(store.app)` wires the `/credentagent/*` rails with
  // ZERO explicit args — it reads these off `app.locals.credentagent` (see the quickstart).
  // The catalog re-prices server-side (the amount source of truth — invariant 2); the
  // completion seam is the gate's shared `completeOrder` bound over THIS server's
  // stores, so a finished ceremony records the order + clears the cart the SAME way
  // get-order-status / the order-status poll read.
  const ceremonyCatalog: CeremonyCatalog = {
    createOrder: (items: CartItemRef[], orderId: string, repriceOpts?: RepriceOpts): CeremonyOrder =>
      createOrder(items, orderId, source.current(), { ageVerified: repriceOpts?.ageVerified, loyaltyApplied: repriceOpts?.loyaltyApplied }),
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
      cart: { clear: async () => { const sid = orderSessions.get(input.order.id); if (sid) await cartStore.write(sid, new Map()); } },
      // Custom-gate enforcement (007): hand `completeOrder` the credential registry
      // `credentagent.mount(store.app)` published on app.locals — read LAZILY at completion
      // time (mount runs after this closure is defined) so an applicable custom gate() is
      // enforced on the shared completion path (invariant 1), not only in the rendered page.
      credentialRegistry: (app.locals.credentagent as { credentialRegistry?: ReadonlyMap<string, Credential> } | undefined)?.credentialRegistry,
      ...(opts.settle ? { settle: opts.settle } : {}),
    });
  app.locals.credentagent = {
    orderStore: ceremonyOrderStore,
    verificationStore,
    catalog: ceremonyCatalog,
    completion,
    // signingKey survives an instance split; default to an ephemeral per-process key
    // for a single-process dev server / tests when none is configured (but statelessOrders
    // forces a concrete, storefront-owned key so it can sign the mandate).
    ...(signingKey ? { signingKey } : {}),
    allowEphemeralKey: opts.allowEphemeralKey ?? !signingKey,
    statelessOrders,
    // 008: hand the external verifier to the zero-arg `mount()` (it reads app.locals). The
    // delegated rail only registers when this is present — otherwise the built-in rails serve.
    ...(opts.verifier ? { verifier: opts.verifier } : {}),
  };

  // ── cart logic (per-session over the catalog source + the cart store) ─────
  // Each MCP session gets its own working cart: `sessionId` is the MCP session
  // (extra.sessionId); a fallback key covers non-session transports (e.g. the in-memory
  // transport used in tests) so single-connection flows work.
  // `priceFrom` reads the warm catalog snapshot synchronously; every async entry below
  // first `await source.load()` so the snapshot is fresh regardless of transport — the
  // HTTP `/mcp` route is already primed by the middleware, but `mcpServer()` over a raw
  // transport (e.g. stdio) is not, so the tool handlers warm the catalog themselves.
  const DEFAULT_SESSION = "default";
  const sessionOf = (extra: { sessionId?: string }): string => extra.sessionId ?? DEFAULT_SESSION;
  const priceFrom = (cart: Map<string, number>): PricedCart =>
    priceCart([...cart.entries()].map(([productId, quantity]) => ({ productId, quantity })), source.current());
  const readPriced = async (sessionId: string): Promise<PricedCart> => {
    await source.load();
    return priceFrom(await cartStore.read(sessionId));
  };
  const addToCart = async (sessionId: string, items: CartItemInput[]): Promise<PricedCart> => {
    await source.load();
    const cart = await cartStore.read(sessionId);
    for (const { productId, quantity } of items) {
      if (quantity <= 0) continue;
      cart.set(productId, (cart.get(productId) ?? 0) + quantity);
    }
    await cartStore.write(sessionId, cart);
    return priceFrom(cart);
  };
  const setQuantity = async (sessionId: string, productId: string, quantity: number): Promise<PricedCart> => {
    await source.load();
    const cart = await cartStore.read(sessionId);
    if (quantity <= 0) cart.delete(productId);
    else cart.set(productId, quantity);
    await cartStore.write(sessionId, cart);
    return priceFrom(cart);
  };
  const removeFromCart = async (sessionId: string, productId: string): Promise<PricedCart> => {
    await source.load();
    const cart = await cartStore.read(sessionId);
    cart.delete(productId);
    await cartStore.write(sessionId, cart);
    return priceFrom(cart);
  };
  // Cart-bearing result, emitted three ways so either host reads it: structuredContent
  // (ChatGPT widget + model), a JSON text block, and _meta (Claude's out-of-band channel).
  const cartResult = (priced: PricedCart): CallToolResult => ({
    structuredContent: { products: source.current(), cart: priced } as unknown as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(priced) }],
    _meta: { [CART_META_KEY]: priced },
  });

  function buildServer(): McpServer {
    const server = new McpServer({ name: "credentagent-storefront", version: "0.1.0" });

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
      async (_args, extra): Promise<CallToolResult> => {
        await source.load();
        const catalog = source.current();
        const priced = await readPriced(sessionOf(extra));
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
      async ({ items }, extra): Promise<CallToolResult> => cartResult(await addToCart(sessionOf(extra), items)),
    );
    registerAppTool(
      server,
      "set-quantity",
      { title: "Set Quantity", description: "Set the exact quantity of a product by id (0 removes).", inputSchema: { productId: z.string(), quantity: z.number().int().min(0) }, annotations: { readOnlyHint: false }, _meta: UI_META },
      async ({ productId, quantity }, extra): Promise<CallToolResult> => cartResult(await setQuantity(sessionOf(extra), productId, quantity)),
    );
    registerAppTool(
      server,
      "remove-from-cart",
      { title: "Remove from Cart", description: "Remove a product from the cart by id.", inputSchema: { productId: z.string() }, annotations: { readOnlyHint: false }, _meta: UI_META },
      async ({ productId }, extra): Promise<CallToolResult> => cartResult(await removeFromCart(sessionOf(extra), productId)),
    );
    registerAppTool(
      server,
      "get-cart",
      { title: "Get Cart", description: "Return the current cart: line items, quantities, total.", inputSchema: {}, annotations: { readOnlyHint: true }, _meta: UI_META },
      async (_args, extra): Promise<CallToolResult> => cartResult(await readPriced(sessionOf(extra))),
    );
    registerAppTool(
      server,
      "checkout",
      { title: "Checkout", description: "Snapshot the cart into an order and return a checkout link; if gated, also a `requires` manifest of what the buyer must prove on the page.", inputSchema: { items: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive() })).optional() }, annotations: { readOnlyHint: false }, _meta: UI_META },
      async ({ items }, extra): Promise<CallToolResult> => {
        await source.load();
        const catalog = source.current();
        const sessionId = sessionOf(extra);
        const entries = items?.length ? items : [...(await cartStore.read(sessionId)).entries()].map(([productId, quantity]) => ({ productId, quantity }));
        if (entries.length === 0) return { content: [{ type: "text", text: "The cart is empty — add items before checking out." }], isError: true };
        // Random id (not a per-instance counter): two serverless instances must
        // not both mint "ORD-1" for different carts.
        const order = createOrder(entries, `ORD-${Math.random().toString(36).slice(2, 8)}`, catalog);
        // statelessOrders: carry the order in a signed Cart Mandate on the link instead of
        // a store write — the checkout page + gate rails reconstruct + verify it (FR-007).
        const cart = statelessOrders ? cartParamFor(order) : null;
        if (!statelessOrders) await createdOrderStore.write(order.id, order);
        orderSessions.set(order.id, sessionId); // so completion clears THIS session's cart
        const checkoutUrl = withCart(`${baseUrl}/checkout?order=${order.id}`, cart);
        // ← where CredentAgent mounts on. Re-home any /credentagent/* approve link onto this
        // server's origin (and propagate the cart param), so the gate links share the base.
        const rawRequires = resolveGate?.(order);
        const requires = rawRequires ? homeRequires(rawRequires, baseUrl, cart) : undefined;
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
        await source.load();
        const product = getProduct(source.current(), productId);
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

  // MCP over streamable HTTP, STATEFUL: the server issues an mcp-session-id on
  // `initialize` and reuses that session's transport for its later requests, so each
  // client gets a stable session id (→ its own cart, keyed by session in the tool
  // handlers). NOTE: the transport map is per-instance memory — multi-instance serverless
  // needs sticky sessions (session affinity) for per-session carts to hold.
  const transports = new Map<string, StreamableHTTPServerTransport>();
  app.all("/mcp", async (req: Request, res: Response) => {
    // Self-derive the public origin from the first request so checkout URLs are
    // absolute behind any proxy (Vercel, a tunnel) with zero config — without it,
    // `${baseUrl}/checkout` would be relative and the widget's `new URL()` throws.
    if (!baseUrl) baseUrl = originFromRequest(req);

    // Stateless mode (multi-instance serverless): a fresh transport + server per request,
    // no session id, nothing in per-instance memory — so a request never depends on having
    // hit the same instance as its `initialize`. See `statelessMcp`.
    if (statelessMcp) {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); });
      try {
        await buildServer().connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch {
        if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "error" }, id: null });
      }
      return;
    }

    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      // A new session must arrive as an `initialize` with no session id; anything else
      // (unknown id, or a non-init without a session) is rejected.
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null });
        return;
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, created); },
      });
      created.onclose = () => { if (created.sessionId) transports.delete(created.sessionId); };
      await buildServer().connect(created);
      transport = created;
    }
    try {
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "error" }, id: null });
    }
  });

  // The checkout page: the ONE shared three-gate page (renderRequirements), so the
  // storefront and the committed demo render the same polished checkout (T030). This
  // page LINKS to the ceremony routes credentagent.mount() registered (re-homed onto this
  // origin, in policy order, payment last); it does NOT run the ceremony — completion
  // happens on the mounted /credentagent/* rails, which enforce the gates fail-closed.
  app.get("/checkout", async (req: Request, res: Response) => {
    // statelessOrders: reconstruct + VERIFY the order from the `cart` mandate (no store
    // read); else read the createdOrderStore. `cart` is propagated onto the gate links below.
    const cartRaw = typeof req.query.cart === "string" ? req.query.cart : undefined;
    const created = await resolveCreated(String(req.query.order ?? ""), cartRaw);
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
    const requires = homeRequires(resolveGate?.(created) ?? [], baseUrl, statelessOrders ? cartRaw : null) as VerificationManifestEntry[];
    // Pass this order's proven custom gates (007) so the hub reflects a proven custom
    // gate and unlocks payment — without it, a proven license loops back to a locked page.
    const verification: RenderVerification = { ageVerified, loyaltyApplied, ...(v.verifiedGates ? { verifiedGates: v.verifiedGates } : {}) };
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
      : opts.verifier
      ? // A GATED order with a delegated verifier configured (008): route the checkout page's Pay
        // CTA to the mounted delegated ceremony, so the real external-verifier rail — not the
        // built-in presence-only passkey/dc-payment rails — completes the payment.
        {
          methods: [
            { value: "delegated", name: "Pay with your wallet", desc: "Authorize with a credential from your phone wallet — verification and settlement run through the configured external verifier.", href: withCart(`/credentagent/delegated?order=${orderQ}`, statelessOrders ? cartRaw : null), checked: true },
          ],
        }
      : // A GATED order: offer the same payment methods the demo does — the headline
        // passkey rail (authorize on-device; settles on-chain via x402 on Hedera) and
        // the cross-device wallet rail — both mounted by credentagent.mount(), both completing
        // through the fail-closed gate (no bypass). Without this the renderer falls back
        // to a single Pay CTA from the manifest and the x402/Hedera passkey option never shows.
        {
          methods: [
            { value: "passkey", name: "Pay with x402 Hedera · Passkey", desc: "Authorize with this device's passkey — payment settles on-chain via the x402 protocol (test network).", href: withCart(`/credentagent/passkey?order=${orderQ}`, statelessOrders ? cartRaw : null), checked: true },
            { value: "dc-payment", name: "Cross-device wallet", desc: "Scan a QR and approve with your phone's passkey or wallet — also x402 on Hedera.", href: withCart(`/credentagent/dc-payment?order=${orderQ}`, statelessOrders ? cartRaw : null) },
          ],
        };

    // #63: let a standing checkout tab reflect a completion made on another tab / device /
    // rail — the page polls this order's status endpoint and reloads on completion (the same
    // signal the widget polls). Route-agnostic: the gate renders whatever URL we pass.
    const statusUrl = `/checkout/order-status?orderId=${encodeURIComponent(order.id)}`;
    // #73: bake THIS order's current verification signature so a standing tab reloads when a
    // step is made elsewhere (age verified, loyalty applied), not only on final completion.
    const statusRevision = verificationRevision(v);
    res.type("html").send(renderRequirements(order, requires, verification, { ...(payment ? { payment } : {}), paid, statusUrl, statusRevision }));
  });
  app.post("/checkout/place-order", async (req: Request, res: Response) => {
    // statelessOrders: reconstruct + verify from the body's `cart` mandate; else the store.
    const order = await resolveCreated(String(req.body?.order ?? ""), req.body?.cart);
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
      const sid = orderSessions.get(order.id); // completion empties THIS session's cart
      if (sid) await cartStore.write(sid, new Map());
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
    // #73: return this order's current verification signature so a standing checkout tab can
    // reload the moment a step is made on another device — not only when payment completes.
    const v = orderId ? (((await verificationStore.read(orderId)) ?? null) as VerificationRecord | null) : null;
    res.json({ completed: !!order, revision: verificationRevision(v), order });
  });

  return {
    app,
    // Static source: the injected array. Dynamic source: the last-known-good snapshot
    // (throws if read before the first successful load — the server primes it per request).
    get catalog(): Product[] { return source.current(); },
    mcpServer: buildServer,
    gate(resolve: GateResolver) { resolveGate = resolve; },
    async listen(port = 3005): Promise<{ url: string; port: number }> {
      if (!baseUrl) baseUrl = `http://localhost:${port}`;
      await new Promise<void>((resolve) => { app.listen(port, () => resolve()); });
      return { url: `${baseUrl}/mcp`, port };
    },
  };
}
