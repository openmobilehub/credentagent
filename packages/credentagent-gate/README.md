# @openmobilehub/credentagent-gate

**The consent layer for AI agents.** An AI agent must prove a verifiable credential
from the user's phone wallet before a consequential MCP tool completes. **Identity
leads; payments is one application** — `age.over(21)`, a loyalty membership, a
prescription, and `payment.in("usd")` are all just credentials in the same policy.

> **Design preview / v0.1.** This package is real and tested, but the broader CredentAgent
> SDK is still being extracted from the reference server
> ([mcp-apps-shopping-demo](https://github.com/openmobilehub/mcp-apps-shopping-demo)).
> See the repo's `ROADMAP.md` for what's shipping vs. next.

## Install

```bash
npm install @openmobilehub/credentagent-gate
```

Apache-2.0, ESM, ships its own types. Pairs with
[`@openmobilehub/credentagent-storefront`](../credentagent-storefront), but stands alone on any
Express-shaped host.

## Quickstart

The whole flow in ≤ 10 lines — a credential-gated agentic storefront. `createStorefront()`
publishes the ceremony seams; `new CredentAgent().mount(store.app)` wires the real `/credentagent/*`
ceremony rails; `store.gate()` resolves your policy on every `checkout` call (copied from
[`examples/storefront.mjs`](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/examples/storefront.mjs) /
[`storefront-gate.test.ts`](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/storefront-gate.test.ts)):

```ts
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { CredentAgent, age, membership, payment, required, optional } from "@openmobilehub/credentagent-gate";

const store = createStorefront();                  // the storefront — one line
const credentagent = new CredentAgent();                     // zero-config (defaults to http://localhost:3000)
credentagent.mount(store.app);                          // wires the real /credentagent/* ceremony rails

store.gate((order) =>                              // resolved on every checkout (payment settles LAST)
  credentagent.requirements(order, [
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
> For a deployment pass your public origin: `new CredentAgent({ walletOrigin: "https://shop.example" })`.

## Orders — a checkout without a storefront

Don't have (or want) the MCP storefront? Drive the checkout yourself with `credentagent.orders`.
Two things happen at **startup** (wire the checkout once, subscribe to completion once); the third,
`orders.create()`, happens **per purchase** — inside a request handler, each time an agent wants to buy.
The comments below mark which is which:

```ts
import express from "express";
import { CredentAgent, age, payment, required } from "@openmobilehub/credentagent-gate";

const app = express();
app.use(express.json());
const credentagent = new CredentAgent({ walletOrigin: "http://localhost:4000" });

// ── once, at startup ──────────────────────────────────────────────
credentagent.orders.serve(app);                              // wire the whole checkout onto your app
credentagent.on("order.settled", ({ id }) => fulfill(id));   // subscribe once — fires when ANY order is paid

// ── per purchase — inside a request handler (runs every time) ──────
app.post("/buy-wine", async (_req, res) => {
  const { id, approveUrl } = await credentagent.orders.create({   // → { id, approveUrl, manifest }
    order:  { id: "", total: 21, currency: "USD", lines: [{ id: "wine", name: "Bottle of wine", quantity: 1, unitPrice: 21, minimumAge: 21 }] },
    policy: [required(age.over(21)), required(payment.in("usd"))],
  });
  res.json({ id, approveUrl });                              // hand approveUrl to the human
});

// read status here (durable, works across instances). In a single-process server the
// in-process order.settled listener above is enough; this is the cross-instance signal.
app.get("/orders/:id", async (req, res) => res.json(await credentagent.orders.retrieve(req.params.id)));
```

> **`on("order.settled")` is an in-process event, not a webhook** — it fires synchronously in the
> one long-lived Node process that completed the order. On serverless (Vercel, Lambda) the instance
> can be frozen the moment the response is sent, so async work started in the listener may never
> finish — don't fulfill from it there. Instead, inject shared stores (`orderStore`,
> `completedOrderStore`) and read `orders.retrieve(id)` as the durable, cross-instance signal. A
> real signed HTTP webhook is the next increment
> ([#101](https://github.com/openmobilehub/credentagent/issues/101)).

`orders.retrieve(id)` is the one result **door**: `{ ok: true, completion }` once paid, `{ ok: false,
pending: true, approveUrl }` while it's open, or `{ ok: false, code }` for an unknown id. The amount and
the age threshold are re-derived from the order you stored server-side — never trusted from the link
(invariant 2), and a gated order can only complete through the wallet ceremony, never a shortcut
(invariant 1). Runnable: [`examples/orders-checkout/`](https://github.com/openmobilehub/credentagent/tree/main/examples/orders-checkout).

## The three execution contexts

The split is load-bearing — conflating them is the documented root cause of confusion
([spec §0](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/001-attesto-sdk/spec.md)). v0.1 is consolidated **Mode A**:

1. **Tool — mints the link + reports requirements.** Your `checkout` handler runs once when
   checkout is requested. There is no phone in the loop, so it does **not** run a ceremony — it
   calls `credentagent.requirements(order, policy)` and surfaces the resulting `requires` manifest.
2. **Page — runs the gates.** The buyer opens the link once and completes every verification and
   payment in a single browser session, on the `/credentagent/*` routes `mount()` serves.
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
import { defineCredential, dcql, gate } from "@openmobilehub/credentagent-gate";

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

A custom credential is **served by the mounted ceremony and enforced end-to-end** — no new code
path: `requirements()` registers it by id, the credential-gate rail builds the wallet request from
its own `request`/`verify`, and `completeOrder` enforces every applicable `gate()` on the shared
completion path (a hard block, independent of `required`/`optional`). Worked pack:
[`examples/professional-license.mjs`](../../examples/professional-license.mjs).

> **Multi-instance / serverless:** register-on-resolve is enough for one long-lived process, but
> where checkout and completion can land on different instances (serverless, multiple workers) an
> instance that never ran `requirements()` has a cold registry — its completion sweep would no-op
> and an applicable `gate()` could complete unproven. Declare your custom credentials up front so
> every instance enforces them from boot: `new CredentAgent({ credentials: [prescription] })`.

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

| Rail (`/credentagent/*`) | What it proves | Trust today |
| :-- | :-- | :-- |
| `passkey` (same-device + cross-device caBLE) | WebAuthn assertion verified against this server's origin / RP-ID, user-verification required, nonce/replay-bound — **real cryptography** (`@simplewebauthn`) | real WebAuthn crypto |
| `credential` (age / membership) | OpenID4VP presentation; the explicit positive claim is checked, but the mdoc's issuer/device signatures are **not** verified | `presence-only-demo` |
| `dc-payment` (Digital Credentials API) | amount-bound mdoc presentation; the JWE vp_token + device signature are taken at face value, **not** cryptographically verified | `presence-only-demo` |

The OpenID4VP plumbing is scaffolded; cryptographic mdoc trust is the integration step, not new
cryptography. The mandate is AP2-shaped and dev-signed (integrity hash), not key-signed.

### Presenting a stable reader identity (optional)

By default the OpenID4VP rails **self-sign an ephemeral reader certificate per request**, so a
wallet has no reason to trust the verifier and shows an "unknown verifier" warning. Pass a stable
reader identity and the rails present it instead — a wallet that trusts it (via an imported RICAL)
shows the verifier as trusted:

```ts
new CredentAgent({
  walletOrigin: "https://shop.example",
  readerIdentity: {
    key: readFileSync("reader.key", "utf8"),   // PEM, EC P-256
    cert: readFileSync("reader.pem", "utf8"),  // PEM leaf → rides in the request's `x5c`
  },
});
```

The cert's SubjectAltName must cover the `walletOrigin` host or the wallet rejects the request
(origin binding); the client warns at construction on a mismatch.

> **This is verifier trust, not issuer trust — they point in opposite directions.** It changes
> whether the *wallet* trusts *us* to ask. It does **not** verify the mdoc the wallet presents
> *back*, so `trust_level` stays **`presence-only-demo`** either way.

> **A refused tool call is a protocol, not a wall.** For a page-less tool, `gated()` returns a typed
> **`verification_required`** envelope the agent *drives* (which credential, a per-order approve link,
> the tool to poll) instead of completing — the retained blocking **Mode B** primitive.

## Delegated draws — human-not-present seams (005, preview)

Approve a spending limit once; your agent draws against it while you're away, every draw re-checked
server-side. The Stripe-grade entry point is **`DelegatedGate`**:

```ts
import { DelegatedGate } from "@openmobilehub/credentagent-gate";

const gate  = new DelegatedGate({ catalog: { coffee: 18 } });
const grant = await gate.preApprove({ merchant: "blue-bottle", perOrder: 30, total: 100 }); // approve once
const result = await grant.spend({ idempotencyKey: "order-1", item: "coffee" });             // unattended draw (retry-safe key)
//  → { ok: true, amount: 18, remaining: 82 }   — or { ok: false, reason: "over-cap", retryable: "terminal" }
await grant.revoke();                                                                         // kill-switch
```

Under that facade are **signer-agnostic seams** for redeeming a user-sealed
**Intent Mandate** (a bounded, revocable delegation) with no live human — `sealIntent` / `checkDraw`
(pure, total, typed refusals), a `RevocationStore` (per-intent + subject kill-switch, atomic
single-use consume), and an additive, fail-closed **draw branch** in `completeOrder` that re-runs
every bounds + revocation check server-side, writes a `delegationId`, and **suppresses settlement**.
Age is **non-delegable** — an age-restricted cart always steps up to a live ceremony.

Honesty (Principle VII, constitution v1.1.0): draws carry a **`presence`** axis (`"delegated"` /
`"delegated-demo"`) — *when* consent happened — separate from `trust_level` — *how strongly it's
bound*. The wire crypto is **real** (ES256 over the canonical draw; content-addressed `intentId`), but
v0.1 has **no issuer/DeviceKey trust anchor and no per-draw proof-of-possession** — the grant is
effectively a bearer instrument, fenced as a demo. A *real* HNP control requires `presence:
"delegated"` **and** `trust_level: "issuer-verified"`; the HTTP intent rail + the wallet server that
provide those are later increments.

## API surface (v0.1)

```ts
// Client (configure once, then declarative calls)
class CredentAgent {
  constructor(opts?: { walletOrigin?: string; store?: VerificationStore; credentials?: Credential[] });
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

// Delegated draws (HNP, 005 preview) — the Stripe-grade facade + the underlying seams
DelegatedGate  ·  gate.preApprove(bounds) → DelegatedGrant  ·  grant.spend(purchase) → SpendResult  ·  grant.revoke()
sealIntent  ·  checkDraw  ·  signDraw  ·  MemoryRevocationStore  ·  Draw / IntentBounds / CommittedDraw / Refusal

// Cart Mandate (ap2.CartMandate) — signed, tamper-evident cart integrity; the
// signingKey-gated check in completeOrder + the opt-in `statelessOrders` transport
issueCartMandate(args, secret)  ·  verifyCartMandate(mandate, orderId, secret)  ·  DEFAULT_CART_MANDATE_TTL_MS

// Retained Mode-B / roadmap blocking primitive
gated()  ·  buildVerificationRequired()  ·  isVerificationRequired()  ·  envelopeInstruction()
ageDcql()  ·  ENVELOPE_VERSION  ·  ENVELOPE_SENTINEL

// Types: CredentAgentOptions, GateOrder, OrderLine, Credential, Step, Effect,
//        VerificationManifestEntry, VerificationStore, VerificationRecord,
//        TrustLevel, DcqlQuery, DcqlClaim, DcqlCredentialOption, ExpressApp,
//        CompletionSeam / SettlementSeam / CeremonyOrder (host composition)
```

Full, compiler-checked contract: [`specs/001-attesto-sdk/`](https://github.com/openmobilehub/mcp-apps-shopping-demo/tree/main/specs/001-attesto-sdk/) (the
[quickstart](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/001-attesto-sdk/quickstart.md), [`spec.md`](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/001-attesto-sdk/spec.md),
and the [mount contract](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/003-gate-ceremony-extraction/contracts/attesto-mount.api.md)).

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).
