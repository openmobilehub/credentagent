// Run the REAL storefront + gate from THIS repo (the code we've been iterating on) —
// not the separate demo's vendored copy.
//
//   npm run build -w @openmobilehub/attestomcp-gate
//   npm run build -w @openmobilehub/attestomcp-storefront
//   node examples/run-storefront/serve.mjs        # → http://localhost:3005
//
// Serves:
//   • http://localhost:3005/mcp            — the MCP shopping endpoint (connect a client)
//   • http://localhost:3005/attestomcp/*   — the gate's browsable checkout / approve pages
//   • the product-picker widget bundle
//
// The `/attestomcp/*` checkout pages have instant-demo buttons, so you can drive the age /
// passkey / dc-payment ceremony in a browser WITHOUT a phone wallet.
import express from "express";
import { createStorefront } from "@openmobilehub/attestomcp-storefront/server";
import { AttestoMCP, required, optional, age, membership } from "@openmobilehub/attestomcp-gate";

const PORT = Number(process.env.PORT) || 3005;
// STATELESS=1 → the checkout link carries the signed cart mandate (?order=…&cart=…), no
// order store. Default (unset) → STATEFUL: the store holds the order, link is ?order=id.
const STATELESS = process.env.STATELESS === "1" || process.env.STATELESS === "true";
const base = `http://localhost:${PORT}`;
// allowEphemeralKey: this is a single-process dev server, so a per-process signing key is
// fine. A multi-instance deploy MUST pass a stable { signingKey } instead (statelessOrders
// throws without one otherwise — a mandate must verify across instances).
const store = createStorefront({ baseUrl: base, statelessOrders: STATELESS, allowEphemeralKey: true });

// Wire the gate as the quickstart does: a required age-21 gate on any alcohol line, plus
// an OPTIONAL 10% membership discount (present a loyalty credential → discount applies).
// mount() reads statelessOrders (+ the owned signingKey) off app.locals.attestomcp.
const attestomcp = new AttestoMCP();
attestomcp.mount(store.app);
store.gate((order) =>
  attestomcp.requirements(order, [
    required(age.over(21).when((o) => (o.lines ?? []).some((l) => (l.minimumAge ?? 0) >= 21))),
    optional(membership.discount(10)),
  ]),
);

// Wrap the storefront app behind a permissive CORS layer so the MCP Inspector's
// "Direct" (browser → server) connection works — the storefront app itself is
// same-origin/proxy-oriented and sends no CORS headers. Dev-only convenience.
const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.header("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] ?? "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.header("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});
app.use(store.app);
await new Promise((resolve) => app.listen(PORT, resolve));
const url = `${base}/mcp`;
console.log(`\n  storefront (this repo's code) → ${base}`);
console.log(`  mode                          → ${STATELESS ? "STATELESS (cart mandate in the link: ?order=id&cart=…)" : "STATEFUL (store-backed: ?order=id)"}`);
console.log(`  MCP endpoint                  → ${url}`);
console.log(`  gate checkout pages           → ${base}/attestomcp/…`);
console.log(`\n  Shop via an MCP client:  npx @modelcontextprotocol/inspector  → ${url}`);
console.log(`  then browse → add the whiskey → checkout returns a /attestomcp/… approve link;`);
console.log(`  open it in a browser and drive the ceremony with the instant-demo buttons.\n`);
