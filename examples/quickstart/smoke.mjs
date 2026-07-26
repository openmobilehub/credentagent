// Smoke — the executable form of specs/007-quickstart-ladder/contracts/quickstart-surface.md.
//
//   npm run smoke                        # spawns server.mjs (stateless mode) and asserts a–i
//   SMOKE_URL=https://… npm run smoke    # same assertions against a deployed URL
//
// Every assertion is security-bearing: each fails when its control is removed. Beyond the
// a–g contract surface, (h) pins the age THRESHOLD match (invariant 5 — an 18+ proof must
// not satisfy a 21+ gate) and (i) pins per-order state SCOPING (invariant 4 — one order's
// age verification must not unlock another).
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = Number(process.env.SMOKE_PORT ?? 3999);
const external = process.env.SMOKE_URL?.replace(/\/$/, "");
const base = external ?? `http://localhost:${PORT}`;
let child, failures = 0;

const ok = (label, cond, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${cond ? "" : `  ← FAILED ${detail}`}`);
  if (!cond) failures++;
};
const tamper = (cart) => {
  const m = JSON.parse(Buffer.from(cart, "base64url").toString());
  m.lines[0].quantity += 9; // price a 1-qty order, pay for 10 — must be refused
  m.lines[0].lineTotal = m.lines[0].unitPrice * m.lines[0].quantity;
  return Buffer.from(JSON.stringify(m)).toString("base64url");
};
const placeOrder = (order, cart) =>
  fetch(`${base}/checkout/place-order`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ order, ...(cart ? { cart } : {}) }),
  });
const completed = async (orderId) =>
  (await (await fetch(`${base}/checkout/order-status?orderId=${orderId}`)).json()).completed;

if (!external) {
  // Boot-refusal probe (US3.3): deployed mode without GATE_SECRET must fail fast.
  const env = { ...process.env, VERCEL: "1", PORT: String(PORT) };
  delete env.GATE_SECRET; delete env.VERCEL_PROJECT_PRODUCTION_URL;
  delete env.KV_REST_API_URL; delete env.KV_REST_API_TOKEN;
  delete env.UPSTASH_REDIS_REST_URL; delete env.UPSTASH_REDIS_REST_TOKEN;
  const probe = spawnSync("node", ["server.mjs"], { env, timeout: 10_000, encoding: "utf8" });
  ok("boot refuses without GATE_SECRET (deployed mode)", probe.status !== 0 && /GATE_SECRET/.test(probe.stderr));

  // Real run: deployed-mode semantics (statelessOrders) on localhost.
  child = spawn("node", ["server.mjs"], { env: { ...env, GATE_SECRET: "quickstart-smoke-secret" }, stdio: ["ignore", "pipe", "inherit"] });
  for (let i = 0; ; i++) {
    try { await fetch(`${base}/checkout/order-status?orderId=probe`); break; }
    catch { if (i > 60) { console.error("server never came up"); process.exit(1); } await new Promise((r) => setTimeout(r, 250)); }
  }
}

try {
  // (a) MCP initialize handshake
  const mcp = new Client({ name: "quickstart-smoke", version: "0.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  ok("(a) MCP initialize handshake", true);

  // (g) the widget bundle actually loads — the ui:// resource read must return HTML,
  // not "widget bundle not found". A Node client calling tools never exercises this, so
  // a missing bundle (e.g. not in the serverless includeFiles) slips past every other
  // assertion; this is the one that catches it.
  try {
    const list = await mcp.listResources();
    const ui = list.resources.find((r) => r.uri.startsWith("ui://"));
    const doc = ui ? await mcp.readResource({ uri: ui.uri }) : null;
    const html = doc?.contents?.[0]?.text ?? "";
    ok("(g) widget ui:// resource loads (HTML bundle present)", !!ui && html.includes("<") && html.length > 1000, `uri=${ui?.uri} len=${html.length}`);
  } catch (e) {
    ok("(g) widget ui:// resource loads (HTML bundle present)", false, e.message.slice(0, 80));
  }

  const checkout = async (items) => {
    const r = await mcp.callTool({ name: "checkout", arguments: { items } });
    const sc = r.structuredContent ?? {};
    return { ...sc, cart: sc.checkoutUrl ? new URL(sc.checkoutUrl).searchParams.get("cart") : null };
  };

  // (b) whiskey → age gate in the requires manifest, payment last
  const gated = await checkout([{ productId: "oak-whiskey", quantity: 1 }]);
  const ageReq = (gated.requires ?? []).find((e) => e.credential === "age");
  ok("(b) whiskey checkout requires age 21+ (required, payment last)",
    !!ageReq && ageReq.required === true && ageReq.minAge === 21 &&
    gated.requires.at(-1)?.credential === "payment", JSON.stringify(gated.requires));

  // (c) headphones → no age entry
  const ungated = await checkout([{ productId: "aurora-headphones", quantity: 1 }]);
  ok("(c) headphones checkout has no age requirement",
    !(ungated.requires ?? []).some((e) => e.credential === "age"), JSON.stringify(ungated.requires));

  const CLAIMS = { issuer_name: "Demo Bank", payment_instrument_id: "pi-SMOKE", holder_name: "Smoke Buyer", expiry_date: "2032-09-01" };
  const railVerify = (order, cartB64) =>
    fetch(`${base}/credentagent/dc-payment/verify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ order, cartMandate: JSON.parse(Buffer.from(cartB64, "base64url").toString()), claims: CLAIMS }),
    }).then((r) => r.json());
  // The credential rail's instant-demo path: present disclosed age claims for THIS order.
  const ageVerify = (order, cartB64, claims) =>
    fetch(`${base}/credentagent/credential/verify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cred: "age", order, cart: cartB64, claims }),
    }).then((r) => r.json());

  // (d) unverified completion of a GATED order → refused server-side (403)
  const d = await placeOrder(gated.orderId, gated.cart);
  ok("(d) unverified place-order of gated order → 403", d.status === 403, `got ${d.status}`);
  ok("(d′) gated order stays incomplete", (await completed(gated.orderId)) === false);

  // (f) enforce on EVERY completion path: paying for an age-gated order whose age is
  // still unverified must be refused by the payment rail itself, with the typed reason.
  if (gated.cart) {
    const f = await railVerify(gated.orderId, gated.cart);
    ok("(f) payment-only verify of age-gated order → refused (reason: age)",
      f.completed !== true && f.reason === "age" && (await completed(gated.orderId)) === false, JSON.stringify(f));
  }

  // (e) the payment rail: tampered cart mandate refused, untampered completes.
  // (place-order is the wrong door here — every quickstart order requires payment, so (d)
  // proves that path always 403s; stateless completion happens on the dc-payment rail.)
  const victim = await checkout([{ productId: "aurora-headphones", quantity: 1 }]);
  const attacked = await checkout([{ productId: "aurora-headphones", quantity: 1 }]);
  if (victim.cart) {
    const refused = await railVerify(attacked.orderId, tamper(attacked.cart));
    ok("(e) tampered cart mandate → verify refused, order NOT completed",
      refused.completed !== true && (await completed(attacked.orderId)) === false, JSON.stringify(refused));
    const done = await railVerify(victim.orderId, victim.cart);
    ok("(e′) untampered mandate completes on the payment rail (stateless)",
      done.completed === true && (await completed(victim.orderId)) === true, JSON.stringify(done));
  } else {
    ok("(e) skipped — store mode (no cart param); run with statelessOrders for the tamper probe", true);
  }

  // (h) THRESHOLD match (invariant 5): the 21+ whiskey gate must refuse an age_over_18
  // proof and accept an age_over_21 proof — the SAME order and gate, so the gate is shown
  // to discriminate by threshold, not by the mere presence of an age claim. (h) fails if
  // the gate is loosened to accept a lower threshold; (h′) fails if it rejects everything
  // (which would make (h) pass trivially) — the pair pins the boundary from both sides.
  if (gated.cart) {
    const under = await ageVerify(gated.orderId, gated.cart, { age_over_18: true });
    ok("(h) age_over_18 proof refused at the 21+ gate", under.verified === false, JSON.stringify(under.gates));
    const at = await ageVerify(gated.orderId, gated.cart, { age_over_21: true });
    ok("(h′) age_over_21 proof accepted at the 21+ gate", at.verified === true, JSON.stringify(at.gates));

    // (i) per-order state SCOPING (invariant 4): verifying age on one order must NOT
    // unlock a different age-gated order. Verify age on A only, then pay both A and B.
    // A completes; B — never age-verified — is refused by the payment rail for age. This
    // fails if verification state is process-global (B would wrongly complete: cross-user
    // bleed). A and B are independent checkouts, so they carry distinct order ids.
    const A = await checkout([{ productId: "oak-whiskey", quantity: 1 }]);
    const B = await checkout([{ productId: "oak-whiskey", quantity: 1 }]);
    await ageVerify(A.orderId, A.cart, { age_over_21: true }); // A only — B stays unverified
    const payA = await railVerify(A.orderId, A.cart);
    const payB = await railVerify(B.orderId, B.cart);
    ok("(i) A's age verification lets A complete on the payment rail",
      payA.completed === true && (await completed(A.orderId)) === true, JSON.stringify(payA).slice(0, 120));
    ok("(i′) A's age verification does NOT bleed to B (refused: age)",
      payB.completed !== true && payB.reason === "age" && (await completed(B.orderId)) === false, JSON.stringify(payB).slice(0, 120));
  }

  await mcp.close();
} catch (err) {
  console.error("smoke crashed:", err);
  failures++;
} finally {
  child?.kill();
}
console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nsmoke green — contract holds");
process.exit(failures ? 1 : 0);
