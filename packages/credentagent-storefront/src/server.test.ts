// Contract tests for createStorefront — drives the real MCP server over an
// in-memory transport (deterministic). Covers CT1 (9 tools), CT2/CT3 (checkout
// gated/ungated), CT5 (ui resource + the 6/3 UI-linked split), CT6 (state
// isolation), CT9/FR-014 (the ChatGPT widget meta — widgetAccessible).

import { describe, it, expect } from "vitest";
import request from "supertest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { createStorefront, originFromRequest, type Storefront } from "./server.js";
import { redisStorage, type RedisLike } from "./redis.js";
import { firestoreCatalog, type FirestoreLike } from "./firestore.js";
import { MemoryOrderStore } from "./state.js";
import { CredentAgent, age, membership, payment, required, optional, MemoryVerificationStore } from "@openmobilehub/credentagent-gate";
import type { Request } from "express";

// A Map-backed RedisLike fake so a `redisStorage(...)` provider can be exercised through
// createStorefront without a live Redis.
function fakeRedis(): RedisLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async get<T = unknown>(key: string): Promise<T | null> {
      return store.has(key) ? (store.get(key) as T) : null;
    },
    async set(key: string, value: unknown): Promise<unknown> {
      store.set(key, JSON.parse(JSON.stringify(value)));
      return "OK";
    },
    async del(key: string): Promise<unknown> {
      return store.delete(key) ? 1 : 0;
    },
  };
}

const mockReq = (headers: Record<string, string>, protocol = "http"): Request =>
  ({ headers, protocol } as unknown as Request);

// A fake Firestore so a `firestoreCatalog(...)` source can be driven through createStorefront
// with no live Firebase. `fail(true)` simulates an unreachable backend.
function fakeFirestore(
  docs: Array<{ id: string; data: Record<string, unknown> }>,
): FirestoreLike & { fail: (v: boolean) => void } {
  let failing = false;
  return {
    fail: (v: boolean) => { failing = v; },
    collection() {
      return {
        async get() {
          if (failing) throw new Error("firestore unreachable");
          return { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) };
        },
      };
    },
  };
}

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

// Multi-instance serverless (e.g. Vercel) has no session affinity: a request can land on
// a different instance than the one that served its `initialize`. Two independent
// createStorefront apps model two instances (separate in-memory session maps). Establish
// the MCP session on app A, then replay the follow-up on app B carrying A's session id.
const initReq = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
const listReq = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("serverless session survival — a follow-up on another instance", () => {
  it("stateful (default) rejects the cross-instance follow-up with 'No valid session'", async () => {
    const a = createStorefront({ signingKey: "k" });
    const b = createStorefront({ signingKey: "k" });
    const init = await request(a.app).post("/mcp").set(MCP_HEADERS).send(initReq);
    const sid = init.headers["mcp-session-id"];
    expect(sid).toBeTruthy(); // stateful mode issues a session id
    const followUp = await request(b.app).post("/mcp").set({ ...MCP_HEADERS, "mcp-session-id": sid }).send(listReq);
    // Reproduces the production symptom: the widget's follow-up tool call is refused.
    expect(followUp.body?.error?.message).toBe("No valid session");
  });

  it("statelessMcp handles the cross-instance follow-up (no session, so nothing to lose)", async () => {
    const a = createStorefront({ signingKey: "k", statelessMcp: true });
    const b = createStorefront({ signingKey: "k", statelessMcp: true });
    const init = await request(a.app).post("/mcp").set(MCP_HEADERS).send(initReq);
    expect(init.headers["mcp-session-id"]).toBeUndefined(); // stateless issues none
    // A "follow-up" on instance B is just an independent request; it succeeds.
    const list = await request(b.app).post("/mcp").set(MCP_HEADERS).send(listReq);
    expect(list.status).toBe(200);
    expect(list.text).not.toContain("No valid session");
  });
});

