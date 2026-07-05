# @openmobilehub/attestomcp-gate

**The consent layer for AI agents.** An AI agent must prove a verifiable credential
from the user's phone wallet before a consequential MCP tool completes. **Identity
leads; payments is one application** — `age.over(21)`, a loyalty membership, a
prescription, and `payment.in("usd")` are all just credentials in the same policy.

> **Design preview / v0.1.** This package is real and tested, but the broader AttestoMCP
> SDK is still being extracted from the reference server
> ([mcp-apps-shopping-demo](https://github.com/openmobilehub/mcp-apps-shopping-demo)).
> See the repo's `ROADMAP.md` for what's shipping vs. next.

## Install

```bash
npm install @openmobilehub/attestomcp-gate
```

Apache-2.0, ESM, ships its own types. Pairs with
[`@openmobilehub/attestomcp-storefront`](../attestomcp-storefront), but stands alone on any
Express-shaped host.

## Quickstart

The whole flow in ≤ 10 lines — a credential-gated agentic storefront. `createStorefront()`
publishes the ceremony seams; `new AttestoMCP().mount(store.app)` wires the real `/attestomcp/*`
ceremony rails; `store.gate()` resolves your policy on every `checkout` call (copied from
[`examples/storefront.mjs`](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/examples/storefront.mjs) /
[`storefront-gate.test.ts`](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/storefront-gate.test.ts)):

```ts
import { createStorefront } from "@openmobilehub/attestomcp-storefront/server";
import { AttestoMCP, age, membership, payment, required, optional } from "@openmobilehub/attestomcp-gate";

const store = createStorefront();                  // the storefront — one line
const attestomcp = new AttestoMCP();                     // zero-config (defaults to http://localhost:3000)
attestomcp.mount(store.app);                          // wires the real /attestomcp/* ceremony rails

store.gate((order) =>                              // resolved on every checkout (payment settles LAST)
  attestomcp.requirements(order, [
    required(age.over(21).when((order) => order.lines.some((l) => l.minimumAge != null))),
    optional(membership.discount(10)),              // 10% off if a loyalty credential is presented
    required(payment.in("usd")),                    // amount derived from the order; settles last
  ]),
);

const { url } = await store.listen(3005);          // → add http://localhost:3005/mcp to Claude / ChatGPT / Goose
```

Add the whiskey (21+) to the cart and check out → the tool returns the checkout link **plus**
a `requires` manifest → the buyer proves age (and optionally membership) → authorizes payment →
the widget shows the confirmation. Add the headphones instead and the age gate drops — the
`.when()` predicate receives the **order** and is false.

> `.when((order) => …)` takes the **whole `GateOrder`** (id, total, currency, lines), so a
> predicate keys off the cart's lines — e.g. `order.lines.some((l) => l.minimumAge != null)`.
> For a deployment pass your public origin: `new AttestoMCP({ walletOrigin: "https://shop.example" })`.

## The three execution contexts

The split is load-bearing — conflating them is the documented root cause of confusion
([spec §0](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/001-attesto-sdk/spec.md)). v0.1 is consolidated **Mode A**:

1. **Tool — mints the link + reports requirements.** Your `checkout` handler runs once when
   checkout is requested. There is no phone in the loop, so it does **not** run a ceremony — it
   calls `attestomcp.requirements(order, policy)` and surfaces the resulting `requires` manifest.
2. **Page — runs the gates.** The buyer opens the link once and completes every verification and
   payment in a single browser session, on the `/attestomcp/*` routes `mount()` serves.
3. **Poll — reports completion.** The agent polls (MCP has no server→client push) and reports the
   result. It never performs the ceremony.

`requirements()` is the **code→data boundary** (Principle VI): it runs your `.when()` / `appliesTo`
predicates server-side, sorts `payment` last, and emits a flat, JSON-safe manifest — **no functions
cross the wire**. The manifest's `requires[]` is exactly what the agent and the widget receive.

## The credential model

Built-ins, custom credentials, and effects are one shape (`Credential` + `Effect`):

| Builder | Effect | Verifies |
| :-- | :-- | :-- |
| `age.over(n)` | `gate()` | the explicit positive `age_over_${n} === true` (an 18+ proof never satisfies a 21+ gate) |
| `membership.discount(n)` | `discount({ percent: n })` | a non-empty `membership_number`; applies the discount once |
| `payment.in(cur)` | `authorize()` | `authorized === true`; settles last, amount derived from the order |

Wrap each in `required(c)` or `optional(c)` to build the ordered policy array. Attach a call-site
conditional with `.when((order) => boolean)` — it returns a fresh `Credential` (non-mutating) whose
predicate is AND-ed onto any existing `appliesTo`.

**Gate any credential** with `defineCredential` — no registration step, usable by object
(from [`specs/001-attesto-sdk/quickstart.md`](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/001-attesto-sdk/quickstart.md)):

```ts
import { defineCredential, dcql, gate } from "@openmobilehub/attestomcp-gate";

const prescription = defineCredential({
  id: "prescription",
  request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
  verify: (c) => c.rx_valid === true,
  effect: gate(),                                   // or discount({ percent }) / authorize()
  appliesTo: (order) => order.lines.some((l) => l.requiresRx),  // definition-time conditional
  ui: { label: "Prescription", action: "Verify prescription" },
});
// …then drop required(prescription) into the same policy array.
```

`dcql({ docType, claims })` is concise sugar for a single-mdoc DCQL query (selective disclosure,
never-retain by default). The three effect builders — `gate()`, `discount({ percent })`,
`authorize()` — are the only effects the resolver interprets.

## Honest status

Honesty is carried in the **types**, not prose (Principle VII):

- **`enforcedAt: "checkout"`** — v0.1 is consolidated Mode A: every gate runs on the checkout page
  (Context 2) and is enforced server-side on the completion path. (`"tool"` is the Mode-B blocking
  shape — roadmap.)
- **`trust_level: "presence-only-demo"`** — the gate enforces *disclosure* (an explicit positive
  claim, not token-presence) and *binding* (nonce / ephemeral key), but **not trust** (mdoc
  issuer / device signatures). A self-crafted mdoc would pass. **This is a flow demo, not a real
  safety control** — never present it as one. Issuer-trust verification (Multipaz / `@auth0/mdl`,
  `trust_level: "issuer-verified"`) is roadmap.

The three rails `mount()` serves differ in how much crypto is real today:

| Rail (`/attestomcp/*`) | What it proves | Trust today |
| :-- | :-- | :-- |
| `passkey` (same-device + cross-device caBLE) | WebAuthn assertion verified against this server's origin / RP-ID, user-verification required, nonce/replay-bound — **real cryptography** (`@simplewebauthn`) | real WebAuthn crypto |
| `credential` (age / membership) | OpenID4VP presentation; the explicit positive claim is checked, but the mdoc's issuer/device signatures are **not** verified | `presence-only-demo` |
| `dc-payment` (Digital Credentials API) | amount-bound mdoc presentation; the JWE vp_token + device signature are taken at face value, **not** cryptographically verified | `presence-only-demo` |

The OpenID4VP plumbing is scaffolded; cryptographic mdoc trust is the integration step, not new
cryptography. The mandate is AP2-shaped and dev-signed (integrity hash), not key-signed.

> **A refused tool call is a protocol, not a wall.** For a page-less tool, `gated()` returns a typed
> **`verification_required`** envelope the agent *drives* (which credential, a per-order approve link,
> the tool to poll) instead of completing — the retained blocking **Mode B** primitive.

## API surface (v0.1)

```ts
// Client (configure once, then declarative calls)
class AttestoMCP {
  constructor(opts?: { walletOrigin?: string; store?: VerificationStore });
  requirements(order: GateOrder, policy: Step[]): VerificationManifestEntry[];   // Context 1
  mount(app: ExpressApp, ceremony?: MountCeremony): void;                        // Context 2
}

// Policy builders + extensibility
age.over(n)  ·  membership.discount(n)  ·  payment.in(currency)
required(c)  ·  optional(c)  ·  .when((order) => boolean)
defineCredential({ id, request, verify, effect, appliesTo?, ui })
dcql({ docType, claims })  ·  gate()  ·  discount({ percent?, amount? })  ·  authorize()

// Stores + host-side composition seam
MemoryVerificationStore  ·  completeOrder(input, ctx)

// Cart Mandate (ap2.CartMandate) — signed, tamper-evident cart integrity; the
// signingKey-gated check in completeOrder + the opt-in `statelessOrders` transport
issueCartMandate(args, secret)  ·  verifyCartMandate(mandate, orderId, secret)  ·  DEFAULT_CART_MANDATE_TTL_MS

// Retained Mode-B / roadmap blocking primitive
gated()  ·  buildVerificationRequired()  ·  isVerificationRequired()  ·  envelopeInstruction()
ageDcql()  ·  ENVELOPE_VERSION  ·  ENVELOPE_SENTINEL

// Types: AttestoMCPOptions, GateOrder, OrderLine, Credential, Step, Effect,
//        VerificationManifestEntry, VerificationStore, VerificationRecord,
//        TrustLevel, DcqlQuery, DcqlClaim, DcqlCredentialOption, ExpressApp,
//        CompletionSeam / SettlementSeam / CeremonyOrder (host composition)
```

Full, compiler-checked contract: [`specs/001-attesto-sdk/`](https://github.com/openmobilehub/mcp-apps-shopping-demo/tree/main/specs/001-attesto-sdk/) (the
[quickstart](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/001-attesto-sdk/quickstart.md), [`spec.md`](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/001-attesto-sdk/spec.md),
and the [mount contract](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/003-gate-ceremony-extraction/contracts/attesto-mount.api.md)).

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).
