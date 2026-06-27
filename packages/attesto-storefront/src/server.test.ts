// Contract tests for createStorefront — drives the real MCP server over an
// in-memory transport (deterministic). Covers CT1 (9 tools), CT2/CT3 (checkout
// gated/ungated), CT5 (ui resource + the 6/3 UI-linked split), CT6 (state
// isolation), CT9/FR-014 (the ChatGPT widget meta — widgetAccessible).

import { describe, it, expect } from "vitest";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStorefront, originFromRequest, type Storefront } from "./server.js";
import { Attesto, age, membership, payment, required, optional } from "@openmobilehub/attesto-gate";
import type { Request } from "express";

const mockReq = (headers: Record<string, string>, protocol = "http"): Request =>
  ({ headers, protocol } as unknown as Request);

const ALL_TOOLS = [
  "browse-products", "add-to-cart", "set-quantity", "remove-from-cart", "get-cart",
  "get-product-details", "get-product-reviews", "checkout", "get-order-status",
];
const UI_LINKED = ["browse-products", "add-to-cart", "set-quantity", "remove-from-cart", "get-cart", "checkout"];
const PLAIN = ["get-product-details", "get-product-reviews", "get-order-status"];

async function connect(store: Storefront): Promise<Client> {
  const server = store.mcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "storefront-test", version: "1.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("CT1 — the nine tools are registered", () => {
  it("exposes exactly the nine shopping tools", async () => {
    const names = (await (await connect(createStorefront())).listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...ALL_TOOLS].sort());
  });
});

describe("CT9 / FR-014 — the ChatGPT widget meta (the 6/3 split)", () => {
  it("the six UI-linked tools carry widgetAccessible + outputTemplate; the three plain do NOT", async () => {
    const tools = (await (await connect(createStorefront())).listTools()).tools;
    const meta = (n: string) => tools.find((t) => t.name === n)?._meta as Record<string, unknown> | undefined;
    for (const n of UI_LINKED) {
      expect(meta(n)?.["openai/widgetAccessible"], `${n} widgetAccessible`).toBe(true);
      expect(meta(n)?.["openai/outputTemplate"], `${n} outputTemplate`).toBeTruthy();
      expect((meta(n)?.ui as { resourceUri?: string })?.resourceUri, `${n} ui.resourceUri`).toBeTruthy();
    }
    for (const n of PLAIN) {
      expect(meta(n)?.["openai/widgetAccessible"], `${n} should be plain`).toBeUndefined();
    }
  });
});

describe("CT2/CT3 — checkout (Mode A), ungated vs gated", () => {
  it("ungated ⇒ checkoutUrl + cart, no requires", async () => {
    const c = await connect(createStorefront());
    const sc = (await c.callTool({ name: "checkout", arguments: { items: [{ productId: "oak-whiskey", quantity: 1 }] } })).structuredContent as any;
    expect(sc.checkoutUrl).toContain("/checkout?order=");
    expect(sc.requires).toBeUndefined();
    expect(sc.cart.lines[0].id).toBe("oak-whiskey"); // cart-bearing (FR-014)
  });
  it("gated ⇒ requires surfaces", async () => {
    const store = createStorefront();
    store.gate((order) => (order.lines.some((l) => l.minimumAge != null) ? [{ credential: "age", minAge: 21 }] : []));
    const c = await connect(store);
    const sc = (await c.callTool({ name: "checkout", arguments: { items: [{ productId: "oak-whiskey", quantity: 1 }] } })).structuredContent as any;
    expect(sc.requires?.find((e: any) => e.credential === "age")?.minAge).toBe(21);
  });
});

describe("origin derivation — absolute checkout URLs behind a proxy", () => {
  it("prefers x-forwarded-* (Vercel/tunnel), else Host; strips trailing slash", () => {
    expect(originFromRequest(mockReq({ "x-forwarded-proto": "https", "x-forwarded-host": "preview.vercel.app" })))
      .toBe("https://preview.vercel.app");
    // proxy may send a comma list; take the first hop
    expect(originFromRequest(mockReq({ "x-forwarded-proto": "https, http", "x-forwarded-host": "a.example, b" })))
      .toBe("https://a.example");
    // no forwarded headers ⇒ fall back to Host + req.protocol
    expect(originFromRequest(mockReq({ host: "localhost:3005" }))).toBe("http://localhost:3005");
    // nothing to go on ⇒ empty (caller keeps the relative path)
    expect(originFromRequest(mockReq({}))).toBe("");
  });
});

describe("CT5 — the widget ui:// resource is registered", () => {
  it("registers a ui:// widget resource (the bundle the UI-linked tools point at)", async () => {
    const c = await connect(createStorefront());
    const uris = (await c.listResources()).resources.map((r) => r.uri);
    expect(uris.some((u) => u.startsWith("ui://"))).toBe(true);
    // (Reading the bundle exercises loadBundle from dist/ui at runtime; the build
    // produces it and the manual host check (T031) confirms it renders.)
  });
});

