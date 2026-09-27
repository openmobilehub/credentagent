// MCP 2026-07-28 over the real /mcp route: the session-less, per-request protocol revision,
// served next to the 2025-era one on the same endpoint.
//
// Two things change for this store on 2026-07-28, and each has a bypass test here:
//   • there are no sessions, so there is no session to key a server-side cart by — a request
//     must never fall back to one cart shared by every client (Security invariant 4);
//   • "I need more information" is a real protocol answer (`input_required`), and the
//     `requestState` a client echoes back is attacker-controlled — a forged one never counts.

import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CredentAgent } from "@openmobilehub/credentagent-gate";
import { createStorefront } from "./server.js";
import type { Storefront } from "./server.js";
import { MemoryCartStore } from "./state.js";
import { readFileSync } from "node:fs";

const MODERN = "2026-07-28";

// The gate's priced catalog (dollars) — mirrors the sample storefront catalog it gates.
const GATE_CATALOG = {
  "court-sneakers": { price: 95, category: "Apparel" },
  "oak-whiskey": { price: 124, minAge: 21, category: "Beverages" },
  "drift-mouse": { price: 49, category: "Electronics" },
  "aurora-headphones": { price: 199, category: "Audio" },
};
const agent = () => new CredentAgent({ walletOrigin: "http://localhost:3005", catalog: GATE_CATALOG });
const grantStore = (ca: CredentAgent = agent()) =>
  createStorefront({ grants: ca.grants, merchant: "utopia", approvalHoldMs: 0 });

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function serve(store: Storefront): Promise<URL> {
  const http = store.app.listen(0);
  await new Promise<void>((resolve) => http.on("listening", () => resolve()));
  open.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  return new URL(`http://localhost:${(http.address() as AddressInfo).port}/mcp`);
}

/** A client pinned to 2026-07-28 — it never falls back to the 2025 handshake. */
async function modernClient(url: URL, capabilities: Record<string, unknown> = {}): Promise<Client> {
  const c = new Client({ name: "modern", version: "1.0.0" }, { capabilities, versionNegotiation: { mode: { pin: MODERN } } });
  await c.connect(new StreamableHTTPClientTransport(url));
  open.push(() => c.close());
  return c;
}

const sc = (r: Awaited<ReturnType<Client["callTool"]>>) => r.structuredContent as Record<string, any>;

