# CredentAgent examples

Each is runnable against the two `@openmobilehub/credentagent-*` packages (build them first:
`npm run build:packages`). Grouped by what they show:

**Storefront + gate** (connect to Goose / any MCP host)
- [`storefront.mjs`](#storefrontmjs--a-credential-gated-storefront-in-8-lines) — a credential-gated storefront in ~8 lines
- [`custom-credential.mjs`](#custom-credentialmjs--gate-any-action-with-any-credential) — gate any action with **any** credential (Principle V)
- [`with-x402-settlement.mjs`](#with-x402-settlementmjs--settle-payment-on-chain-via-the-settle-seam) — settle payment on-chain via the `settle` seam
- [`storefront-redis.mjs`](storefront-redis.mjs) / [`storefront-firestore.mjs`](storefront-firestore.mjs) — injectable persistence (Upstash Redis stores / Firestore catalog source)
- [`run-storefront/`](run-storefront/) — run THIS repo's storefront directly (stateful + stateless side by side)

**Gating patterns** (identity-first, beyond commerce)
- [`gate-any-action.mjs`](#gate-any-actionmjs--gate-a-non-commerce-action-identity-first-no-checkout) — gate a non-commerce action, no checkout

**Cart Mandate / stateless** (004)
- [`stateless-orders/`](stateless-orders/) — the created order rides in a signed Cart Mandate on the link

**Human-not-present** (005, preview)
- [`hnp-draws/`](hnp-draws/) — the delegated-draw "doorman": one pre-approval, good + bad draws, all decided server-side

---

## [`quickstart/`](./quickstart/) — start here: try it, run it, own it (~5 min)

The standalone quickstart: try the **hosted demo** (paste one URL into Claude / ChatGPT /
Goose), run it locally against the **published** packages (`npm i && npm start` — no monorepo
build), or **Deploy-to-Vercel** your own copy in one click. Ships its own security smoke
(`npm run smoke`). See [`quickstart/README.md`](./quickstart/README.md).

## `storefront.mjs` — a credential-gated storefront in ~8 lines

A minimal, runnable agentic storefront you add to **Goose** (or any MCP host) as an HTTP connector and
watch the gate fire. The storefront is a one-line black box — `createStorefront()` ships the catalog +
`browse-products` / `checkout` / `get-order-status` tools over HTTP — and **CredentAgent mounts onto it**:

```ts
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { CredentAgent, age, membership, payment, required, optional } from "@openmobilehub/credentagent-gate";

const store = createStorefront();                 // the whole storefront — nothing to configure
const credentagent = new CredentAgent();
credentagent.mount(store.app);                          // CredentAgent mounts onto it
store.gate((order) => credentagent.requirements(order, [
  required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
  optional(membership.discount(10)),
  required(payment.in("usd")),
]));
const { url } = await store.listen(3005);          // → http://localhost:3005/mcp
```

### Run it

```bash
npm install
npm run build                   # build the two @openmobilehub/credentagent-* packages
node examples/storefront.mjs     # → http://localhost:3005/mcp
```

### Add it to Goose

`goose configure` → **Add Extension** → **Remote Extension (Streamable HTTP)** → URL:

```
http://localhost:3005/mcp
```

Then ask Goose:

- *"What do you sell?"* → lists the catalog (whiskey is 21+, headphones aren't).
- *"Add the Oak Reserve Whiskey and check out"* → the agent surfaces the **age 21+** requirement (plus
  the optional membership discount and payment) and a checkout link.
- *"Add the Aurora headphones and check out"* → **no age gate** — `requires` has no `age` entry.

Open the checkout link to see the order + what's required. (Completing on that page is a **demo stub** — the
real fail-closed wallet ceremony is provided by `credentagent.mount()` and the full reference demo at the repo
root.)

### What it proves

The two packages compose with **zero glue**: the storefront's priced `Order` feeds
`credentagent.requirements()` directly (the line carries `minimumAge`, re-derived from the catalog), and the
checkout tool gains a serializable `requires` manifest — the agent-facing contract — without you wiring any
of it by hand.

## `custom-credential.mjs` — gate any action with **any** credential

The built-in `age` / `membership` / `payment` gates are merely *pre-defined* credentials. This example
proves Principle V — **gate any consequential action with any credential** — by defining a custom
`prescription` gate inline with `defineCredential({ id, request, verify, effect, ui })` (no registration
step) and dropping it into the **same** ordered policy array as the built-ins:

```ts
import { defineCredential, dcql, gate, required } from "@openmobilehub/credentagent-gate";

const prescription = defineCredential({
  id: "prescription",
  request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }), // what to ask the wallet
  verify: (claims) => claims.rx_valid === true,                               // explicit positive claim
  effect: gate(),                                                             // gate() | discount() | authorize()
  appliesTo: (order) => order.lines.some((l) => l.category === "Pharmacy"),   // ONLY for pharmacy lines
  ui: { label: "Prescription", action: "Verify prescription" },
});

store.gate((order) => credentagent.requirements(order, [
  required(prescription),                    // custom gate — conditional via appliesTo
  required(age.over(21).when(hasAlcohol)),    // built-ins drop into the SAME array
  optional(membership.discount(10)),
  required(payment.in("usd")),                // amount derived from the order; settles last
]));
```

### Run it

```bash
npm run build                       # build the two @openmobilehub/credentagent-* packages
node examples/custom-credential.mjs  # → http://localhost:3006/mcp
```

Then ask Goose:

- *"Buy the amoxicillin"* → the **Prescription** gate is surfaced (`appliesTo` matched the `Pharmacy` line).
- *"Buy the ibuprofen"* → **no** prescription gate (OTC line — `appliesTo` returned false).
- *"Buy the whiskey"* → the built-in **age 21+** gate fires instead.

In every case `payment` settles last (the resolver moves `authorize` effects to the end).

### Honest limits

- **The custom gate resolves into the manifest AND completes on the phone (007).** `appliesTo`, `effect`,
  `ui.label`, and a per-order approve link flow through `requirements()` (the code→data boundary; functions
  never cross the wire), and the **mounted ceremony** now serves the credential's own `request` / `verify` /
  `ui.action` — the credential-gate rail is no longer limited to `age` / `membership`. See
  [`professional-license.mjs`](#professional-licensemjs--the-credential-library-proven-end-to-end) for the
  worked pack that also **enforces** a custom gate at completion.
- The canonical gate `OrderLine` type carries a `requiresRx` flag for this case, but the storefront's
  `PricedCartLine` forwards only `category` / `minimumAge`, so this example keys `appliesTo` off `category`
  to stay genuinely runnable on a `createStorefront()` order.
- `trust_level` is `"presence-only-demo"`: the wire crypto is real (disclosure + nonce binding), but there is
  **no** issuer/device-signature trust anchor yet — a flow demonstration, not a real safety control until #14.

## `professional-license.mjs` — the credential library, proven end-to-end

The worked pack for the credential library (issue #19). Where `custom-credential.mjs` shows a custom gate
*resolving*, this one shows a custom `gate()` **served by the mounted ceremony and enforced at completion**:
an order with the licensed item cannot complete until the license is proven — on every payment rail, not just
the rendered page (invariant 1). No new rail, no switch-case, no registration — just `defineCredential`:

```ts
const professionalLicense = defineCredential({
  id: "professional_license",
  request: dcql({ docType: "org.example.license.1", claims: ["license_active"] }),
  verify: (claims) => claims.license_active === true,        // explicit positive claim (invariant 5)
  effect: gate(),                                            // hard block, enforced whenever it applies
  appliesTo: (order) => order.lines.some((l) => l.category === "Licensed"),
  ui: { label: "Professional license", action: "Verify your license" },
});

store.gate((order) => credentagent.requirements(order, [
  required(professionalLicense),   // custom gate — served + enforced for Licensed lines
  required(payment.in("usd")),     // built-in — settles last
]));
```

### Run it

```bash
npm run build:packages
node examples/professional-license.mjs   # → http://localhost:3007/mcp
```

- *"Buy the contractor drill"* → the **Professional license** gate is surfaced **and enforced** (the order
  won't complete until `license_active` is proven).
- *"Buy the headphones"* → **no** license gate (unlicensed line).

### What it proves

`requirements()` registers each policy credential by id (register-on-resolve — no developer registration);
`mount()` injects that registry so the credential-gate rail serves the credential's own `request`/`verify`,
and `completeOrder` sweeps every applicable `gate()` credential, re-derived from the re-priced order
(invariant 2), refusing one not proven for that order (invariants 1/4). `gate()` is the hard-block effect —
enforced whenever it applies, independent of `required(...)` / `optional(...)`. `trust_level` stays
`"presence-only-demo"` (no issuer trust anchor yet — #14). *Multi-instance:* register-on-resolve means each
instance resolves the policy once (e.g. at startup); the reference single-server/demo always does.

## `with-x402-settlement.mjs` — settle payment on-chain via the `settle` seam

The gate authorizes payment; **settlement is a seam you inject**. `createStorefront({ settle })` threads an
optional `settle(order)` into the gate's shared `completeOrder`: after the four payment gates pass, `settle`
runs and its record rides along on the completion — surfaced on the receipt and in `get-order-status`.

```ts
const settle = async (order) => {
  // amount re-derived server-side from the (already re-priced) order — never a client figure
  return { network: "hedera-testnet", status: "settled", txId: "0.0.123@…", hashscanUrl: "https://…" };
};

const store = createStorefront({ settle });   // ← the only new line vs storefront.mjs
```

### Run it

```bash
npm run build
node examples/with-x402-settlement.mjs   # → http://localhost:3007/mcp
```

Buy the whiskey → prove age → authorize payment, and the receipt shows the on-chain settlement record.

### What it proves

- **Settlement is fail-closed.** If `settle` **throws**, `completeOrder` records nothing and the cart stays
  intact (authorized-but-not-settled) — a flaky chain never marks an order paid (`completion.ts`).
- **The amount is never trusted from the client.** `settle` receives the order whose total `completeOrder`
  already re-derived from the catalog (Security invariant 2).
- The example's `settle` is a **mock** so it runs with no credentials; the file's commented block shows the
  **real** Hedera/x402 wiring (`settleOrder` + `hederaSettlementConfig` over the blocky402 facilitator,
  a fresh session wallet per order on Hedera testnet) used by the reference demo at the repo root.

## `gate-any-action.mjs` — gate a **non-commerce** action (identity-first, no checkout)

The storefront examples all end in a **purchase**. This one proves the broader claim — *identity leads,
payments is one application* — by gating a **non-commerce** action: an MCP tool that releases sensitive
records, behind an identity credential, with **no payment anywhere**.

```ts
import { buildVerificationRequired, isVerificationRequired, ageDcql } from "@openmobilehub/credentagent-gate";

function releaseRecords(args, ctx) {
  if (!ctx.ageVerified) {
    return buildVerificationRequired({         // ← gate any tool call: return a typed refusal,
      order: { id: args.requestId, total: 0, currency: "USD" }, //   a $0 ACTION, not a sale
      credential: "age", minAge: 21, request: ageDcql(),
      approveUrl: `https://shop.example/credentagent/credential?order=${args.requestId}&cred=age`,
      detail: "Releasing these records requires proof the requester is 21+.",
    });
  }
  return { released: true, records: [/* … */] };
}
```

### Run it

```bash
npm run build --workspaces
node examples/gate-any-action.mjs
```

It prints the `verification_required` envelope the agent sees on the gated call, then the action's result
after the credential is proven. The same shape gates `approve-deploy`, `file-prescription-refill`,
`grant-access` — any consequential action.

### Honest limits

- The envelope + the gating decision are real today. The user proves on the `approve_url` **page** that
  `credentagent.mount()` serves (see `storefront.mjs` for the full ceremony); a fully **page-less** proving
  handshake is on the roadmap.
- The built-in `envelopeInstruction()` is worded for the **checkout** framing ("buyer", "placed"), so this
  example builds an **action-agnostic** instruction from the envelope's fields instead. (An action-agnostic
  instruction helper is a small follow-up.)
- `trust_level` is `"presence-only-demo"` — don't gate anything needing a real safety guarantee on it yet.
