// The human-NOT-present tools (spec 009) driven over the real MCP server — the exact surface an
// AI agent (Claude) sees. The lifecycle: create (pending) → the human approves → spend within the
// sealed bounds → revoke. Security assertions mirror the gate's: a pending grant can't spend, the
// allow-bounds hold, and age NEVER delegates — all through the MCP tool wire, not just the library.

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStorefront } from "./server.js";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

// The gate's priced catalog (dollars): whiskey is age-restricted → non-delegable.
const GATE_CATALOG = {
  "drift-mouse": { price: 49, category: "Electronics" },
  "oak-whiskey": { price: 124, minAge: 21, category: "Beverages" },
  "lumen-desk-lamp": { price: 59, category: "Home" },
};

async function client(ca: CredentAgent) {
  const store = createStorefront({ grants: ca.grants });
  const server = store.mcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "grants-test", version: "1.0.0" });
  await Promise.all([server.connect(st), c.connect(ct)]);
  return c;
}

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
