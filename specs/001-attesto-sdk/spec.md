# Attesto SDK — v0.1 Spec

**Status:** design, grounded in the working reference server in this repo. Every claim cites real code.
**One line:** an SDK that lets a developer gate a consequential MCP tool behind a verifiable credential
from the user's phone wallet. Identity leads; payments is one application.

> **Read this section first. Every example in this spec — and in the docs — must respect it.**

## §0 · The three execution contexts

A credential is proven on the user's **phone**, so it can never happen inside an MCP tool call. That one
fact splits the system into three contexts that run at different times, in different places. Conflating
them is what made every earlier draft confusing.

```
┌─ CONTEXT 1 · the MCP tool handler (your Node server) — runs ONCE, when checkout is requested ─┐
│  TRIGGER: the user clicks the widget's "Checkout" button  OR  says "check out" in chat.        │
│    src/app.tsx:278  callServerTool({ name: "checkout", arguments: { items } })                 │
│    server.ts        the registered `checkout` handler runs here, server-side                   │
│  JOB: take the cart items → build + price the order → return the checkout link (+ what it      │
│       will require). Then it EXITS. No phone is in the loop yet.                                │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                         │ returns { orderId, checkoutUrl, requires }
                         ▼
┌─ CONTEXT 2 · the checkout page (browser + phone) — where the gates actually run ──────────────┐
│    src/app.tsx:281  openLink({ url: checkoutUrl })  → opens /checkout?order=ID                 │
│  Separate HTTP routes, NOT the Context-1 handler — each shown as a CARD on the page:           │
│    verify age       /credential-gate/age → mdoc on the phone → /verify → back (page.ts:75)      │
│    membership card  /credential-gate/loyalty → present loyalty → 10% off; OPTIONAL, never blocks│
│    pay              /payment-gate/passkey or /dc-payment → WebAuthn / wallet-signed AP2 (caBLE) │
│    settle           completion.ts → re-price + x402→Hedera → orderStore.write                   │
│  Age is RE-ENFORCED server-side on every completion path → 403 (passkey/routes.ts:67,          │
│  dc-payment/routes.ts:58, app.ts:71). Fail-closed regardless of what Context 1 returned.       │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─ CONTEXT 3 · completion (poll) — how the agent learns it finished ────────────────────────────┐
│    src/app.tsx:286  pollOrderCompletion() → GET /checkout/order-status                         │
│  On completion the widget injects a silent chat turn (app.tsx:182) → the agent confirms.       │
│  The agent may also poll the `get-order-status` MCP tool directly (server.ts).                 │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Consequences that every design decision inherits:**

1. The **handler runs once, when checkout is requested** — not during verification or payment. Its only
   job is to mint the link and report what the upcoming page will require. (This is why an SDK call in
   the handler *reports* requirements; it does not *perform* them — there is no phone in Context 1.)
2. The **gates run in Context 2**, on the page/phone, via separate routes.
3. **Fail-closed lives in Context 2's completion paths** (the 403s), independent of Context 1. An
   age-restricted order can never complete unverified even if Context 1 returned a bare link.
4. **One handoff.** The user opens the checkout link once and does age → (loyalty) → payment in that one
   browser session; they return to chat only when Context 3 reports completion.

## §1 · The flow (consolidated checkout)

```
checkout({ items })  ──▶  Context 1: priceCart(items) → order; report requirements
              ◀──  { orderId, checkoutUrl, requires: ["age 21+", "payment"] }
agent → user: "Opening checkout — you'll verify you're 21 and pay on your phone: <checkoutUrl>"
user opens checkoutUrl  ── ONE handoff ──▶  Context 2 (one session, cards on one page):
                                            verify age → [membership discount card] → pay → settle
