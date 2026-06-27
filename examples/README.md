# Attesto examples

## `storefront.mjs` — a credential-gated storefront in ~8 lines

A minimal, runnable agentic storefront you add to **Goose** (or any MCP host) as an HTTP connector and
watch the gate fire. The storefront is a one-line black box — `createStorefront()` ships the catalog +
`browse-products` / `checkout` / `get-order-status` tools over HTTP — and **Attesto mounts onto it**:

```ts
import { createStorefront } from "@openmobilehub/attesto-storefront/server";
import { Attesto, age, membership, payment, required, optional } from "@openmobilehub/attesto-gate";

const store = createStorefront();                 // the whole storefront — nothing to configure
const attesto = new Attesto();
attesto.mount(store.app);                          // Attesto mounts onto it
store.gate((order) => attesto.requirements(order, [
  required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
  optional(membership.discount(10)),
  required(payment.in("usd")),
]));
const { url } = await store.listen(3005);          // → http://localhost:3005/mcp
```

### Run it

```bash
npm install
npm run build:packages          # build the two @openmobilehub/attesto-* packages
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
real fail-closed wallet ceremony is provided by `attesto.mount()` and the full reference demo at the repo
root.)

### What it proves

The two packages compose with **zero glue**: the storefront's priced `Order` feeds
`attesto.requirements()` directly (the line carries `minimumAge`, re-derived from the catalog), and the
checkout tool gains a serializable `requires` manifest — the agent-facing contract — without you wiring any
of it by hand.

## `custom-credential.mjs` — gate any action with **any** credential

The built-in `age` / `membership` / `payment` gates are merely *pre-defined* credentials. This example
proves Principle V — **gate any consequential action with any credential** — by defining a custom
`prescription` gate inline with `defineCredential({ id, request, verify, effect, ui })` (no registration
step) and dropping it into the **same** ordered policy array as the built-ins:

```ts
import { defineCredential, dcql, gate, required } from "@openmobilehub/attesto-gate";

const prescription = defineCredential({
  id: "prescription",
  request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }), // what to ask the wallet
  verify: (claims) => claims.rx_valid === true,                               // explicit positive claim
  effect: gate(),                                                             // gate() | discount() | authorize()
  appliesTo: (order) => order.lines.some((l) => l.category === "Pharmacy"),   // ONLY for pharmacy lines
  ui: { label: "Prescription", action: "Verify prescription" },
});

store.gate((order) => attesto.requirements(order, [
  required(prescription),                    // custom gate — conditional via appliesTo
  required(age.over(21).when(hasAlcohol)),    // built-ins drop into the SAME array
  optional(membership.discount(10)),
  required(payment.in("usd")),                // amount derived from the order; settles last
]));
```

### Run it

```bash
npm run build:packages              # build the two @openmobilehub/attesto-* packages
node examples/custom-credential.mjs  # → http://localhost:3006/mcp
```

Then ask Goose:

- *"Buy the amoxicillin"* → the **Prescription** gate is surfaced (`appliesTo` matched the `Pharmacy` line).
- *"Buy the ibuprofen"* → **no** prescription gate (OTC line — `appliesTo` returned false).
- *"Buy the whiskey"* → the built-in **age 21+** gate fires instead.

In every case `payment` settles last (the resolver moves `authorize` effects to the end).

### Honest limits

- **The custom gate fully resolves into the manifest** — `appliesTo`, `effect`, `ui.label`, and a per-order
  approve link all flow through `requirements()` (the code→data boundary; functions never cross the wire).
  But the **mounted phone ceremony** only knows the built-in `age` / `membership` kinds in v0.1
  (`CredentialKind` is `"age" | "membership"`), so a custom credential's own `request` / `verify` /
  `ui.action` are not executed by the ceremony page yet — completing an arbitrary custom credential on the
  phone is roadmap.
- The canonical gate `OrderLine` type carries a `requiresRx` flag for this case, but the storefront's
  `PricedCartLine` forwards only `category` / `minimumAge`, so this example keys `appliesTo` off `category`
  to stay genuinely runnable on a `createStorefront()` order.
- `trust_level` is `"presence-only-demo"`: v0.1 enforces disclosure + nonce binding, **not** issuer/device
  signatures — a flow demonstration, not a real safety control yet.
