// Repro #2: storefront spend-from-grant runs its LIVE-catalog pre-checks (step-up, per-spend-exceeded)
// BEFORE delegating to grant.spend(), which is where the status gate (revoked / not-authorized) and the
// idempotent replay live. Driven over the real MCP server (in-memory transport), local only.
// Run from repo root: node docs/reviews/2026-10-agent-purchases/repros/storefront-precheck-order.mjs
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const prod = (p) => ({ name: p.id, currency: "USD", image: "", description: "", ...p });

// A mutable LIVE catalog the storefront re-prices against (a dynamic CatalogSource, like Firestore).
let liveProducts = [
  prod({ id: "widget", price: 20, category: "Gadgets" }),
  prod({ id: "bigtv", price: 500, category: "Gadgets" }),
  prod({ id: "booze", price: 20, category: "Gadgets", minimumAge: 21 }),
];
const source = { load: async () => liveProducts, current: () => liveProducts };

const GATE_CATALOG = {
  widget: { price: 20, category: "Gadgets" },
  bigtv: { price: 500, category: "Gadgets" },
  booze: { price: 20, minAge: 21, category: "Gadgets" },
};

const ca = new CredentAgent({ walletOrigin: "http://localhost:3005", catalog: GATE_CATALOG });
const store = createStorefront({ grants: ca.grants, catalog: source });
const server = store.mcpServer();
const [ct, st] = InMemoryTransport.createLinkedPair();
const c = new Client({ name: "repro", version: "1.0.0" });
await Promise.all([server.connect(st), c.connect(ct)]);

const call = async (name, args) => (await c.callTool({ name, arguments: args })).structuredContent;
const newGrant = async () => call("create-spending-grant", { budget: 200, perSpend: 60, signing: "page" });
const spend = async (grantId, productId, idempotencyKey) =>
  (await call("spend-from-grant", { grantId, productId, ...(idempotencyKey ? { idempotencyKey } : {}) })).spend;
const show = (label, mcp, lib) =>
  console.log(`${label}\n   MCP spend-from-grant -> ${JSON.stringify(mcp)}\n   grant.spend() direct -> ${JSON.stringify(lib)}\n`);

// ── A. REVOKED grant ────────────────────────────────────────────────────────────────────────────
{
  const g = await newGrant();
  await ca.grants._authorize(g.id);
  const rv = await call("revoke-grant", { grantId: g.id });
  console.log(`A. grant ${g.id} status after revoke-grant = ${rv.status}\n`);
  const h = await ca.grants.retrieve(g.id);
  show("A1. revoked grant, product ABOVE per-spend cap (bigtv $500 > $60)",
    await spend(g.id, "bigtv"), await h.spend({ idempotencyKey: "a1-direct", items: [{ sku: "bigtv" }] }));
  show("A2. revoked grant, age-restricted product (booze 21+, no age proof)",
    await spend(g.id, "booze"), await h.spend({ idempotencyKey: "a2-direct", items: [{ sku: "booze" }] }));
  show("A3. revoked grant, in-bounds product (widget $20) — control",
    await spend(g.id, "widget"), await h.spend({ idempotencyKey: "a3-direct", items: [{ sku: "widget" }] }));
}

// ── B. DENIED / PENDING grant ───────────────────────────────────────────────────────────────────
{
  const g = await newGrant();
  const denied = await ca.grants._deny(g.id);
  const h = await ca.grants.retrieve(g.id);
  console.log(`B. grant ${g.id} _deny -> ${denied}, status = ${h.status}\n`);
  show("B1. denied grant, product ABOVE per-spend cap",
    await spend(g.id, "bigtv"), await h.spend({ idempotencyKey: "b1-direct", items: [{ sku: "bigtv" }] }));
  const p = await newGrant(); // never approved
  const hp = await ca.grants.retrieve(p.id);
  show(`B2. PENDING grant (status=${hp.status}), age-restricted product`,
    await spend(p.id, "booze"), await hp.spend({ idempotencyKey: "b2-direct", items: [{ sku: "booze" }] }));
}

// ── C. IDEMPOTENT REPLAY after the live price / age changes ─────────────────────────────────────
{
  const g = await newGrant();
  await ca.grants._authorize(g.id);
  const first = await spend(g.id, "widget", "order-123");
  const usage1 = await (await ca.grants.retrieve(g.id)).usage();
  console.log(`C0. first spend key=order-123 -> ${JSON.stringify(first)}\n    usage=${JSON.stringify(usage1)}\n`);

  // Live price bump above the sealed $60 cap (the gate's own snapshot still says $20).
  liveProducts = liveProducts.map((p) => (p.id === "widget" ? { ...p, price: 100 } : p));
  const replay = await spend(g.id, "widget", "order-123");
  const direct = await (await ca.grants.retrieve(g.id)).spend({ idempotencyKey: "order-123", items: [{ sku: "widget" }] });
  show("C1. REPLAY same key=order-123 after live price $20 -> $100", replay, direct);

  // Live catalog now marks it 21+.
  liveProducts = liveProducts.map((p) => (p.id === "widget" ? { ...p, price: 20, minimumAge: 21 } : p));
  const replay2 = await spend(g.id, "widget", "order-123");
  show("C2. REPLAY same key=order-123 after widget newly marked 21+", replay2,
    await (await ca.grants.retrieve(g.id)).spend({ idempotencyKey: "order-123", items: [{ sku: "widget" }] }));

  const usage2 = await (await ca.grants.retrieve(g.id)).usage();
  console.log(`C3. usage after the replays (purchase DID happen once): ${JSON.stringify(usage2)}\n`);

  // What a model told "per-spend-exceeded" might do next: the price drops back, it retries with a NEW key.
  liveProducts = liveProducts.map((p) => (p.id === "widget" ? { ...p, price: 20, minimumAge: undefined } : p));
  const again = await spend(g.id, "widget", "order-123-retry");
  const usage3 = await (await ca.grants.retrieve(g.id)).usage();
  console.log(`C4. follow-on fresh-key retry -> ok=${again.ok} amount=${again.amount}; usage=${JSON.stringify(usage3)}  (second charge)\n`);
}
process.exit(0);
