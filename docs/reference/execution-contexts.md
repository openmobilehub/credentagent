# The three execution contexts

A credential is proven on the user's **phone** — never inside an MCP tool call. That
one physical fact splits an Attesto-gated flow into **three contexts that run at
different times, in different places**. Respecting the split is load-bearing:
conflating the contexts is the **documented root cause of confusion** in every earlier
draft of this design ([constitution, Principle II](../../.specify/memory/constitution.md);
[spec §0](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/001-attesto-sdk/spec.md)),
and it is forbidden by the constitution.

Read this page before wiring a gate. Every example in the Attesto docs assumes it.

```
┌─ CONTEXT 1 · the MCP tool handler (your Node server) — runs ONCE, when checkout is requested ─┐
│  TRIGGER: the user clicks the widget's "Checkout" button OR says "check out" in chat.          │
│  JOB: take the cart → price the order → return the checkout link + what the page WILL require. │
│       Then it EXITS. No phone is in the loop yet — so it runs NO ceremony.                      │
│       → attesto.requirements(order, policy)                                                     │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                         │ returns { orderId, checkoutUrl, requires }
                         ▼
┌─ CONTEXT 2 · the checkout page (browser + phone) — where the gates actually RUN ──────────────┐
│  The buyer opens the link ONCE and completes every verification + payment in one session,      │
│  on the /attesto/* routes that mount() serves. Age → (membership discount) → pay → settle.     │
│  Every gate is re-enforced server-side on every completion path (fail-closed → 403).           │
│       → attesto.mount(app)                                                                      │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─ CONTEXT 3 · completion (poll) — how the AGENT learns it finished ────────────────────────────┐
│  MCP has no server→client push, so the agent POLLS. It reports the result; it never            │
│  performs the ceremony.                                                                         │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Context 1 — the tool: mint the link, report requirements

Your `checkout` MCP tool handler runs **once**, server-side, the moment checkout is
requested — when the user clicks the widget's Checkout button or says "check out" in
chat. Its entire job is to:

1. take the cart items, build and **price the order** server-side, and
2. return the **checkout link** plus a manifest of *what the upcoming page will
   require*.

Then it exits. **There is no phone in the loop in Context 1**, so the handler does
**not** — and structurally *cannot* — run a credential ceremony. It only *reports*
requirements; it does not *perform* them. The single call that does this is:

```ts
requirements(order: GateOrder, policy: Step[]): VerificationManifestEntry[]
```

([`packages/attesto-gate/src/client.ts`](../../packages/attesto-gate/src/client.ts) `Attesto.requirements`).
You hand it the server-priced `order` and your ordered policy array; it resolves the
policy and hands back the flat `requires` manifest your tool surfaces to the agent and
the widget:

```ts
// inside your checkout MCP tool handler — Context 1
const order = priceCart(items);                 // your pricing, server-side
const requires = attesto.requirements(order, [
  required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
  optional(membership.discount(10)),
  required(payment.in("usd")),                  // amount derived from the order; settles last
]);
return {
  structuredContent: { orderId: order.id, checkoutUrl, requires },
};
```

A reported requirement is **awareness, not enforcement** — it tells the agent what the
page will ask for. Hiding a button is not a security control; the gates themselves run
and are enforced in Context 2.

## Context 2 — the page: run the gates

The agent hands the buyer the `checkoutUrl`. The buyer opens it **once** and completes
**every** verification and payment in a single browser session — age → (optional
membership discount) → pay → settle — on the `/attesto/*` routes that

```ts
mount(app: ExpressApp, ceremony?: MountCeremony): void
```

([`Attesto.mount`](../../packages/attesto-gate/src/client.ts)) wires onto your
Express-shaped host. These are **separate HTTP routes, not the Context-1 handler** —
they are where the phone enters the loop and where the actual cryptographic ceremonies
happen (WebAuthn on the passkey rail; OpenID4VP on the credential and dc-payment rails).

This is **consolidated Mode A**: one handoff, one page, all cards in one session.
Crucially, each gate is **re-enforced server-side on every completion path** — an
age-restricted order can never complete unverified even if Context 1 returned a bare
link, because the page's payment lock is render-only and a direct POST would otherwise
bypass it. Fail-closed lives here, in Context 2, independent of whatever Context 1
returned.

## Context 3 — the poll: report completion

MCP has **no server→client push**, so the agent cannot be notified when the buyer
finishes on their phone. Instead it **polls** for the order's completion and reports the
result back in chat. The agent **never performs the ceremony** — it only orchestrates
URLs and observes status. When the order completes, the flow returns to chat with the
confirmation (total, gates cleared, settlement).

## Why the split is sacred

| Context | Where it runs | When | Does it run a ceremony? | Attesto call |
| :-- | :-- | :-- | :-- | :-- |
| **1 · Tool** | your Node server | once, at checkout request | **No** — no phone in the loop | `requirements(order, policy)` |
| **2 · Page** | browser + phone | when the buyer opens the link | **Yes** — this is the only place gates run | `mount(app)` |
| **3 · Poll** | the agent | until completion | **No** — observes, reports | poll the order status |

Every earlier draft that put a credential check "in the tool" forced the user back and
forth between chat and browser, or implied the handler could verify a phone credential
it has no access to. It can't: a credential is proven on the phone, which only exists in
Context 2. Keep the three apart and the model is unambiguous — **mint in 1, prove in 2,
report in 3.**

## `requirements()` is the code → data boundary

`requirements()` is the single seam where your **policy code becomes wire data**
(constitution Principle VI). A tool result is plain JSON sent over the MCP wire to
*both* the agent and the widget, so **functions must never cross the wire**.
`requirements()` enforces that: it runs your `.when()` / `appliesTo` predicates
**server-side**, drops the gates that don't apply, sorts `payment` (the `authorize`
effect) **last**, and emits a flat, JSON-safe manifest with no closures
([`packages/attesto-gate/src/manifest.ts`](../../packages/attesto-gate/src/manifest.ts)
`resolveRequirements`).

Each entry is a `VerificationManifestEntry` — pure data:

```jsonc
{
  "credential": "age",
  "required": true,
  "effect": "gate",          // "gate" | "discount" | "authorize"
  "enforcedAt": "checkout",  // v0.1 Mode A: gates run on the page (Context 2)
  "trust_level": "presence-only-demo",
  "label": "Verify you're 21+",
  "minAge": 21,              // present on age gates
  "approveUrl": "https://shop.example/attesto/credential?order=ORD-1&cred=age"
}
```

Two honesty fields are carried in the **type**, not in prose:

- **`enforcedAt: "checkout"`** — in v0.1's consolidated Mode A every gate runs on the
  checkout page (Context 2) and is enforced there. (`"tool"` is the Mode-B blocking
  shape, which is roadmap.)
- **`trust_level: "presence-only-demo"`** — the gate enforces *disclosure* (an explicit
  positive claim) and *binding* (nonce / ephemeral key), but **not issuer/device trust**
  (no mdoc signature anchor yet). This is a flow demo, not a real safety control —
  `"issuer-verified"` is the v0.2 line.

Because `requirements()` is the boundary, the `requires[]` array your tool returns is
*exactly* what the agent and the widget receive — no live policy logic ever leaves the
server. That is what makes Context 1's output safe to serialize and Context 3's poll
sufficient to drive the agent.

---

See also: [`@openmobilehub/attesto-gate` README — "The three execution contexts"](../../packages/attesto-gate/README.md)
· [spec §0](https://github.com/openmobilehub/mcp-apps-shopping-demo/blob/main/specs/001-attesto-sdk/spec.md)
· [constitution, Principles II & III](../../.specify/memory/constitution.md).
