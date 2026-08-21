// The human-NOT-present tools (spec 009) driven over the real MCP server — the exact surface an
// AI agent (Claude) sees. The lifecycle: create (pending) → the human approves → spend within the
// sealed bounds → revoke. Security assertions mirror the gate's: a pending grant can't spend, the
// allow-bounds hold, and age NEVER delegates — all through the MCP tool wire, not just the library.

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStorefront } from "./server.js";
import type { Product } from "./index.js";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

// The gate's priced catalog (dollars): whiskey is age-restricted → non-delegable.
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

const sc = (r: Awaited<ReturnType<Client["callTool"]>>) => r.structuredContent as Record<string, any>;

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

  it("create returns a PENDING grant + approveUrl; spending before approval refuses not-authorized", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:3005", catalog: GATE_CATALOG });
    const c = await client(ca);

    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 60, categories: ["Electronics"] } }));
    expect(g.status).toBe("pending");
    expect(g.approveUrl).toContain(`/credentagent/grants/${g.grantId}`);

    // BYPASS (through the wire): the human never approved — the agent cannot spend.
    const s = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "drift-mouse" } }));
    expect(s).toMatchObject({ ok: false, code: "not-authorized" });
  });

  it("full lifecycle: approve → spend ok → allow-bounds refuse → whiskey step-up → revoke kills it", async () => {
    const ca = new CredentAgent({ walletOrigin: "http://localhost:3005", catalog: GATE_CATALOG });
    const c = await client(ca);

    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 60, categories: ["Electronics", "Beverages"] } }));
    await ca.grants._authorize(g.grantId); // the human's one-time approval (the approveUrl page calls this same seam)
    expect(sc(await c.callTool({ name: "get-grant-status", arguments: { grantId: g.grantId } })).status).toBe("authorized");

    // ✓ an allowed, under-cap purchase — server-priced, remaining drawn down
    const ok = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "drift-mouse", idempotencyKey: "k1" } }));
    expect(ok).toMatchObject({ ok: true, amount: 49, remaining: 151, authorization: "delegated" });

    // ✗ outside the allow-bounds (Home not granted)
    const notAllowed = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "lumen-desk-lamp" } }));
    expect(notAllowed).toMatchObject({ ok: false, code: "not-allowed" });

    // ✗ AGE NEVER DELEGATES: whiskey is in an allowed category and under budget — still refused.
    const whiskey = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "oak-whiskey" } }));
    expect(whiskey).toMatchObject({ ok: false, code: "step-up" });

    // idempotent replay through the wire: same key echoes the ORIGINAL outcome, no double charge
    const replay = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "drift-mouse", idempotencyKey: "k1" } }));
    expect(replay).toMatchObject({ ok: true, remaining: 151, replayed: true });

    // revoke → the very next spend dies
    expect(sc(await c.callTool({ name: "revoke-grant", arguments: { grantId: g.grantId } })).status).toBe("revoked");
    const after = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "drift-mouse" } }));
    expect(after).toMatchObject({ ok: false, code: "revoked" });
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
    await ca.grants._authorize(g.grantId);
    const r = await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "ghost-item" } });
    expect(r.isError).toBeFalsy(); // a typed door, not a generic exception the agent can't branch on
    expect(sc(r)).toMatchObject({ ok: false, code: "invalid-request" });
  });

  // BYPASS — the grant's own snapshot says the item is a cheap, unrestricted gadget; the LIVE
  // storefront catalog says it's now age-restricted. Delete the live-age pre-check and the engine
  // (reading the stale snapshot) buys it unattended — exactly the P1 Codex named.
  it("BYPASS: an item age-restricted in the LIVE catalog still refuses step-up, despite a stale grant snapshot", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: { widget: { price: 20, category: "Gadgets" } } });
    const store = createStorefront({ grants: ca.grants, catalog: [prod({ id: "widget", price: 20, category: "Gadgets", minimumAge: 21 })] });
    const c = await connect(store);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 100, perSpend: 50, categories: ["Gadgets"] } }));
    await ca.grants._authorize(g.grantId);
    const s = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "widget" } }));
    expect(s).toMatchObject({ ok: false, code: "step-up" });
  });

  // BYPASS — the grant snapshot prices the item under the cap; the LIVE catalog bumped it over.
  // Delete the live-price pre-check and the engine (stale, cheap) lets it evade the sealed cap.
  it("BYPASS: a live price over the sealed per-spend cap refuses, despite a cheaper grant snapshot", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: { widget: { price: 20, category: "Gadgets" } } });
    const store = createStorefront({ grants: ca.grants, catalog: [prod({ id: "widget", price: 500, category: "Gadgets" })] });
    const c = await connect(store);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 1000, perSpend: 50, categories: ["Gadgets"] } }));
    await ca.grants._authorize(g.grantId);
    const s = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "widget" } }));
    expect(s).toMatchObject({ ok: false, code: "per-spend-exceeded" });
  });

  // ── #172: the human proved their age on the approve page, so the agent may buy the 21+ item ──

  // The positive path for the reversal, over the real MCP wire: without it the whole feature is
  // unproven — the point of #172 is that a grant the human proved for CAN spend.
  it("a grant carrying a 21+ proof buys the age-restricted item over MCP", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: GATE_CATALOG });
    const c = await client(ca);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 300, perSpend: 150, categories: ["Beverages"] } }));
    // What the grant-age rail does when the human's wallet proves age on the approve page.
    expect(await ca.grants._recordAgeProof(g.grantId, { provenAge: 21 })).toBe(true);
    await ca.grants._authorize(g.grantId);
    const s = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "oak-whiskey", idempotencyKey: "w172" } }));
    expect(s).toMatchObject({ ok: true, amount: 124, remaining: 176 });
  });

  // BYPASS — the live-catalog pre-check must still refuse a grant with NO proof. Delete the
  // `!ageProofCovers(...)` half of that condition and this goes red: every grant would buy 21+.
  it("BYPASS: a grant with no age proof still refuses the 21+ item over MCP", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: GATE_CATALOG });
    const c = await client(ca);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 300, perSpend: 150, categories: ["Beverages"] } }));
    await ca.grants._authorize(g.grantId);
    const s = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "oak-whiskey" } }));
    expect(s).toMatchObject({ ok: false, code: "step-up" });
  });

  // BYPASS — the pre-check must test the proof against the LIVE threshold, not the grant's stale
  // snapshot. The human proved 18+; the storefront has since raised this product to 21+. Drop the
  // threshold comparison (or read the snapshot's age) and this goes red.
  it("BYPASS: an 18+ proof cannot buy a product the LIVE catalog raised to 21+", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: { widget: { price: 20, minAge: 18, category: "Gadgets" } } });
    const store = createStorefront({ grants: ca.grants, catalog: [prod({ id: "widget", price: 20, category: "Gadgets", minimumAge: 21 })] });
    const c = await connect(store);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 100, perSpend: 50, categories: ["Gadgets"] } }));
    await ca.grants._recordAgeProof(g.grantId, { provenAge: 18 });
    await ca.grants._authorize(g.grantId);
    const s = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "widget" } }));
    expect(s).toMatchObject({ ok: false, code: "step-up" });
  });

  // ── #172: the loyalty membership the human proved on the approve page ──────────────────────
  // The risk is invariant 3 — the line sum, the order total and the SIGNED draw amount must agree
  // on every path. These run it over the real MCP wire, where the storefront's live-catalog
  // pre-check and the engine both have to reach the same number.

  it("a grant carrying a membership is charged the discounted amount over MCP", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: GATE_CATALOG, loyaltyDiscountPct: 10 });
    const c = await client(ca);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 100, categories: ["Electronics"] } }));
    expect(await ca.grants._recordMembershipProof(g.grantId, { membershipNumber: "GOLD-0001" })).toBe(true);
    await ca.grants._authorize(g.grantId);
    const s = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "drift-mouse", idempotencyKey: "m172" } }));
    expect(s).toMatchObject({ ok: true, amount: 44.1, remaining: 155.9 }); // $49 − 10%
  });

  // BYPASS — the storefront's per-spend pre-check must measure what is CHARGED, not the list price.
  // Compare the list price instead and this goes red: a purchase the gate would have completed is
  // refused by the storefront, which is exactly the cross-path drift invariant 3 forbids.
  it("BYPASS: the per-spend pre-check honours the discount, so a discounted purchase is not refused", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: GATE_CATALOG, loyaltyDiscountPct: 10 });
    const c = await client(ca);
    // drift-mouse lists at $49 — over the $45 cap — but bills at $44.10.
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 45, categories: ["Electronics"] } }));
    await ca.grants._recordMembershipProof(g.grantId, { membershipNumber: "GOLD-0001" });
    await ca.grants._authorize(g.grantId);
    const s = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "drift-mouse", idempotencyKey: "cap172" } }));
    expect(s).toMatchObject({ ok: true, amount: 44.1 });
  });

  it("no membership ⇒ full catalog price, exactly as before", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: GATE_CATALOG, loyaltyDiscountPct: 10 });
    const c = await client(ca);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 200, perSpend: 100, categories: ["Electronics"] } }));
    await ca.grants._authorize(g.grantId);
    const s = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "drift-mouse", idempotencyKey: "nom172" } }));
    expect(s).toMatchObject({ ok: true, amount: 49 });
  });

  // The happy path still works when the two catalogs AGREE: an in-scope, in-cap, unrestricted item spends.
  it("spends when the live catalog agrees (in scope, under cap, no age gate)", async () => {
    const ca = new CredentAgent({ walletOrigin: wallet, catalog: { widget: { price: 20, category: "Gadgets" } } });
    const store = createStorefront({ grants: ca.grants, catalog: [prod({ id: "widget", price: 20, category: "Gadgets" })] });
    const c = await connect(store);
    const g = sc(await c.callTool({ name: "create-spending-grant", arguments: { budget: 100, perSpend: 50, categories: ["Gadgets"] } }));
    await ca.grants._authorize(g.grantId);
    const s = sc(await c.callTool({ name: "spend-from-grant", arguments: { grantId: g.grantId, productId: "widget", idempotencyKey: "w1" } }));
    expect(s).toMatchObject({ ok: true, amount: 20, remaining: 80 });
  });
});