describe("one /mcp endpoint, both protocol eras", () => {
  it("serves a 2026-07-28 client per request — no session id", async () => {
    const c = await modernClient(await serve(createStorefront()));
    expect(c.getProtocolEra()).toBe("modern");
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toContain("checkout");
  });

  it("still serves a 2025-era client its session, on the same endpoint", async () => {
    const url = await serve(createStorefront());
    const c = new Client({ name: "legacy", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(url);
    await c.connect(transport);
    open.push(() => c.close());
    expect(c.getProtocolEra()).toBe("legacy");
    expect(transport.sessionId).toBeTruthy();
  });
});

describe("the cart a 2026-07-28 conversation keys by its cart id (no sessions, so no shared cart — Security invariant 4)", () => {
  const call = async (c: Client, name: string, args: Record<string, unknown>) => sc(await c.callTool({ name, arguments: args }));

  it("issues a cart id with the first picker, and keeps using that one cart — through add, set, remove, get and checkout", async () => {
    const c = await modernClient(await serve(createStorefront()));
    const { cartId } = await call(c, "browse-products", {});
    expect(cartId).toMatch(/^cart_/);

    let r = await call(c, "add-to-cart", { cartId, items: [{ productId: "court-sneakers", quantity: 1 }, { productId: "drift-mouse", quantity: 1 }] });
    expect(r.cartId).toBe(cartId); // the id never changes
    r = await call(c, "set-quantity", { cartId, productId: "court-sneakers", quantity: 3 });
    r = await call(c, "remove-from-cart", { cartId, productId: "drift-mouse" });
    r = await call(c, "get-cart", { cartId });
    expect(r.cart.lines.map((l: any) => [l.id, l.quantity])).toEqual([["court-sneakers", 3]]);

    const order = await call(c, "checkout", { cartId });
    expect(order.orderId).toMatch(/^ORD-/);
    expect(order.cart.total).toBe(285); // priced from the catalog: 3 × $95
  });

  it("shows the agent what the user picked in the widget — both hold the same cart id", async () => {
    // The widget and the agent are separate callers with nothing in common on 2026-07-28 except the
    // cart id they both received from the result that opened the picker.
    const url = await serve(createStorefront());
    const agent = await modernClient(url);
    const widget = await modernClient(url);
    const { cartId } = await call(agent, "browse-products", {});

    await call(widget, "set-quantity", { cartId, productId: "drift-mouse", quantity: 2 }); // the user's clicks
    await call(agent, "add-to-cart", { cartId, items: [{ productId: "court-sneakers", quantity: 1 }] }); // "also add sneakers"

    const reopened = await call(agent, "browse-products", { cartId }); // "show me the picker again"
    expect(reopened.cart.lines.map((l: any) => [l.id, l.quantity])).toEqual([["drift-mouse", 2], ["court-sneakers", 1]]);
    expect((await call(agent, "checkout", { cartId })).cart.total).toBe(193); // 2 × $49 + $95
  });

  it("never lets one conversation's cart reach another — each gets its own id", async () => {
    const url = await serve(createStorefront());
    const a = await modernClient(url);
    const b = await modernClient(url);
    const { cartId: aId } = await call(a, "add-to-cart", { items: [{ productId: "oak-whiskey", quantity: 2 }] });
    const bCart = await call(b, "get-cart", {});

    // Were the cart keyed by one fallback session, B would now see A's two bottles.
    expect(bCart.cart.itemCount).toBe(0);
    expect(bCart.cartId).not.toBe(aId);
    expect((await b.callTool({ name: "checkout", arguments: {} })).isError).toBe(true); // B's cart is empty
  });

  it("REFUSES a cart id the store never issued — an agent inventing one must not land on anyone's cart", async () => {
    const url = await serve(createStorefront());
    const c = await modernClient(url);
    const other = await modernClient(url);
    const invented = `cart_${"A".repeat(22)}_${"A".repeat(22)}`;
    // Another conversation "invents" the same id first and fills it…
    expect((await other.callTool({ name: "add-to-cart", arguments: { cartId: invented, items: [{ productId: "oak-whiskey", quantity: 9 }] } })).isError).toBe(true);
    // …and nobody can read or check out a cart under an invented id.
    expect((await c.callTool({ name: "get-cart", arguments: { cartId: invented } })).isError).toBe(true);
    expect((await c.callTool({ name: "checkout", arguments: { cartId: invented } })).isError).toBe(true);
  });

  it("checks out the items a client passes explicitly, with no cart id at all", async () => {
    const c = await modernClient(await serve(createStorefront()));
    const r = await call(c, "checkout", { items: [{ productId: "court-sneakers", quantity: 1 }] });
    expect(r.orderId).toMatch(/^ORD-/);
    expect(r.cart.itemCount).toBe(1);
  });

  it("leaves a 2025-era session's cart where it was — keyed by the session, with no cart id", async () => {
    const url = await serve(createStorefront());
    const c = new Client({ name: "legacy", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(url));
    open.push(() => c.close());
    const added = await call(c, "add-to-cart", { items: [{ productId: "court-sneakers", quantity: 1 }] });
    expect(added.cartId).toBeUndefined();
    expect((await call(c, "get-cart", {})).cart.itemCount).toBe(1);
  });
});

// `statelessMcp` serves 2025-era clients with no session either (multi-instance serverless, e.g.
// Vercel). It used to fall back to ONE shared cart key there — every shopper saw every other
// shopper's items (issue #204). It now keys the cart by a cart id, exactly as on 2026-07-28.
describe("2025-era clients on a statelessMcp store — a cart per conversation, never one shared cart", () => {
  const call = async (c: Client, name: string, args: Record<string, unknown>) => sc(await c.callTool({ name, arguments: args }));
  async function legacyClient(url: URL): Promise<Client> {
    const c = new Client({ name: "legacy", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(url));
    open.push(() => c.close());
    expect(c.getProtocolEra()).toBe("legacy");
    return c;
  }

  it("REFUSES to share a cart between two shoppers (the #204 leak)", async () => {
    const url = await serve(createStorefront({ statelessMcp: true }));
    const a = await legacyClient(url);
    const b = await legacyClient(url);
    const { cartId: aId } = await call(a, "add-to-cart", { items: [{ productId: "oak-whiskey", quantity: 2 }] });
    expect(aId).toMatch(/^cart_/);

    // Were the cart keyed by the shared fallback key, B would now see A's two bottles.
    const bCart = await call(b, "get-cart", {});
    expect(bCart.cart.itemCount).toBe(0);
    expect(bCart.cartId).not.toBe(aId);
  });

  it("follows the conversation across server instances by its cart id (one shared storage)", async () => {
    // Two instances, as on Vercel: same signing key, same cart storage, no shared memory.
    const shared = { statelessMcp: true, signingKey: "shared-key", cartStore: new MemoryCartStore() };
    const one = await legacyClient(await serve(createStorefront(shared)));
    const two = await legacyClient(await serve(createStorefront(shared)));

    const { cartId } = await call(one, "add-to-cart", { items: [{ productId: "court-sneakers", quantity: 1 }] });
    const onTwo = await call(two, "get-cart", { cartId }); // the next request lands on the other instance
    expect(onTwo.cart.lines.map((l: any) => [l.id, l.quantity])).toEqual([["court-sneakers", 1]]);
  });

  it("REFUSES a cart id the store never issued", async () => {
    const c = await legacyClient(await serve(createStorefront({ statelessMcp: true })));
    expect((await c.callTool({ name: "get-cart", arguments: { cartId: "cart_1" } })).isError).toBe(true);
  });
});

// Which build is live: the real package versions, never a hard-coded number.
describe("the server reports its real version", () => {
  const pkg = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")).version as string;
  const storefront = pkg("../package.json");
  const gate = pkg("../../credentagent-gate/package.json");

  it("GET /version names both package versions and the MCP versions it serves", async () => {
    const res = await request(createStorefront().app).get("/version");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "credentagent-storefront", version: storefront, gate });
    expect(res.body.mcpProtocolVersions).toEqual(expect.arrayContaining(["2026-07-28", "2025-11-25"]));
  });

  it("labels the deployment with `build`, so two deploys of one version can be told apart", async () => {
    const store = createStorefront({ build: "dev.3f9c2a1" });
    expect((await request(store.app).get("/version")).body).toMatchObject({ version: storefront, build: "dev.3f9c2a1" });
    const c = await modernClient(await serve(store));
    await c.listTools();
    expect(c.getServerVersion()?.version).toBe(`${storefront}+dev.3f9c2a1`);
  });

  it("tells MCP clients the same version, on both protocol eras", async () => {
    const url = await serve(createStorefront());
    const modern = await modernClient(url);
    const legacy = new Client({ name: "legacy", version: "1.0.0" });
    await legacy.connect(new StreamableHTTPClientTransport(url));
    open.push(() => legacy.close());
    await modern.listTools(); // server info rides on a 2026-07-28 response's _meta
    expect(modern.getServerVersion()?.version).toBe(storefront);
    expect(legacy.getServerVersion()?.version).toBe(storefront);
  });
});

describe("create-spending-grant on 2026-07-28 — a real input_required round trip", () => {
  const ARGS = { budget: 200, perSpend: 120, item: "sneakers", signing: "page" };
  const CHOICES: Record<string, string> = { size: "US 10", colour: "Black" };
  /**
   * The client asks "the human" each question the server embeds, then retries by itself. The
   * last question carries the approve link; `tap` decides whether the human really approves there.
   */
  function human(c: Client, ca: CredentAgent, tap: boolean): { asked: string[]; grantIds: string[] } {
    const seen = { asked: [] as string[], grantIds: [] as string[] };
    c.setRequestHandler("elicitation/create", async (req) => {
      const params = req.params as { message: string; requestedSchema: { properties: object } };
      const field = Object.keys(params.requestedSchema.properties)[0];
      seen.asked.push(field);
      if (field !== "approved") return { action: "accept", content: { [field]: CHOICES[field] } };
      const grantId = /grants\/([^/?\s]+)/.exec(params.message)![1];
      seen.grantIds.push(grantId);
      if (tap) await ca.grants._authorize(grantId);
      return { action: "accept", content: { approved: true } };
    });
    return seen;
  }

  it("asks through the protocol, pins the grant to the product the human chose, and waits for their tap", async () => {
    const ca = agent();
    const c = await modernClient(await serve(grantStore(ca)), { elicitation: {} });
    const { asked } = human(c, ca, true);

    const v = sc(await c.callTool({ name: "create-spending-grant", arguments: ARGS }));
    expect(asked).toEqual(expect.arrayContaining(["size", "colour", "approved"]));
    expect(v.status).toBe("authorized");
    expect(v.allow).toMatchObject({ skus: ["court-sneakers"] });
    expect(v.item).toMatchObject({ productId: "court-sneakers", selections: { size: "US 10", colour: "Black" } });
  });

  it("REFUSES to report the grant authorized on the client's say-so — the flow never completes without the tap", async () => {
    const ca = agent();
    const c = await modernClient(await serve(grantStore(ca)), { elicitation: {} });
    const { grantIds } = human(c, ca, false); // answers "approved: true" every round, but nobody taps

    await expect(c.callTool({ name: "create-spending-grant", arguments: ARGS })).rejects.toThrow(/still required input/);
    expect(new Set(grantIds).size).toBe(1); // one grant, re-checked — never a second one minted
    expect((await ca.grants.retrieve(grantIds[0]))?.status).toBe("pending");
  });

  it("gives a client that declared no elicitation the questions as tool output instead", async () => {
    const c = await modernClient(await serve(grantStore()));
    const v = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 120, item: "sneakers" } }));
    expect(v.code).toBe("input-required");
    expect(v.questions.map((q: any) => q.key).sort()).toEqual(["colour", "size"]);
  });
});

