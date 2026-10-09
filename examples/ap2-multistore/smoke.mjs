// ap2-multistore/smoke.mjs — the same conversation Claude has, driven over MCP with NO phone: the
// phone's signature is simulated (devSimulateWalletSignature) through the store's real signing
// endpoints. Run it before a live demo; it exits non-zero if any step is wrong.
//
//   node examples/ap2-multistore/smoke.mjs
//
// It runs on ports 4200–4204 (SMOKE_BASE_PORT), so it never collides with a live demo on 4100–4104.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { devSimulateWalletSignature } from "@openmobilehub/credentagent-gate";

const here = (f) => new URL(f, import.meta.url).pathname;
const BASE = Number(process.env.SMOKE_BASE_PORT ?? 4200);
const local = (n, path = "") => `http://localhost:${BASE + n}${path}`;
// A short grace window, so "the model stopped waiting" is reached in milliseconds, not the live 20 s. CATALOG_LOOKUP_MS
// gives the stores a slow catalog (as a database would be), so two purchases sent together really do overlap there.
const env = { ...process.env, BASE_PORT: String(BASE), AP2_MODEL_GRACE_MS: "300", AP2_PRICE_POLL_MS: "200", CATALOG_LOOKUP_MS: "50" };
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

  // The chat cards: three tools render the widget, served as one resource per host (Claude, ChatGPT).
  const { tools } = await mcp.listTools();
  const carded = tools.filter((t) => t._meta?.ui?.resourceUri).map((t) => t.name).sort();
  check(carded.join() === "buy,buy-when-price-drops,compare-offers,make-offer,request-permission", `tools with a chat card → ${carded.join(", ")}`);
  const watcher = tools.find((t) => t.name === "watch-permission")?._meta;
  check(watcher?.ui?.visibility?.join() === "app" && watcher["openai/widgetAccessible"] === true, "watch-permission is the card's: callable by it, hidden from the model");
  const cardUri = tools.find((t) => t.name === "buy")._meta.ui.resourceUri;
  const card = (await mcp.readResource({ uri: cardUri })).contents[0];
  const tags = (re) => (card.text.match(re) ?? []).length; // a raw "</script" inside the inlined client would close its tag early
  check(card.text.includes("globalThis.ExtApps=") && tags(/<script\b/gi) === tags(/<\/script/gi), `card resource ${cardUri.split("/").pop()} inlines the MCP Apps client`);
  // Inlined byte for byte, and still valid JavaScript. A host reports any script error in a card as
  // "Runtime error" (ChatGPT did, when a string replace() expanded the bundle's "$&" and "$`").
  const inlined = card.text.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const bundle = readFileSync(new URL(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps")), "utf8");
  let compiles = true;
  try { new vm.Script(inlined); } catch { compiles = false; }
  check(compiles && inlined.startsWith(bundle.slice(0, 2000)) && inlined.includes(bundle.slice(-6000, bundle.lastIndexOf("export"))), "the inlined MCP Apps client is intact and compiles");

  const asked = await mcp.callTool({ name: "request-permission", arguments: { store: beanbarn, skus: ["house-blend"], budget: 50, perSpend: 25, description: "House Blend from BeanBarn — up to $50, $25 a purchase.", why: "lowest price for House Blend with a 4.4 rating" } });
  const grant = asked.structuredContent;
  check(grant.approveUrl?.startsWith(beanbarn) && grant.store === "BeanBarn", `request-permission → approveUrl ${grant.approveUrl}`);
  check(asked._meta?.["ap2/qr"]?.startsWith("data:image/svg+xml;base64,") && !asked.content[0].text.includes("data:image"), "the QR code reaches the card, not the model's text");

  // The phone, simulated: it opens the link, then the real signing endpoints, a real P-256 signature.
  const signOnPhone = async (store, g) => {
    await fetch(g.approveUrl);
    const oid = await (await fetch(`${store}/credentagent/grants/${g.grantId}/sign/request`)).json();
    const signature = await devSimulateWalletSignature({ request: { request: oid.requests[0].data.request, dcql_query: oid.dcql_query }, origin: store });
    await fetch(`${store}/credentagent/grants/${g.grantId}/sign/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ readerContextToken: oid.readerContextToken, result: signature }) });
  };
  await signOnPhone(beanbarn, grant);

  // The card follows the signature and tells the chat ONCE, however often it redraws or reloads.
  const seen = await tool("watch-permission", { store: beanbarn, grantId: grant.grantId });
  const again = await tool("watch-permission", { store: beanbarn, grantId: grant.grantId });
  check(seen.status === "authorized" && seen.announce === true && again.announce === false, "the card announces the signature exactly once");

  const held = await tool("check-permission", { store: beanbarn, grantId: grant.grantId });
  check(held.status === "authorized", `check-permission → ${held.status} (${held.trustLevel})`);

  const bought = await tool("buy", { store: beanbarn, grantId: grant.grantId, items: [{ sku: "house-blend" }] });
  check(bought.ok === true && bought.order?.amount === 2100, `buy at BeanBarn → ${bought.ok ? `verified, $${bought.order.amount / 100}, ${bought.order.trust_level}` : JSON.stringify(bought)}`);

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

  // Two purchases under ONE permission that arrive together (a standing order's tick and a manual buy, say) must
  // not both pass the budget check: $25 signed, $21 a bag, so exactly one fits (#287).
  const pair = (await mcp.callTool({ name: "request-permission", arguments: { store: beanbarn, skus: ["house-blend"], budget: 25, perSpend: 25, description: "House Blend from BeanBarn — up to $25, $25 a purchase.", why: "a second permission, to try two purchases at once" } })).structuredContent;
  await signOnPhone(beanbarn, pair);
  await tool("check-permission", { store: beanbarn, grantId: pair.grantId });
  const both = await Promise.all([1, 2].map(() => tool("buy", { store: beanbarn, grantId: pair.grantId, items: [{ sku: "house-blend" }] })));
  const oneFit = both.filter((b) => b.ok === true).length === 1 && both.filter((b) => b.ok === false).length === 1;
  check(oneFit, `two purchases at once can't spend past the signed total ($25): one ok, one refused${oneFit ? "" : ` — got ${both.map((b) => (b.ok ? "ok" : b.code)).join(", ")}`}`);

  // …and never announces what the model already knows: here it checked first, so the card stays quiet
  // (a second "go ahead" in the chat could send the model to buy twice).
  const roastworks = stores.find((s) => s.store === "RoastWorks").url;
  const espresso = (await mcp.callTool({ name: "request-permission", arguments: { store: roastworks, skus: ["espresso-beans"], budget: 20, perSpend: 20, description: "Espresso Beans from RoastWorks.", why: "top-rated espresso, and the cheapest" } })).structuredContent;
  await signOnPhone(roastworks, espresso);
  await tool("check-permission", { store: roastworks, grantId: espresso.grantId });
  const quiet = await tool("watch-permission", { store: roastworks, grantId: espresso.grantId });
  check(quiet.status === "authorized" && quiet.announce === false, "the card stays quiet when the model already knows it is signed");

  // …and while the model is waiting for the signature in its own turn (the normal path): it will see the
  // signature itself, so a message from the card would be a second "go ahead".
  const tea = (await mcp.callTool({ name: "request-permission", arguments: { store: acme, skus: ["green-tea"], budget: 20, perSpend: 20, description: "Green Tea from Acme.", why: "the person asked for tea" } })).structuredContent;
  const modelWaits = tool("check-permission", { store: acme, grantId: tea.grantId }); // open, holding for the signature
  await new Promise((ok) => setTimeout(ok, 200));
  await signOnPhone(acme, tea);
  const [cardSaw, modelSaw] = await Promise.all([tool("watch-permission", { store: acme, grantId: tea.grantId }), modelWaits]);
  check(modelSaw.status === "authorized" && cardSaw.announce === false && cardSaw.final === true, "the card stays quiet while the model waits for the signature in its turn");

  // Scenario 1, simple: one store sells it, so there is nothing to compare. The agent says so and buys there.
  const coldBrew = await mcp.callTool({ name: "compare-offers", arguments: { product: "cold brew" } });
  const only = coldBrew.structuredContent.summary?.sellers;
  check(only?.join() === "RoastWorks" && coldBrew.content[0].text.startsWith("Only RoastWorks sells it"), `scenario 1: "cold brew" is sold only by ${only?.join(", ")}`);
  const cb = (await mcp.callTool({ name: "request-permission", arguments: { store: roastworks, skus: ["cold-brew"], budget: 14, perSpend: 14, description: "Cold Brew from RoastWorks, up to $14.", why: "the only store that sells it" } })).structuredContent;
  await signOnPhone(roastworks, cb);
  await tool("check-permission", { store: roastworks, grantId: cb.grantId });
  const cbBought = await tool("buy", { store: roastworks, grantId: cb.grantId, items: [{ sku: "cold-brew" }] });
  check(cbBought.ok === true && cbBought.order?.amount === 1400, `scenario 1: bought at RoastWorks → ${cbBought.ok ? `$${cbBought.order.amount / 100}` : cbBought.reason}`);
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

  // Scenario 2(b): the person signs "buy it when it drops to $15" and leaves. The agent watches the price and
  // buys the moment the store owner drops it, under the permission already signed — with nobody in the chat.
  const later = (await mcp.callTool({ name: "request-permission", arguments: { store: roastworks, skus: ["espresso-beans"], budget: 15, perSpend: 15, description: "Espresso Beans once they cost $15 or less.", why: "the cheapest, once it drops", waitForPrice: true } })).structuredContent;
  check(Boolean(later.grantId), "scenario 2(b): a permission to buy when the price drops can be signed (the 2(a) refusal steps aside)");
  await signOnPhone(roastworks, later);
  await tool("check-permission", { store: roastworks, grantId: later.grantId });
  const order = await tool("buy-when-price-drops", { store: roastworks, grantId: later.grantId, sku: "espresso-beans", maxPrice: 15 });
  check(order.status === "watching" && order.lastPrice === 18, `scenario 2(b): standing order watching — price now $${order.lastPrice}`);
  const set = await fetch(local(4, "/price"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ store: "roastworks", sku: "espresso-beans", price: 15 }) });
  let done = null;
  for (let i = 0; i < 50 && !done; i++) {
    await new Promise((ok) => setTimeout(ok, 100));
    done = (await tool("standing-orders", {})).orders.find((o) => o.orderId === order.orderId && o.status !== "watching" && o.status !== "buying") ?? null;
  }
  check(set.ok && done?.status === "bought" && done.receipt?.order?.amount === 1500, `scenario 2(b): price dropped to $15 → ${done?.status ?? "still watching"}${done?.receipt?.order ? ` at $${done.receipt.order.amount / 100}, verified` : ""}`);

  // Scenario 2(c): the person's $20 limit is under every list price for House Blend, so the agent offers it.
  // Each store answers against a floor it never shows; an accepted offer is the store's record and buys once.
  check(stores.every((s) => s.products.every((p) => !("floor" in p))), "scenario 2(c): no store's catalog shows the agent its lowest price");
  const offered = await mcp.callTool({ name: "make-offer", arguments: { product: "house blend", price: 20 } });
  const answer = (name) => offered.structuredContent.answers.find((a) => a.store === name);
  check(answer("Acme Coffee Co")?.accepted === false && answer("Acme Coffee Co").counter === 22 && answer("BeanBarn")?.accepted === true && answer("BeanBarn").offerId && offered.content[0].text.startsWith("BeanBarn accepted $20.00"),
    `scenario 2(c): $20 offered → Acme declines (takes $${answer("Acme Coffee Co")?.counter}), BeanBarn accepts (list $${answer("BeanBarn")?.list})`);
  const offerId = answer("BeanBarn").offerId;
  const noOffer = await mcp.callTool({ name: "request-permission", arguments: { store: beanbarn, skus: ["house-blend"], budget: 40, perSpend: 20, description: "House Blend, $20.", why: "accepted our offer" } });
  check(noOffer.isError === true, "scenario 2(c): without the accepted offer, BeanBarn won't open a $20 permission (its price is $21)");
  const deal = (await mcp.callTool({ name: "request-permission", arguments: { store: beanbarn, skus: ["house-blend"], budget: 40, perSpend: 20, description: "House Blend from BeanBarn at the $20 it accepted.", why: "accepted our offer", offerId } })).structuredContent;
  await signOnPhone(beanbarn, deal);
  await tool("check-permission", { store: beanbarn, grantId: deal.grantId });
  const dealt = await tool("buy", { store: beanbarn, grantId: deal.grantId, items: [{ sku: "house-blend" }] });
  check(dealt.ok === true && dealt.order?.amount === 2000 && dealt.order.checks.some((c) => c.startsWith("Our record of the offer we accepted")), `scenario 2(c): bought at the offer → ${dealt.ok ? `$${dealt.order.amount / 100}, verified` : dealt.reason}`);
  // The offer is spent: a second bag under the same permission (budget $40) is priced at the $21 list, over its $20 limit.
  const twice = await tool("buy", { store: beanbarn, grantId: deal.grantId, items: [{ sku: "house-blend" }] });
  check(twice.ok === false, `scenario 2(c): the offer buys once — a second bag → refused (${twice.code ?? twice.reason})`);
  // …and a second permission signed for the same offer cannot spend it again either.
  const reuse = (await mcp.callTool({ name: "request-permission", arguments: { store: beanbarn, skus: ["house-blend"], budget: 20, perSpend: 20, description: "House Blend, $20.", why: "same offer", offerId } }));
  check(reuse.isError === true, "scenario 2(c): a used offer can't open another $20 permission");

  // The back offices: each store's page renders, and its live feed saw what happened there.
  const page = await (await fetch(`${beanbarn}/`)).text();
  check(page.includes("Live activity") && page.includes('"BeanBarn"'), "BeanBarn back office renders");
  const types = (await (await fetch(`${beanbarn}/console/history`)).json()).map((e) => e.type);
  const want = ["catalog.read", "permission.requested", "permission.opened", "permission.signed", "cart.quoted", "purchase.verified", "purchase.refused", "offer.accepted"];
  const missing = want.filter((t) => !types.includes(t));
  check(missing.length === 0, `BeanBarn feed → every event kind${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  const acmeFeed = await (await fetch(`${acme}/console/history`)).json();
  const acmeRefusal = acmeFeed.find((e) => e.type === "purchase.refused");
  check(acmeRefusal?.reason === "This permission was signed for another store", `Acme feed says why → "${acmeRefusal?.reason}"`);
  check(acmeFeed.some((e) => e.type === "offer.declined" && e.counter === 2200), "Acme feed shows the offer it declined, and the lowest it takes");
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
