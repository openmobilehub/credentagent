// ap2-multistore/smoke.mjs — the same conversation Claude has, driven over MCP with NO phone: the
// phone's signature is simulated (devSimulateWalletSignature) through the store's real signing
// endpoints. Run it before a live demo; it exits non-zero if any step is wrong.
//
//   node examples/ap2-multistore/smoke.mjs
import { spawn } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { devSimulateWalletSignature } from "@openmobilehub/credentagent-gate";

const here = (f) => new URL(f, import.meta.url).pathname;
const kids = [spawn(process.execPath, [here("./stores.mjs")], { stdio: "inherit" }), spawn(process.execPath, [here("./agent.mjs")], { stdio: "inherit" })];
const up = async (url) => { for (let i = 0; i < 100; i++) { try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } throw new Error(`${url} never came up`); };

let failed = false;
const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}`); if (!ok) failed = true; };

try {
  await Promise.all(["http://localhost:4101/agent/catalog", "http://localhost:4103/agent/catalog", "http://localhost:4100/mcp"].map(up));
  const mcp = new Client({ name: "smoke", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost:4100/mcp")));
  const tool = async (name, args) => (await mcp.callTool({ name, arguments: args })).structuredContent;

  const { stores } = await tool("compare-offers", {});
  check(stores.length === 3 && stores.every((s) => s.products?.length === 3), "compare-offers reads three catalogs");
  const beanbarn = stores.find((s) => s.store === "BeanBarn").url;
  const acme = stores.find((s) => s.store === "Acme Coffee Co").url;

  const grant = await tool("request-permission", { store: beanbarn, skus: ["house-blend"], budget: 50, perSpend: 25, description: "House Blend from BeanBarn — up to $50, $25 a purchase." });
  check(grant.approveUrl?.startsWith(beanbarn), `request-permission → approveUrl ${grant.approveUrl}`);

  // The phone, simulated: the real signing endpoints, a real P-256 signature.
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

  await mcp.close();
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  for (const k of kids) k.kill();
}
process.exitCode = failed ? 1 : 0;
