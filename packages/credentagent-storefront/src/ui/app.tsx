import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import {
  CART_META_KEY,
  CATALOG_META_KEY,
  priceCart,
  SAMPLE_CATALOG as CATALOG,
  type CartItemInput,
  type PricedCart,
  type Product,
} from "../index";
import styles from "./app.module.css";

// Optimistic client-side pricing against the bundled catalog; the server re-prices
// authoritatively on every tool call. (A host that injects its own catalog at
// runtime still gets server-authoritative prices; live-catalog optimistic pricing
// is a US2 follow-up.)
const priceCartLocal = (items: CartItemInput[]): PricedCart => priceCart(items, CATALOG);

type Insets = McpUiHostContext["safeAreaInsets"];
// Set the absolute quantity of a product in the shared cart (0 removes it). The
// picker calls this directly so each card reflects — and edits — the live cart.
type SetQuantityFn = (productId: string, quantity: number) => Promise<void>;
// Hand off to checkout: opens the merchant page in the browser. Only available
// inside a host with a link/open capability; undefined in standalone mode.
type CheckoutFn = () => Promise<void>;
// Open an external URL via the host bridge: sandboxed widget iframes block
// plain target="_blank" anchors, so links must route through openLink /
// openExternal exactly like the checkout hand-off does.
type OpenLinkFn = (url: string) => void | Promise<void>;

// Minimal shape of ChatGPT's in-iframe bridge. ChatGPT injects `window.openai`
// into skybridge widgets; the methods we use are optional-chained because the
// surface evolves. (MCP hosts like Claude use the ext-apps bridge instead.)
interface OpenAiBridge {
  toolInput?: unknown;
  toolOutput?: unknown;
  callTool?: (name: string, params?: Record<string, unknown>) => Promise<unknown>;
  openExternal?: (opts: { href: string }) => void | Promise<void>;
}
declare global {
  interface Window {
    openai?: OpenAiBridge;
  }
}

type HostMode = "chatgpt" | "mcp" | "standalone";

// Pick the bridge: ChatGPT exposes window.openai; a top-level window (or the
// ?standalone flag) means no host; otherwise we're embedded in an MCP host.
function detectHost(): HostMode {
  if (typeof window !== "undefined" && window.openai) return "chatgpt";
  const params = new URLSearchParams(window.location.search);
  if (params.has("standalone") || window.self === window.top) return "standalone";
  return "mcp";
}

// callTool results may arrive as the raw structuredContent or wrapped in a
// CallToolResult; normalize to the structured payload.
function structuredOf(result: unknown): unknown {
  if (result && typeof result === "object" && "structuredContent" in result) {
    return (result as { structuredContent: unknown }).structuredContent;
  }
  return result;
}

