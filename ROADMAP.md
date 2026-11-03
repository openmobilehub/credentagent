# Roadmap

CredentAgent is **the consent layer for AI agents**: an agent proves a verifiable credential
from the user's wallet before a consequential action completes. **Identity leads; payments
is one application.** This roadmap is honest about exactly what binds cryptographically
**today** versus what's next — because a consent layer is only useful if you can trust its
claims about itself.

The release each item first shipped in is noted in brackets; the current version is on
[npm](https://www.npmjs.com/package/@openmobilehub/credentagent-gate).

## Shipping

- **Mode A — consolidated checkout.** `createStorefront()` + `new CredentAgent().mount(app)` +
  `store.gate(policy)`. The agent's tool mints one checkout link and reports a serializable
  `requires` manifest; the buyer proves everything in one browser session on the mounted
  `/credentagent/*` rails; a poll reports completion. (See [the three execution
  contexts](./docs/reference/execution-contexts.md).)
- **The policy model.** `required(...)`/`optional(...)` over `age.over(n)`,
  `membership.discount(n)`, `payment.in(cur)`, with `.when((order) => …)` conditionals;
  `defineCredential({ id, request, verify, effect, ui })` to **gate any credential** — the
  built-ins are just pre-defined credentials. `requirements()` is the code→data boundary
  (functions never cross the wire; payment always sorts last).
- **Custom credentials complete on the phone** [0.3.0]. The credential rail builds the
  wallet request from a `defineCredential` credential's own `request`/`verify`, and
  `completeOrder` enforces every applicable `gate()`. Catalog attributes are forwarded, so a
  custom gate can key on any product field.
- **The rails** `mount()` serves, with honest per-rail trust (see
  [the trust model](./docs/reference/trust-model.md)):
  - `passkey` — **real WebAuthn** (same-device + cross-device caBLE), origin/RP-ID-bound,
    nonce/replay-protected.
  - `credential` (age / membership) and `dc-payment` — **real OpenID4VP wire crypto** (JWE/
    ECDH-ES decrypt, nonce binding, HPKE, ISO-mdoc parse), `trust_level: "presence-only-demo"`.
  - `delegated` [0.3.0–0.4.0] — opt-in with `mount({ verifier })`: verification and settlement
    run through an **external** verifier/processor; the gate re-derives the binding, re-runs
    your policy, and relays the verifier's trust level verbatim.
- **Cart Mandate, end to end.** `issueCartMandate` / `verifyCartMandate` + enforcement in
  `completeOrder` (tamper-evident cart, fail-closed), Cart ↔ Payment Mandate reconciliation at
  the shared completion seam, and the opt-in **`statelessOrders`** transport [0.2.x] (the
  created order travels as the signed mandate, no shared order store). Server-HMAC signed.
- **Storage and catalog for real deployments** [0.2.x]. Redis persistence via
  `createStorefront({ storage })` (and `redisStorage.fromEnv()` [0.5.0]), a dynamic catalog
  via `createStorefront({ catalog })` with your own `CatalogSource` (e.g. over Firestore or
  any database), and
  session-scoped carts.
- **Orders, webhooks and grants** [0.3.0]. `orders.serve(app)` wires the human-present
  checkout in one call; `credentagent.webhooks` sends a real, signed HTTP `order.settled`;
  **spending grants** let an agent buy within bounds while the user is away.
- **Device-signed spending grants** [0.5.0]. `grants.create({ signing: "device" })`: the
  wallet signs the AP2 Intent Mandate first, and the gate verifies that signature — reported
  as `trust_level: "device-signed"` (the signature is real; the trust anchor is still a demo
  credential).
- **Integration ergonomics** [0.4.0]. `credentagent.doctor()` (a one-call config
  preflight), `defineHost()` (the typed "bring your own host" contract), and
  `new CredentAgent({ branding })` (brand the ceremony pages with one option).
- **Demo PKI** [0.3.0] — a trust-root + credential toolkit so test wallets show no red
  warnings. Still a demo anchor, not issuer trust.

## Next

- **Mode B — gate any page-less tool.** The `verification_required` envelope primitive ships
  today; the **page-less proving ceremony** (for hosts with no browser handoff — e.g. a CLI
  agent gating `release-record`, `approve-deploy`, `file-prescription` with **no checkout at
  all**) is the next build. This is where "gate **any** consequential action with **any**
  credential" becomes runnable beyond commerce — the heart of the identity-first promise.

## Research — the honesty line

- **Issuer-verified trust** (`trust_level: "issuer-verified"`). Today the OpenID4VP rails are
  **presence-only** — the wire crypto is real, but there is **no issuer/device-signature
  trust anchor**, so a self-crafted mdoc would pass; they must never be presented as a real
  safety control. Device-signed grants verify a real holder signature, but their anchor is
  still a demo credential. The next step is real mdoc issuer/device-signature verification
  against a trust anchor (Multipaz / `@auth0/mdl`). This is the **integration step, not new
  cryptography**, and it's the single change that turns a flow demo into a real control.
  Until then the gate never reports `"issuer-verified"` itself; only an external verifier on
  the `delegated` seam may.
- **User/agent-signed Cart Mandate** — the true AP2 user-authorization semantic (today's
  server HMAC proves *the server* issued the cart, not that *the user* authorized it). KB-JWT /
  key-bound mandate signing. (Device-signed grants already do this for the Intent Mandate.)

> We will not advertise issuer-verified trust until it's real. If a doc or type implies a
> gate is a safety control, that's a bug — open an issue.
