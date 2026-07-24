#!/usr/bin/env node
// A runnable CredentAgent gate for browser / on-device testing of the demo credentials.
//
// It IS the quickstart (examples/quickstart/server.mjs): the REAL storefront reference
// consumer — createStorefront() + CredentAgent.mount() + store.gate(policy) — so the
// checkout page, place-order, cart mandate, completion and MCP tools are the actual
// library code, not a hand-rolled copy. It adds exactly two things:
//   1. the demo reader identity (optional; #51) so a wallet holding utopia.rical trusts
//      the verifier, and
//   2. ONE seeded order (ORD-DEMO) so a single browser link opens the real storefront
//      checkout without needing an MCP agent to mint an order first.
//
//   (cd packages/credentagent-gate && npm run build)          # once
//   (cd packages/credentagent-storefront && npm run build)    # once
//   node tools/demo-pki/run-gate.mjs                          # → :3007
//   open http://localhost:3007/checkout?order=ORD-DEMO
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { createOrder, SAMPLE_CATALOG } from "@openmobilehub/credentagent-storefront";
import { CredentAgent, age, membership, payment, required, optional, defineCredential, dcql, gate } from "@openmobilehub/credentagent-gate";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3007);
const BASE = `http://localhost:${PORT}`;

// The demo reader identity is OPTIONAL (#51). If ./gen-pki.sh has produced it, present it
// so a wallet holding utopia.rical trusts the verifier; if not (fresh clone), the gate
// self-signs per request — the ceremony still works, the wallet just shows the verifier
// as untrusted. The trust setup is an upgrade, never a prerequisite.
const keyPath = join(HERE, "keys/reader-key.pem");
const certPath = join(HERE, "certs/reader-cert.pem");
const readerIdentity =
  existsSync(keyPath) && existsSync(certPath)
    ? { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") }
    : undefined;

// The REAL storefront — catalog, cart/order stores, checkout page, place-order, cart
// mandate, completion, MCP tools. We inject an in-memory created-order store so we can
// seed one order for a browser link (the storefront otherwise mints orders via its MCP
// `checkout` tool).
const orders = new Map();
const createdOrderStore = { read: async (id) => orders.get(id) ?? null, write: async (id, o) => { orders.set(id, o); } };
const store = createStorefront({ createdOrderStore, baseUrl: BASE, signingKey: "demo-gate-secret" });

// Wire the /credentagent/* ceremony rails onto the storefront's server, with the demo
// reader identity threaded through.
const credentagent = new CredentAgent({ walletOrigin: BASE, ...(readerIdentity ? { readerIdentity } : {}) });
credentagent.mount(store.app);

// A CUSTOM gate — any credential drops into the same policy and now renders CONSISTENTLY
// on every page (checkout hub AND ceremony rail steppers), with its own label/action.
// `optional` because completing its ceremony is still roadmap (#42); it displays truthfully
// without blocking payment.
const liquorLicense = defineCredential({
  id: "liquor-license",
  request: dcql({ docType: "org.example.liquor.license.1", claims: ["license_active"] }),
  verify: (c) => c.license_active === true,
  effect: gate(),
  appliesTo: (o) => o.lines.some((l) => l.minimumAge != null), // alcohol carts only
  ui: { label: "Liquor license", action: "Verify license" },
});

// The policy: age 21+ on age-restricted lines, the custom liquor-license gate, optional
// membership discount, payment last.
store.gate((order) =>
  credentagent.requirements(order, [
    required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
    optional(membership.discount(10)),
    required(payment.in("usd")),
  ]),
);

// Seed ONE order (an age-restricted item) so a single browser link opens the real
// storefront checkout — no MCP agent needed to mint an order first.
const restricted = SAMPLE_CATALOG.find((p) => p.minimumAge != null) ?? SAMPLE_CATALOG[0];
await createdOrderStore.write("ORD-DEMO", createOrder([{ productId: restricted.id, quantity: 1 }], "ORD-DEMO", SAMPLE_CATALOG));

const { url } = await store.listen(PORT);
console.log(`\nCredentAgent demo gate (real storefront) → ${BASE}`);
console.log(
  readerIdentity
    ? `  reader identity : certs/reader-cert.pem  (SAN=localhost, on utopia.rical → verifier shows TRUSTED)`
    : `  reader identity : none — self-signed per request. Ceremony still works; wallet shows the\n                    verifier as UNTRUSTED (red). Run ./gen-pki.sh + import utopia.rical to fix.`,
);
console.log(`  seeded order    : ORD-DEMO  (1× ${restricted.name}, age ${restricted.minimumAge ?? "n/a"}+)\n`);
console.log(`Full checkout flow (age → pay → done) — one link:`);
console.log(`  ${BASE}/checkout?order=ORD-DEMO`);
console.log(`  MCP endpoint    : ${url}  (add to Claude/ChatGPT/Goose to drive it agentically)`);
console.log(`  (on the phone: \`adb reverse tcp:${PORT} tcp:${PORT}\` first, then open the checkout link)\n`);
console.log(`Ctrl-C to stop.`);