function parseJsonContent<T>(result: CallToolResult): T | null {
  for (const block of result.content ?? []) {
    if (block.type === "text") {
      try {
        return JSON.parse(block.text) as T;
      } catch {
        // not JSON; keep scanning
      }
    }
  }
  return null;
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

// Deterministic muted color from a product id, for image fallbacks.
function colorFor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 45% 55%)`;
}

// Inline SVG placeholder used when a product image fails to load (e.g. blocked
// by the host CSP). No network required.
function placeholderDataUri(p: Product): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
<rect width="400" height="300" fill="${colorFor(p.id)}"/>
<text x="200" y="150" fill="rgba(255,255,255,0.95)" font-family="system-ui,sans-serif"
 font-size="22" font-weight="600" text-anchor="middle" dominant-baseline="middle">${p.category}</text>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function emptyCart(): PricedCart {
  return {
    lines: [], itemCount: 0, subtotal: 0, discount: 0, total: 0, currency: "USD",
    unknownIds: [], hasAgeRestricted: false, ageVerified: false, loyaltyApplied: false,
  };
}


// Recompute a priced cart with one product set to an absolute quantity (0
// removes). Used for optimistic UI: the stepper updates instantly, then the
// server's authoritative cart reconciles when the tool call returns.
function withQuantity(cart: PricedCart, productId: string, quantity: number): PricedCart {
  const items: CartItemInput[] = cart.lines.map((l) => ({ productId: l.id, quantity: l.quantity }));
  const filtered = items.filter((i) => i.productId !== productId);
  if (quantity > 0) filtered.push({ productId, quantity });
  return priceCartLocal(filtered);
}

type CompletedOrder = {
  orderId: string;
  amount: number;
  currency: string;
  method?: string;
  // Present when the payment really settled on-chain via x402 (network kept
  // generic — other chains may follow). The explorer link is the proof.
  settlement?: {
    network: string;
    hashscanUrl: string;
    payer?: { accountId: string; kind?: string };
    amountTinybar?: number;
    settledInMs?: number;
  };
};

// How the payment was authorized, for the in-widget confirmation panel.
function methodLabel(method: string | undefined, settled: boolean): string {
  switch (method) {
    case "instant-demo":
      return "Instant demo";
    case "passkey":
      return settled ? "x402 · Passkey" : "Passkey";
    case "dc-payment":
      return "Cross-device passkey";
    default:
      return method ?? "—";
  }
}

// Best-effort programmatic open of the checkout page. Sandboxed widget iframes
// block plain target="_blank", so we route through the host bridge first; if the
// bridge is missing, throws, or never resolves (some hosts, e.g. Gemini, do this
// with openLink), a window.open fallback is attempted. Either way the widget also
// renders a tappable link — the guaranteed path — so this never blocks the UI.
function tryOpenCheckout(url: string, bridgeOpen?: OpenLinkFn): void {
  let opened = false;
  if (bridgeOpen) {
    try {
      void Promise.resolve(bridgeOpen(url)).catch(() => {});
      opened = true;
    } catch {
      // bridge unavailable; fall through to window.open
    }
  }
  if (!opened) {
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // popups blocked; the rendered link remains the fallback
    }
  }
}

// After checkout, poll the same-origin status endpoint until the user completes
// the purchase on the gate page. This runs in the browser — the live surface
// that can poll — so the agent is never asked to. Resolves with the order on
// completion, or null on timeout/cancel. The signal lets the component cancel
// the loop on unmount.
async function pollOrderCompletion(
  origin: string,
  orderId: string,
  signal: { cancelled: boolean },
  opts: { intervalMs?: number; maxMs?: number } = {},
): Promise<CompletedOrder | null> {
  const intervalMs = opts.intervalMs ?? 3000;
  const deadline = Date.now() + (opts.maxMs ?? 5 * 60_000);
  while (!signal.cancelled && Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/checkout/order-status?orderId=${encodeURIComponent(orderId)}`);
      if (res.ok) {
        const data = (await res.json()) as { completed?: boolean; order?: CompletedOrder };
        if (data.completed && data.order) return data.order;
      }
    } catch {
      // transient network error; keep polling
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

// Silent model context pushed after a completed purchase so the agent stays
// aware of the order (and that the cart is now empty) without drafting anything
// into the composer. The in-widget confirmation panel is the user-facing surface.
function orderContextMarkdown(order: CompletedOrder): string {
  const settled = order.settlement
    ? ` The payment settled on-chain via the x402 protocol on ${order.settlement.network}${order.settlement.amountTinybar != null ? ` (${order.settlement.amountTinybar / 1e8} HBAR moved)` : ""}${order.settlement.payer ? `, paid from ${order.settlement.payer.accountId}${order.settlement.payer.kind === "session-wallet" ? " (a fresh wallet created just for this order)" : ""}` : ""} — public proof: ${order.settlement.hashscanUrl} (share this link with the user).`
    : "";
  return `The user completed their purchase on the checkout page — order ${order.orderId}, total ${formatMoney(order.amount, order.currency)} (paid via ${methodLabel(order.method, !!order.settlement)}).${settled} The cart is now empty. If the user brings up the order, confirm these details; otherwise carry on. Show the catalog again whenever they want to keep shopping.`;
}

// Ambient context so the agent always knows the current cart (with ids) and how
// to drive checkout. updateModelContext replaces prior context, so this stays
// fresh without spamming the transcript.
function cartContextMarkdown(cart: PricedCart): string {
  if (cart.lines.length === 0) {
    return "The product picker is open. The user's cart is currently empty.";
  }
  const lines = cart.lines
    .map((l) => `- ${l.quantity}× ${l.name} (id: ${l.id}) — ${formatMoney(l.lineTotal, l.currency)}`)
    .join("\n");
  return `The user's current cart:

${lines}

Total: ${formatMoney(cart.total, cart.currency)} (${cart.itemCount} item(s)).

Drive the experience in chat: confirm the cart and ask whether to add more or check out. Adjust items by id with add-to-cart / set-quantity / remove-from-cart. You CANNOT place orders or take payment — for checkout, call the checkout tool to get a link and share it; the user completes the purchase on the merchant page with their own account.`;
}

// ----- Host mode: connects to the MCP host bridge -----

function HostApp() {
  // Seed with the bundled catalog so a widget opened by a cart-only tool (e.g.
  // get-cart, which doesn't carry the catalog) renders products immediately
  // instead of getting stuck on "Loading products…". browse-products' _meta
  // overwrites this with the same static list.
  const [products, setProducts] = useState<Product[]>(CATALOG);
  const [cart, setCart] = useState<PricedCart>(emptyCart());
  const [insets, setInsets] = useState<Insets>();
  const [confirmedOrder, setConfirmedOrder] = useState<CompletedOrder | null>(null);
  const [pendingCheckoutUrl, setPendingCheckoutUrl] = useState<string | null>(null);
  const appRef = useRef<Parameters<NonNullable<Parameters<typeof useApp>[0]["onAppCreated"]>>[0] | null>(null);
  // Mirrors `cart` so setQuantity can read the current value synchronously
  // (state is async) and compute the next optimistic cart.
  const cartRef = useRef<PricedCart>(emptyCart());

  const applyCart = useCallback((c: PricedCart) => {
    cartRef.current = c;
    setCart(c);
    appRef.current
      ?.updateModelContext({ content: [{ type: "text", text: cartContextMarkdown(c) }] })
      .catch(console.error);
  }, []);

  const { app, error } = useApp({
    appInfo: { name: "Product Picker", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app) => {
      appRef.current = app;
      // Fires for tool results the host routes to this open app — including
      // add-to-cart / set-quantity / get-cart calls the AGENT made in chat.
      // That keeps the cart badge in sync with chat-driven changes.
      app.ontoolresult = async (result) => {
        const catalog = result._meta?.[CATALOG_META_KEY] as { products?: Product[] } | undefined;
        if (catalog?.products) setProducts(catalog.products);
        const metaCart = result._meta?.[CART_META_KEY] as PricedCart | undefined;
        if (metaCart && Array.isArray(metaCart.lines)) {
          applyCart(metaCart);
          return;
        }
        const parsed = parseJsonContent<PricedCart>(result);
        if (parsed && Array.isArray(parsed.lines) && Array.isArray(parsed.unknownIds)) {
          applyCart(parsed);
        }
      };
      app.onhostcontextchanged = (params) => setInsets(params.safeAreaInsets);
      app.onerror = console.error;
    },
  });

  const setQuantity = useCallback<SetQuantityFn>(async (productId, quantity) => {
    if (!appRef.current) return;
    setConfirmedOrder(null); // editing the cart starts a new order
    setPendingCheckoutUrl(null); // …which invalidates any pending checkout link
    applyCart(withQuantity(cartRef.current, productId, quantity)); // optimistic
    const result = await appRef.current.callServerTool({
      name: "set-quantity",
      arguments: { productId, quantity },
    });
    const parsed = parseJsonContent<PricedCart>(result);
    if (parsed) applyCart(parsed); // authoritative
  }, [applyCart]);

  // Hand off to checkout: snapshot the cart into an order (server side) and open
  // the returned merchant URL in the browser. The agent does not place the order
  // or take payment — the user finishes on that page. Then poll for completion
  // and, when done, show the in-widget confirmation panel and push silent context
  // to the agent (no composer draft).
  const pollRef = useRef<{ cancelled: boolean } | null>(null);
  useEffect(() => () => { if (pollRef.current) pollRef.current.cancelled = true; }, []);
  const checkout = useCallback<CheckoutFn>(async () => {
    if (!appRef.current) return;
    // Pass the on-screen cart so the order matches exactly what the user sees,
    // independent of whether prior set-quantity calls round-tripped to the server.
    const items = cartRef.current.lines.map((l) => ({ productId: l.id, quantity: l.quantity }));
    const result = await appRef.current.callServerTool({ name: "checkout", arguments: { items } });
    const parsed = parseJsonContent<{ orderId?: string; checkoutUrl?: string }>(result);
    if (!parsed?.checkoutUrl) return;
    const { checkoutUrl, orderId } = parsed;
    // Surface the link (guaranteed tap path) and best-effort auto-open. Neither
    // is awaited: the button must not stay disabled through the open or the
    // multi-minute completion poll, and some hosts never resolve openLink.
    setConfirmedOrder(null);
    setPendingCheckoutUrl(checkoutUrl);
    tryOpenCheckout(checkoutUrl, (url) => appRef.current?.openLink({ url }));
    if (!orderId) return;
    // Poll for completion in the background; the checkout() promise has already
    // resolved, so the button is back to "Checkout" while the user pays.
    if (pollRef.current) pollRef.current.cancelled = true;
    const signal = { cancelled: false };
    pollRef.current = signal;
    void (async () => {
      const order = await pollOrderCompletion(new URL(checkoutUrl).origin, orderId, signal);
      if (!order || signal.cancelled) return;
      setPendingCheckoutUrl(null);
      setConfirmedOrder(order); // read-only confirmation panel in the widget
      // The gate clears the cart server-side; refresh the badge to match.
      const refreshed = await appRef.current?.callServerTool({ name: "get-cart", arguments: {} });
      const c = refreshed && parseJsonContent<PricedCart>(refreshed);
      if (c) applyCart(c); // applyCart pushes cart context; override with the order below
      // Silent: agent knows the order without anything landing in the composer.
      appRef.current
        ?.updateModelContext({ content: [{ type: "text", text: orderContextMarkdown(order) }] })
        .catch(console.error);
    })();
  }, [applyCart]);

  // Hooks must run unconditionally — keep this above the early returns or the
  // hook count changes when `app` connects and React unmounts the tree.
  const openLink = useCallback<OpenLinkFn>(async (url) => {
    await appRef.current?.openLink({ url });
  }, []);

  if (error) return <div className={styles.status}><strong>Error:</strong> {error.message}</div>;
  if (!app) return <div className={styles.status}>Connecting…</div>;

  return <Picker products={products} cart={cart} insets={insets} setQuantity={setQuantity} checkout={checkout} openLink={openLink} confirmedOrder={confirmedOrder} pendingCheckoutUrl={pendingCheckoutUrl} />;
}

// ----- ChatGPT mode: connects to the window.openai bridge -----
// Same UI as host mode; only the bridge differs. callServerTool → callTool,
// openLink → openExternal, and tool results
// arrive via window.openai.toolOutput (refreshed on the openai:set_globals event)
// instead of ontoolresult.

function ChatGptApp() {
  const oai = window.openai!;
  const [products, setProducts] = useState<Product[]>(CATALOG);
  const [cart, setCart] = useState<PricedCart>(emptyCart());
  const [confirmedOrder, setConfirmedOrder] = useState<CompletedOrder | null>(null);
  const [pendingCheckoutUrl, setPendingCheckoutUrl] = useState<string | null>(null);

  // browse-products yields { products, cart }; cart tools yield a PricedCart.
  const applyToolOutput = useCallback((output: unknown) => {
    if (!output || typeof output !== "object") return;
    const o = output as Record<string, unknown>;
    if (Array.isArray(o.products)) setProducts(o.products as Product[]);
    const maybeCart = (o.cart ?? o) as PricedCart;
    if (Array.isArray(maybeCart.lines)) setCart(maybeCart);
  }, []);

  useEffect(() => {
    applyToolOutput(window.openai?.toolOutput);
    const onGlobals = () => applyToolOutput(window.openai?.toolOutput);
    window.addEventListener("openai:set_globals", onGlobals);
    return () => window.removeEventListener("openai:set_globals", onGlobals);
  }, [applyToolOutput]);

  const setQuantity = useCallback<SetQuantityFn>(async (productId, quantity) => {
    setConfirmedOrder(null); // editing the cart starts a new order
    setPendingCheckoutUrl(null); // …which invalidates any pending checkout link
    setCart((prev) => withQuantity(prev, productId, quantity)); // optimistic
    const result = await oai.callTool?.("set-quantity", { productId, quantity });
    applyToolOutput(structuredOf(result)); // authoritative
  }, [oai, applyToolOutput]);

  const pollRef = useRef<{ cancelled: boolean } | null>(null);
  useEffect(() => () => { if (pollRef.current) pollRef.current.cancelled = true; }, []);
  const checkout = useCallback<CheckoutFn>(async () => {
    // Pass the on-screen cart so the order matches exactly what the user sees.
    const items = cart.lines.map((l) => ({ productId: l.id, quantity: l.quantity }));
    const result = await oai.callTool?.("checkout", { items });
    const parsed = structuredOf(result) as { orderId?: string; checkoutUrl?: string } | undefined;
    if (!parsed?.checkoutUrl) return;
    const { checkoutUrl, orderId } = parsed;
    // Surface the link + best-effort auto-open; never block the button on the
    // open or the multi-minute poll (see HostApp.checkout for the rationale).
    setConfirmedOrder(null);
    setPendingCheckoutUrl(checkoutUrl);
    tryOpenCheckout(checkoutUrl, (url) => oai.openExternal?.({ href: url }));
    if (!orderId) return;
    if (pollRef.current) pollRef.current.cancelled = true;
    const signal = { cancelled: false };
    pollRef.current = signal;
    void (async () => {
      const order = await pollOrderCompletion(new URL(checkoutUrl).origin, orderId, signal);
      if (!order || signal.cancelled) return;
      setPendingCheckoutUrl(null);
      setConfirmedOrder(order); // read-only confirmation panel in the widget
      const refreshed = await oai.callTool?.("get-cart", {});
      applyToolOutput(structuredOf(refreshed));
    })();
  }, [oai, applyToolOutput, cart]);

  const openLink = useCallback<OpenLinkFn>(async (url) => {
    await oai.openExternal?.({ href: url });
  }, [oai]);

  return <Picker products={products} cart={cart} setQuantity={setQuantity} checkout={checkout} openLink={openLink} confirmedOrder={confirmedOrder} pendingCheckoutUrl={pendingCheckoutUrl} />;
}

// ----- Standalone mode: runs in a plain browser with the local catalog -----
// No agent here, so "Add to cart" just accumulates a local cart for the badge.
// Checkout is agent-driven and only available inside an MCP host.

function StandaloneApp() {
  const [cart, setCart] = useState<PricedCart>(emptyCart());
  const qtys = useRef(new Map<string, number>());

  const setQuantity = useCallback<SetQuantityFn>(async (productId, quantity) => {
    if (quantity <= 0) qtys.current.delete(productId);
    else qtys.current.set(productId, quantity);
    const all = [...qtys.current.entries()].map(([productId, quantity]) => ({ productId, quantity }));
    setCart(priceCartLocal(all));
  }, []);

  return <Picker products={CATALOG} cart={cart} setQuantity={setQuantity} />;
}

// ----- Selection UI (the only thing that lives in the iframe) -----

interface PickerProps {
  products: Product[];
  cart: PricedCart;
  insets?: Insets;
  setQuantity: SetQuantityFn;
  checkout?: CheckoutFn;
  openLink?: OpenLinkFn;
  confirmedOrder?: CompletedOrder | null;
  // Set once checkout is minted: the merchant URL the user must finish on. The
  // widget renders it as a tappable link so checkout proceeds even when the
  // host's open bridge is unavailable (the auto-open is best-effort).
  pendingCheckoutUrl?: string | null;
}

function Picker({ products, cart, insets, setQuantity, checkout, openLink, confirmedOrder, pendingCheckoutUrl }: PickerProps) {
  const [checkingOut, setCheckingOut] = useState(false);

  // The stepper reflects the live cart: each card shows the quantity already in
  // the cart, and +/−/Add edit it directly (− to 0 removes the item).
  const qtyById = useMemo(
    () => new Map(cart.lines.map((l) => [l.id, l.quantity])),
    [cart],
  );

  const handleCheckout = useCallback(async () => {
    if (!checkout || cart.itemCount === 0) return;
    setCheckingOut(true);
    try {
      await checkout();
    } catch (e) {
      console.error(e);
    } finally {
      setCheckingOut(false);
    }
  }, [checkout, cart.itemCount]);

  const mainStyle = useMemo(
    () =>
      ({
        // Top/side insets pad the shell directly. The bottom inset is handed to
        // the footer as a CSS variable (see .footer in app.module.css) so the
        // footer's background reaches under the home indicator while its content
        // clears it — rather than padding the whole shell and leaving a bare gap
        // below the footer.
        paddingTop: insets?.top,
        paddingRight: insets?.right,
        paddingLeft: insets?.left,
        "--safe-area-bottom": insets?.bottom != null ? `${insets.bottom}px` : undefined,
      }) as CSSProperties,
    [insets],
  );

  return (
    <main className={styles.main} style={mainStyle}>
      {products.length === 0 ? (
        <div className={styles.status}>Loading products…</div>
      ) : (
        <div className={styles.grid}>
          {products.map((p) => {
            const qty = qtyById.get(p.id) ?? 0;
            return (
              <div key={p.id} className={`${styles.card} ${qty > 0 ? styles.cardSelected : ""}`}>
                <img
                  className={styles.thumb}
                  src={p.image}
                  alt={p.name}
                  onError={(e) => {
                    e.currentTarget.onerror = null;
                    e.currentTarget.src = placeholderDataUri(p);
                  }}
                />
                <div className={styles.cardBody}>
                  <span className={styles.category}>{p.category}</span>
                  <span className={styles.name}>
                    {p.name}
                    {p.minimumAge != null && <span className={styles.ageBadge}>{p.minimumAge}+</span>}
                  </span>
                  <span className={styles.desc}>{p.description}</span>
                  <div className={styles.priceRow}>
                    <span className={styles.price}>{formatMoney(p.price, p.currency)}</span>
                    {qty === 0 ? (
                      <button className={styles.addBtn} onClick={() => setQuantity(p.id, 1)}>
                        Add
                      </button>
                    ) : (
                      <div className={styles.stepper}>
                        <button
                          className={styles.qtyBtn}
                          onClick={() => setQuantity(p.id, qty - 1)}
                          aria-label={qty === 1 ? `Remove ${p.name}` : `Decrease ${p.name}`}
                        >
                          {qty === 1 ? "🗑" : "−"}
                        </button>
                        <span className={styles.qty}>{qty}</span>
                        <button
                          className={styles.qtyBtn}
                          onClick={() => setQuantity(p.id, qty + 1)}
                          aria-label={`Increase ${p.name}`}
                        >
                          +
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {confirmedOrder && (
        <div className={styles.confirmation} role="status" aria-live="polite">
          <div className={styles.confirmHeader}>✓ Order confirmed</div>
          <dl className={styles.confirmFields}>
            <div className={styles.confirmRow}>
              <dt>Order</dt>
              <dd>{confirmedOrder.orderId}</dd>
            </div>
            <div className={styles.confirmRow}>
              <dt>Total</dt>
              <dd>{formatMoney(confirmedOrder.amount, confirmedOrder.currency)}</dd>
            </div>
            <div className={styles.confirmRow}>
              <dt>Payment</dt>
              <dd>{methodLabel(confirmedOrder.method, !!confirmedOrder.settlement)}</dd>
            </div>
            {confirmedOrder.settlement && (
              <div className={styles.confirmRow}>
                <dt>Settlement</dt>
                <dd>
                  {confirmedOrder.settlement.amountTinybar != null &&
                    `${confirmedOrder.settlement.amountTinybar / 1e8} ℏ · `}
                  {confirmedOrder.settlement.network}
                  {confirmedOrder.settlement.settledInMs != null &&
                    ` · in ${(confirmedOrder.settlement.settledInMs / 1000).toFixed(1)}s`}{" "}
                  ·{" "}
                  <a
                    href={confirmedOrder.settlement.hashscanUrl}
                    onClick={(e) => {
                      // Sandboxed iframe: plain target="_blank" is blocked by the
                      // host. Route through the bridge like the checkout link.
                      e.preventDefault();
                      const url = confirmedOrder.settlement!.hashscanUrl;
                      if (openLink) void openLink(url);
                      else window.open(url, "_blank", "noopener");
                    }}
                  >
                    View on HashScan ↗
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {pendingCheckoutUrl && !confirmedOrder && (
        <div className={styles.pending} role="status" aria-live="polite">
          <div className={styles.pendingHeader}>Finish in your browser</div>
          <p className={styles.pendingText}>
            A secure checkout page is opening. Clear the checks there — age,
            payment — and once you pass them all, your order confirmation appears
            right here. If the page didn’t open, tap below.
          </p>
          <a
            className={styles.continueLink}
            href={pendingCheckoutUrl}
            onClick={(e) => {
              // Sandboxed iframe: a plain target="_blank" is blocked. Route the
              // tap through the host bridge, falling back to window.open.
              e.preventDefault();
              if (openLink) void openLink(pendingCheckoutUrl);
              else window.open(pendingCheckoutUrl, "_blank", "noopener");
            }}
          >
            Continue to checkout ↗
          </a>
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.summary}>
          {cart.itemCount > 0
            ? `🛒 ${cart.itemCount} in cart · ${formatMoney(cart.total, cart.currency)}`
            : "🛒 Cart is empty"}
        </span>
        {checkout && cart.itemCount > 0 && !pendingCheckoutUrl && (
          <button
            className={styles.checkout}
            disabled={checkingOut}
            onClick={handleCheckout}
          >
            {checkingOut ? "Opening…" : "Checkout"}
          </button>
        )}
      </div>
    </main>
  );
}

const HOST_MODE = detectHost();
const Root =
  HOST_MODE === "chatgpt" ? ChatGptApp : HOST_MODE === "standalone" ? StandaloneApp : HostApp;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