Context 3: poll → COMPLETED { total, gates, settlement+HashScan }  →  agent confirms in chat
```

This is the demo's actual flow. An earlier draft put age verification at the *tool* as a separate
blocking step, which forced the user back and forth between chat and browser twice — a regression.
Consolidated is the default. (The separate-blocking shape survives only for **Mode B** below.)

## §2 · Where each credential runs

| Credential | Reported in Ctx 1 | Proof ceremony (Ctx 2) | Enforced server-side |
| :-- | :-- | :-- | :-- |
| **age** (required) | ✅ in `requires` | `/credential-gate/age` — OpenID4VP/mdoc, phone *(mounted by the SDK)* | `/verify` **+ every completion path → 403** (`passkey/routes.ts:67`, `dc-payment/routes.ts:58`, `app.ts:71`) |
| **membership** (optional) | ✅ in `requires` | `/credential-gate/loyalty` — a **discount card**; present loyalty → 10% off | discount reconciled in pricing (`mandate.ts` Gate 1) |
| **payment** (required) | ✅ in `requires` | `/payment-gate/passkey` or `/dc-payment` (WebAuthn / wallet-signed AP2 over caBLE) | 4 mandate gates + settlement gates completion (`completion.ts`) |

Age is **proven once** (`/credential-gate/age/verify`) and then **re-enforced server-side on all three
completion paths** — `place-order`, `passkey`, `dc-payment` each independently re-check `isAgeUnverified`
→ 403 (`app.ts:71`, `passkey/routes.ts:67`, `dc-payment/routes.ts:58`), because the page's payment lock is
**render-only** and a direct POST would otherwise bypass it (`checkout.ts:6`). Context 1 only *surfaces*
the requirement to the agent — awareness, not enforcement. This is CLAUDE.md invariant #1: hiding a button
is not enforcement; enforce on every completion path.

**Optional credentials are displayed, not hidden.** Membership never *blocks* checkout, but it shows up as
a **discount card** among the initial verifications (Context 2) so the buyer can opt in — present loyalty →
10% off, reconciled into the order total before payment binds. So the page presents three cards in one
session: **verify age** (required) · **membership discount** (optional) · **pay** (required).

## §3 · What the SDK owns vs. what stays yours

- **The SDK (`attesto`) owns:** the per-order verification store; the `/credential-gate/*` ceremony routes
  (via `attesto.mount(app)`); computing the `requires` manifest from a policy; deriving the per-order
  approve link from `walletOrigin + order.id`.
- **You own:** your catalog / pricing (`priceCart` → order with a stable id); your checkout page; your
  payment ceremony + completion (`orderStore`). *(v0.1 — the roadmap pulls payment into the SDK.)*

## §4 · The API (fitted to Context 1)

```ts
import { Attesto, age, membership, payment, required, optional } from "@openmobilehub/attesto-gate";
import { z } from "zod";

const attesto = new Attesto({ walletOrigin: "https://shop.example" });
attesto.mount(app);   // Context 2: mounts /credential-gate/* + owns the per-order verification store

server.registerTool(
  "checkout",
  {
    description: "Check out the cart",
    inputSchema: { items: z.array(z.object({ productId: z.string(), quantity: z.number().int().positive() })) },
  },
  // Context 1 — runs once, when the user clicks Checkout (or says "check out").
  async ({ items }) => {
    const order = priceCart(items);                       // your catalog → order (stable id)
    const requires = attesto.requirements(order, [        // what Context 2 will ask for (for the agent to relay)
      required(age.over(21)),                             // required · enforced at the page + completion
      optional(membership.discount(10)),                  // optional · applied only if presented
      required(payment.in("usd")),                        // required · amount derived from the order
    ]);
    return {
      structuredContent: { orderId: order.id, checkoutUrl: yourCheckoutPage(order), requires },
      content: [{ type: "text", text: `Checkout ready — verify age 21+, optionally apply your membership discount, and pay on your phone: ${yourCheckoutPage(order)}` }],
    };
  },
);
```

Why this reads cleanly (the MCP idiom): the `inputSchema` is shown inline, so `{ items }` traces to it;
`order` comes from your `priceCart(items)`; `requires` comes from the visible `attesto.requirements(...)`
call. Nothing is injected off-screen.

**The policy** (one ordered array — the single source of truth):
- **order** = array position (top-to-bottom = run order; payment always settles last).
- **required / optional** = the explicit wrappers.
- **per-credential options** inline on typed builders — `age.over(21)`, `membership.discount(10)`,
  `payment.in("usd")`. An age gate that sets a currency is a compile error. Payment amount is **derived**
  from the order, never a field you pass (keeps amount-binding in agreement — invariant #3).

**Additional credential gates — beyond the three built-ins.** `age` / `membership` / `payment` are just
*pre-defined* credentials. Any consequential check is added the same way: define it once, drop it into the
same ordered policy. A credential is four things — what to ask, how to read it, what proving it does, how
it shows up:

```ts
import { defineCredential, dcql, gate, discount } from "@openmobilehub/attesto-gate";

const prescription = defineCredential({
  id:      "prescription",
  request: dcql({ docType: "org.hl7.prescription.1", claims: ["rx_valid"] }), // what to ask the wallet
  verify:  (c) => c.rx_valid === true,                                        // is it proven?
  effect:  gate(),                                                            // gate() | discount() | authorize()
  ui:      { label: "Prescription", action: "Verify prescription" },          // the card shown in Context 2
});

const veteran = defineCredential({
  id: "veteran",
  request: dcql({ docType: "org.example.veteran.1", claims: ["is_veteran"] }),
  verify:  (c) => c.is_veteran === true,
  effect:  discount({ percent: 10 }),
  ui:      { label: "Military discount", action: "Verify service" },
});

attesto.requirements(order, [
  required(age.over(21)),
  required(prescription),          // your custom gate — blocks until proven
  optional(veteran),               // your custom optional discount
  required(payment.in("usd")),
]);
```

- **`effect` decides what proving it *does*,** reusing the built-ins' three behaviors: `gate()` blocks
  (age, prescription, KYC) · `discount()` reduces the total (membership, veteran, coupon) · `authorize()`
  binds payment. A built-in is literally a credential with one of these effects.
- It rides the **same three contexts**: surfaced in `requires` (Ctx 1); shown as a card and proven on the
  phone via the SDK's generic `/credential-gate` ceremony (Ctx 2, mounted by `attesto.mount`); re-checked
  server-side at completion for `gate()` / `authorize()` effects.
- Passed **by object, no registration** — `required(prescription)`. Publish one as its own tiny package
  and anyone can `required(theirCredential)` it.

**v0.1 scope [clarify]:** ship the three built-ins + `defineCredential` + the generic ceremony route, with
one custom example (a prescription `gate()`) proving the extension point. Arbitrary `discount()` amounts
stay bounded by the engine's discount reconciliation (invariant #3) until generalized — see roadmap.

## §5 · Modes — v0.1 ships Consolidated only

- **Mode A — Consolidated checkout (v0.1, the only flow).** Context 1 returns the link + `requires`;
  Context 2 runs every gate in one session (one handoff). `attesto.requirements(order, policy)`.
- **Mode B — Blocking tool (roadmap, not built).** Context 1 returns a typed `verification_required`
  envelope and the tool doesn't succeed until the credential clears — for consequential tools with **no**
  page to hand off to (e.g. `transfer_funds`). Deferred to keep v0.1 simple; ships later as
  `attesto.check(order, policy) → { ok, envelope }`.

## §6 · Honesty (in the types, not prose)

Two orthogonal typed axes, surfaced (never silent):
- `enforcedAt: "tool" | "checkout"` — *where* a credential runs. v0.1: age = effectively "checkout" via
  the mounted ceremony + completion; membership/payment = "checkout". At GA they flip with no call-site change.
- `trust_level: "presence-only-demo" | "issuer-verified"` — *how much* the mdoc is trusted. v0.1 is
  presence-only (disclosure + nonce binding, **not** issuer/device signatures — `verify.ts`). The
  credential itself is real (a digital credential carrying test DL data); validating it against a real
  verifier is possible but **deliberately deferred to keep v0.1 simple**. Fenced as a demo, never sold as
  a safety control.

## §7 · Security invariants the SDK must preserve (from CLAUDE.md)

1. Enforce gates server-side on **every** completion path (not just the rendered page).
2. Never trust the order token — re-derive amounts from the catalog. (`resolveOrder`/`priceCart` re-prices.)
3. Discounts reconcile with amount binding across all payment paths.
4. Scope verification state per order id — never process-global.
5. Require explicit positive claims (`age_over_21 === true`, not token-presence; 18+ ≠ 21+).
6. Bind OpenID4VP to this origin with nonce/replay protection.

## §8 · Decisions (resolved)

- **Default flow:** ✅ **Consolidated (Mode A).** v0.1 ships Mode A only; Mode B (blocking) is roadmap (§5).
- **v0.1 method:** `attesto.requirements(order, policy)` — Mode A reports what the page will require (it
  doesn't block). The `check()` → `{ ok, envelope }` form arrives with Mode B on the roadmap.
- **Credential builders:** `age.over(21)`, `membership.discount(10)`, `payment.in("usd")`.
- **Package name:** `@openmobilehub/attesto-gate`.
- **Wallet interaction:** **sequential / progressive disclosure** (age, then payment, on the page) — may
  use multiple wallets. Not combined into a single OpenID4VP request.
- **Builders naming:** `required` / `optional` (keep `requireCredential` / `optionalCredential` as
  deprecated aliases).
- **mdoc trust:** real-verifier integration **deliberately deferred** to keep v0.1 simple (see §6).
- **Additional credential gates:** ✅ supported via `defineCredential` — custom credentials drop into the
  same ordered `required` / `optional` policy with a `gate()` / `discount()` / `authorize()` effect (§4).
  v0.1 ships the three built-ins + the extension point + one worked example; arbitrary `discount()`
  generalization is roadmap.
- **Storefront testing:** v0.1 uses the storefront as the integration **harness** (the gate is proven by
  running it in the real checkout); the storefront gets its own `specs/002-attesto-storefront` later.