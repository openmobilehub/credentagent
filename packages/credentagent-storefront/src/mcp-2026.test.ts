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

describe("the cart a 2026-07-28 client carries (no sessions, so no shared cart — Security invariant 4)", () => {
  const call = async (c: Client, name: string, args: Record<string, unknown>) => sc(await c.callTool({ name, arguments: args }));

  it("keeps the cart in the token the client passes back — through add, set, remove, get and checkout", async () => {
    const c = await modernClient(await serve(createStorefront()));
    let r = await call(c, "add-to-cart", { items: [{ productId: "court-sneakers", quantity: 1 }, { productId: "drift-mouse", quantity: 1 }] });
    expect(r.cart.itemCount).toBe(2);
    r = await call(c, "set-quantity", { productId: "court-sneakers", quantity: 3, cartToken: r.cartToken });
    r = await call(c, "remove-from-cart", { productId: "drift-mouse", cartToken: r.cartToken });
    r = await call(c, "get-cart", { cartToken: r.cartToken });
    expect(r.cart.lines.map((l: any) => [l.id, l.quantity])).toEqual([["court-sneakers", 3]]);

    const order = await call(c, "checkout", { cartToken: r.cartToken });
    expect(order.orderId).toMatch(/^ORD-/);
    expect(order.cart.total).toBe(285); // re-priced from the catalog: 3 × $95 — the token carries no prices
  });

  it("never lets one client's cart reach another — each has only its own token", async () => {
    const url = await serve(createStorefront());
    const a = await modernClient(url);
    const b = await modernClient(url);
    await call(a, "add-to-cart", { items: [{ productId: "oak-whiskey", quantity: 2 }] });

    // Were the cart keyed by one fallback session, B would now see A's two bottles.
    expect((await call(b, "get-cart", {})).cart.itemCount).toBe(0);
    const bCheckout = await b.callTool({ name: "checkout", arguments: {} });
    expect(bCheckout.isError).toBe(true); // B's cart is empty — nothing of A's to check out
  });

  it("REFUSES an edited cartToken — its items never reach the cart or an order", async () => {
    const c = await modernClient(await serve(createStorefront()));
    const { cartToken } = await call(c, "add-to-cart", { items: [{ productId: "court-sneakers", quantity: 1 }] });
    const [prefix, , sig] = (cartToken as string).split(".");
    const edited = `${prefix}.${Buffer.from(JSON.stringify([["oak-whiskey", 9]])).toString("base64url")}.${sig}`;

    expect((await c.callTool({ name: "add-to-cart", arguments: { items: [{ productId: "drift-mouse", quantity: 1 }], cartToken: edited } })).isError).toBe(true);
    expect((await c.callTool({ name: "checkout", arguments: { cartToken: edited } })).isError).toBe(true);
  });

  it("checks out the items a client passes explicitly, with no token at all", async () => {
    const c = await modernClient(await serve(createStorefront()));
    const r = await call(c, "checkout", { items: [{ productId: "court-sneakers", quantity: 1 }] });
    expect(r.orderId).toMatch(/^ORD-/);
    expect(r.cart.itemCount).toBe(1);
  });

  it("leaves a 2025-era session's cart where it was — on the server, with no token", async () => {
    const url = await serve(createStorefront());
    const c = new Client({ name: "legacy", version: "1.0.0" });
    await c.connect(new StreamableHTTPClientTransport(url));
    open.push(() => c.close());
    const added = await call(c, "add-to-cart", { items: [{ productId: "court-sneakers", quantity: 1 }] });
    expect(added.cartToken).toBeUndefined();
    expect((await call(c, "get-cart", {})).cart.itemCount).toBe(1);
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
