# API reference

The public API of the two AttestoMCP packages, grounded in the actual exports.

- **`@openmobilehub/attestomcp-gate`** — the Gate: `new AttestoMCP()`, the policy
  builders, the credential model, the stores, and the honesty types.
- **`@openmobilehub/attestomcp-storefront`** — the storefront core: `createStorefront()`
  and its options.

AttestoMCP is the **consent layer for AI agents**: an AI agent must prove a verifiable
credential from the user's phone wallet before a consequential action — a payment, an
age gate, an access grant — completes. **Identity leads; payments is one application.**

> **Honest status (v0.1).** The wire crypto is real (WebAuthn on the passkey rail;
> OpenID4VP JWE/ECDH-ES decrypt + nonce binding; HPKE; ISO-mdoc parse), but there is
> **no issuer / device-signature trust anchor yet** and the AP2 mandate is dev-signed.
> Every manifest entry carries `trust_level: "presence-only-demo"` — a self-crafted
> mdoc would pass. **Never present a presence-only gate as a real safety control.**
> Issuer-verified trust (`trust_level: "issuer-verified"`) is the v0.2 line.
>
> The runnable end-to-end reference lives in the separate
> [mcp-apps-shopping-demo](https://github.com/openmobilehub/mcp-apps-shopping-demo)
> repo.

---

## `@openmobilehub/attestomcp-gate`

```ts
import {
  AttestoMCP,
  age, membership, payment,
  required, optional,
  defineCredential, dcql, gate, discount, authorize,
  MemoryVerificationStore,
} from "@openmobilehub/attestomcp-gate";
```

### `class AttestoMCP`

The configure-once client. Construct with your wallet origin (or zero-config for local
dev), then make declarative calls.

```ts
new AttestoMCP(opts?: AttestoMCPOptions)
```

| Field (`AttestoMCPOptions`) | Type | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `walletOrigin` | `string` | `http://localhost:${PORT ?? 3000}` | Absolute origin the wallet ceremony binds to (e.g. `https://shop.example`). Wallet ceremonies (OpenID4VP / WebAuthn) are origin-bound. A scheme-less value or a localhost origin **in production** logs a warning (never throws) and falls back to the localhost default. |
| `store` | `VerificationStore` | `new MemoryVerificationStore()` | Per-order verification state. Pluggable (e.g. Redis) for serverless. |

Read-only properties after construction: `attestomcp.walletOrigin` (string, trailing
slash stripped) and `attestomcp.store` (the resolved `VerificationStore`).

```ts
const attestomcp = new AttestoMCP();                                  // local dev — zero config
const attestomcp = new AttestoMCP({ walletOrigin: "https://shop.example" });  // deployed
```

#### `attestomcp.requirements(order, policy)` — Context 1

```ts
requirements(order: GateOrder, policy: Step[]): VerificationManifestEntry[]
```

Resolves a policy against a **server-priced** order into the flat, JSON-safe `requires`
manifest. This is the **code→data boundary**: it runs every `.when()` / `appliesTo`
predicate server-side, sorts `authorize` (payment) effects last, and emits an array of
`VerificationManifestEntry` — **no functions cross the wire**. The returned array is
exactly what the agent and the widget receive.

- **`order`** — a `GateOrder` whose `total` and per-line `unitPrice` / `minimumAge` are
  **re-derived server-side from the catalog**, never trusted from an order token.
- **`policy`** — an ordered array of `Step` (each built with `required(c)` /
  `optional(c)`).
- **Returns** — `VerificationManifestEntry[]`; a gate appears only when its `appliesTo`
  predicate is true (absent ⇒ always).

```ts
const requires = attestomcp.requirements(order, [
  required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
  optional(membership.discount(10)),
  required(payment.in("usd")),   // sorted last regardless of position
]);
```

#### `attestomcp.mount(app, ceremony?)` — Context 2

```ts
mount(app: ExpressApp, ceremony?: MountCeremony): void
```

Wires the verification ceremony's `/attestomcp/*` rails onto your Express app. `ExpressApp`
is a minimal structural type (`{ locals: Record<string, unknown> }`) — the package keeps
itself dependency-free and never imports `express`. AttestoMCP injects **its own** per-order
`verificationStore` (keyed by order id, never process-global), so you never pass it.

Three modes:

1. **With `ceremony` seams** — `{ orderStore, catalog, completion, signingKey, … }`
   (a `MountCeremony` = `Partial<CeremonySeams>` minus `verificationStore`). Validates
   the seams, **fails fast** on a missing required one, and attaches each rail.
2. **Zero-arg compose** (the quickstart) — a composing host such as
   `createStorefront()` has already published the seams on `app.locals.attestomcp`;
   `mount()` reads them off and wires the rails with no explicit args, sharing the
   host's own `verificationStore` when it supplied one.
3. **Legacy (no seams, none on `app.locals`)** — exposes the per-order store on
   `app.locals.attestomcp` so a host's existing fail-closed routes resolve verification
   *through* AttestoMCP. Attaches no new routes.

Once rails are mounted, subsequent `requirements()` calls emit approve links that
resolve to the mounted `/attestomcp/*` routes.

```ts
const store = createStorefront();
const attestomcp = new AttestoMCP();
attestomcp.mount(store.app);    // zero-arg compose — reads store.app.locals.attestomcp
```

### Policy builders

Each built-in returns a `Credential` (see [The credential model](#the-credential-model)).
Built-ins, customs, and effects are one shape.

#### `age.over(minAge)`

```ts
age.over(minAge: number): Credential
```

Gate (`effect: gate()`) that verifies the **explicit positive** claim
`age_over_${minAge} === true` (Security invariant 5 — an 18+ proof never satisfies a
21+ gate). Sets `params.minAge`; the request is the age DCQL (ISO 18013-5 mDL + EU PID).

```ts
required(age.over(21));
```

#### `membership.discount(percent)`

```ts
membership.discount(percent: number): Credential
```

Optional credential (`effect: discount({ percent })`) that verifies a non-empty
`membership_number`; presenting it applies the discount once. The request asks for the
`org.multipaz.loyalty.1` doctype (`membership_number`, `tier`). Sets `params.percent`.

```ts
optional(membership.discount(10));   // 10% off if a loyalty credential is presented
```

#### `payment.in(currency)`

```ts
payment.in(currency: string): Credential
```

Authorization (`effect: authorize()`) that verifies `authorized === true`. The amount is
**derived from the order server-side**, never passed as a field. The resolver sorts
authorize effects **last**, so payment always settles after every other gate. Sets
`params.currency`; the request asks for the `org.openwallet.payment.1` doctype.

```ts
required(payment.in("usd"));
```

### `required(c)` / `optional(c)`

```ts
required(c: Credential): Step   // { credential: c, required: true }  — blocking when it applies
optional(c: Credential): Step   // { credential: c, required: false } — surfaced, never blocking
```

Wrap a `Credential` to produce a `Step` for the policy array.

### `.when(predicate)`

A method on every `Credential`:

```ts
when(predicate: (order: GateOrder) => boolean): Credential
```

Attaches a **call-site** conditional and returns a **new** `Credential` (chainable,
non-mutating). The predicate receives the whole `GateOrder` and is **AND-ed** onto any
existing `appliesTo` (so a `defineCredential` definition-time conditional and a call-site
`.when()` both must hold). The gate is in the manifest only when the predicate is true.

```ts
age.over(21).when((order) => order.lines.some((l) => l.minimumAge != null));
```

### `defineCredential(c)` — gate any credential

```ts
defineCredential(c: {
  id: string;
  request: DcqlQuery;
  verify: (claims: Record<string, unknown>) => boolean;
  effect: Effect;
  appliesTo?: (order: GateOrder) => boolean;
  ui: { label: string; action: string };
}): Credential
```

Define a custom credential — no registration step. Same shape as the built-ins; the
resolver reads `effect` + `params` and runs `verify` / `appliesTo` / any `.when()`. Pass
the resulting `Credential` to `required()` / `optional()` and drop it into the same policy
array.

```ts
const prescription = defineCredential({
  id: "prescription",
  request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }),
  verify: (c) => c.rx_valid === true,
  effect: gate(),
  appliesTo: (order) => order.lines.some((l) => l.requiresRx),  // definition-time conditional
  ui: { label: "Prescription", action: "Verify prescription" },
});
// …then: required(prescription)
```

### `dcql(spec)`

```ts
dcql(spec: { docType: string; claims: string[] }): DcqlQuery
```

Concise sugar for a single-mdoc DCQL query: name the `docType` and claim leaves, get back
a verifier-shaped `DcqlQuery` (`format: "mso_mdoc"`, selective disclosure with
`intent_to_retain: false` by default). The credential `id` is the last dotted segment of
`docType`.

```ts
dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] });
```

### Effect builders

The three effects the resolver interprets — the only effects a credential may carry:

```ts
gate(): Effect                                            // { kind: "gate" }
discount(opts: { percent?: number; amount?: number }): Effect  // { kind: "discount", ... }
authorize(): Effect                                       // { kind: "authorize" } — settles last
```

### `MemoryVerificationStore`

```ts
class MemoryVerificationStore implements VerificationStore
```

The default in-process `VerificationStore`, keyed by order id (never process-global, so
one shopper's verification can never unlock another's checkout). Swap in your own
implementation (e.g. Redis / Upstash) for serverless.

```ts
read(orderId: string): VerificationRecord | undefined
write(orderId: string, record: VerificationRecord): void
clear(orderId: string): void
```

---

## The credential model (types)

```ts
import type {
  AttestoMCPOptions, GateOrder, OrderLine, Credential, Step, Effect,
  VerificationManifestEntry, VerificationStore, VerificationRecord,
  TrustLevel, DcqlQuery, DcqlClaim, DcqlCredentialOption,
} from "@openmobilehub/attestomcp-gate";
import type { ExpressApp } from "@openmobilehub/attestomcp-gate";
```

### `GateOrder` / `OrderLine` (input to `requirements()`)

The server-priced order. Re-derived server-side; **never the order token**.

```ts
interface GateOrder {
  id: string;        // stable per checkout
  total: number;     // cents; re-derived server-side
  currency: string;  // ISO 4217
  lines: OrderLine[];
}

interface OrderLine {
  id: string;             // product id
  quantity: number;
  unitPrice: number;      // cents; authoritative (catalog)
  minimumAge?: number;    // per-product age threshold (e.g. 21), re-derived onto the line
  category?: string;      // available to custom .when() predicates
  requiresRx?: boolean;   // example custom flag a `prescription` appliesTo reads
}
```

### `Credential` / `Step` / `Effect` (policy — code, never serialized)

```ts
interface Credential {
  id: string;
  request: DcqlQuery;                                  // what to ask the wallet
  verify: (claims: Record<string, unknown>) => boolean; // explicit positive claim
  effect: Effect;                                      // gate | discount | authorize
  appliesTo?: (order: GateOrder) => boolean;           // inclusion predicate (absent ⇒ always)
  ui: { label: string; action: string };              // the card shown on the checkout page
  params?: { minAge?: number; percent?: number; currency?: string };
  when(predicate: (order: GateOrder) => boolean): Credential;  // chainable, non-mutating
}

interface Step { credential: Credential; required: boolean; }

type Effect =
  | { kind: "gate" }
  | { kind: "discount"; percent?: number; amount?: number }
  | { kind: "authorize" };
```

### `VerificationManifestEntry` (output — data on the wire)

The flat, JSON-safe element of the `requires` manifest `requirements()` returns. **No
functions.** This is what the agent and the widget see.

```ts
interface VerificationManifestEntry {
  credential: string;
  required: boolean;
  effect: "gate" | "discount" | "authorize";
  enforcedAt: "tool" | "checkout";        // where it runs (honesty in the type)
  trust_level: TrustLevel;                // mdoc trust (honesty in the type)
  label: string;                          // human-readable, from ui.label
  minAge?: number;                        // age only
  discountPct?: number;                   // discount only
  approveUrl?: string;                    // per-order link (gate / authorize effects)
}
```

### Honesty types

These two fields carry the honest status **in the type**, not in prose:

- **`enforcedAt: "tool" | "checkout"`** — where the gate runs. v0.1 is consolidated
  **Mode A**: every gate is `"checkout"` (Context 2 — the page), enforced server-side on
  the completion path. `"tool"` is the Mode-B blocking shape (roadmap).
- **`trust_level`** — how honestly the presented mdoc is trusted:

  ```ts
  type TrustLevel = "presence-only-demo" | "issuer-verified";
  ```

  v0.1 always emits `"presence-only-demo"`: the gate enforces **disclosure** (an explicit
  positive claim, not mere token-presence) and **binding** (nonce / ephemeral key), but
  **not trust** (mdoc issuer / device signatures) — a self-crafted mdoc would pass.
  `"issuer-verified"` is the v0.2 line. **A presence-only gate is a flow demo, not a real
  safety control.**

### DCQL types

```ts
interface DcqlClaim { path: string[]; intent_to_retain?: boolean; }
interface DcqlCredentialOption {
  id: string;
  format: "mso_mdoc";
  meta: Record<string, string>;
  claims: DcqlClaim[];
}
interface DcqlQuery { credentials: DcqlCredentialOption[]; }
```

### Store types

```ts
interface VerificationRecord {
  ageVerified?: boolean;
  loyalty?: { applied: boolean; membershipNumber: string | null };
  [credentialId: string]: unknown;   // custom credential results, keyed by id
}

interface VerificationStore {
  read(orderId: string): VerificationRecord | undefined | Promise<VerificationRecord | undefined>;
  write(orderId: string, record: VerificationRecord): void | Promise<void>;
  clear(orderId: string): void | Promise<void>;
}
```

### `ExpressApp` / `MountCeremony`

```ts
interface ExpressApp { locals: Record<string, unknown>; }   // structural — no `express` dependency
type MountCeremony = Omit<Partial<CeremonySeams>, "verificationStore">;  // host never passes the store
```

---

## Retained Mode-B / roadmap blocking primitive

For a **page-less** tool (no checkout page), `gated()` returns a typed
`verification_required` envelope the agent **drives** — which credential, a per-order
approve link, the tool to poll — instead of completing with a dead error string. The
envelope's wire shape is a tested contract; do not break it.

```ts
import {
  gated, buildVerificationRequired, isVerificationRequired, envelopeInstruction,
  ageDcql, ENVELOPE_VERSION, ENVELOPE_SENTINEL,
} from "@openmobilehub/attestomcp-gate";
import type {
  VerificationRequired, BuildEnvelopeArgs, BuiltinKind,
  EasyGatePolicy, GateDeps, MinimalToolResult,
} from "@openmobilehub/attestomcp-gate";
```

| Symbol | Kind | Purpose |
| :-- | :-- | :-- |
| `gated()` | function | **Deprecated** Mode-B shim — use `requirements()` for checkout. Wraps a tool so it returns a `verification_required` envelope when the gate fails. |
| `buildVerificationRequired(args)` | function | Construct the typed `verification_required` envelope. |
| `isVerificationRequired(value)` | function | Type guard — detect the envelope by its sentinel. |
| `envelopeInstruction(...)` | function | The agent-facing instruction string describing how to resume. |
| `ageDcql()` | function | The age DCQL (ISO 18013-5 mDL + EU PID) the verifier uses. |
| `ENVELOPE_VERSION` | const | `"attestomcp.verification/v1"`. |
| `ENVELOPE_SENTINEL` | const | `"verification_required"` — the field an agent keys on. |
| `VerificationRequired` | type | The envelope shape: `_attestomcp` sentinel, `version`, `order`, `reason`, `present { credential, min_age?, request, approve_url }`, resume info. |
| `BuiltinKind` | type | `"age" \| "membership" \| "payment"`. |

> Mode A (consolidated checkout) is the v0.1 default; this envelope is the blocking shape
> for the page-less / roadmap path. `trust_level` carries the same honesty caveat as the
> manifest.

---

## Cart Mandate (`ap2.CartMandate`)

A **signed, tamper-evident envelope over the cart** — the signed sibling of the AP2
`PaymentMandate`. It proves *this server issued this cart*, so a cart that travels with a
request can be checked before it's trusted. **Additive and fail-closed**, and it does **not**
change the price authority: the catalog still re-prices (invariant 2); the mandate is a fast
integrity pre-check + defense-in-depth, never a substitute for re-derivation.

```ts
import { issueCartMandate, verifyCartMandate, DEFAULT_CART_MANDATE_TTL_MS } from "@openmobilehub/attestomcp-gate";
import type { CartMandate, CartMandateLine, CartMandateVerdict, CartMandateRefusal, IssueCartMandateArgs } from "@openmobilehub/attestomcp-gate";
```

| Symbol | Purpose |
| :-- | :-- |
| `issueCartMandate(args, secret)` | Sign a server-priced cart → `CartMandate`. `args`: `{ orderId, lines, currency, total, id?, ttlMs?, now? }`. |
| `verifyCartMandate(mandate, orderId, secret, now?)` | Verify → `CartMandateVerdict` (`{ ok, mandate }` / `{ ok:false, reason }`). Checks, in order: shape, **HMAC signature** (constant-time), **order-id binding**, **expiry**. Never throws. |
| `DEFAULT_CART_MANDATE_TTL_MS` | Default validity window (15 min). |
| `CartMandateRefusal` | `"malformed" \| "signature" \| "order-id" \| "expired"` — a slow buyer sees `expired`, a tampered/forged cart sees `signature` (distinct reasons). |

**Honesty (`trust_level: "presence-only-demo"`).** v0.1 signs with the **server's** HMAC key
(the same sealed-HMAC primitive as the challenge nonce). That proves the server issued the cart,
**not that the user authorized it**. A user/agent-signed cart mandate + issuer trust is the v0.2
line; the `alg` field (`"HS256"`) reserves room for an ES256 / key-bound variant without changing
the contract.

**In `completeOrder`.** When the completion input carries a `cartMandate` **and** the context has a
`signingKey`, completion verifies it (signature + order-id + expiry) **before** re-pricing, then —
if a Payment Mandate is also present — reconciles `cart total == re-priced total == bound amount`
across every payment path. Failures surface as `{ completed:false, reason:"cart-mandate" }`
(tamper/replay/expiry) or `"reconcile"` (cart and payment disagree).

### `statelessOrders` (mount seam option, default off)

When `true`, a **verified** cart mandate becomes the created-order **transport**: `resolveOrder`
reconstructs the order's line items from the mandate with **no `orderStore` read**, so a checkout
survives an instance split with no shared store (serverless / multi-instance). It stays fail-closed
(a forged / tampered / replayed / expired mandate resolves nothing) and the catalog **still
re-prices** — the mandate carries the *items*, never the *price*.

**Wire contract.** Every rail (`passkey`, `dc-payment`, `credential`) accepts the mandate the same way:

- **GET** routes (page / request) — a **base64url-JSON** `cart` query param:
  `…/attestomcp/dc-payment?order=<id>&cart=<base64url(JSON)>`.
- **POST** verify — a `cartMandate` JSON field in the body: `{ "order": "<id>", "cartMandate": { … } }`.
  The payment rails also forward it to `completeOrder`, which **re-verifies + reconciles** it.

The gate decodes it trust-free (a missing/garbage value falls through to the store path);
`verifyCartMandate` is the real gate. **Follow-up DX:** the approve link the gate emits does not yet
auto-embed the mandate under `statelessOrders` — the host wires the client to carry it today; embedding
it in the approve URL (so the client threads it transparently) is the planned ergonomic improvement.
Note a signed cart in a **GET URL** is long, and very large carts can approach URL-length limits — POST
paths are unaffected.

> **Trade-off — reference vs. payload.** With `statelessOrders: false` (default) the client/agent
> carries only the **order id** (a *reference*); the line items stay server-side in the store. With
> it `true`, the client carries the **whole signed cart** — product ids, quantities, and the sealed
> prices — on the wire, back and forth. You gain instance-independence; you pay by putting cart
> contents on the wire through the agent/orchestrator. The mandate is HMAC-signed so it is
> **tamper-evident**, but it is **not encrypted** — whoever holds it can read the cart — and a large
> cart means a larger token. Prefer it **off** when you can keep server-side state (so the agent
> holds only a reference); turn it **on** when you can't. Design discussion:
> [`specs/004-cart-mandate/spec.md`](../../specs/004-cart-mandate/spec.md) (FR-007) and the 005
> connector design.

---

## `@openmobilehub/attestomcp-storefront`

The storefront core — a runnable MCP shopping server (nine tools + the widget bundle +
a checkout page), **catalog-injected**, gate-ready. Two entry points: `.` (the pure
pricing/order model) and `./server` (the runnable server, brings in
`@modelcontextprotocol/sdk` + `express`).

```ts
import { createStorefront } from "@openmobilehub/attestomcp-storefront/server";
```

### `createStorefront(opts?)`

```ts
createStorefront(opts?: StorefrontOptions): Storefront
```

Stands up the real MCP storefront over HTTP at `/mcp` around an injected catalog. The
`checkout` tool is **ungated by default**; call `store.gate(resolve)` to have it surface a
`requires` manifest. It pre-binds the gate's `completeOrder` over its own stores + catalog
and publishes the ceremony seams on `store.app.locals.attestomcp`, so `new AttestoMCP().mount(store.app)`
wires the `/attestomcp/*` rails with zero glue.

#### `StorefrontOptions`

All optional.

| Field | Type | Default | Meaning |
| :-- | :-- | :-- | :-- |
| `catalog` | `Product[]` | `SAMPLE_CATALOG` | Products to sell. |
| `reviews` | `Record<string, Review[]>` | — | Reviews per product id, backing `get-product-reviews`. |
| `baseUrl` | `string` | `http://localhost:<port>` | Origin the checkout links resolve from (self-derived from the first request behind a proxy if unset). |
| `cartStore` | `CartStore` | in-memory | The cart store. |
| `orderStore` | `OrderStore<CompletedOrderRecord>` | in-memory | Completed-order store (read by `get-order-status`). |
| `createdOrderStore` | `OrderStore<Order>` | in-memory | Created-but-not-yet-completed orders, keyed by order id (read by the checkout page + place-order). Inject a shared store on multi-instance serverless. |
| `verificationStore` | `VerificationStore` | in-memory | Per-order verification state the mounted ceremony writes; published on `app.locals.attestomcp` so the rails and the completion seam share the same per-order state. |
| `signingKey` | `string` | — | Stable HMAC key for the ceremony's challenge nonce (e.g. `process.env.GATE_SECRET`). Required so an options→verify hop survives an instance split on serverless. |
| `allowEphemeralKey` | `boolean` | `true` unless `signingKey` is set | Allow a per-process ephemeral signing key (single-process dev / tests). |
| `settle` | `(order: CeremonyOrder) => Promise<Record<string, unknown> & { network: string; txId: string; status: string }>` | — | Optional demo-mode settlement seam (e.g. on-chain). **Throwing GATES completion** — a configured-but-failed settle records nothing and leaves the cart intact. |

#### `Storefront` (the return)

```ts
interface Storefront {
  app: Express;                                       // the Express app — pass to attestomcp.mount()
  catalog: Product[];                                 // the resolved catalog
  gate(resolve: GateResolver): void;                  // attach the policy resolver
  listen(port?: number): Promise<{ url: string; port: number }>;  // default port 3005
  mcpServer(): McpServer;                             // build a fresh McpServer instance
}

type GateResolver = (order: Order) => unknown[] | undefined;  // requires manifest, or undefined = ungated
```

- **`app`** — the Express app; `attestomcp.mount(app)` reads the ceremony seams off
  `app.locals.attestomcp`.
- **`gate(resolve)`** — register a resolver run on every `checkout` call. Return the
  `requires` manifest (typically `attestomcp.requirements(order, policy)`) or `undefined`
  to leave checkout ungated. The same resolver also enforces the gates server-side on the
  completion path (a direct POST of a gated order to the instant-demo path is refused).
- **`listen(port?)`** — start the HTTP server (default `3005`); resolves to
  `{ url: "<baseUrl>/mcp", port }`. Add `url` to Claude / ChatGPT / Goose.
- **`mcpServer()`** — build a fresh `McpServer` (e.g. for stdio transport / tests).

```ts
const store = createStorefront();
const attestomcp = new AttestoMCP();
attestomcp.mount(store.app);
store.gate((order) =>
  attestomcp.requirements(order, [
    required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
    optional(membership.discount(10)),
    required(payment.in("usd")),
  ]),
);
const { url } = await store.listen(3005);   // → http://localhost:3005/mcp
```

### Pure pricing model (the `.` entry point)

Pure, catalog-injected functions (no globals) — useful standalone or to fork:

```ts
import {
  priceCart, createOrder, requiredAgeForLines, getProduct, getReviews,
  SAMPLE_CATALOG, LOYALTY_DISCOUNT_PCT,
} from "@openmobilehub/attestomcp-storefront";
import type { Product, Order, PricedCart, PricedCartLine, Review, PriceOpts } from "@openmobilehub/attestomcp-storefront";

const cart = priceCart([{ productId: "oak-whiskey", quantity: 1 }], SAMPLE_CATALOG);
cart.hasAgeRestricted;                              // true → wire the gate on checkout
requiredAgeForLines(cart.lines, SAMPLE_CATALOG);   // 21

const order = createOrder([{ productId: "oak-whiskey", quantity: 1 }], "ORD-1", SAMPLE_CATALOG);
order.total;                                       // 124
```

Each product's `minimumAge` is the single field that ties the two packages together:
`priceCart` re-derives it onto every priced line, so a storefront `Order` feeds
`attestomcp.requirements()` directly. The gate's amount is **re-derived server-side from this
catalog**, never trusted from the order token.

---

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).
