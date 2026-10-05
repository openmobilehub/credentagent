# AGENTS.md

Agent-facing integration manifest for **CredentAgent** — the consent layer for AI agents.
This is the machine-readable counterpart to the human READMEs, in the
[AGENTS.md convention](https://agents.md) (stewarded by the Agentic AI Foundation under
the Linux Foundation). It serves two readers:

1. **A coding agent integrating the gate into a host app** — start at
   [Integrating the gate](#integrating-the-gate).
2. **A coding agent working on this repository** — start at
   [Working in this repo](#working-in-this-repo); the full contributor contract is
   [CLAUDE.md](CLAUDE.md), which takes precedence where they overlap.

## What this project is

An AI agent must prove a **verifiable credential** from the user's phone wallet before a
consequential action — a payment, an age gate, an access grant — completes. Identity
leads; payments is one application: `age.over(21)`, a loyalty membership, a prescription,
and `payment.in("usd")` are all just credentials in the same policy.

Two npm workspaces (TypeScript, Node ≥ 20, ESM):

| Package | What it is |
| --- | --- |
| [`@openmobilehub/credentagent-gate`](packages/credentagent-gate) | The gate: `new CredentAgent()`, policy builders, and the `/credentagent/*` ceremony rails that `mount()` serves |
| [`@openmobilehub/credentagent-storefront`](packages/credentagent-storefront) | `createStorefront()`: a runnable MCP shopping server + pure pricing/order model — the reference consumer |

## Integrating the gate

### Install

```bash
npm install @openmobilehub/credentagent-gate @openmobilehub/credentagent-storefront
```

The quickstart below needs both. The gate also stands alone on any Express-shaped host
(`npm install @openmobilehub/credentagent-gate`); the storefront is the batteries-included
MCP storefront.

### Quickstart — the whole flow

```ts
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { CredentAgent, age, membership, payment, required, optional } from "@openmobilehub/credentagent-gate";

const store = createStorefront();               // the storefront — one line
const credentagent = new CredentAgent();        // zero-config (defaults to http://localhost:3000)
credentagent.mount(store.app);                  // wires the real /credentagent/* ceremony rails

store.gate((order) =>                           // resolved on every checkout (payment settles LAST)
  credentagent.requirements(order, [
    required(age.over(21).when((order) => order.lines.some((l) => l.minimumAge != null))),
    optional(membership.discount(10)),
    required(payment.in("usd")),
  ]),
);

const { url } = await store.listen(3005);       // → add http://localhost:3005/mcp to an MCP client
```

For a deployment pass your public origin: `new CredentAgent({ walletOrigin: "https://shop.example" })`.
No storefront? Drive a checkout with `credentagent.orders` (`orders.serve(app)` /
`orders.create()` / `orders.retrieve(id)`), or wire the gate over your own catalog, order
store, and completion path with `defineHost(...)` — never call the low-level
`completeOrder` by hand. Both are worked, runnable examples in the
[gate README](packages/credentagent-gate/README.md).

### The three execution contexts (do not conflate them)

1. **Tool** — your MCP tool handler calls `credentagent.requirements(order, policy)` and
   surfaces the resulting `requires` manifest. No phone is in the loop; it never runs a
   ceremony.
2. **Page** — the buyer opens the checkout link and completes every proof on the
   `/credentagent/*` routes (see [Runtime endpoints](#runtime-endpoints)).
3. **Poll** — the agent polls for completion (MCP has no server→client push) and reports
   the result. It never performs the ceremony.

`requirements()` is the code→data boundary: it runs `.when()` / `appliesTo` predicates
server-side, sorts `payment` last, and emits a flat JSON-safe manifest — no functions
cross the wire.

### The policy surface

```ts
// Built-ins (each verifies an explicit positive claim, not token-presence)
age.over(n)  ·  membership.discount(n)  ·  payment.in(currency)
required(c)  ·  optional(c)  ·  .when((order) => boolean)

// Any credential, no registration step
defineCredential({ id, request, verify, effect, appliesTo?, ui })
dcql({ docType, claims })          // sugar for a single-mdoc DCQL query
gate()  ·  discount({ percent })  ·  authorize()   // the only effects the resolver interprets
```

On multi-instance / serverless deploys declare custom credentials up front —
`new CredentAgent({ credentials: [myCredential] })` — so every instance enforces them
from boot. Run `credentagent.doctor()` at startup: a typed, network-free preflight that
flags an ephemeral gate secret, a missing `mandateSigningKey`, a localhost
`walletOrigin`, or in-memory stores on a deployment.

### AP2 mandates

The gate records what a buyer authorized as an AP2 mandate (an SD-JWT signed ES256).
Pass a stable private P-256 JWK as `new CredentAgent({ mandateSigningKey })`; without
one the key is generated at boot, every signed mandate stops verifying at the next
restart, and `doctor()` reports it as an error on a deployment. Anyone can check a
mandate with `verifyMandate(token, { publicJwk })`, fetching the public key from the
host's `/.well-known/did.json`. A verified mandate proves the gate's key signed those
bytes — not that the amount is right (re-price server-side) or that any credential
behind it came from a real issuer.

### Runtime endpoints

Routes are registered by three different calls — call the ones you need. There is no
`llms.txt` discovery document; this file and the manifest that `requirements()`
returns are the discovery surface.

**`credentagent.mount(app)`** — always, on every path:

| Route | What it is |
| --- | --- |
| `GET /.well-known/did.json` | the gate's public mandate-signing key as a DID document. Taken at the **root** of the host app, not under `/credentagent/*` — a proxy or route allowlist must pass it, or nobody can check the mandates the gate signs |

**`credentagent.mount(app, seams)`** (or a host such as the storefront that supplies the
seams) — the ceremony rails. On a bare Express app with no seams, `mount(app)` attaches
**none** of these:

| Route | Rail |
| --- | --- |
| `/credentagent/passkey` (+ `/options`, `/verify`) | WebAuthn, same-device + cross-device (caBLE) — real cryptography |
| `/credentagent/credential` (+ `/request`, `/verify`) | age / loyalty / custom credentials via OpenID4VP |
| `/credentagent/dc-payment` (+ `/request`, `/verify`) | Digital Credentials API + OpenID4VP, amount-bound (mdoc) |
| `/credentagent/delegated` (+ `/request`, `/verify`) | opt-in (`mount({ verifier })`): external issuer-trust verifier |

**`credentagent.orders.serve(app)`** — checkout without a storefront:

| Route | What it is |
| --- | --- |
| `/credentagent/orders/:id` (+ `/place`, `/status`) | order page, placement, and status |

**`credentagent.grants.serve(app)`** — spending grants:

| Route | What it is |
| --- | --- |
| `/credentagent/grants/:id` (+ `/approve`, `/deny`) | grant approval page |
| `/credentagent/grants/:id/sign/request`, `/credentagent/grants/:id/sign/verify` | phone-signed spending grants: the wallet signs the grant terms (reports `"device-signed"`) |
| `/credentagent/grants/:id/age`, `/credentagent/grants/:id/membership` (+ `/request`, `/verify`) | credential proof attached to a spending grant (OpenID4VP) |

### Honesty — what the gate does and does not prove

`trust_level` is **`"presence-only-demo"`** on the built-in OpenID4VP rails. The wire
crypto is real (WebAuthn, JWE/ECDH-ES decrypt + nonce binding, ISO-mdoc parse), but there
is **no issuer / device-signature trust anchor yet** — a self-crafted mdoc would pass.
A presence-only gate enforces *disclosure* and *binding*, not trust. **Never present it
as a real safety control**, and never generate docs or copy that imply issuer-verified
trust is already here.

`trust_level` has three values, weakest to strongest:

- **`"presence-only-demo"`** — disclosure and binding only, as above.
- **`"device-signed"`** — reported for phone-signed spending grants. The **holder's**
  signature is verified (the wallet's SD-JWT VC key binding over the exact grant terms,
  checked against the key the credential commits to), but the **issuer** is not: the
  credential has no issuer trust anchor yet, so a self-crafted credential would still
  pass. Stronger than presence-only, still not a real safety control.
- **`"issuer-verified"`** — the gate **never** reports this itself. It is reachable today
  only through the delegated `verifier` seam, where an external verifier brings the trust
  anchor and the gate relays its verdict verbatim.

## Working in this repo

[CLAUDE.md](CLAUDE.md) is the full contributor contract — security invariants, honesty
fencing, DX rubric, review process. The load-bearing minimum:

- **Layout:** two workspaces under `packages/` (see the table above). A new ceremony
  rail mirrors the existing rail structure (`dcql`/`request`/`verify`/`page`/`routes`
  split) — it does not bolt onto an existing rail.
- **Build & test:** `npm run build` (typecheck + build all), then **`npm test` from the
  repo root** — that is the run CI trusts, and the only one that includes the
  cross-package integration test. `npm run test:workspaces` (per-package) is a faster
  inner loop, not a verification.
- **Security invariants** (full list in CLAUDE.md — a change that breaks one is
  blocking): enforce gates server-side on every completion path; never trust the order
  token — re-derive amounts server-side; discounts must reconcile with amount binding on
  all payment paths; scope verification state per session/order, never process-global;
  verify explicit positive claims (`age_over_21 === true`, not token-presence); keep
  WebAuthn / OpenID4VP origin-bound with nonce/replay protection.
- **The bypass-test expectation:** every security control needs a test that **fails when
  the control is deleted**. A test that would still pass with the control removed is not
  a useful test. Exercise the bypass path: POST the unverified age-restricted order and
  assert refusal.
- **DX is load-bearing** at the same tier as the security invariants
  ([docs/reference/architecture-principles.md](docs/reference/architecture-principles.md)).
  Write the caller-side example first — if it needs a plumbing block, fix the API, never
  dress up the example.
- **Conventions:** every commit carries a DCO `Signed-off-by:` line (`git commit -s`).
  PR descriptions follow [.github/pull_request_template.md](.github/pull_request_template.md)
  — plain language first, technical detail below the divider. Reviews run against
  [REVIEW.md](REVIEW.md).

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).
