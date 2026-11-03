// The credential library, proven end-to-end (007): gate a purchase with a CUSTOM
// credential that completes on the phone with NO new code path.
//
//   npm run build:packages                    # build the two @openmobilehub/credentagent-* packages
//   node examples/professional-license.mjs    # → http://localhost:3007/mcp
//
// This is the worked pack for issue #19: a `professional_license` gate defined inline
// with `defineCredential({ id, request, verify, effect, ui })` — no registration step —
// and dropped into the same ordered policy array as the built-ins. Unlike the older
// `custom-credential.mjs` (which showed a custom gate RESOLVING into the manifest), this
// gate is served by the MOUNTED ceremony from its OWN request/verify and ENFORCED on the
// shared completion path: an order with the licensed item cannot complete until the
// license is proven — on every payment rail, not just the rendered page (invariant 1).
//
// The generalization is what makes this real: the credential-gate rail no longer knows
// only "age" | "membership" — it serves ANY credential the policy registers, and
// `completeOrder` sweeps every applicable `gate()` credential (re-derived from the
// re-priced order — invariant 2) and refuses one that isn't proven (per order — invariant 4).

import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import {
  CredentAgent,
  payment,
  required,
  defineCredential,
  dcql,
  gate,
} from "@openmobilehub/credentagent-gate";

// ── A catalog with a licensed (professional) item, so the custom gate has something
// to fire on. `Product.category` is a free-form string that priceCart() forwards onto
// each priced line, so the custom `appliesTo` can read it with no mapping. ──
const catalog = [
  {
    id: "contractor-drill",
    name: "ProForce 20V Hammer Drill (licensed trade)",
    price: 189.0,
    currency: "USD",
    image: "",
    category: "Licensed", // ← the flag our custom `appliesTo` reads off the line
    description: "High-torque hammer drill sold to licensed contractors.",
  },
  {
    id: "aurora-headphones",
    name: "Aurora Wireless Headphones",
    price: 199.0,
    currency: "USD",
    image: "",
    category: "Electronics", // NOT licensed — no license gate
    description: "Over-ear noise-cancelling headphones.",
  },
];

const store = createStorefront({ catalog, signingKey: process.env.GATE_SECRET });
const credentagent = new CredentAgent();
credentagent.mount(store.app); // …reads the seams + wires the /credentagent/* ceremony rails

// ── The custom credential — defined by OBJECT, no registration (Principle V) ──
// Same shape as age.over(21) / membership.discount(10) / payment.in("usd"). The
// generalized rail builds the wallet request from THIS `request` DCQL and runs THIS
// `verify` server-side; `completeOrder` enforces it whenever `appliesTo` holds.
const isLicensedLine = (order) => order.lines.some((l) => l.category === "Licensed");

const professionalLicense = defineCredential({
  id: "professional_license",
  request: dcql({ docType: "org.example.license.1", claims: ["license_active"] }), // what to ask the wallet
  verify: (claims) => claims.license_active === true, // explicit positive claim (Security invariant 5)
  effect: gate(), // custom credentials support gate() only — a hard gate
  appliesTo: isLicensedLine, // definition-time conditional: ONLY for licensed lines
  ui: { label: "Professional license", action: "Verify your license" }, // the card shown in Context 2
});

// ── One ordered, conditional policy array (Principle IV) ──
// The custom gate drops into the SAME array as the built-in payment; `appliesTo` keeps
// it off an unlicensed cart. `gate()` is the hard-block effect — it is enforced whenever
// it applies, on every completion path.
store.gate((order) =>
  credentagent.requirements(order, [
    required(professionalLicense), // CUSTOM gate — surfaces + enforces only for Licensed lines
    required(payment.in("usd")), // built-in — amount derived from the order; settles last
  ]),
);

const { url } = await store.listen(Number(process.env.PORT ?? 3007));
console.log(`\n  ✓ CredentAgent professional-license storefront running → ${url}`);
console.log("  Add it to Goose / Claude as a Streamable HTTP connector, then try:");
console.log('    "buy the contractor drill" → the Professional license gate is surfaced AND enforced');
console.log('    "buy the headphones"       → NO license gate (unlicensed line)\n');

// ── Honest scope (Principle VII) ──
// trust_level is "presence-only-demo" on every surface: the wire crypto is real
// (WebAuthn / OpenID4VP JWE + nonce binding / ISO-mdoc parse), but there is NO issuer /
// device-signature trust anchor yet, so a self-crafted mdoc would pass. This gate
// enforces DISCLOSURE + BINDING + COMPLETION, not TRUST — never present a
// "professional license" card as a real safety control until issuer-verified trust
// lands (#14). Multi-instance note: the rail + completion learn a custom credential from
// `requirements()` (register-on-resolve), so a split deployment must resolve the policy
// once at startup on every instance (definitions are code; only state is shared).
