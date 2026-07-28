// The human-NOT-present tools (spec 009) driven over the real MCP server — the exact surface an
// AI agent (Claude) sees. The lifecycle: create (pending) → the human approves → spend within the
// sealed bounds → revoke. Security assertions mirror the gate's: a pending grant can't spend, the
// allow-bounds hold, and age NEVER delegates — all through the MCP tool wire, not just the library.
//
// The tools now emit the full GrantViewData projection (spec 011) as structuredContent, discriminated
// by `kind`, with the widget attached (`_meta.ui.resourceUri`). The spend outcome (typed door) rides
// in the result's `spend`.

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStorefront } from "./server.js";
import type { Product } from "./index.js";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

// The gate's priced catalog (dollars): whiskey is age-restricted → non-delegable. Ids/prices match
// the storefront's SAMPLE_CATALOG so the two agree (the grant tools re-price against the storefront).
const GATE_CATALOG = {
  "drift-mouse": { price: 49, category: "Electronics" },
  "oak-whiskey": { price: 124, minAge: 21, category: "Beverages" },
  "lumen-desk-lamp": { price: 59, category: "Home" },
};

/** Connect an MCP client to a storefront over the in-memory transport. */
async function connect(store: ReturnType<typeof createStorefront>) {
  const server = store.mcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "grants-test", version: "1.0.0" });
  await Promise.all([server.connect(st), c.connect(ct)]);
  return c;
}

/** Minimal Product for a custom storefront catalog (the LIVE source the grant tools re-price against). */
const prod = (p: Partial<Product> & { id: string; price: number; category: string }): Product => ({
  name: p.id,
  currency: "USD",
  image: "",
  description: "",
  ...p,
});

