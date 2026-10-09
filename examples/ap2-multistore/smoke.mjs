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
// A short grace window, so "the model stopped waiting" is reached in seconds, not the live 20 s. The card waits up
// to this window for the model to notice the signature, and the model re-checks every 1.5 s, so the window must be
// longer than one poll; 3 s keeps the run short.
const env = { ...process.env, BASE_PORT: String(BASE), AP2_MODEL_GRACE_MS: "3000" };
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
  check(stores.length === 3 && stores.every((s) => s.products?.length >= 3), "compare-offers reads three catalogs");
  const beanbarn = stores.find((s) => s.store === "BeanBarn").url;
  const acme = stores.find((s) => s.store === "Acme Coffee Co").url;

  // The chat cards: three tools render the SDK's card page, served as one resource per host (Claude, ChatGPT).
  const { tools } = await mcp.listTools();
  const carded = tools.filter((t) => t._meta?.ui?.resourceUri).map((t) => t.name).sort();
  check(carded.join() === "buy,compare-offers,request-permission", `tools with a chat card → ${carded.join(", ")}`);
  const watcher = tools.find((t) => t.name === "credentagent-permission-status")?._meta;
  check(watcher?.ui?.visibility?.join() === "app" && watcher["openai/widgetAccessible"] === true, "credentagent-permission-status is the card's: callable by it, hidden from the model");
  const cardUri = tools.find((t) => t.name === "buy")._meta.ui.resourceUri;
  const card = (await mcp.readResource({ uri: cardUri })).contents[0];
  // The resource is the kit's page, served as built; the kit's own tests pin the page's integrity.
  const preview = await (await fetch(local(0, "/widget"))).text();
  check(card.text === preview && card.text.includes("ui/initialize"), `card resource ${cardUri.split("/").pop()} is the kit's card page, the one /widget previews`);

  const asked = await mcp.callTool({ name: "request-permission", arguments: { store: beanbarn, skus: ["house-blend"], budget: 50, perSpend: 25, description: "House Blend from BeanBarn — up to $50, $25 a purchase.", why: "lowest price for House Blend with a 4.4 rating" } });
  const grant = asked.structuredContent;
  check(grant.approveUrl?.startsWith(beanbarn) && grant.store?.name === "BeanBarn", `request-permission → approveUrl ${grant.approveUrl}`);
  check(asked._meta?.["credentagent/qr"]?.startsWith("data:image/svg+xml") && !asked.content[0].text.includes("data:image"), "the QR code reaches the card, not the model's text");

  // The phone, simulated: it opens the link, then the real signing endpoints, a real P-256 signature.
  const signOnPhone = async (store, g) => {
    await fetch(g.approveUrl);
    const oid = await (await fetch(`${store}/credentagent/grants/${g.grantId}/sign/request`)).json();
    const signature = await devSimulateWalletSignature({ request: { request: oid.requests[0].data.request, dcql_query: oid.dcql_query }, origin: store });
    await fetch(`${store}/credentagent/grants/${g.grantId}/sign/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ readerContextToken: oid.readerContextToken, result: signature }) });
  };
  await signOnPhone(beanbarn, grant);

  // The card follows the signature and tells the chat ONCE, however often it redraws or reloads.
  const seen = await tool("credentagent-permission-status", { grantId: grant.grantId });
  const again = await tool("credentagent-permission-status", { grantId: grant.grantId });
  check(seen.status === "authorized" && seen.announce === true && again.announce === false, "the card announces the signature exactly once");

  const held = await tool("check-permission", { store: beanbarn, grantId: grant.grantId });
  check(held.status === "authorized", `check-permission → ${held.status} (${held.trustLevel})`);

  const bought = await tool("buy", { store: beanbarn, grantId: grant.grantId, items: [{ sku: "house-blend" }] });
  check(bought.ok === true && bought.order?.total === 21, `buy at BeanBarn → ${bought.ok ? `verified, $${bought.order.total}, ${bought.trustLevel}` : JSON.stringify(bought)}`);

  // The permission names BeanBarn. Acme must refuse it, even though the agent's signature is valid.
  const elsewhere = await tool("buy", { store: acme, grantId: grant.grantId, items: [{ sku: "house-blend" }] });
  check(elsewhere.ok === false && elsewhere.reason === "This permission was signed for another store", `same permission at Acme → refused: "${elsewhere.reason}"`);

  // Not on the permission: green tea is in BeanBarn's catalog but not in what the person signed.
  const offList = await tool("buy", { store: beanbarn, grantId: grant.grantId, items: [{ sku: "green-tea" }] });
  check(offList.ok === false, `unsigned product → refused (${offList.code ?? offList.detail})`);

  // Budget: $21 spent of $50, so a second bag fits and a third does not.
  const second = await tool("buy", { store: beanbarn, grantId: grant.grantId, items: [{ sku: "house-blend" }] });
  const third = await tool("buy", { store: beanbarn, grantId: grant.grantId, items: [{ sku: "house-blend" }] });
  check(second.ok === true && third.ok === false, `budget $50: 2nd bag → ${second.ok ? "ok" : second.code}, 3rd → ${third.ok ? "ok (WRONG)" : third.code}`);

  // …and never announces what the model already knows: here it checked first, so the card stays quiet
  // (a second "go ahead" in the chat could send the model to buy twice).
  const roastworks = stores.find((s) => s.store === "RoastWorks").url;
  const espresso = (await mcp.callTool({ name: "request-permission", arguments: { store: roastworks, skus: ["espresso-beans"], budget: 20, perSpend: 20, description: "Espresso Beans from RoastWorks.", why: "top-rated espresso, and the cheapest" } })).structuredContent;
  await signOnPhone(roastworks, espresso);
  await tool("check-permission", { store: roastworks, grantId: espresso.grantId });
  const quiet = await tool("credentagent-permission-status", { grantId: espresso.grantId });
  check(quiet.status === "authorized" && quiet.announce === false, "the card stays quiet when the model already knows it is signed");

  // …and while the model is waiting for the signature in its own turn (the normal path): it will see the
  // signature itself, so a message from the card would be a second "go ahead".
  const tea = (await mcp.callTool({ name: "request-permission", arguments: { store: acme, skus: ["green-tea"], budget: 20, perSpend: 20, description: "Green Tea from Acme.", why: "the person asked for tea" } })).structuredContent;
  const modelWaits = tool("check-permission", { store: acme, grantId: tea.grantId }); // open, holding for the signature
  await new Promise((ok) => setTimeout(ok, 200));
  await signOnPhone(acme, tea);
  const [cardSaw, modelSaw] = await Promise.all([tool("credentagent-permission-status", { grantId: tea.grantId }), modelWaits]);
  check(modelSaw.status === "authorized" && cardSaw.announce === false && cardSaw.final === true, "the card stays quiet while the model waits for the signature in its turn");

  // Scenario 1, simple: one store sells it, so there is nothing to compare. The agent says so and buys there.
  const coldBrew = await mcp.callTool({ name: "compare-offers", arguments: { product: "cold brew" } });
  const only = coldBrew.structuredContent.summary?.sellers;
  check(only?.join() === "RoastWorks" && coldBrew.content[0].text.startsWith("Only RoastWorks sells it"), `scenario 1: "cold brew" is sold only by ${only?.join(", ")}`);
  const cb = (await mcp.callTool({ name: "request-permission", arguments: { store: roastworks, skus: ["cold-brew"], budget: 14, perSpend: 14, description: "Cold Brew from RoastWorks, up to $14.", why: "the only store that sells it" } })).structuredContent;
  await signOnPhone(roastworks, cb);
  await tool("check-permission", { store: roastworks, grantId: cb.grantId });
  const cbBought = await tool("buy", { store: roastworks, grantId: cb.grantId, items: [{ sku: "cold-brew" }] });
  check(cbBought.ok === true && cbBought.order?.total === 14, `scenario 1: bought at RoastWorks → ${cbBought.ok ? `$${cbBought.order.total}` : cbBought.reason}`);
  const decaf = await mcp.callTool({ name: "compare-offers", arguments: { product: "decaf" } });
  check(decaf.structuredContent.summary?.sellers.length === 0 && decaf.content[0].text.startsWith('No store sells "decaf"'), "a product no store sells: the agent is told not to ask for a permission");

  // Scenario 2(a): every store sells it above the person's limit. The agent is told not to ask and not to buy,
  // and a store refuses to open a permission nothing could be bought with, so the phone is never asked to sign one.
  const pricey = await mcp.callTool({ name: "compare-offers", arguments: { product: "espresso", maxPrice: 15 } });
  const ps = pricey.structuredContent.summary;
  check(ps?.within?.length === 0 && ps.cheapest?.store === "RoastWorks" && ps.cheapest.price === 18 && pricey.content[0].text.startsWith("No offer is within the person's maximum of $15.00"), `scenario 2(a): nothing within $15 — cheapest $${ps?.cheapest?.price} at ${ps?.cheapest?.store}`);
  const useless = await mcp.callTool({ name: "request-permission", arguments: { store: roastworks, skus: ["espresso-beans"], budget: 15, perSpend: 15, description: "Espresso, up to $15.", why: "cheapest" } });
  const roastFeed = await (await fetch(`${roastworks}/console/history`)).json();
  check(useless.isError === true && /within its limit/.test(useless.structuredContent?.error ?? "") && roastFeed.some((e) => e.type === "permission.refused"), "scenario 2(a): the store won't open a permission nothing fits — and its back office says why");

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