describe("checkout completion round-trip — the HTTP form post the widget poll depends on", () => {
  it("place-order (urlencoded form) records completion that order-status then reports", async () => {
    const store = createStorefront(); // app + mcpServer share the same closure stores
    const c = await connect(store);
    const sc = (await c.callTool({ name: "checkout", arguments: { items: [{ productId: "drift-mouse", quantity: 1 }] } })).structuredContent as any;
    const orderId = sc.orderId as string;

    // Not completed until the buyer finishes on the page.
    const before = await request(store.app).get(`/checkout/order-status?orderId=${orderId}`);
    expect(before.body.completed).toBe(false);

    // The checkout page submits application/x-www-form-urlencoded — the app must
    // parse it or `req.body.order` is undefined and completion is never recorded.
    await request(store.app).post("/checkout/place-order").type("form").send({ order: orderId }).expect(200);

    // The widget's poll now sees the completed order.
    const after = await request(store.app).get(`/checkout/order-status?orderId=${orderId}`);
    expect(after.body.completed).toBe(true);
    expect(after.body.order?.orderId).toBe(orderId);
  });
});

// The unified three-gate checkout page (T030): the storefront renders the SAME
// renderRequirements() page as the committed demo. Drives the real GET /checkout
// over supertest; the manifest's approveUrls home onto this server's mounted routes.
describe("GET /checkout — the shared three-gate page (renderRequirements)", () => {
  function gatedStore(): Storefront {
    const store = createStorefront();
    const attesto = new Attesto();
    attesto.mount(store.app);
    store.gate((order) =>
      attesto.requirements(order, [
        required(age.over(21).when((o: { lines: { minimumAge?: number }[] }) => o.lines.some((l) => l.minimumAge != null))),
        optional(membership.discount(10)),
        required(payment.in("usd")),
      ]),
    );
    return store;
  }

  const checkoutId = async (c: Client, productId: string): Promise<string> =>
    ((await c.callTool({ name: "checkout", arguments: { items: [{ productId, quantity: 1 }] } })).structuredContent as any).orderId;

  it("a gated alcohol order locks payment behind the age gate and links each gate to its mounted approveUrl — NO bypass button", async () => {
    const store = gatedStore();
    const orderId = await checkoutId(await connect(store), "oak-whiskey");
    const res = await request(store.app).get(`/checkout?order=${orderId}`);
    expect(res.status).toBe(200);
    // Numbered gates linking to the mounted ceremony routes (route-agnostic render).
    expect(res.text).toContain("/attesto/credential?order=");
    expect(res.text).toContain("cred=age");
    // Payment is withheld until age is proven (presentation reflects the server gate).
    expect(res.text).toContain("Payment is locked");
    // The confusing "Complete purchase (demo)" bypass is gone on a gated order.
    expect(res.text).not.toContain("Complete purchase (demo)");
    // The presence-only honesty note is intact (FR-011).
    expect(res.text).toContain("presence-only-demo");
  });

  it("once age is proven, the gated order offers the mounted payment rail as the Pay CTA (still no bypass)", async () => {
    const store = gatedStore();
    const orderId = await checkoutId(await connect(store), "oak-whiskey");
    await request(store.app).post("/attesto/credential/verify").send({ order: orderId, cred: "age", claims: { age_over_21: true } });
    const res = await request(store.app).get(`/checkout?order=${orderId}`);
    expect(res.text).not.toContain("Payment is locked");
    expect(res.text).toContain("Age verified");
    expect(res.text).toContain("/attesto/dc-payment?order="); // the payment rail, as the Pay CTA
    expect(res.text).not.toContain("Complete purchase (demo)");
  });

  it("an ungated order keeps a simple instant-demo complete path", async () => {
    const store = createStorefront(); // ungated
    const orderId = await checkoutId(await connect(store), "drift-mouse");
    const res = await request(store.app).get(`/checkout?order=${orderId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Complete purchase (demo)");
    expect(res.text).not.toContain("Payment is locked");
  });
});

describe("CT6 — cart state is per storefront instance (no bleed)", () => {
  it("two storefronts keep independent carts", async () => {
    const a = await connect(createStorefront());
    const b = await connect(createStorefront());
    await a.callTool({ name: "add-to-cart", arguments: { items: [{ productId: "oak-whiskey", quantity: 2 }] } });
    const bCart = (await b.callTool({ name: "get-cart", arguments: {} })).structuredContent as any;
    expect(bCart.cart.itemCount).toBe(0); // a's add did not leak into b
  });
});