// The unified three-gate checkout page (T030): the storefront renders the SAME
// renderRequirements() page as the committed demo. Drives the real GET /checkout
// over supertest; the manifest's approveUrls home onto this server's mounted routes.
describe("GET /checkout — the shared three-gate page (renderRequirements)", () => {
  function gatedStore(): Storefront {
    const store = createStorefront();
    const credentagent = new CredentAgent();
    credentagent.mount(store.app);
    store.gate((order) =>
      credentagent.requirements(order, [
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
    expect(res.text).toContain("/credentagent/credential?order=");
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
    await request(store.app).post("/credentagent/credential/verify").send({ order: orderId, cred: "age", claims: { age_over_21: true } });
    const res = await request(store.app).get(`/checkout?order=${orderId}`);
    expect(res.text).not.toContain("Payment is locked");
    expect(res.text).toContain("Age verified");
    expect(res.text).toContain("/credentagent/dc-payment?order="); // the payment rail, as the Pay CTA
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

  // BYPASS (Security invariant 1, load-bearing): the instant-demo place-order path
  // completes WITHOUT a device ceremony, so it must refuse a GATED order — otherwise a
  // direct POST of an age-restricted order id completes with NO age proof (the UI hides
  // the button on gated orders, but hiding a button is not enforcement). This test FAILS
  // if the server-side gated check is removed.
  it("BYPASS: a gated order POSTed straight to place-order is refused server-side, records nothing", async () => {
    const store = gatedStore();
    const orderId = await checkoutId(await connect(store), "oak-whiskey");
    // Direct POST of the gated, age-restricted order id to the instant-demo path.
    await request(store.app).post("/checkout/place-order").type("form").send({ order: orderId }).expect(403);
    // Nothing recorded — order-status stays pending (no completion written).
    const status = await request(store.app).get(`/checkout/order-status?orderId=${orderId}`);
    expect(status.body.completed).toBe(false);
  });

  // The same gated order DOES complete once it runs the real ceremony through the
  // mounted rails (age proof → dc-payment) — so the refusal above was the gate, not an
  // unrelated failure.
  it("the refused gated order completes through the mounted payment gate (age proof → dc-payment)", async () => {
    const store = gatedStore();
    const orderId = await checkoutId(await connect(store), "oak-whiskey");
    await request(store.app).post("/credentagent/credential/verify").send({ order: orderId, cred: "age", claims: { age_over_21: true } });
    const pay = await request(store.app).post("/credentagent/dc-payment/verify").send({
      order: orderId,
      claims: { payment_instrument_id: "acct_demo_1", expiry_date: "2031-12-31", masked_account_reference: "•••• 4242", issuer_name: "Demo Bank", holder_name: "T" },
    });
    expect(pay.body.completed).toBe(true);
    const status = await request(store.app).get(`/checkout/order-status?orderId=${orderId}`);
    expect(status.body.completed).toBe(true);
  });
});

describe("dynamic catalog source (spec 006) — createStorefront({ catalog: firestoreCatalog(...) })", () => {
  const DOCS = [
    { id: "oak-whiskey", data: { name: "Oak Reserve", price: 124, currency: "USD", category: "Beverages", minimumAge: 21 } },
    { id: "drift-mouse", data: { name: "Drift Mouse", price: 49, currency: "USD", category: "Electronics" } },
  ];

  const checkoutId = async (c: Client, productId: string): Promise<string> =>
    ((await c.callTool({ name: "checkout", arguments: { items: [{ productId, quantity: 1 }] } })).structuredContent as any).orderId;

  function gatedDynamicStore(fs: FirestoreLike): Storefront {
    const store = createStorefront({ catalog: firestoreCatalog({ client: fs }) });
    const credentagent = new CredentAgent();
    credentagent.mount(store.app);
    store.gate((order) =>
      credentagent.requirements(order, [
        required(age.over(21).when((o: { lines: { minimumAge?: number }[] }) => o.lines.some((l) => l.minimumAge != null))),
        required(payment.in("usd")),
      ]),
    );
    return store;
  }

  it("serves the Firestore-loaded catalog through the tools (incl. the doc's age threshold)", async () => {
    const c = await connect(createStorefront({ catalog: firestoreCatalog({ client: fakeFirestore(DOCS) }) }));
    const res = (await c.callTool({ name: "browse-products", arguments: {} })).structuredContent as any;
    expect(res.products.map((p: any) => p.id).sort()).toEqual(["drift-mouse", "oak-whiskey"]);
    expect(res.products.find((p: any) => p.id === "oak-whiskey").minimumAge).toBe(21);
  });

  it("re-derives the age gate from the LIVE catalog on the checkout path (invariant 2)", async () => {
    const store = gatedDynamicStore(fakeFirestore(DOCS));
    const orderId = await checkoutId(await connect(store), "oak-whiskey");
    const res = await request(store.app).get(`/checkout?order=${orderId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("cred=age"); // the age gate, derived from the doc's minimumAge
    expect(res.text).toContain("Payment is locked"); // withheld until age is proven
  });

  // BYPASS (Security invariant 1): a gated dynamic-catalog order POSTed straight to the
  // instant-demo path is refused server-side, exactly like a static-catalog gated order.
  it("BYPASS: a gated order over a dynamic catalog is refused at place-order (403)", async () => {
    const store = gatedDynamicStore(fakeFirestore(DOCS));
    const orderId = await checkoutId(await connect(store), "oak-whiskey");
    await request(store.app).post("/checkout/place-order").type("form").send({ order: orderId }).expect(403);
    const status = await request(store.app).get(`/checkout/order-status?orderId=${orderId}`);
    expect(status.body.completed).toBe(false);
  });

  // FAIL-CLOSED (Security invariant 2, load-bearing): an unreachable cold load must REFUSE
  // every request (503) rather than serve an empty catalog. FAILS if the prime middleware /
  // fail-closed path is removed (the request would proceed against an absent catalog).
  it("FAIL-CLOSED: an unreachable cold catalog load makes requests 503", async () => {
    const fs = fakeFirestore(DOCS);
    fs.fail(true); // down on the FIRST (cold) load — no last-known-good
    const store = createStorefront({ catalog: firestoreCatalog({ client: fs }) });
    const res = await request(store.app).get(`/checkout/order-status?orderId=whatever`);
    expect(res.status).toBe(503);
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

describe("storage provider — per-slot resolution (US2/US3 · FR-002, FR-006)", () => {
  it("no storage and no explicit store ⇒ in-memory default (FR-002 / CT-1)", () => {
    const provider = redisStorage({ client: fakeRedis() });
    const plain = createStorefront();
    const withProvider = createStorefront({ storage: provider });
    // When a provider is given, its store is used…
    expect(withProvider.app.locals.credentagent.verificationStore).toBe(provider.verificationStore);
    // …but the zero-config default is a fresh in-memory store, NOT the provider's.
    expect(plain.app.locals.credentagent.verificationStore).not.toBe(provider.verificationStore);
  });

  it("an explicit store overrides the provider for its slot (FR-006 / CT-3)", () => {
    const provider = redisStorage({ client: fakeRedis() });
    const explicit = new MemoryVerificationStore();
    const store = createStorefront({ storage: provider, verificationStore: explicit });
    expect(store.app.locals.credentagent.verificationStore).toBe(explicit);
    expect(store.app.locals.credentagent.verificationStore).not.toBe(provider.verificationStore);
  });

  it("override is per-slot: an injected completed-order store gets the write; the provider's does not", async () => {
    const providerClient = fakeRedis();
    const provider = redisStorage({ client: providerClient, namespace: "prov" });
    const explicitOrders = new MemoryOrderStore<{ orderId: string }>();
    const store = createStorefront({ storage: provider, orderStore: explicitOrders });

    // an un-overridden slot still comes from the provider
    expect(store.app.locals.credentagent.verificationStore).toBe(provider.verificationStore);

    // drive an ungated completion; the explicit completed-order store must receive the write
    const c = await connect(store);
    const orderId = ((await c.callTool({ name: "checkout", arguments: { items: [{ productId: "drift-mouse", quantity: 1 }] } })).structuredContent as any).orderId;
    await request(store.app).post("/checkout/place-order").type("form").send({ order: orderId }).expect(200);

    expect(await explicitOrders.read(orderId)).toBeTruthy(); // explicit store got the completion
    expect(providerClient.store.has(`prov:order:completed:${orderId}`)).toBe(false); // provider's completed store untouched
  });
});

describe("in-memory default stays lean (US2 · FR-008)", () => {
  it("createStorefront() builds and serves with no storage option", async () => {
    const names = (await (await connect(createStorefront())).listTools()).tools.map((t) => t.name);
    expect(names.length).toBe(9); // the nine tools — the zero-config path is intact
  });

  it("the ./server module does not statically import @upstash/redis", () => {
    // Guard: the persistent dep must stay OFF the default path — it is only reachable via
    // the separate ./redis subpath (loaded lazily there). If someone adds a static import
    // to server.ts, the lean in-memory install regresses and this fails.
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf-8");
    expect(src.includes("@upstash/redis")).toBe(false);
  });
});

describe("storage errors do not fall back to in-memory (Polish · FR-012)", () => {
  it("a provider whose backend is down keeps its store (no silent memory fallback)", async () => {
    const throwing: RedisLike = {
      async get() {
        throw new Error("backend down");
      },
      async set() {
        throw new Error("backend down");
      },
      async del() {
        throw new Error("backend down");
      },
    };
    const provider = redisStorage({ client: throwing });
    const store = createStorefront({ storage: provider });
    // The resolved store IS the provider's (not a MemoryVerificationStore), so ops reject
    // rather than silently succeeding against process-local memory.
    expect(store.app.locals.credentagent.verificationStore).toBe(provider.verificationStore);
    await expect(store.app.locals.credentagent.verificationStore.read("ORD-1")).rejects.toThrow(/backend down/);
  });
});

// Per-session carts (issue #34): drive TWO real MCP clients over one HTTP server — each
// establishes its own session (mcp-session-id) — and assert their carts don't bleed.
describe("per-session carts over HTTP (issue #34 · Security Invariant #4)", () => {
  it("two MCP sessions on one server get independent carts", async () => {
    const store = createStorefront();
    const httpServer = store.app.listen(0);
    await new Promise<void>((resolve) => httpServer.on("listening", () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;
    const url = new URL(`http://localhost:${port}/mcp`);

    const a = new Client({ name: "shopper-a", version: "1.0.0" });
    const b = new Client({ name: "shopper-b", version: "1.0.0" });
    await a.connect(new StreamableHTTPClientTransport(url));
    await b.connect(new StreamableHTTPClientTransport(url));

    // Shopper A adds whiskey to A's cart…
    await a.callTool({ name: "add-to-cart", arguments: { items: [{ productId: "oak-whiskey", quantity: 2 }] } });

    const bCart = (await b.callTool({ name: "get-cart", arguments: {} })).structuredContent as any;
    const aCart = (await a.callTool({ name: "get-cart", arguments: {} })).structuredContent as any;
    // …B's cart is independent (empty) — fails if the cart isn't keyed by session —
    // and A still sees its own 2.
    expect(bCart.cart.itemCount).toBe(0);
    expect(aCart.cart.itemCount).toBe(2);

    await a.close();
    await b.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
});

// statelessOrders (gate FR-007): the checkout link carries the signed Cart Mandate
// instead of a createdOrderStore write; the page reconstructs + verifies it. The store
// here THROWS on read, so any passing test also proves no created-order store read.
describe("statelessOrders — the cart mandate is the order transport (FR-007)", () => {
  const makeStateless = (): Storefront => {
    const store = createStorefront({
      statelessOrders: true,
      allowEphemeralKey: true, // single-process test; a real multi-instance deploy passes a stable signingKey
      baseUrl: "http://shop.test",
      createdOrderStore: {
        read: () => { throw new Error("createdOrderStore.read must NOT happen under statelessOrders"); },
        write: async () => { throw new Error("createdOrderStore.write must NOT happen under statelessOrders"); },
      },
    });
    const credentagent = new CredentAgent();
    credentagent.mount(store.app);
    store.gate((order) => credentagent.requirements(order, [required(age.over(21).when((o) => o.lines.some((l) => (l.minimumAge ?? 0) >= 21)))]));
    return store;
  };
  const checkoutUrl = async (store: Storefront): Promise<URL> => {
    const sc = (await (await connect(store)).callTool({ name: "checkout", arguments: { items: [{ productId: "oak-whiskey", quantity: 1 }] } })).structuredContent as any;
    return new URL(sc.checkoutUrl);
  };

  it("checkout returns a link (and approve links) carrying the signed cart mandate", async () => {
    const store = makeStateless();
    const sc = (await (await connect(store)).callTool({ name: "checkout", arguments: { items: [{ productId: "oak-whiskey", quantity: 1 }] } })).structuredContent as any;
    expect(sc.checkoutUrl).toMatch(/[?&]cart=[A-Za-z0-9_-]+/);
    expect(sc.requires?.[0]?.approveUrl).toMatch(/[?&]cart=[A-Za-z0-9_-]+/); // the age gate link too
  });

  it("GET /checkout renders from the mandate with NO created-order store read", async () => {
    const store = makeStateless();
    const url = await checkoutUrl(store);
    const res = await request(store.app).get(url.pathname + url.search);
    expect(res.status).toBe(200); // reconstructed from ?cart; the throwing store was never read
  });

  it("BYPASS: a tampered cart mandate resolves nothing (fails closed → 404)", async () => {
    const store = makeStateless();
    const url = await checkoutUrl(store);
    // Keep valid JSON + valid lines but break the signature (edit the sealed cart).
    const m = JSON.parse(Buffer.from(url.searchParams.get("cart")!, "base64url").toString("utf8"));
    m.lines = [{ id: "oak-whiskey", quantity: 99, unitPrice: 124, lineTotal: 12276 }];
    url.searchParams.set("cart", Buffer.from(JSON.stringify(m)).toString("base64url"));
    const res = await request(store.app).get(url.pathname + "?" + url.searchParams.toString());
    expect(res.status).toBe(404); // verifyCartMandate refuses the edited cart → resolveCreated null
  });
});

// Full checkout walk in BOTH custody modes — the regression Diego hit: after the age
// gate, the "return to checkout" link must carry the cart under statelessOrders, or the
// store-less hub 404s ("Unknown order"). Walks checkout → age gate → back-to-checkout →
// dc-payment → completed, and asserts the return hop RESOLVES in both modes.
describe.each([
  ["stateful", false],
  ["stateless", true],
])("full checkout walk — %s (age gate → back to checkout → pay)", (_mode, stateless) => {
  const DC_CLAIMS = { issuer_name: "Demo Bank", payment_instrument_id: "pi-77AABBCC", holder_name: "Demo Buyer", expiry_date: "2032-09-01" };
  const build = (): Storefront => {
    const store = createStorefront({ statelessOrders: stateless, allowEphemeralKey: true, baseUrl: "http://shop.test" });
    const a = new CredentAgent();
    a.mount(store.app);
    store.gate((order) => a.requirements(order, [required(age.over(21).when((o) => o.lines.some((l) => (l.minimumAge ?? 0) >= 21)))]));
    return store;
  };

  it("walks checkout → age → return-to-checkout (resolves, not 'Unknown order') → dc-payment → completed", async () => {
    const store = build();
    const sc = (await (await connect(store)).callTool({ name: "checkout", arguments: { items: [{ productId: "oak-whiskey", quantity: 1 }] } })).structuredContent as any;
    const orderId: string = sc.orderId;
    const cart = new URL(sc.checkoutUrl).searchParams.get("cart");
    // the link carries the cart iff stateless
    expect(!!cart).toBe(stateless);

    // the checkout hub resolves the order
    const hubUrl = new URL(sc.checkoutUrl);
    expect((await request(store.app).get(hubUrl.pathname + hubUrl.search)).status).toBe(200);

    // the age gate page — its returnUrl must carry the cart under statelessOrders
    const ageUrl = new URL(sc.requires.find((r: any) => String(r.approveUrl).includes("cred=age")).approveUrl);
    const agePage = await request(store.app).get(ageUrl.pathname + ageUrl.search);
    expect(agePage.status).toBe(200);
    const returnUrl: string = JSON.parse(agePage.text.match(/const RETURN_URL = ("(?:[^"\\]|\\.)*")/)![1]);
    expect(returnUrl.includes("cart=")).toBe(stateless);

    // prove age (instant demo)
    const verified = await request(store.app).post("/credentagent/credential/verify").send({ order: orderId, cred: "age", cart, claims: { age_over_21: true } });
    expect(verified.body.verified).toBe(true);

    // THE REGRESSION: returning to checkout must resolve the order (was 404 statelessly)
    const back = await request(store.app).get(returnUrl);
    expect(back.status).toBe(200);
    expect(back.text).not.toContain("Unknown order");

    // pay → complete through the shared seam (age already proven above)
    const done = await request(store.app).post("/credentagent/dc-payment/verify").send({ order: orderId, cart, amount: 124, claims: DC_CLAIMS });
    expect(done.body.completed).toBe(true);
  });
});

// statelessOrders + UNGATED instant-demo place-order: the "Place order (instant demo)"
// button must forward the cart, or the store-less server can't record the order. (This
// path only shows when resolveGate returns [] — here headphones under an alcohol-only gate.)
describe("statelessOrders — ungated instant-demo place-order carries the cart", () => {
  const buildUngated = (): Storefront => {
    const store = createStorefront({ statelessOrders: true, allowEphemeralKey: true, baseUrl: "http://shop.test" });
    const a = new CredentAgent();
    a.mount(store.app);
    // Only gate alcohol → headphones are UNGATED → the instant-demo place-order button shows.
    a; store.gate((order) => a.requirements(order, [required(age.over(21).when((o) => o.lines.some((l) => (l.minimumAge ?? 0) >= 21)))]));
    return store;
  };

  it("the checkout page's place-order script forwards the cart (regression: it dropped it)", async () => {
    const store = buildUngated();
    const sc = (await (await connect(store)).callTool({ name: "checkout", arguments: { items: [{ productId: "aurora-headphones", quantity: 1 }] } })).structuredContent as any;
    const url = new URL(sc.checkoutUrl);
    const page = await request(store.app).get(url.pathname + url.search);
    expect(page.status).toBe(200);
    expect(page.text).toContain("const CART = new URLSearchParams"); // the fix: cart read + forwarded
  });

  it("place-order with the cart records the order on a store-less server", async () => {
    const store = buildUngated();
    const sc = (await (await connect(store)).callTool({ name: "checkout", arguments: { items: [{ productId: "aurora-headphones", quantity: 1 }] } })).structuredContent as any;
    const cart = new URL(sc.checkoutUrl).searchParams.get("cart");
    const placed = await request(store.app).post("/checkout/place-order").send({ order: sc.orderId, cart });
    expect(placed.status).toBe(200);
    // recorded ⇒ order-status reports completed (was impossible without the cart)
    const status = await request(store.app).get(`/checkout/order-status?orderId=${sc.orderId}`);
    expect(status.body.completed).toBe(true);
  });
});

// statelessOrders needs a STABLE signing key (its whole point is surviving an instance
// split — a per-process random key would make a mandate minted on instance A fail on B).
// Fail fast unless a signingKey is given or allowEphemeralKey is explicit (dev/tests).
describe("statelessOrders — requires a stable signingKey (fail fast)", () => {
  it("throws when statelessOrders is on with no signingKey and no allowEphemeralKey", () => {
    expect(() => createStorefront({ statelessOrders: true })).toThrow(/statelessOrders requires a stable/);
  });
  it("accepts a configured signingKey (the multi-instance-correct path)", () => {
    expect(() => createStorefront({ statelessOrders: true, signingKey: "stable-secret" })).not.toThrow();
  });
  it("accepts an explicit allowEphemeralKey (single-process dev / tests)", () => {
    expect(() => createStorefront({ statelessOrders: true, allowEphemeralKey: true })).not.toThrow();
  });
  it("stateful (default) never requires a key", () => {
    expect(() => createStorefront({})).not.toThrow();
  });
});
