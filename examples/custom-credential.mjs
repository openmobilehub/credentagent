// Gate ANY consequential action with ANY credential (Principle V).
//
//   npm run build:packages               # build the two @openmobilehub/attesto-* packages
//   node examples/custom-credential.mjs  # → http://localhost:3006/mcp
//
// Mirrors examples/storefront.mjs, but adds a CUSTOM credential — a `prescription`
// gate defined inline with `defineCredential({ id, request, verify, effect, ui })`,
// no registration step — composed alongside the three built-ins on the same ordered
// policy array. The custom gate is conditional: `appliesTo` (AND-ed with any
// call-site `.when()`) makes it appear ONLY for pharmacy lines, so an OTC-only cart
// surfaces no prescription card. This is the core promise: the built-ins
// (age/membership/payment) are merely pre-defined credentials; you write your own
// the exact same way.
//
// `attesto.mount(store.app)` reads the ceremony seams the storefront published on
// `store.app.locals.attesto` and wires the `/attesto/*` rails onto THIS server. Set
// GATE_SECRET for a stable challenge key across restarts (otherwise a dev server
// uses an ephemeral per-process key).

import { createStorefront } from "@openmobilehub/attesto-storefront/server";
import {
  Attesto,
  age,
  membership,
  payment,
  required,
  optional,
  defineCredential,
  dcql,
  gate,
} from "@openmobilehub/attesto-gate";

// ── A catalog with a pharmacy (Rx) line, so the custom gate has something to fire on ──
// createStorefront() injects the catalog; `Product.category` is a free-form string,
// and priceCart() forwards `category` (and `minimumAge`) onto each priced line — so a
// priced Order feeds attesto.requirements() directly, no mapping (see the storefront's
// PricedCartLine).
const catalog = [
  {
    id: "amoxicillin",
    name: "Amoxicillin 500mg (30 caps)",
    price: 42.0,
    currency: "USD",
    image: "",
    category: "Pharmacy", // ← the flag our custom `appliesTo` reads off the line
    description: "Prescription antibiotic. Requires a valid prescription.",
  },
  {
    id: "ibuprofen",
    name: "Ibuprofen 200mg (50 tablets)",
    price: 8.0,
    currency: "USD",
    image: "",
    category: "Health", // over-the-counter — NOT a pharmacy line, so no Rx gate
    description: "Over-the-counter pain reliever.",
  },
  {
    id: "oak-whiskey",
    name: "Oak Reserve Whiskey Collection",
    price: 124.0,
    currency: "USD",
    image: "",
    category: "Beverages",
    description: "Trio of small-batch aged whiskeys. 21+ only.",
    minimumAge: 21, // built-in age gate still composes alongside the custom one
  },
];

const store = createStorefront({ catalog, signingKey: process.env.GATE_SECRET });
const attesto = new Attesto();
attesto.mount(store.app); // …reads the seams + wires the /attesto/* ceremony rails

// ── The custom credential — defined by OBJECT, no registration (Principle V) ──
// defineCredential returns a Credential of the SAME shape as age.over(21) /
// membership.discount(10) / payment.in("usd"); the resolver reads its `effect` +
// `ui` and runs `appliesTo`. The canonical gate `OrderLine` type carries a
// `requiresRx` flag for exactly this case, BUT the storefront's PricedCartLine only
// forwards `category` / `minimumAge` (not `requiresRx`), so to stay genuinely
// runnable on a createStorefront() order we key the predicate off `category`.
const isPharmacyLine = (order) => order.lines.some((l) => l.category === "Pharmacy");

const prescription = defineCredential({
  id: "prescription",
  request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }), // what to ask the wallet
  verify: (claims) => claims.rx_valid === true, // explicit positive claim (Security: not mere token presence)
  effect: gate(), // gate() | discount({percent}) | authorize() — a hard gate here
  appliesTo: isPharmacyLine, // definition-time conditional: ONLY for pharmacy lines
  ui: { label: "Prescription", action: "Verify prescription" }, // the card shown in Context 2
});

const hasAlcohol = (order) => order.lines.some((l) => l.minimumAge != null);

// ── One ordered, conditional policy array (Principle IV) ──
// Custom and built-in credentials drop into the SAME array; array position is run
// order; payment settles LAST no matter where it's declared. `.when(...)` composes
// (AND) onto a credential's `appliesTo`.
store.gate((order) =>
  attesto.requirements(order, [
    required(prescription), // CUSTOM gate — surfaces only when appliesTo (Pharmacy) holds
    required(age.over(21).when(hasAlcohol)), // built-in 21+ — only when the cart has alcohol
    optional(membership.discount(10)), // built-in 10% off with a loyalty credential
    required(payment.in("usd")), // built-in — amount derived from the order; settles last
  ]),
);

// ── inputSchema → handler-field tracing (Principle I) ──
// The storefront's `checkout` tool (attesto-storefront/src/server.ts) declares
// `inputSchema: { items: z.array(z.object({ productId, quantity })).optional() }`. Its
// handler destructures exactly that `{ items }`, snapshots them into a priced Order,
// and passes that Order to the `store.gate(...)` resolver above — which returns the
// flat `requires` manifest the agent + widget read back on `structuredContent`. Every
// value the agent sees traces to a field declared inline; no hidden config, no
// injected callbacks. requirements() is the code→data boundary — `appliesTo` / `verify`
// run server-side HERE and never cross the wire (Principle VI).

const { url } = await store.listen(Number(process.env.PORT ?? 3006));
console.log(`\n  ✓ Attesto custom-credential storefront running → ${url}`);
console.log("  Add it to Goose as a Streamable HTTP connector, then try:");
console.log('    "buy the amoxicillin"  → the Prescription gate is surfaced (appliesTo: Pharmacy)');
console.log('    "buy the ibuprofen"    → NO prescription gate (OTC line)');
console.log('    "buy the whiskey"      → the built-in age 21+ gate fires instead\n');

// ── Honest limit (Principle VII) ──
// requirements() fully RESOLVES this custom gate into the manifest — appliesTo,
// effect, ui.label, and a per-order approve link all flow through — and the agent
// surfaces it correctly. What is NOT wired yet: the MOUNTED phone ceremony only knows
// the built-in `age` / `membership` kinds (CredentialKind in
// attesto-gate/src/ceremony/credential-gate/dcql.ts is `"age" | "membership"`), so a
// custom credential's own `request` (DCQL) / `verify` / `ui.action` are not executed
// by the ceremony page in v0.1 — completing an arbitrary custom credential on the
// phone is roadmap. And trust_level is "presence-only-demo": v0.1 enforces disclosure
// + nonce binding, NOT issuer/device signatures — a flow demonstration, never a real
// safety control yet.
