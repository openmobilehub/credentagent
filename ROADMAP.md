# Roadmap

Attesto is **the consent layer for AI agents**: an agent proves a verifiable credential
from the user's wallet before a consequential action completes. **Identity leads; payments
is one application.** This roadmap is honest about exactly what binds cryptographically
**today** versus what's next — because a consent layer is only useful if you can trust its
claims about itself.

## Shipping (v0.1)

- **Mode A — consolidated checkout.** `createStorefront()` + `new Attesto().mount(app)` +
  `store.gate(policy)`. The agent's tool mints one checkout link and reports a serializable
  `requires` manifest; the buyer proves everything in one browser session on the mounted
  `/attesto/*` rails; a poll reports completion. (See [the three execution
  contexts](./docs/reference/execution-contexts.md).)
- **The policy model.** `required(...)`/`optional(...)` over `age.over(n)`,
  `membership.discount(n)`, `payment.in(cur)`, with `.when((order) => …)` conditionals;
  `defineCredential({ id, request, verify, effect, ui })` to **gate any credential** — the
  built-ins are just pre-defined credentials. `requirements()` is the code→data boundary
  (functions never cross the wire; payment always sorts last).
- **The rails** `mount()` serves, with honest per-rail trust (see
  [the trust model](./docs/reference/trust-model.md)):
  - `passkey` — **real WebAuthn** (same-device + cross-device caBLE), origin/RP-ID-bound,
    nonce/replay-protected.
  - `credential` (age / membership) and `dc-payment` — **real OpenID4VP wire crypto** (JWE/
    ECDH-ES decrypt, nonce binding, HPKE, ISO-mdoc parse), `trust_level: "presence-only-demo"`.
- **Signed Cart Mandate (core).** `issueCartMandate` / `verifyCartMandate` + enforcement in
  `completeOrder` (tamper-evident cart, fail-closed). Server-HMAC for now.

## Next

- **Mode B — gate any page-less tool.** The `verification_required` envelope primitive ships
  today; the **page-less proving ceremony** (for hosts with no browser handoff — e.g. a CLI
  agent gating `release-record`, `approve-deploy`, `file-prescription` with **no checkout at
  all**) is the next build. This is where "gate **any** consequential action with **any**
  credential" becomes runnable beyond commerce — the heart of the identity-first promise.
- **Cart Mandate, end to end.** Issuance at checkout, `PaymentMandate` reconciliation by id,
  and the opt-in **stateless-orders** transport (the cart travels as the signed mandate, no
  shared order store).
- **More built-in credentials** completable on the phone (the ceremony completes age /
  membership today; a custom credential resolves into the manifest but its bespoke
  request/verify isn't run by the phone ceremony yet).

## Research / v0.2 — the honesty line

- **Issuer-verified trust** (`trust_level: "issuer-verified"`). Today the OpenID4VP rails are
  **presence-only** — the wire crypto is real, but there is **no issuer/device-signature
  trust anchor**, so a self-crafted mdoc would pass; they must never be presented as a real
  safety control. The v0.2 step is real mdoc issuer/device-signature verification against a
  trust anchor (Multipaz / `@auth0/mdl`). This is the **integration step, not new
  cryptography**, and it's the single change that turns a flow demo into a real control.
- **User/agent-signed Cart Mandate** — the true AP2 user-authorization semantic (the v0.1
  HMAC proves *the server* issued the cart, not that *the user* authorized it). KB-JWT /
  key-bound mandate signing.

> We will not advertise issuer-verified trust until it's real. If a doc or type implies a
> gate is a safety control, that's a bug — open an issue.