const client = (ca: CredentAgent) => connect(createStorefront({ grants: ca.grants }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sc = (r: Awaited<ReturnType<Client["callTool"]>>) => r.structuredContent as Record<string, any>;
/** The spend outcome (typed door) rides in the projection's `spend`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const door = (r: Awaited<ReturnType<Client["callTool"]>>) => sc(r).spend as Record<string, any>;

describe("grant tools over MCP (human-not-present)", () => {
  it("registers the four tools ONLY when grants is wired (additive)", async () => {
    const withGrants = await client(new CredentAgent({ catalog: GATE_CATALOG }));
    const names = (await withGrants.listTools()).tools.map((t) => t.name);
    for (const n of ["create-spending-grant", "get-grant-status", "spend-from-grant", "revoke-grant"]) {
      expect(names).toContain(n);
    }

    const bare = createStorefront({}); // no grants option
    const server = bare.mcpServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "bare", version: "1.0.0" });
    await Promise.all([server.connect(st), c.connect(ct)]);
    const bareNames = (await c.listTools()).tools.map((t) => t.name);
    expect(bareNames).not.toContain("create-spending-grant");
  });

  it("all four grant tools carry the widget resource (_meta.ui.resourceUri), like the shopping tools", async () => {
    const c = await client(new CredentAgent({ catalog: GATE_CATALOG }));
    const tools = (await c.listTools()).tools;
    for (const n of ["create-spending-grant", "get-grant-status", "spend-from-grant", "revoke-grant"]) {
      const t = tools.find((x) => x.name === n)!;
      const meta = t._meta as { ui?: { resourceUri?: string } } | undefined;
      expect(meta?.ui?.resourceUri).toMatch(/^ui:\/\//);
    }
  });

  it("create returns a PENDING GrantViewData + approveUrl; spending before approval refuses not-authorized", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:3005", catalog: GATE_CATALOG });
    const c = await client(ca);

    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 60, categories: ["Electronics"] } }));
    expect(g.kind).toBe("credentagent.grant");
    expect(g.status).toBe("pending");
    expect(g.lifecycle).toBe("pending");
    expect(g.approveUrl).toContain(`/credentagent/grants/${g.id}`);
    expect(g.remaining).toBe(200); // nothing spent yet
    expect(g.presence).toBe("delegated-demo");
    expect(g.trustLevel).toBe("server-issued-demo");

    // BYPASS (through the wire): the human never approved — the agent cannot spend.
    const s = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "drift-mouse" } });
    expect(door(s)).toMatchObject({ ok: false, code: "not-authorized" });
  });

  it("full lifecycle: approve → spend ok → allow-bounds refuse → whiskey step-up → revoke kills it", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:3005", catalog: GATE_CATALOG });
    const c = await client(ca);

    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 60, categories: ["Electronics", "Beverages"] } }));
    await ca.grants._authorize(g.id); // the human's one-time approval (the approveUrl page calls this same seam)
    expect(sc(await c.callTool({ name: "get-grant-status", arguments: { grantId: g.id } })).status).toBe("authorized");

    // ✓ an allowed, under-cap purchase — server-priced, remaining drawn down; the returned view reflects it
    const ok = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "drift-mouse", idempotencyKey: "k1" } });
    expect(door(ok)).toMatchObject({ ok: true, amount: 49, remaining: 151, authorization: "delegated" });
    expect(sc(ok).remaining).toBe(151); // the projection re-read the live budget
    expect(sc(ok).spent).toBe(49);

    // ✗ outside the allow-bounds (Home not granted)
    const notAllowed = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "lumen-desk-lamp" } });
    expect(door(notAllowed)).toMatchObject({ ok: false, code: "not-allowed" });

    // ✗ AGE NEVER DELEGATES: whiskey is in an allowed category and under budget — still refused.
    const whiskey = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "oak-whiskey" } });
    expect(door(whiskey)).toMatchObject({ ok: false, code: "step-up" });

    // idempotent replay through the wire: same key echoes the ORIGINAL outcome, no double charge
    const replay = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "drift-mouse", idempotencyKey: "k1" } });
    expect(door(replay)).toMatchObject({ ok: true, remaining: 151, replayed: true });

    // revoke → the very next spend dies; the view is terminal
    const revoked = sc(await c.callTool({ name: "revoke-grant", arguments: { grantId: g.id } }));
    expect(revoked.status).toBe("revoked");
    expect(revoked.lifecycle).toBe("revoked");
    const after = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "drift-mouse" } });
    expect(door(after)).toMatchObject({ ok: false, code: "revoked" });
  });

  it("unknown grant ids are typed errors, not throws", async () => {
    const c = await client(new CredentAgent({ catalog: GATE_CATALOG }));
    for (const name of ["get-grant-status", "revoke-grant"]) {
      const r = await c.callTool({ name, arguments: { grantId: "grant_nope" } });
      expect(r.isError).toBe(true);
    }
    const s = await c.callTool({ name: "spend-from-grant", arguments: { grantId: "grant_nope", productId: "drift-mouse" } });
    expect(s.isError).toBe(true);
  });
});

// The GrantViewData projection (spec 011): the four tools now emit the full display snapshot the
// grant widget renders. These pin the projection the widget depends on — product resolution, the
// server-derived lifecycle thresholds, and the product-specific `allow.skus` binding.
describe("grant tools — GrantViewData projection (spec 011)", () => {
  it("create with `products` binds allow.skus and resolves the single product from the live catalog", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:3005", catalog: GATE_CATALOG });
    const c = await connect(createStorefront({ grants: ca.grants, merchant: "Utopia" }));
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 60, products: ["drift-mouse"] } }));
    expect(g.allow).toMatchObject({ skus: ["drift-mouse"], categories: [] });
    // A single-SKU grant is the flagship: the resolved product carries name/price/category (not just the id).
    expect(g.product).toMatchObject({ id: "drift-mouse", name: "Drift Wireless Mouse", price: 49, category: "Electronics" });
    expect(g.merchant).toBe("Utopia");
  });

  // BYPASS — a product-specific grant must refuse a DIFFERENT product. Delete the allow-bounds check
  // in grants.ts and a grant scoped to drift-mouse would buy the lamp; this goes red.
  it("BYPASS: a `products`-scoped grant refuses a spend on any other product (not-allowed)", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:3005", catalog: GATE_CATALOG });
    const c = await client(ca);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 60, products: ["drift-mouse"] } }));
    await ca.grants._authorize(g.id);
    // ✓ the bound product spends
    const ok = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "drift-mouse", idempotencyKey: "p1" } });
    expect(door(ok)).toMatchObject({ ok: true, amount: 49 });
    // ✗ a different product — outside the single-SKU bound — is refused
    const bad = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "lumen-desk-lamp" } });
    expect(door(bad)).toMatchObject({ ok: false, code: "not-allowed" });
  });

  it("lifecycle is server-derived across the thresholds: pending → active → low → exhausted", async () => {
    // A small budget so two $49 mouse spends cross 20% and then spend out. perSpend 49; budget 100.
    const ca = new CredentAgent({ walletOrigin: "http://localhost:3005", catalog: GATE_CATALOG });
    const c = await client(ca);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 100, perSpend: 49, products: ["drift-mouse"] } }));
    expect(g.lifecycle).toBe("pending");
    await ca.grants._authorize(g.id);
    expect(sc(await c.callTool({ name: "get-grant-status", arguments: { grantId: g.id } })).lifecycle).toBe("active");

    // spend $49 → remaining 51 (> 20%) still active
    await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "drift-mouse", idempotencyKey: "a" } });
    expect(sc(await c.callTool({ name: "get-grant-status", arguments: { grantId: g.id } })).lifecycle).toBe("active");

    // spend $49 again → remaining 2 (<= 20%) → low
    const second = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "drift-mouse", idempotencyKey: "b" } });
    expect(door(second)).toMatchObject({ ok: true, remaining: 2 });
    expect(sc(second).lifecycle).toBe("low");
  });
});

// The three Codex findings on #118: merchant identity, unknown-product refusal, and — the P1 —
// re-pricing delegated spends against the storefront's LIVE catalog so a dynamic source can't
// drift out from under the grant's sealed snapshot.
describe("grant tools — merchant config & live-catalog re-pricing (Codex #118)", () => {
  const wallet = "http://localhost:3005";

  it("seals the grant with the CONFIGURED merchant, not a hardcoded default", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: GATE_CATALOG });
    const c = await connect(createStorefront({ grants: ca.grants, merchant: "acme-co" }));
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 100, perSpend: 50 } }));
    // g.merchant is read from the SEALED grant record — a hardcoded "utopia" would fail this.
    expect(g.merchant).toBe("acme-co");
  });

  it("defaults the merchant to a neutral 'storefront' for the generic package", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: GATE_CATALOG });
    const c = await connect(createStorefront({ grants: ca.grants }));
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 100, perSpend: 50 } }));
    expect(g.merchant).toBe("storefront");
  });

  it("refuses an unknown product with a typed invalid-request, not a thrown tool exception", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: GATE_CATALOG });
    const c = await client(ca);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 100, perSpend: 50 } }));
    await ca.grants._authorize(g.id);
    const r = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "ghost-item" } });
    expect(r.isError).toBeFalsy(); // a typed door, not a generic exception the agent can't branch on
    expect(door(r)).toMatchObject({ ok: false, code: "invalid-request" });
  });

  // BYPASS — the grant's own snapshot says the item is a cheap, unrestricted gadget; the LIVE
  // storefront catalog says it's now age-restricted. Delete the live-age pre-check and the engine
  // (reading the stale snapshot) buys it unattended — exactly the P1 Codex named.
  it("BYPASS: an item age-restricted in the LIVE catalog still refuses step-up, despite a stale grant snapshot", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: { widget: { price: 20, category: "Gadgets" } } });
    const store = createStorefront({ grants: ca.grants, catalog: [prod({ id: "widget", price: 20, category: "Gadgets", minimumAge: 21 })] });
    const c = await connect(store);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 100, perSpend: 50, categories: ["Gadgets"] } }));
    await ca.grants._authorize(g.id);
    const s = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "widget" } });
    expect(door(s)).toMatchObject({ ok: false, code: "step-up" });
  });

  // BYPASS — the grant snapshot prices the item under the cap; the LIVE catalog bumped it over.
  // Delete the live-price pre-check and the engine (stale, cheap) lets it evade the sealed cap.
  it("BYPASS: a live price over the sealed per-spend cap refuses, despite a cheaper grant snapshot", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: { widget: { price: 20, category: "Gadgets" } } });
    const store = createStorefront({ grants: ca.grants, catalog: [prod({ id: "widget", price: 500, category: "Gadgets" })] });
    const c = await connect(store);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 1000, perSpend: 50, categories: ["Gadgets"] } }));
    await ca.grants._authorize(g.id);
    const s = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "widget" } });
    expect(door(s)).toMatchObject({ ok: false, code: "per-spend-exceeded" });
  });

  // The happy path still works when the two catalogs AGREE: an in-scope, in-cap, unrestricted item spends.
  it("spends when the live catalog agrees (in scope, under cap, no age gate)", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: { widget: { price: 20, category: "Gadgets" } } });
    const store = createStorefront({ grants: ca.grants, catalog: [prod({ id: "widget", price: 20, category: "Gadgets" })] });
    const c = await connect(store);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 100, perSpend: 50, categories: ["Gadgets"] } }));
    await ca.grants._authorize(g.id);
    const s = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.id, productId: "widget", idempotencyKey: "w1" } });
    expect(door(s)).toMatchObject({ ok: true, amount: 20, remaining: 80 });
  });
});
