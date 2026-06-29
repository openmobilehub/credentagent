# Attesto

**The consent layer for AI agents.** Before an AI agent completes a consequential
action — a payment, an age gate, an access grant — Attesto makes it prove a
**verifiable credential from the user's phone wallet**. **Identity leads; payments is
one application** — `age.over(21)`, a loyalty membership, a prescription, and
`payment.in("usd")` are all just credentials in the same policy.

> **Design preview / v0.1.** These packages are real, tested, and `npm`-installable,
> extracted from the working reference server
> ([mcp-apps-shopping-demo](https://github.com/openmobilehub/mcp-apps-shopping-demo)).
> Read the [honest status](#honest-status) below before treating any gate as a safety control.

## What it is

Agents are gaining the ability to *act* — to check out a cart, unlock age-restricted
content, grant access. Attesto puts a **human-in-the-loop credential check** in front
of that action: the agent mints a link, the user proves a credential from their wallet
(WebAuthn passkey, or an OpenID4VP / W3C Digital Credentials presentation), and only
then does the action complete. The check is **enforced server-side on the completion
path** — hiding a button is not enforcement.

Attesto is two npm packages plus a reference demo. The **Gate** is host-agnostic — it
mounts on any Express-shaped app. The **Storefront** is one ready-made host that shows
the Gate in a full agentic-commerce flow; you can bring your own host instead.

## The two packages

| Package | One line | Install |
| :-- | :-- | :-- |
| [`@openmobilehub/attesto-gate`](./packages/attesto-gate) | The Gate — `new Attesto()` + `attesto.mount(app)` wires the wallet-ceremony rails and resolves a typed credential policy into a serializable `requires` manifest. | `npm install @openmobilehub/attesto-gate` |
| [`@openmobilehub/attesto-storefront`](./packages/attesto-storefront) | The Storefront — `createStorefront()` stands up a runnable MCP shopping server (catalog-injected, nine tools, a widget) that the Gate mounts onto. | `npm install @openmobilehub/attesto-storefront @openmobilehub/attesto-gate` |

Both are Apache-2.0, ESM, ship their own types, and target Node ≥ 20. The Gate stands
alone on any Express host; the Storefront is the reference host that demos the whole
flow.

## Quickstart

A credential-gated agentic storefront in ≤ 10 lines. `createStorefront()` publishes the
ceremony seams; `new Attesto().mount(store.app)` wires the real `/attesto/*` rails;
`store.gate()` resolves your policy on every `checkout` call (payment settles **last**):

```ts
import { createStorefront } from "@openmobilehub/attesto-storefront/server";
import { Attesto, age, membership, payment, required, optional } from "@openmobilehub/attesto-gate";

const store = createStorefront();                  // the storefront — one line
const attesto = new Attesto();                     // zero-config (defaults to http://localhost:3000)
attesto.mount(store.app);                          // wires the real /attesto/* ceremony rails

store.gate((order) =>                              // resolved on every checkout
  attesto.requirements(order, [
    required(age.over(21).when((order) => order.lines.some((l) => l.minimumAge != null))),
    optional(membership.discount(10)),              // 10% off if a loyalty credential is presented
    required(payment.in("usd")),                    // amount derived from the order; settles last
  ]),
);

const { url } = await store.listen(3005);          // → add http://localhost:3005/mcp to Claude / ChatGPT / Goose
```

Add the whiskey (21+) to the cart and check out → the tool returns the checkout link
**plus** a `requires` manifest → the buyer proves age (and optionally membership),
authorizes payment, and the widget shows the confirmation. Add the headphones instead
and the age gate drops — the `.when()` predicate receives the **order** and is false.

For a deployment, pass your public origin: `new Attesto({ walletOrigin: "https://shop.example" })`.

## Documentation

- **Reference** ([`docs/reference/`](./docs/reference/)):
  - [API reference](./docs/reference/api.md) — every public export of both packages
    (`Attesto`, `requirements`, `mount`, the credential builders, `defineCredential` /
    `dcql`, `createStorefront`).
  - [Getting started](./docs/reference/getting-started.md) — install + the ~10-line quickstart.
  - [The three execution contexts](./docs/reference/execution-contexts.md) — tool mints → page runs → poll reports.
  - [Trust model](./docs/reference/trust-model.md) — what binds cryptographically per rail, honestly.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the ceremony rails, the `mount()` injected-seam
  contract, the code→data boundary, and how the two packages compose.
- **[SECURITY-INVARIANTS.md](./SECURITY-INVARIANTS.md)** — the six load-bearing rules
  (enforce server-side on every completion path, never trust the order token, scope
  state per order/session, require explicit positive credential claims, keep
  WebAuthn / OpenID4VP origin-bound with replay protection).
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — DCO sign-off (`git commit -s`), the
  security-bypass testing bar, and the module conventions.
- **[docs/deployment.md](./docs/deployment.md)** — running it for real (serverless stores,
  the stable signing key, the settle seam) + a troubleshooting table.
- **[ROADMAP.md](./ROADMAP.md)** — what binds cryptographically today (Mode A) vs. what's
  next (Mode B page-less gating, issuer-verified trust).

## Honest status

Honesty is core to Attesto — it's infrastructure meant to be trusted, so we name what
binds cryptographically and what doesn't.

**`trust_level: "presence-only-demo"`.** The *wire* cryptography is real — WebAuthn on
the passkey rail (verified against this server's origin / RP-ID, user-verification
required, nonce/replay-bound), OpenID4VP JWE / ECDH-ES decrypt with nonce binding,
HPKE, ISO-mdoc parse. But there is **no issuer / device-signature trust anchor yet**:
the gate enforces **disclosure** (an explicit positive claim such as
`age_over_21 === true`, never mere token-presence) and **binding** (nonce / ephemeral
key), but **not trust**. A self-crafted mdoc would pass. The AP2-shaped mandate is
dev-signed (integrity hash), not key-signed.

> **This is a flow demo, not a real safety control — never present it as one.**
> Issuer-verified cryptographic mdoc trust (issuer MSO + device signatures, via
> Multipaz / `@auth0/mdl`, `trust_level: "issuer-verified"`) is the v0.2+ line.

The honesty is carried in the **types**, not just prose: `trust_level` and `enforcedAt`
are part of the contract. See [SECURITY-INVARIANTS.md](./SECURITY-INVARIANTS.md) and the
Gate's [honest status](./packages/attesto-gate/README.md#honest-status) for the
per-rail breakdown.

## Reference demo

The reference server these packages were extracted from — the agentic shopping app that
runs on every surface (Claude native app, claude.ai, Claude Desktop, ChatGPT, Goose,
the Claude Code terminal) — lives in its own repo:

**[openmobilehub/mcp-apps-shopping-demo](https://github.com/openmobilehub/mcp-apps-shopping-demo)**

It demonstrates the full browse → cart → credential gate → checkout → settlement flow,
including the passkey (same-device + cross-device caBLE) and Digital-Credentials payment
rails and an x402 → Hedera on-chain settlement lab.

## License & project

Apache-2.0. See [LICENSE](./LICENSE).

Attesto is an **[Open Mobile Hub](https://openmobilehub.org)** project (a Linux
Foundation / OpenWallet Foundation effort), built in collaboration with the **Multipaz**
team, and heading to the **Global Digital Collaboration (GDC)** event.
