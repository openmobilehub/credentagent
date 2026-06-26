# @openmobilehub/attesto-gate

**The consent layer for AI agents.** An AI agent must prove a verifiable credential
from the user's phone wallet before a consequential MCP tool completes. **Identity
leads; payments is one application.**

> **Design preview / v0.1.** This package is real and tested, but the broader Attesto
> SDK is still being extracted from the reference server
> ([mcp-apps-shopping-demo](https://github.com/openmobilehub/mcp-apps-shopping-demo)).
> See the repo's `ROADMAP.md` for what's shipping vs. next.

## The idea

A gated tool tells the agent exactly what the buyer must prove instead of dead-erroring.
Configure once, then resolve a credential **policy** to a serializable `requires` manifest:

```ts
import { Attesto, age, membership, payment, required, optional } from "@openmobilehub/attesto-gate";

const attesto = new Attesto({ walletOrigin: "https://shop.example" });
attesto.mount(app);   // wallet-ceremony seam + per-order verification store

// In your checkout tool handler — resolve the policy against the server-priced order:
const requires = attesto.requirements(order, [
  required(age.over(21).when(hasAlcohol)),   // 21+ — only when the cart has alcohol
  optional(membership.discount(10)),          // 10% off if a loyalty credential is presented
  required(payment.in("usd")),                // amount derived from the order; settles last
]);
return { structuredContent: { orderId: order.id, checkoutUrl, requires }, content: [/* … */] };
```

`requirements()` is the **code→data boundary**: it runs your `.when()` predicates server-side
and emits a flat, JSON-safe manifest (no functions cross the wire). The checkout tool mints the
link and surfaces `requires` (consolidated **Mode A**); the page runs the gates and the
completion path enforces.

> **A refused tool call is a protocol, not a wall.** For a page-less tool, `gated()` returns a
> typed **`verification_required`** envelope the agent *drives* (which credential, a per-order
> approve link, the tool to poll) instead of completing — the blocking **Mode B** variant.

## What's real in v0.1

- `Attesto` + `requirements()` — the configure-once client and the policy→manifest resolver.
- Typed builders `age.over(n)` / `membership.discount(n)` / `payment.in(cur)` with `.when()`,
  composed with `required()` / `optional()`.
- `defineCredential()` + `dcql()` + `gate()` / `discount()` / `authorize()` — gate ANY credential.
- `gated()` + `buildVerificationRequired()` / `isVerificationRequired()` / `ageDcql()` — the
  Mode-B blocking envelope (page-less tools), retained.

## Honest status

The reference verifier enforces **disclosure** (an explicit positive claim, not
token-presence) and **binding** (nonce / ephemeral key), but **not trust** (issuer /
device signatures) — a self-crafted mdoc would pass. The envelope says so
(`trust_level: "presence-only-demo"`). This is a flow demo, not a safety control,
until mdoc trust verification lands (Multipaz / `@auth0/mdl`). See the roadmap.

`attesto.mount(app)` wires the per-order verification store seam today; the reference
server still owns the full OpenID4VP ceremony routes, and folding them behind `mount()`
is on the roadmap.

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).
