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
import { enableMrtrParams, mrtrParams } from "./mcp-mrtr.js";
import { matchProducts, prefillVariants, validSelections, missingVariants, describeChoice } from "./product-match.js";
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
  MultiRoundTrip,
  type Ask,
  type InputRequiredResult,
  type Round,
  type Branding,
  type CartItemRef,
  type Credential,
  type Grants,
  type CeremonyCatalog,
  type CeremonyOrder,
  type CeremonyOrderStore,
  type CompletedRecord,
  type CompletionInput,
  type CompletionResult,
  type DelegatedVerifier,
  type RepriceOpts,
  type RenderPaid,
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
  /**
   * The human-NOT-present resource (spec 009): pass `credentagent.grants` (a client constructed
   * with a priced `catalog`) and the server additionally registers the four grant tools —
   * `create-spending-grant`, `get-grant-status`, `spend-from-grant`, `revoke-grant` — so an AI
   * agent can be granted a bounded spending authority ONCE by the human (grant.approveUrl) and
   * then buy unattended within it, every rule enforced server-side (caps, allow-bounds,
   * revocation; age-restricted items NEVER delegate — they refuse `step-up`). Omit ⇒ no grant
   * tools (additive). Serve the approve page with `credentagent.grants.serve(store.app)`.
   */
  grants?: Grants;
  /**
   * The merchant identity a created grant is cryptographically scoped and audited as (spec 009).
   * Only meaningful alongside `grants`. Defaults to `"storefront"` — set it to THIS storefront's
   * identity (e.g. `"utopia"`) so the authorization record and downstream merchant-scope checks
   * reflect the real host, not a placeholder.
   */
  merchant?: string;
  /**
   * How long a `create-spending-grant` re-check holds its answer open while the grant is still
   * awaiting the human's approval, re-reading the grant store until the tap lands (or the window
   * closes). Default 45 000 ms — measured just under claude.ai's 60 s tool-call kill, so the
   * agent's redial resolves seconds after the human approves in the browser, with no "I approved
   * it" message needed. `0` answers immediately (the agent then polls by redialing). The first
   * awaiting-approval answer never holds: the human needs the link before they can tap it.
   */
  approvalHoldMs?: number;
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

// A missing widget bundle is ALWAYS a packaging/deploy defect: the built
// dist/ui/mcp-app.html ships with the package (package.json `files`) and, on a serverless
// deploy, must be listed in the function's `includeFiles`. Say exactly what's wrong and the
// likely cause so the fix is obvious. Shared by bundleVersion (startup) and loadBundle (read).
function bundleMissingError(candidates: string[]): Error {
  return new Error(
    "credentagent-storefront: widget bundle dist/ui/mcp-app.html not found — the package was built " +
      "without its UI (run `npm run build`) or the deploy's includeFiles is missing it. " +
      `Looked in: ${[...new Set(candidates)].join(", ")}.`,
  );
}

// Stamp the resource URI with a short hash of the bundle so hosts re-fetch exactly when the
// widget changes (they cache by URI). A MISSING bundle THROWS (fail fast at createStorefront()
// startup) — it must NEVER fall back to a "dev" version, which would stamp
// ui://product-picker/mcp-app-dev.html and poison connected clients' cached resource URIs, so
// the widget 404s even after the bundle is restored (#55). `candidates` is a seam for the
// missing-bundle test; production always uses bundleCandidates().
export function bundleVersion(candidates: string[] = bundleCandidates()): string {
  for (const c of candidates) {
    try {
      return createHash("sha256").update(readFileSync(c)).digest("hex").slice(0, 8);
    } catch {
      /* try next */
    }
  }
  throw bundleMissingError(candidates);
}

