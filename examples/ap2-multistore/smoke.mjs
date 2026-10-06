// ap2-multistore/smoke.mjs — the same conversation Claude has, driven over MCP with NO phone: the
// phone's signature is simulated (devSimulateWalletSignature) through the store's real signing
// endpoints. Run it before a live demo; it exits non-zero if any step is wrong.
//
//   node examples/ap2-multistore/smoke.mjs
//
// It runs on ports 4200–4204 (SMOKE_BASE_PORT), so it never collides with a live demo on 4100–4104.
import { spawn } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { devSimulateWalletSignature } from "@openmobilehub/credentagent-gate";

const here = (f) => new URL(f, import.meta.url).pathname;
const BASE = Number(process.env.SMOKE_BASE_PORT ?? 4200);
const local = (n, path = "") => `http://localhost:${BASE + n}${path}`;
const env = { ...process.env, BASE_PORT: String(BASE) };
for (const k of ["ACME_URL", "BEANBARN_URL", "ROASTWORKS_URL", "STORES"]) delete env[k]; // local origins, never a tunnel's
const kids = [spawn(process.execPath, [here("./stores.mjs")], { stdio: "inherit", env }), spawn(process.execPath, [here("./agent.mjs")], { stdio: "inherit", env })];
const up = async (url) => { for (let i = 0; i < 100; i++) { try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error(`${url} never came up`); };

let failed = false;
const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}`); if (!ok) failed = true; };

try {
  await Promise.all([local(1, "/agent/catalog"), local(3, "/agent/catalog"), local(4, "/"), local(0, "/mcp")].map(up));
  const mcp = new Client({ name: "smoke", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(local(0, "/mcp"))));
  const tool = async (name, args) => (await mcp.callTool({ name, arguments: args })).structuredContent;

  const { stores } = await tool("compare-offers", {});
  check(stores.length === 3 && stores.every((s) => s.products?.length === 3), "compare-offers reads three catalogs");
  const beanbarn = stores.find((s) => s.store === "BeanBarn").url;
  const acme = stores.find((s) => s.store === "Acme Coffee Co").url;

  const grant = await tool("request-permission", { store: beanbarn, skus: ["house-blend"], budget: 50, perSpend: 25, description: "House Blend from BeanBarn — up to $50, $25 a purchase." });
  check(grant.approveUrl?.startsWith(beanbarn), `request-permission → approveUrl ${grant.approveUrl}`);

  // The phone, simulated: it opens the link, then the real signing endpoints, a real P-256 signature.
  await fetch(grant.approveUrl);
  const oid = await (await fetch(`${beanbarn}/credentagent/grants/${grant.grantId}/sign/request`)).json();
  const signature = await devSimulateWalletSignature({ request: { request: oid.requests[0].data.request, dcql_query: oid.dcql_query }, origin: beanbarn });
  await fetch(`${beanbarn}/credentagent/grants/${grant.grantId}/sign/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ readerContextToken: oid.readerContextToken, result: signature }) });

  const held = await tool("check-permission", { store: beanbarn, grantId: grant.grantId });
  check(held.status === "authorized", `check-permission → ${held.status} (${held.trustLevel})`);

  const bought = await tool("buy", { store: beanbarn, grantId: grant.grantId, items: [{ sku: "house-blend" }] });
  check(bought.ok === true && bought.order?.amount === 2100, `buy at BeanBarn → ${bought.ok ? `verified, $${bought.order.amount / 100}, ${bought.order.trust_level}` : JSON.stringify(bought)}`);

  // The permission names BeanBarn. Acme must refuse it, even though the agent's signature is valid.
  const elsewhere = await tool("buy", { store: acme, grantId: grant.grantId, items: [{ sku: "house-blend" }] });
  check(elsewhere.ok === false, `same permission at Acme → refused (${elsewhere.code ?? elsewhere.detail})`);

  // Not on the permission: green tea is in BeanBarn's catalog but not in what the person signed.
  const offList = await tool("buy", { store: beanbarn, grantId: grant.grantId, items: [{ sku: "green-tea" }] });
  check(offList.ok === false, `unsigned product → refused (${offList.code ?? offList.detail})`);

  // Budget: $21 spent of $50, so a second bag fits and a third does not.
  const second = await tool("buy", { store: beanbarn, grantId: grant.grantId, items: [{ sku: "house-blend" }] });
  const third = await tool("buy", { store: beanbarn, grantId: grant.grantId, items: [{ sku: "house-blend" }] });
  check(second.ok === true && third.ok === false, `budget $50: 2nd bag → ${second.ok ? "ok" : second.code}, 3rd → ${third.ok ? "ok (WRONG)" : third.code}`);

  // The back offices: each store's page renders, and its live feed saw what happened there.
  const page = await (await fetch(`${beanbarn}/`)).text();
  check(page.includes("Live activity") && page.includes('"BeanBarn"'), "BeanBarn back office renders");
  const types = (await (await fetch(`${beanbarn}/console/history`)).json()).map((e) => e.type);
  const want = ["catalog.read", "permission.requested", "permission.opened", "permission.signed", "cart.quoted", "purchase.verified", "purchase.refused"];
  const missing = want.filter((t) => !types.includes(t));
  check(missing.length === 0, `BeanBarn feed → every event kind${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  const acmeFeed = await (await fetch(`${acme}/console/history`)).json();
  const acmeRefusal = acmeFeed.find((e) => e.type === "purchase.refused");
  check(acmeRefusal?.reason === "This permission was signed for another store", `Acme feed says why → "${acmeRefusal?.reason}"`);
  const wall = await (await fetch(local(4, "/"))).text();
  check([1, 2, 3].every((n) => wall.includes(local(n, "/"))), "store wall frames all three back offices");

  await mcp.close();
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  for (const k of kids) k.kill();
}
process.exitCode = failed ? 1 : 0;
