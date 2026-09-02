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

### Branding the ceremony pages

The buyer proves their credential on pages the gate serves during **your** checkout, so those
pages can carry **your** brand. Set `branding` **once** on the constructor and every ceremony page
— the checkout hub and the age / payment / credential gate pages — picks it up. No per-page wiring:

```ts
const credentagent = new CredentAgent({
  walletOrigin: "https://shop.acme.example",
  branding: {
    wordmark: "ACME",          // replaces the "CREDENTAGENT" wordmark
    accent: "#7c3aed",         // primary colour (button, active step, ✓); hover derived
    logo: "data:image/svg+xml;base64,…", // optional; shown instead of the wordmark
    demoPill: false,           // hide the DEMO pill (e.g. in production)
  },
});
credentagent.mount(store.app); // every /credentagent/* page now carries ACME's brand
```

- **Zero-config default** — omit `branding` and the pages render exactly as before.
- **Chrome only, by design.** Branding never touches the honesty trust footer: the
  `presence-only-demo` disclosure (see [Honest status](#honest-status)) is the same on every page,
  branded or not. Nothing you pass can alter or remove it.
- **Safe by construction.** Every field is sanitized where it's used — the wordmark is HTML-escaped,
  the `accent` must be a hex or `rgb()`/`hsl()` colour (anything else — including a bare word like
  `teal` — is ignored, keeping the built-in teal), and `logo` accepts only a `data:image/…` URI, an
  `https:`/`http:` URL, or a root-relative `/path`. A host-supplied string can't inject markup or CSS
  onto a consent screen.

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
> `completedOrderStore`) and read `orders.retrieve(id)` as the durable, cross-instance signal — or
> register a **webhook** (next section) so a different service gets the signed HTTP `POST`.

`orders.retrieve(id)` is the one result **door**: `{ ok: true, completion }` once paid, `{ ok: false,
pending: true, approveUrl }` while it's open, or `{ ok: false, code }` for an unknown id. The amount and
the age threshold are re-derived from the order you stored server-side — never trusted from the link
(invariant 2), and a gated order can only complete through the wallet ceremony, never a shortcut
(invariant 1). Runnable: [`examples/orders-checkout/`](https://github.com/openmobilehub/credentagent/tree/main/examples/orders-checkout).

### Preflight — did I configure this right? (`doctor()`)

Those deployment knobs — a stable `gateSecret`, a public `walletOrigin`, shared stores — are easy to
forget, and a missing one fails at the worst time (a buyer mid-checkout, on the one instance that never
saw the proof). Call `credentagent.doctor()` once at startup for a config check. It returns typed plain
data, and **never throws or touches the network** — it reads your config plus `process.env` for
deployment signals:

```ts
const report = credentagent.doctor();
if (!report.ok) {                                            // ok === no error-level findings
  for (const f of report.findings) console.error(`[${f.level}] ${f.message}\n  fix: ${f.fix}`);
  process.exit(1);                                           // fail the boot rather than serve a broken deploy
}

// …or one line that prints a human-readable summary AND returns the same report:
credentagent.doctor({ print: true });
```

Each finding is `{ level: "error" | "warn", code, message, fix }`. It checks the config you passed to
`new CredentAgent(...)`:

| `code` | fires when | `fix` |
| --- | --- | --- |
| `ephemeral-gate-secret` | no `gateSecret` on a deployment (serverless ⇒ error, else warn) | set `GATE_SECRET` — `openssl rand -hex 32` — and pass `{ gateSecret }` |
| `localhost-wallet-origin` | `walletOrigin` is localhost on a deployment | pass your public `https` origin |
| `in-memory-verification-store` | the default in-memory `store` on a deployment | inject a shared `{ store }` (Redis/Upstash) |
| `in-memory-order-store` | the default in-memory order stores on a deployment | inject `{ orderStore, completedOrderStore }` |

In plain local dev — no deployment env signals (`VERCEL`, `AWS_LAMBDA_*`, `NODE_ENV=production`, …) — it
reports nothing, so the zero-config quickstart stays quiet.

### Webhooks — tell a *different* service when an order settles

`on("order.settled", …)` only fires in the process that settled the order. When fulfillment runs
elsewhere, register a **webhook**: the gate sends a **signed** HTTP `POST` and the other service
verifies it — the Stripe idiom (`constructEvent`). Real HMAC signature, replay-protected.

```ts
// SENDING — configure once; a settled order is POSTed to each endpoint (signed, retried, non-blocking):
new CredentAgent({ webhooks: { endpoints: [{ url: "https://fulfillment.example/hooks", secret: process.env.WHSEC }] } });

// RECEIVING — a different service; only the shared secret. Verify the RAW body:
import { constructEvent } from "@openmobilehub/credentagent-gate";
app.post("/hooks", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try { event = constructEvent(req.body, req.get("CredentAgent-Signature"), process.env.WHSEC); }
  catch (err) { return res.status(400).send(err.message); }        // forged / tampered / replayed → rejected
  if (event.type === "order.settled") fulfill(event.data.object.orderId); // dedupe on event.id
  res.json({ received: true });
});
```

Signature: `CredentAgent-Signature: t=…,v1=<hex HMAC-SHA256>` over `` `${t}.${rawBody}` ``, secret
`whsec_…`. Delivery is **at-least-once** with retry (dedupe on `event.id`) — it never blocks a settled
order. Endpoint URLs must be **https** (http only for localhost dev — enforced where endpoints enter);
redirects are never followed, and each attempt is bounded by a timeout (`timeoutMs`, default 10s).
`verifyEvent(...)` is the never-throws verdict door if you prefer a result to a try/catch. Runnable:
[`examples/order-webhooks/`](https://github.com/openmobilehub/credentagent/tree/main/examples/order-webhooks).

## Bring your own host — mount on YOUR MCP server

`createStorefront()` is one host; the product promise is "mount the gate on **any** app." If you
have your own Express + MCP server, your own catalog/pricing, and your own order store, wire the
gate over them with **`defineHost(...)`** — you should never call the low-level `completeOrder` by
hand or reach into `app.locals` yourself.

Give `defineHost` three things — how you **price** an order, how you **read** a created order, and
where **completed** orders go — and it builds the shared completion for you, owns the per-order
verification store, and publishes every seam. Then `mount(app)` serves the proof pages over them:

```ts
import { CredentAgent, defineHost, age, payment, required } from "@openmobilehub/credentagent-gate";

const host = defineHost({
  catalog: { createOrder: (items, orderId) => priceFromMyCatalog(items, orderId) }, // amount source of truth
  orderStore: { read: (orderId) => myOrders.get(orderId) ?? null },                 // your created order
  records: { read: (id) => myCompleted.get(id), write: (rec) => myCompleted.set(rec.orderId, rec) },
  signingKey: process.env.GATE_SECRET, // stable across instances; or { allowEphemeralKey: true } for dev
  returnUrl: (id) => `/checkout/${id}`, // your checkout route — where a rail returns the buyer after a proof
});

host.publish(app);                                     // publish the seams onto your app
new CredentAgent({ walletOrigin }).mount(app);         // serve the /credentagent/* proof pages over them

// Your OWN place-order / MCP tool calls host.complete(...), so the gates run server-side on YOUR
// completion path too (not just in a rendered page — Security invariant 1). Typed plain data back:
app.post("/checkout/:id", async (req, res) => {
  const order = priceFromMyCatalog([{ productId: "wine", quantity: 1 }], req.params.id);
  const result = await host.complete({ order, mandateId: `demo-${order.id}`, amount: order.total, currency: "USD", method: "demo", gates: [{ gate: "demo", pass: true, detail: "" }] });
  res.status(result.completed ? 200 : 402).json(result); // { completed:false, reason:"age" } until proven
});
```

- **`host.complete(input)`** is the same shared completion the rails use — one choke point, no second
  weaker path. It re-prices from your catalog (never the token), runs the age + any custom `gate()`
  credentials, settles, and records idempotently, returning `{ completed, reason? }`.
- **`returnUrl`** is where a rail sends the buyer back after they prove. Set it to your own checkout
  route — otherwise the rails default to `/checkout?order=<id>`, which a non-storefront host does not
  serve, and the buyer lands on a dead link.
- **`host.verificationStore`** is the per-order proof store (default in-memory; inject a shared store
  — e.g. Redis — for a multi-instance deploy). The rails write it when the buyer proves; your
  completion reads it.
- **Fail-closed like `mount()`:** `defineHost` throws at construction on an incomplete or contradictory
  seam set (missing `catalog`/`orderStore`, both `records` and a `completion`, or neither a `signingKey`
  nor `allowEphemeralKey`).
- **Advanced:** pass your own `completion` seam instead of `records` if you'd rather bind `completeOrder`
  yourself. Runnable end-to-end:
  [`examples/bring-your-own-host.mjs`](https://github.com/openmobilehub/credentagent/blob/main/examples/bring-your-own-host.mjs).

> Still storefront-only (not yet in `defineHost`): the catalog-injected MCP shopping tools, the widget
> bundle, and the `?cart=` stateless-order transport wiring — `createStorefront()` remains the batteries-
> included host. `defineHost` covers the seam contract (pricing, orders, completion, verification), which
> is what a custom host actually needs.

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
never-retain by default). The credential id defaults to a stable, unique derivation from the full
doctype (`org.openwallet.payment.1` → `org_openwallet_payment_1`); pass `dcql({ docType, claims, id })`
to name it yourself. The three effect builders — `gate()`, `discount({ percent })`, `authorize()` —
are the only effects the resolver interprets.

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
- **`trust_level: "device-signed"`** — used by device-signed spending grants (`grants.create({
  signing: "device" })`, below). Here the gate **does** verify the wallet's mdoc DeviceAuth
  signature over the grant's exact bounds — a real holder-of-key binding, one step past
  presence-only. What is still demo is only the trust **anchor**: the payment credential is a
  self-minted demo credential with no issuer/VICAL check (that is the roadmap `issuer-verified`
  line, issue #14), so a self-crafted device key would still pass. The signature is real; the
  anchor is not — the page and the type both say exactly that, and the gate never claims
  `issuer-verified` for the in-gate check.

The three rails `mount()` serves differ in how much crypto is real today:

| Rail (`/credentagent/*`) | What it proves | Trust today |
| :-- | :-- | :-- |
| `passkey` (same-device + cross-device caBLE) | WebAuthn assertion verified against this server's origin / RP-ID, user-verification required, nonce/replay-bound — **real cryptography** (`@simplewebauthn`) | real WebAuthn crypto |
| `credential` (age / membership) | OpenID4VP presentation; the explicit positive claim is checked, but the mdoc's issuer/device signatures are **not** verified | `presence-only-demo` |
| `dc-payment` (Digital Credentials API) | amount-bound mdoc presentation; the JWE vp_token + device signature are taken at face value, **not** cryptographically verified | `presence-only-demo` |
| `delegated` (opt-in — `mount({ verifier })`) | the same policy, verified + settled by an **external** verifier/processor; the gate re-derives the binding and re-runs your policy, and **relays** the verdict's trust | the verifier's — `issuer-verified` with a real anchor |

The built-in OpenID4VP plumbing is scaffolded; cryptographic mdoc trust is the integration step, not
new cryptography. The mandate is AP2-shaped and dev-signed (integrity hash), not key-signed.
`trust_level: "issuer-verified"` is reachable **today** through the `verifier` seam (below) — the gate
relays a level a real anchor produced; it does not verify issuer signatures itself.

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

### Real trust: delegate to an external verifier (`verifier`)

The built-in rails lack an issuer/device **trust anchor** — that is what keeps them
`presence-only-demo`. Pass a `verifier` seam and the gate serves a **delegated ceremony**: your same
`gate()` policy runs a real, issuer-trust-verified, amount-bound payment through an external
verifier/processor (e.g. a Multipaz verifier + a UPay-style processor), **inside** the mounted
ceremony instead of around it. Your policy and storefront are unchanged — only the backend moves in.

**1. The adapter you write.** A plain object with three methods, each a thin wrapper over a
verifier/processor you already have — in plain words:

```ts
interface DelegatedVerifier {
  // "Tell the checker: verify these credentials, bound to exactly $124 payable to me."
  buildRequest(input: { order, dcql, binding, origin }): DelegatedHandoff;
  // "Fetch the checker's verdict, server-to-server, by reference — no money moves here."
  consume(input: { reference, order }): DelegatedVerdict;
  // "Charge. The gate calls this ONLY after its own re-checks pass."
  settle?(input: { reference, order, amount, currency }): SettlementRecordLike;
}
```

Type your adapter with `import type { DelegatedVerifier } from "@openmobilehub/credentagent-gate"` and
let the compiler guide you through each method's exact input/output shape.

`settle` is **optional**: an identity-only gate (age, a licence, membership) completes without it —
there is nothing to charge.

**2. Plugging it in.** One option, your policy untouched — either path works:

```ts
// with the storefront
const store = createStorefront({ verifier });
new CredentAgent().mount(store.app);            // zero-arg — picks the verifier off app.locals

// or storefront-less
credentagent.mount(app, { ...seams, verifier });
```

**3. What happens at runtime.** Checkout → one **delegated** approve link → the wallet ceremony runs
with the checker → the browser returns **only a sealed, order-bound reference** (never the result, so
it cannot forge an approval) → the gate re-prices from the catalog, re-runs *your* policy over the
disclosed claims, **then** authorizes `settle` → the order is recorded with the checker's `trust_level`.

The one rule that makes delegation safe: **trust is delegable, binding is not.**

- The **verifier** brings what the gate lacks: issuer/device signature verification against a real
  anchor. Its verdict reports `trust_level: "issuer-verified"`, which the gate **relays** — it never
  synthesizes a level it did not receive.
- The **gate** keeps what it must never outsource: it re-derives the amount/payee from the catalog and
  re-checks the verdict against it, re-runs *your* policy over the disclosed claims (an 18+ verifier
  check never satisfies `age.over(21)`), and only **then** authorizes `settle`. A verifier that
  approves the wrong amount — or a stricter-than-the-merchant age — is refused before any money moves.

The concrete verifier is a **host-side adapter** — no processor-specific symbol lives in this package.

> **No real adapter ships yet.** This package defines the *interface*; the first real adapter lives
> host-side in [`openwallet-foundation/multipaz-utopia`](https://github.com/openwallet-foundation/multipaz-utopia)
> (**S6**, tracked in [multipaz-utopia#16](https://github.com/openwallet-foundation/multipaz-utopia/issues/16)).
> Today the only way to run the delegated rail is a **stand-in** like the scripted verifier in
> [`examples/delegated-verifier/`](../../examples/delegated-verifier) — a test double, never shipped, and
> deliberately kept out of the runnable `run-storefront` example. Stating this plainly is the honesty
> fence working, not a gap.

> **A refused tool call is a protocol, not a wall.** For a page-less tool, `gated()` returns a typed
> **`verification_required`** envelope the agent *drives* (which credential, a per-order approve link,
> the tool to poll) instead of completing — the retained blocking **Mode B** primitive.

## Grants — approve once, the agent spends while you're away

You approve **one spending limit** — *"up to $100 at this store, max $30 per purchase, Beverages
only"* — and your agent buys against it unattended, every rule re-checked **server-side** on every
spend. This is the human-NOT-present resource, `credentagent.grants` (spec 009):

```ts
import express from "express";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const app = express();
app.use(express.json());
const credentagent = new CredentAgent({
  walletOrigin: "https://shop.example",
  catalog: { coffee: { price: 18, category: "Beverages" }, wine: { price: 21, minAge: 21, category: "Beverages" } },
});

// ── once, at startup ─────────────────────────────────────────────
credentagent.grants.serve(app);                       // serves each grant's approveUrl (approve/deny page)

// ── the human approves ONCE ──────────────────────────────────────
const grant = await credentagent.grants.create({
  merchant: "utopia", budget: 100, perSpend: 30,
  allow: { categories: ["Beverages"] },               // bound WHAT may be bought, not just how much
});
sendToUser(grant.approveUrl);                         // grant.status: "pending" → "authorized" | "denied"

// ── later, human AWAY — rehydrate and spend within the sealed bounds ──
const g = await credentagent.grants.retrieve(grant.id);
if (g.status === "authorized") {
  const s = await g.spend({ idempotencyKey: "order-1", items: [{ sku: "coffee" }] });
  //  → { ok: true, amount: 18, remaining: 82, authorization: "delegated" }
  //  or { ok: false, code: "per-spend-exceeded" | "budget-exceeded" | "not-allowed" | "step-up" | "revoked" | … }
  await g.revoke();                                   // kill-switch — the very next spend refuses
}
```

The refusal `code` is a **typed union** (`GrantDoorCode`) — a typo fails to compile. A retried
`idempotencyKey` replays the ORIGINAL outcome, refusal included, so a key can never be repurposed.
The sealed bounds are **immutable** after create. Try all of it clickable in
[`examples/demo-hub/`](https://github.com/openmobilehub/credentagent/tree/main/examples/demo-hub)
(Section 3) or the two-pane [`examples/grants-proto/`](https://github.com/openmobilehub/credentagent/tree/main/examples/grants-proto).

### Asking for what's missing first — MRTR (multi round-trip)

A grant for *"sneakers"* is not yet a grant for a **particular pair**. `MultiRoundTrip` implements
MCP's [multi round-trip request](https://modelcontextprotocol.io/specification/draft/basic/patterns/mrtr)
pattern so a tool can answer *"which size?"* instead of a link, and finish the job on the next call —
with **no server-side session** between the two:

```ts
import { MultiRoundTrip } from "@openmobilehub/credentagent-gate";

const rounds = new MultiRoundTrip({ secret: process.env.GATE_SECRET });  // configure once

// inside your tool handler — the same code runs on every round:
const round = rounds.open({
  request: "create-spending-grant",     // what this state may be presented on
  params: { budget, perSpend, item },   // the money bounds it was minted for
  principal: sessionId,                 // whose session it belongs to
  state: requestState,                  // the opaque blob the client echoed back
  responses: inputResponses,            // the human's answers to the last round
});
if (!round.ok) return refuse(round.code);          // "tampered" | "expired" | "wrong-request" | "wrong-principal"

if (!round.answers.size) {
  return round.ask({                               // → { resultType: "input_required", inputRequests, requestState }
    size: { message: "Which size?", fields: { size: { type: "string", enum: ["US 9", "US 10"] } } },
  });
}
mintTheGrant(round.answers);                       // enough information — do the thing
```

Everything gathered so far rides in `requestState`, which travels **through the client** — so the
spec (and repo invariants 2 + 4) treat it as attacker-controlled. `open()` refuses a blob that fails
its **HMAC**, that has **expired**, or that was minted for a **different call, different money
bounds, or different session**; and it merges **only** answers to questions this flow actually asked.
Anything else is dropped.

A flow can also seal facts of its **own** into the blob: `round.ask(questions, { carry: { grantId } })`
comes back as `round.carried` on the next call. Carried facts are **server-attested** — the client
transports them but can neither set nor edit them (the seal covers them), and they ride forward
untouched when a later `ask()` omits `carry`. That is what lets a flow park a record id across a
*wait* round — "the grant is minted; call again once the human has tapped Approve" — and treat the
client's reply as a **doorbell only**, re-reading the record server-side instead of believing the
answer.

> **Honesty.** The seal proves *this server* minted the blob and nobody edited it in transit. It does
> not prove a human gave the answers inside: no shipping client implements MRTR yet, so today the
> **agent** answers on the human's behalf (`answers`, the flat fallback channel). That is why the
> resolved purchase is still spelled out on the approve page — the human's tap is what counts.
> Implemented here because `@modelcontextprotocol/sdk` does not ship the MRTR types yet.
### Device-signed grants — the wallet signs the grant first (spec 012)

**Approving a grant is a signature.** A grant's `approveUrl` serves a signing ceremony, and the
grant only reaches `"authorized"` once a wallet on the phone **signs its exact bounds** (an ISO mdoc
DeviceAuth signature over the budget / per-purchase cap / allowed items). Nothing can be spent
against a grant no device signed.

Pass **`signing: "page"`** to opt into the older **click-to-approve** stand-in, where the server
takes the human's word for it (`trustLevel: "server-issued-demo"`). It exists for demos, examples
and CI — anywhere no phone is in the loop. The weaker door is still there; it just has to be asked
for by name.

> **What the signature does and does not prove.** It proves **holder-of-key** and **binding**: the
> device key signed over *these* bounds, so a spend always traces to what the human authorized. It
> does **not** yet prove **trust** — there is no issuer anchor, so a self-minted credential passes
> ([#14](https://github.com/openmobilehub/credentagent/issues/14)). `trustLevel` says
> `"device-signed"`, never `"issuer-verified"`.

```ts
const grant = await credentagent.grants.create({
  merchant: "utopia", budget: 200, perSpend: 130,
  allow: { categories: ["Beverages"] },
  // signing defaults to "device" — pass signing: "page" for the click-to-approve stand-in
});
sendToUser(grant.approveUrl);                         // → the signing ceremony (not click-to-approve)
// …the human signs on their phone…
const g = await credentagent.grants.retrieve(grant.id);
g.status;      // "authorized" — ONLY after the gate verified the device signature over these bounds
g.trustLevel;  // "device-signed"
g.mandate;     // { boundsHash, signedAt, credentialDoctype, verifiedBy } — the evidence, plain data
const s = await g.spend({ idempotencyKey: "order-1", items: [{ sku: "coffee" }] });
// s.mandate → { id, boundsHash } — every spend traces to the signed Intent Mandate (FR-5)
```

**The invariant:** signed by the device **first**, spent by the agent **second**. A device-mode grant
that was never device-signed can never spend; a spend always traces to the exact signed bounds.

**Honesty (`trust_level: "device-signed"`, not `"issuer-verified"`):** the device signature is
**real** — the gate verifies the wallet's mdoc DeviceAuth COSE signature over the bounds-bound session
transcript. What is **still demo** is the trust **anchor**: the payment credential
(`org.openwallet.payment.1`, importable via the demo-PKI `payment.mpzpass`) is self-minted with **no
issuer/VICAL check** (that hardening is issue #14), so a self-crafted device key would pass. The
verify runs through a **seam** — the in-gate backend attests `device-signed` / `verifiedBy: "gate"`;
wiring an external verifier (the `DelegatedVerifier` seam) that reports a stronger, issuer-backed level
is the fast-follow, and the gate **relays** that level verbatim with the attestor recorded in
`verifiedBy`.

Test the whole flow **with no phone** using the exported simulated wallet — see
[`examples/device-signed-grants.mjs`](https://github.com/openmobilehub/credentagent/blob/main/examples/device-signed-grants.mjs)
(`devSimulateWalletSignature` produces a real device signature the way Stripe's test cards stand in
for a real card). The **on-device** path — import `payment.mpzpass` into Multipaz and sign on a
phone — is verified separately.

### Credentials on a grant — presented before you authorize, or not at all

The storefront pins the exact product before the link exists (above), so a grant can be *for* a
bottle of whiskey. That used to be a grant that could spend **$0.00**: every purchase refused
`step-up`, and nothing told the human before they authorized it. Two things fix that, on the page
they were already opening.

**It tells you.** `grant.ageScope` reads the products the grant NAMES against your catalog — the
agent is never asked — and the page names them back:

```ts
grant.ageScope  // → { minimumAge: 21, items: [{ sku: "oak-whiskey", name: "Oak Reserve Whiskey", price: 124, minAge: 21 }] }
```

It does **not** guess. A grant bounded by category alone names no product, so it gets no age step:
a page that warned "this category MIGHT contain something 21+" would be warning about an item
nobody chose, and would be wrong the moment the catalog changed.

**It lets you unlock them.** The page grows a *"Verify 21+ with your wallet"* step — the same
OpenID4VP ceremony as the checkout age gate, run at the one moment the human is holding their
phone. What they prove is sealed into the grant, and their agent can then buy those items while
they're away. Decline, and *"Approve without them"* gives you exactly today's grant.

**The same moment can carry your loyalty card.** Set `loyaltyDiscountPct` and the page grows a
second, optional step — present your membership, and every purchase the agent makes under that
grant is discounted:

```ts
const credentagent = new CredentAgent({ catalog, loyaltyDiscountPct: 10 });
const s = await g.spend({ idempotencyKey: "o-1", items: [{ sku: "coffee" }] });
//  → { ok: true, amount: 16.2, remaining: 83.8, … }     // $18 − 10%
```

The rate is **sealed into the grant** when it authorizes, not read from config at spend time — so
changing your programme never re-prices a grant somebody already agreed to. And it is the *same*
sealed number on both sides of the money: the delegate key signs the discounted amount, and
`completeOrder` re-derives it independently and refuses the draw unless they match to the cent. The
per-purchase cap is measured on what the human is actually **charged**, not the shelf price.

Nothing about identity is delegated to the agent: the credential is the **human's**, presented by
**their** wallet while they are **present**. Without an age proof, an age-restricted item still
refuses `step-up` — and a proof only ever opens items at or below what it proved, so an 18+ proof
never opens a 21+ item.

On a **device-signed** grant these steps sit above the signature, and the claims are inside
`canonicalIntentBounds` — so the wallet's signature covers the exact terms the page showed,
credentials included. A claim recorded after the request was sealed changes the hash and the
signature stops verifying, rather than riding a signature given for different terms.

> **Honesty:** the wire crypto is real (signed OpenID4VP request, sealed nonce, JWE/HPKE decrypt,
> ISO-mdoc parse) but there is **no issuer trust anchor** yet — `trust_level` is
> `"presence-only-demo"` and a self-crafted credential would pass. This is disclosure and binding,
> **not** a real age-safety control, until issuer-verified trust lands.

See it in every state: [`examples/grants-approve/`](https://github.com/openmobilehub/credentagent/tree/main/examples/grants-approve).


### Under the hood — the delegated-draw seams (005)

`grants` wraps **`DelegatedGate`** (`preApprove`/`spend`/`revoke`), which remains exported for
direct use:

```ts
const gate  = new DelegatedGate({ catalog: { coffee: 18 } });
const grant = await gate.preApprove({ merchant: "blue-bottle", perOrder: 30, total: 100 });
const result = await grant.spend({ idempotencyKey: "order-1", item: "coffee" });
await grant.revoke();
```

Under that facade are **signer-agnostic seams** for redeeming a user-sealed
**Intent Mandate** (a bounded, revocable delegation) with no live human — `sealIntent` / `checkDraw`
(pure, total, typed refusals), a `RevocationStore` (per-intent + subject kill-switch, atomic
single-use consume), and an additive, fail-closed **draw branch** in `completeOrder` that re-runs
every bounds + revocation check server-side, writes a `delegationId`, and **suppresses settlement**.
An age-restricted cart completes on that branch **only** against an age claim the human sealed into
the intent at approval time, tested at the order's re-derived threshold — absent, too low, or past
its stated validity, it steps up to a live ceremony (`ageProofCovers` is the one predicate).

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
  constructor(opts?: { walletOrigin?: string; store?: VerificationStore; credentials?: Credential[]; branding?: Branding });
  requirements(order: GateOrder, policy: Step[]): VerificationManifestEntry[];   // Context 1
  mount(app: ExpressApp, ceremony?: MountCeremony): void;                        // Context 2
  doctor(opts?: { print?: boolean }): DoctorReport;                              // config preflight (#25)
}

// Policy builders + extensibility
age.over(n)  ·  membership.discount(n)  ·  payment.in(currency)
required(c)  ·  optional(c)  ·  .when((order) => boolean)
defineCredential({ id, request, verify, effect, appliesTo?, ui })
dcql({ docType, claims })  ·  gate()  ·  discount({ percent?, amount? })  ·  authorize()

// Stores + host-side composition seam
MemoryVerificationStore  ·  completeOrder(input, ctx)

// Bring your own host — the typed seam contract (builds completion + publishes the seams)
defineHost({ catalog, orderStore, records | completion, signingKey | allowEphemeralKey })
  → { verificationStore, publish(app), complete(input) → { completed, reason? } }

// Delegated draws (HNP, 005 preview) — the Stripe-grade facade + the underlying seams
DelegatedGate  ·  gate.preApprove(bounds) → DelegatedGrant  ·  grant.spend(purchase) → SpendResult  ·  grant.revoke()
sealIntent  ·  checkDraw  ·  signDraw  ·  MemoryRevocationStore  ·  Draw / IntentBounds / CommittedDraw / Refusal

// AP2 mandates (spec 013) — SD-JWT (RFC 9901), ES256, discriminated by `vct`.
// One issuer, one verification door, one chain check. See MIGRATING.md for 0.4.0 → 0.5.0.
credentagent.ap2 → Ap2Issuer  ·  issuer.checkout / .payment / .openCheckout / .openPayment
verifyMandate(token, { publicJwk, expect, audience, nonce })  ·  verifyChain(chain, opts)
presentWithKeyBinding({ token, holderKey, aud, nonce })  ·  encode/decodeMandateChainParam
amountFrom · toMinorUnits · toMajorUnits · formatAmount   (money is INTEGER minor units)
credentagent.mandateKey  ·  didDocument()  →  served at /.well-known/did.json

// Retained Mode-B / roadmap blocking primitive
gated()  ·  buildVerificationRequired()  ·  isVerificationRequired()  ·  envelopeInstruction()
ageDcql()  ·  ENVELOPE_VERSION  ·  ENVELOPE_SENTINEL

// Types: CredentAgentOptions, GateOrder, OrderLine, Credential, Step, Effect,
//        VerificationManifestEntry, VerificationStore, VerificationRecord,
//        TrustLevel, Presence, DcqlQuery, DcqlClaim, DcqlCredentialOption, ExpressApp,
//        CompletionSeam / SettlementSeam / CeremonyOrder (host composition)
//        DelegatedVerifier / DelegatedVerdict / DelegatedHandoff / SettlementRecordLike (delegated seam)
```

Full, compiler-checked contract: [`specs/001-attesto-sdk/`](https://github.com/openmobilehub/mcp-apps-shopping-demo/tree/main/specs/001-attesto-sdk/) (the
[quickstart](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/001-attesto-sdk/quickstart.md), [`spec.md`](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/001-attesto-sdk/spec.md),
and the [mount contract](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/003-gate-ceremony-extraction/contracts/attesto-mount.api.md)).

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).