async function loadBundle(): Promise<string> {
  const candidates = bundleCandidates();
  for (const c of candidates) {
    try {
      return await readFile(c, "utf-8");
    } catch {
      /* try next */
    }
  }
  throw bundleMissingError(candidates);
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  // The human-not-present resource (spec 009) — grant tools register only when provided.
  const grants = opts.grants;
  // The merchant a created grant is sealed as — honest default for the generic package.
  const merchant = opts.merchant ?? "storefront";
  // How long an approval re-check holds before answering (see StorefrontOptions.approvalHoldMs).
  const approvalHoldMs = opts.approvalHoldMs ?? 45_000;
  // MRTR (#174): the questions a half-specified grant asks ride in a SEALED `requestState` blob,
  // so the server holds no session between rounds. It is signed with the storefront's
  // `signingKey` when there is one; otherwise with a per-process key — which is fine for a single
  // instance, but on a multi-instance deployment a state minted on instance A is refused
  // ("tampered") by instance B, exactly like an unshared cart-mandate key. Pass `signingKey`.
  const rounds = new MultiRoundTrip({ secret: signingKey ?? randomBytes(32).toString("hex") });

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
        // A compact, agent-legible catalog line (ids + names + prices + categories + age flags).
        // A host rendering the widget shows the grid to a human; a HEADLESS agent (no widget, no
        // human watching) has only this text — without the ids it can't call add-to-cart and dead-
        // ends (#120). Ids are for the agent's OWN use, not for re-listing back to a present user.
        const idLine = catalog
          .map((p) => `${p.id} — ${p.name}, $${p.price}, ${p.category}${p.minimumAge ? `, ${p.minimumAge}+` : ""}`)
          .join(" · ");
        return {
          content: [
            {
              type: "text",
              text:
                `The product picker is now showing the catalog visually to the user (${catalog.length} products in a grid with images). ` +
                `Do NOT re-list the products as text to a user who can see the grid — briefly invite them to pick, or act on what they ask for. ` +
                `Catalog ids for YOUR OWN use when adding to the cart: ${idLine}. ` +
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

    // ── grants — the human-NOT-present tools (spec 009), only when opts.grants is wired ──
    // The lifecycle an agent drives: create (pending) → the HUMAN approves once at approveUrl →
    // spend within the sealed bounds → revoke. Every refusal is a typed code the agent can act on.
    if (grants) {
      const grantView = (g: NonNullable<Awaited<ReturnType<Grants["retrieve"]>>>) =>
        ({ grantId: g.id, status: g.status, merchant: g.merchant, approveUrl: g.approveUrl, budget: g.budget, perSpend: g.perSpend, allow: g.allow ?? null });
      // Rounds of questions are capped: a client that never converges gets an honest "I could not
      // pin this down" instead of an endless loop of elicitations.
      const MAX_ROUNDS = 4;
      /** The MRTR answer, ALSO rendered as plain text for the clients that don't speak MRTR yet. */
      const askResult = (asked: InputRequiredResult, overrides: Record<string, unknown> = {}): CallToolResult => {
        const questions = Object.entries(asked.inputRequests).map(([key, req]) => ({
          key,
          message: req.params.message,
          fields: Object.entries(req.params.requestedSchema.properties).map(([name, f]) => ({ name, options: f.enum ?? null })),
        }));
        const view = {
          ok: false,
          code: "input-required",
          note:
            "NO GRANT EXISTS YET. Put these questions to the human, then call create-spending-grant AGAIN with the " +
            "same budget/perSpend/item plus requestState (copied verbatim, never edited) and answers keyed by field name.",
          ...overrides,
          questions,
          requestState: asked.requestState,
        };
        // MRTR server requirement 7: NEVER send `inputRequests` a client hasn't declared support
        // for. A client that didn't advertise `elicitation` cannot put these questions to anyone,
        // and answering it with a bare `input_required` would only invite an immediate, useless
        // retry — so it gets the questions as ordinary tool output for its agent to relay instead.
        const speaksElicitation = !!server.server.getClientCapabilities()?.elicitation;
        const body: CallToolResult = { content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view };
        // Spread first: the MRTR fields (resultType / inputRequests / requestState) are the wire
        // contract for a client that implements the pattern; content + structuredContent are the
        // same questions in the form today's clients can actually read.
        return speaksElicitation ? { ...asked, ...body } : body;
      };
      const plain = (view: Record<string, unknown>): CallToolResult =>
        ({ content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view });
      /**
       * The wait round: the grant is minted (view carries approveUrl) but the flow stays open
       * until the human's tap. The grantId rides the sealed state as a server-attested carried
       * fact — the client can present it, never choose it.
       */
      const awaitApproval = (round: Extract<Round, { ok: true }>, view: Record<string, unknown>, extras: Record<string, unknown>): CallToolResult =>
        askResult(
          round.ask(
            {
              approval: {
                message:
                  `Waiting for the human. Send them this link — it names exactly what the grant can buy: ${view.approveUrl} ` +
                  `Once they say they've approved (or denied) there, reply here so I re-check.`,
                fields: { approved: { type: "boolean", description: "true once the human says they have dealt with the approve page; the server re-checks its own record either way" } },
              },
            },
            { carry: { grantId: view.grantId, extras } },
          ),
          {
            ...view,
            code: "awaiting-approval",
            note:
              "PENDING — the grant EXISTS but nothing can be spent yet. Send approveUrl to the human, then " +
              "IMMEDIATELY call create-spending-grant again with the EXACT same arguments plus this requestState " +
              "(change nothing else). That call holds the line server-side and returns the moment the human " +
              "approves — keep redialing until the status changes, and never mint a new grant while this one is " +
              "pending. Your answer is only a wake-up signal: approval is re-read server-side, never taken from it.",
          },
        );

      server.registerTool(
        "create-spending-grant",
        {
          title: "Create Spending Grant",
          description:
            "Ask the human for a bounded spending authority you can buy against WHILE THEY ARE AWAY: a total budget, " +
            "a per-purchase cap, and — when they have a specific purchase in mind — the exact product, named in `item` " +
            "(e.g. \"Oak Reserve Whiskey Collection\", \"black court sneakers, US 10\"). If those words fit several " +
            "products, none at all, or leave a choice open (size, colour), this tool returns NO LINK: it answers with the " +
            "questions to put to the human, plus a requestState — ask them, then call it again with the same arguments " +
            "plus that requestState (verbatim) and their answers. Once the product is pinned down the grant can only ever " +
            "buy THAT product. The flow then stays open one more round: you get the approveUrl (SEND IT TO THE HUMAN) " +
            "plus a final question — then IMMEDIATELY call again with the same arguments + that requestState. The " +
            "re-check holds the line server-side and returns the moment the human approves; keep redialing until the " +
            "status changes. Your answer is only a wake-up: approval is re-read server-side (pending → authorized), " +
            "never taken from what you say. Amounts are dollars.",
          inputSchema: {
            budget: z.number().positive().describe("total budget in dollars"),
            perSpend: z.number().positive().describe("max dollars per single purchase"),
            item: z.string().optional().describe("the exact product the human wants, in their own words; omit for an open, category-only grant"),
            categories: z.array(z.string()).optional().describe("allowed product categories (e.g. Beverages); omit = any"),
            description: z.string().optional().describe("the human-readable sentence shown at approval"),
            requestState: z.string().optional().describe("copy VERBATIM from this tool's previous answer; never edit or invent one"),
            answers: z.record(z.string(), z.string()).optional().describe("the human's answers to the questions the previous call asked, keyed by field name (e.g. { size: \"US 10\" })"),
          },
          annotations: { readOnlyHint: false },
        },
        async ({ budget, perSpend, item, categories, description, requestState, answers }, extra): Promise<CallToolResult> => {
          const mint = async (allow: { skus?: string[]; categories?: string[] } | undefined, sentence: string | undefined, extras: Record<string, unknown> = {}) => {
            const g = await grants.create({
              merchant,
              budget,
              perSpend,
              ...(allow ? { allow } : {}),
              ...(sentence ? { description: sentence } : {}),
            });
            return plain({ ...grantView(g), ...extras, note: "PENDING — send approveUrl to the human; spending refuses until they approve." });
          };

          // No `item` — the open, category-only grant, unchanged and round-trip free.
          if (!item) {
            return mint(categories?.length ? { categories } : undefined, description);
          }

          // ── the multi round-trip path: pin the grant to ONE product ──────────────────
          // `requestState` is attacker-controlled (MRTR spec): the engine verifies its signature,
          // TTL, and binding to THIS tool + THESE money bounds + THIS session before a single
          // answer inside it is believed.
          const mrtr = mrtrParams();
          const round = rounds.open({
            request: "create-spending-grant",
            params: { budget, perSpend, item, categories: categories ?? null },
            principal: extra?.sessionId ?? "",
            state: requestState ?? mrtr.requestState,
            responses: mrtr.inputResponses,
            answers,
          });
          if (!round.ok) {
            return plain({
              ok: false,
              code: round.code,
              note:
                "That requestState was refused. Start over: call create-spending-grant again with no requestState. " +
                "If an earlier round already returned a grantId, do NOT mint another — check it with get-grant-status.",
            });
          }

          // ── the wait phase: a grant already exists; the only question left is the human's tap
          // at approveUrl. The answer that woke us up is a DOORBELL, not a credential — status is
          // re-read from the grant store (where the approve page's transition lands), never taken
          // from what the client said.
          if (typeof round.carried.grantId === "string") {
            let g = await grants.retrieve(round.carried.grantId);
            if (!g) {
              return plain({ ok: false, code: "not-found", note: "That grant no longer exists. Start over: call create-spending-grant again with no requestState." });
            }
            // The held redial: hosts kill a tool call on a fixed clock (claude.ai: 60s), so a
            // re-check of a still-pending grant holds its answer open just under that, re-reading
            // the grant store until the human's tap lands or the window closes. Holding changes
            // WHEN the store is re-read, never WHO decides — the client's answer still authorizes
            // nothing (the "REFUSES to report … authorized" bypass test pins that).
            if (g.status === "pending" && !round.declined.length && approvalHoldMs > 0) {
              const deadline = Date.now() + approvalHoldMs;
              while (g.status === "pending" && Date.now() < deadline) {
                await sleep(Math.min(500, deadline - Date.now()));
                g = (await grants.retrieve(round.carried.grantId)) ?? g;
              }
            }
            const extras = (round.carried.extras ?? {}) as Record<string, unknown>;
            const view = { ...grantView(g), ...extras };
            if (g.status !== "pending") {
              const settled: Record<string, string> = {
                authorized: "AUTHORIZED — the human approved at the link. You can now spend-from-grant within the sealed bounds.",
                denied: "DENIED — the human refused this grant at the approve page. Don't retry; ask the human directly if that surprises you.",
                revoked: "REVOKED — this grant was withdrawn. Nothing can be spent against it.",
              };
              return plain({ ...view, note: settled[g.status] ?? g.status });
            }
            if (round.declined.length) {
              return plain({
                ...view,
                ok: false,
                code: "declined",
                note: "The human declined to confirm here. The grant stays PENDING — they can still approve or deny at approveUrl, or call revoke-grant to withdraw it.",
              });
            }
            return awaitApproval(round, view, extras);
          }

          // The human is allowed to say no. A declined question ends the flow honestly instead of
          // asking the same thing again until the round cap runs out.
          if (round.declined.length) {
            return plain({
              ok: false,
              code: "declined",
              declined: round.declined,
              note: "The human declined to answer, so no grant was created. Don't retry unless they ask you to.",
            });
          }
          const ask = (requests: Record<string, Ask>): CallToolResult =>
            round.round >= MAX_ROUNDS
              ? plain({ ok: false, code: "unresolved", note: `Still could not pin down "${item}" after ${MAX_ROUNDS} rounds — no grant was created. Ask the human to name a product from browse-products.` })
              : askResult(round.ask(requests));

          await source.load();
          const catalog = source.current();
          // A later round may have replaced the human's words with an exact product name.
          const words = typeof round.answers.item === "string" ? round.answers.item : item;
          const match = matchProducts(catalog, words);

          if (match.kind === "none") {
            return ask({
              product: {
                message: `I couldn't find "${words}" in this store. What exactly should I buy?`,
                fields: { item: { type: "string", description: "the product name, as listed in the store" } },
              },
            });
          }
          if (match.kind === "many") {
            return ask({
              product: {
                message: `"${words}" matches more than one product. Which one?`,
                fields: { item: { type: "string", enum: match.candidates.map((p) => p.name) } },
              },
            });
          }

          // One product — now every choice it offers (size, colour…) must be pinned down too.
          const product = match.product;
          const selections = { ...prefillVariants(product, words), ...validSelections(product, round.answers) };
          const missing = missingVariants(product, selections);
          if (missing.length) {
            return ask(
              Object.fromEntries(
                missing.map((v) => [
                  v.name,
                  { message: `${product.name}: ${v.label ?? `Which ${v.name}?`}`, fields: { [v.name]: { type: "string" as const, enum: v.options } } },
                ]),
              ),
            );
          }

          // Bounds sanity, BEFORE the human is asked to approve: a grant whose caps can never
          // cover this product's live price would only refuse later, with the human gone.
          if (product.price > perSpend || product.price > budget) {
            return plain({
              ok: false,
              code: "bounds-too-low",
              productId: product.id,
              price: product.price,
              note: `${describeChoice(product, selections)} costs more than the caps you asked for (budget $${budget}, per purchase $${perSpend}). No grant was created — call again with caps that cover it.`,
            });
          }

          const choice = describeChoice(product, selections);
          const g = await grants.create({
            merchant,
            budget,
            perSpend,
            allow: { skus: [product.id] }, // WHAT it may buy: this product and nothing else (fail-closed)
            description: `Buy ${choice} from ${merchant}${description ? ` — ${description}` : ""}.`,
          });
          const extras = {
            item: { productId: product.id, name: product.name, price: product.price, selections },
            ...(product.minimumAge != null
              ? { ageRestricted: product.minimumAge, ageNote: `This item is ${product.minimumAge}+. Age never delegates: an unattended spend refuses with step-up and needs the human present.` }
              : {}),
          };
          // Minted, but not finished: the flow stays open (one more round) until the human taps.
          return awaitApproval(round, { ...grantView(g), ...extras }, extras);
        },
      );
      server.registerTool(
        "get-grant-status",
        {
          title: "Get Grant Status",
          description: "Read a spending grant: status (pending | authorized | denied | revoked) and its sealed bounds.",
          inputSchema: { grantId: z.string() },
          annotations: { readOnlyHint: true },
        },
        async ({ grantId }): Promise<CallToolResult> => {
          const g = await grants.retrieve(grantId);
          if (!g) return { content: [{ type: "text", text: JSON.stringify({ error: "unknown grant" }) }], structuredContent: { error: "unknown grant" }, isError: true };
          const view = grantView(g);
          return { content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view };
        },
      );
      server.registerTool(
        "spend-from-grant",
        {
          title: "Spend From Grant",
          description:
            "Buy ONE product unattended against an authorized grant. The server re-prices from the catalog and enforces " +
            "every sealed rule; a refusal returns a typed code: not-authorized (human never approved), not-allowed (outside " +
            "the allowed categories), per-spend-exceeded, budget-exceeded, step-up (age-restricted — NEVER delegable: hand " +
            "back to the human), revoked. Pass a stable idempotencyKey to make retries safe (same key replays the SAME outcome).",
          inputSchema: {
            grantId: z.string(),
            productId: z.string(),
            quantity: z.number().int().min(1).optional(),
            idempotencyKey: z.string().optional().describe("stable per-purchase key; omit for a fresh one"),
          },
          annotations: { readOnlyHint: false },
        },
        async ({ grantId, productId, quantity, idempotencyKey }): Promise<CallToolResult> => {
          const g = await grants.retrieve(grantId);
          if (!g) return { content: [{ type: "text", text: JSON.stringify({ error: "unknown grant" }) }], structuredContent: { error: "unknown grant" }, isError: true };
          const qty = quantity ?? 1;
          const reply = (door: Record<string, unknown>): CallToolResult => {
            const view = { grantId, productId, ...door };
            return { content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view };
          };

          // Re-price and re-validate against the storefront's LIVE catalog before delegating
          // (Codex P1 + invariant 2). The grant engine holds its own catalog snapshot, which a
          // dynamic `source` (e.g. Firestore) can drift from; these fail-closed pre-checks read
          // `source.current()` so a price bump can't evade the sealed per-spend cap and an item
          // newly marked age-restricted can't be bought unattended — regardless of the grant's
          // snapshot. The engine remains the authority for allow-bounds and budget draw-down.
          await source.load();
          const live = getProduct(source.current(), productId);
          if (!live) return reply({ ok: false, code: "invalid-request", reason: "unknown product" }); // P2: typed, not a throw
          if (live.minimumAge != null) return reply({ ok: false, code: "step-up" }); // age NEVER delegates
          if (live.price * qty > g.perSpend) return reply({ ok: false, code: "per-spend-exceeded" }); // live price vs sealed cap

          try {
            const s = await g.spend({
              idempotencyKey: idempotencyKey ?? `mcp-${randomUUID().slice(0, 12)}`,
              items: [{ sku: productId, qty }],
            });
            return reply(s as unknown as Record<string, unknown>);
          } catch {
            // The engine's catalog doesn't know this sku (it throws on an unknown item) — surface
            // the promised typed refusal instead of a generic tool exception. P2.
            return reply({ ok: false, code: "invalid-request", reason: "unknown product" });
          }
        },
      );
      server.registerTool(
        "revoke-grant",
        {
          title: "Revoke Grant",
          description: "Kill-switch a spending grant — the very next spend is refused (code: revoked). Not reversible.",
          inputSchema: { grantId: z.string() },
          annotations: { readOnlyHint: false },
        },
        async ({ grantId }): Promise<CallToolResult> => {
          const g = await grants.retrieve(grantId);
          if (!g) return { content: [{ type: "text", text: JSON.stringify({ error: "unknown grant" }) }], structuredContent: { error: "unknown grant" }, isError: true };
          await g.revoke();
          const view = grantView((await grants.retrieve(grantId))!);
          return { content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view };
        },
      );
    }

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

    // MRTR: surface `params.requestState` / `params.inputResponses` to the tool handlers above.
    // Must run AFTER the tools are registered — the SDK installs its tools/call handler lazily.
    enableMrtrParams(server);

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
    // Forward the settlement record so the paid banner can show what actually settled
    // (#107). Dropping it here made EVERY completed order — even a real x402 or processor
    // settlement — render "no settlement", the receipt-honesty bug this fixes.
    const paid = done
      ? { amount: done.amount, currency: done.currency, method: done.method, ...(done.settlement ? { settlement: done.settlement as RenderPaid["settlement"] } : {}) }
      : null;

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
    // Carry the host brand onto the checkout hub too, so it matches the linked gate pages
    // (issue #61). `credentagent.mount(store.app)` publishes it here alongside the other seams;
    // read it at request time (mount runs after this route is defined).
    const branding = (app.locals.credentagent as { branding?: Branding } | undefined)?.branding;
    res.type("html").send(renderRequirements(order, requires, verification, { ...(payment ? { payment } : {}), paid, statusUrl, statusRevision, ...(branding ? { branding } : {}) }));
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
