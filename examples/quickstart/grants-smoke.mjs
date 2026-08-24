// Grants E2E smoke — the human-NOT-present grant flow end to end, over a REAL MCP client against a
// REAL local server, with the grant widget attached (spec 011). Every assertion is security- or
// contract-bearing: it fails when its control is removed.
//
//   node grants-smoke.mjs                 # boots a local storefront (grants wired) and drives it
//
// Flow: create a product-specific grant → assert the GrantViewData projection (kind, lifecycle
// pending, approveUrl) + the tool carries the widget resource (_meta) → the agent CANNOT spend
// before approval → approve via the serve endpoint's page action → spend the bound product (the
// returned view's remaining drops) → a different product is refused (not-allowed) → revoke → the
// grant is terminal and the next spend dies.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { SAMPLE_CATALOG } from "@openmobilehub/credentagent-storefront";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const PORT = Number(process.env.GRANTS_SMOKE_PORT ?? 3998);
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${cond ? "" : `  ← FAILED ${detail}`}`);
  if (!cond) failures++;
};

// The priced catalog the grants resource bounds spends from — derived from the storefront catalog
// so the grant's allow-bounds and the checkout agree (a single-SKU grant on drift-mouse, $49).
const grantCatalog = Object.fromEntries(
  SAMPLE_CATALOG.map((p) => [p.id, { price: p.price, category: p.category, ...(p.minimumAge ? { minAge: p.minimumAge } : {}) }]),
);
const credentagent = new CredentAgent({ walletOrigin: BASE, catalog: grantCatalog });
const store = createStorefront({ grants: credentagent.grants, merchant: "Utopia" });
credentagent.grants.serve(store.app); // grant.approveUrl → a real approve/deny page + POST actions
await store.listen(PORT);

const mcp = new Client({ name: "grants-e2e", version: "0.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));

const call = async (name, args) => (await mcp.callTool({ name, arguments: args })).structuredContent ?? {};
// The serve page's approve action (the demo stand-in for the wallet ceremony) — the SAME seam the
// approveUrl page's Approve button POSTs to.
const approve = (id) => fetch(`${BASE}/credentagent/grants/${id}/approve`, { method: "POST" });

try {
  // The grant tools carry the widget resource, exactly like the shopping tools (spec 011 FR-2).
  const tools = (await mcp.listTools()).tools;
  const createTool = tools.find((t) => t.name === "create-spending-grant");
  ok("create-spending-grant carries the widget resource (_meta.ui.resourceUri)",
    !!createTool?._meta?.ui?.resourceUri && String(createTool._meta.ui.resourceUri).startsWith("ui://"),
    JSON.stringify(createTool?._meta));

  // 1) create a PRODUCT-SPECIFIC grant → the full GrantViewData projection, status pending.
  // signing:"page" is now an EXPLICIT opt-in: approving a grant is a wallet signature by default
  // (spec 012). This smoke runs in CI with no phone, so it asks for the click-to-approve door by
  // name — exactly the case that door exists for. The device path is covered by
  // examples/device-signed-grants.mjs, which signs with the simulated wallet.
  const created = await call("create-spending-grant", { budget: 200, perSpend: 60, products: ["drift-mouse"], signing: "page" });
  const id = created.id;
  ok("create → GrantViewData (kind marker, lifecycle pending, approveUrl, resolved product)",
    created.kind === "credentagent.grant" &&
      created.lifecycle === "pending" &&
      typeof created.approveUrl === "string" && created.approveUrl.includes(`/credentagent/grants/${id}`) &&
      created.product?.id === "drift-mouse" &&
      created.remaining === 200,
    JSON.stringify({ kind: created.kind, lifecycle: created.lifecycle, product: created.product, remaining: created.remaining }));

  // 2) BYPASS: the human never approved — the agent cannot spend (fail-closed).
  const early = await call("spend-from-grant", { grantId: id, productId: "drift-mouse" });
  ok("spend BEFORE approval is refused (not-authorized)", early.spend?.ok === false && early.spend?.code === "not-authorized", JSON.stringify(early.spend));

  // 3) approve via the serve endpoint's page action, then confirm the view flips to active.
  await approve(id);
  const active = await call("get-grant-status", { grantId: id });
  ok("approve via the serve endpoint → status authorized, lifecycle active", active.status === "authorized" && active.lifecycle === "active", JSON.stringify({ status: active.status, lifecycle: active.lifecycle }));

  // 4) BYPASS: a product-specific grant refuses a DIFFERENT product (not-allowed).
  const wrong = await call("spend-from-grant", { grantId: id, productId: "lumen-desk-lamp" });
  ok("a product-bound grant refuses a different product (not-allowed)", wrong.spend?.ok === false && wrong.spend?.code === "not-allowed", JSON.stringify(wrong.spend));

  // 5) spend the bound product → the returned view's remaining drops (server-priced, not caller-supplied).
  const spent = await call("spend-from-grant", { grantId: id, productId: "drift-mouse", idempotencyKey: "e2e-1" });
  ok("spend the bound product → ok, and the returned view's remaining decreased (200 → 151)",
    spent.spend?.ok === true && spent.spend?.amount === 49 && spent.remaining === 151 && spent.remaining < 200,
    JSON.stringify({ door: spent.spend, remaining: spent.remaining }));

  // 6) revoke → the grant is terminal and the next spend dies (fail-closed kill-switch).
  const revoked = await call("revoke-grant", { grantId: id });
  ok("revoke → lifecycle terminal (revoked)", revoked.status === "revoked" && revoked.lifecycle === "revoked", JSON.stringify({ status: revoked.status, lifecycle: revoked.lifecycle }));
  const afterRevoke = await call("spend-from-grant", { grantId: id, productId: "drift-mouse", idempotencyKey: "e2e-2" });
  ok("a spend after revoke is refused (revoked)", afterRevoke.spend?.ok === false && afterRevoke.spend?.code === "revoked", JSON.stringify(afterRevoke.spend));

  await mcp.close();
} catch (err) {
  console.error("grants-smoke crashed:", err);
  failures++;
}
console.log(failures ? `\n${failures} assertion(s) FAILED` : "\ngrants-smoke green — the grant flow holds end to end");
process.exit(failures ? 1 : 0);