// Raw 2026-07-28 requests, so the test controls exactly what rides in `requestState`.
describe("create-spending-grant on 2026-07-28 — requestState is attacker-controlled", () => {
  const ARGS = { budget: 200, perSpend: 120, item: "sneakers", signing: "page" };
  let id = 0;
  const call = (store: Storefront, extra: Record<string, unknown> = {}, args: Record<string, unknown> = ARGS) =>
    request(store.app)
      .post("/mcp")
      .set({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN,
        "mcp-method": "tools/call",
        "mcp-name": "create-spending-grant",
      })
      .send({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: {
          name: "create-spending-grant",
          arguments: args,
          ...extra,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
            "io.modelcontextprotocol/clientInfo": { name: "raw", version: "0" },
          },
        },
      });
  const ANSWERS = {
    size: { action: "accept", content: { size: "US 10" } },
    colour: { action: "accept", content: { colour: "Black" } },
  };

  it("answers the first round with the input_required wire shape", async () => {
    const r = (await call(grantStore())).body.result;
    expect(r.resultType).toBe("input_required");
    expect(r.inputRequests.size.method).toBe("elicitation/create");
    expect(r.inputRequests.size.params.requestedSchema).toMatchObject({ type: "object", required: ["size"] });
    expect(typeof r.requestState).toBe("string");
  });

  it("takes the answers from the request-level retry params — then asks for the human's tap", async () => {
    const store = grantStore();
    const { requestState } = (await call(store)).body.result;
    const next = (await call(store, { requestState, inputResponses: ANSWERS })).body.result;
    // The product is pinned and the grant exists; the only question left is the approval.
    expect(next.resultType).toBe("input_required");
    expect(Object.keys(next.inputRequests)).toEqual(["approval"]);
    expect(next.inputRequests.approval.params.message).toContain("/credentagent/grants/");
  });

  it("REFUSES a hand-edited requestState — its answers never become a grant", async () => {
    const store = grantStore();
    const { requestState } = (await call(store)).body.result as { requestState: string };
    const forged = requestState.slice(0, -2) + (requestState.endsWith("A") ? "BB" : "AA");
    const r = (await call(store, { requestState: forged, inputResponses: ANSWERS })).body.result;
    expect(r.structuredContent).toMatchObject({ ok: false, code: "tampered" });
    expect(r.structuredContent.approveUrl).toBeUndefined();
  });

  it("REFUSES a genuine requestState re-presented with a bigger budget", async () => {
    const store = grantStore();
    const { requestState } = (await call(store)).body.result;
    const r = (await call(store, { requestState, inputResponses: ANSWERS }, { ...ARGS, budget: 5000 })).body.result;
    expect(r.structuredContent.ok).toBe(false);
    expect(r.structuredContent.approveUrl).toBeUndefined();
  });
});
