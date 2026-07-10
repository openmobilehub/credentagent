# Vision — CredentAgent

*The consent layer for AI agents.* One paragraph, then the reasoning.

An AI agent should be able to **act for you** — buy the coffee, renew the prescription,
pass the age gate — **without holding your credentials, your card, or your password.**
CredentAgent is the layer that makes that safe: before a consequential action completes,
the agent must present a **verifiable credential** the user actually authorized — from
their phone wallet when present, or against a **bounded pre-authorization** (an Intent
Mandate) when they are asleep. The gate re-checks every claim server-side and fails
closed. **You delegate authority, not secrets.**

## The thesis: identity leads; payment is one application

The industry frames this as "agentic payments." That framing is too small and puts the
riskiest capability first. The real primitive is **consent over a verifiable claim**:
`age.over(21)`, a loyalty membership, a prescription, and `payment.in("usd")` are all just
credentials in the same policy, checked by the same gate. Payment is the loudest
application, not the foundation. Building the foundation as *identity* means the age gate,
the access grant, and the charge share one mental model, one enforcement path, and one
honesty story — instead of a bespoke SDK per vertical.

## The frontier: Human-Not-Present delegation

Present-human consent (tap your phone, approve) is solved-ish — WebAuthn and OpenID4VP
do it. The hard, valuable, unbuilt thing is **Human-Not-Present (HNP)**: the user
pre-approves **once** — "up to $30 a coffee, $100 total, at Blue Bottle" — and the agent
draws against that grant, unattended, over hours or days. Every draw is re-checked against
the sealed bounds server-side (cap, cumulative total, merchant scope, single-use, expiry,
revocation), and **age-restricted items are never delegable** — they always step up to a
live human. This is the difference between "an agent that can shop" and "an agent you can
*trust* to shop": bounded autonomy with a kill-switch, not a standing blank check.

The shape of the SDK is the shape of the promise:

```ts
const gate  = new DelegatedGate({ catalog })
const grant = await gate.preApprove({ merchant: "blue-bottle", perOrder: 30, total: 100 })
// …hours later, human asleep, agent draws against it…
const r = await grant.spend({ paymentId: "c1", item: "coffee" })
//  → { ok: true, amount: 18, remaining: 82 }   — or a typed refusal, never a throw
await grant.revoke()   // you change your mind, from your phone
```

## Structural independence — the property we are building toward

The end-state separates three roles that today's "let the agent hold your card" collapses
into one: the **issuer** of authority (the user, via their wallet), the **holder** that
draws against it (the agent), and the **verifier/redeemer** that enforces the bounds (the
gate). When those are structurally distinct, no single party can both mint and spend
authority — the property that makes delegation safe rather than a shared secret by another
name.

**Honest status:** this property *fully* lands only with the **wallet-server increment**,
when the delegate key `K_s` is minted behind the user's biometric in their wallet and the
grant is user-signed. In v0.1 the grant is **server-composed and server-signed** — a
bearer instrument the agent holds — so issuer and redeemer are not yet structurally
independent. The wire crypto is real (ES256 draws, nonce binding, atomic single-use); the
*trust anchor* is not. We label this exactly, in the types, and never oversell it.

## The trust ladder (we say which rung we're on, in the types)

Honesty is load-bearing and carried in `trust_level` / `presence`, not just prose:

| Rung | `presence` / `trust_level` | What's real | What's not yet |
| :-- | :-- | :-- | :-- |
| **v0.1** (here) | `delegated-demo` / `server-issued-demo` | ES256 draws, bounds enforced server-side, atomic single-use, revocation, fail-closed | grant is server-signed & bearer; no user/issuer signature |
| **v0.2** | `delegated` / user-signed | grant minted & signed in the user's wallet (`K_s` behind biometric) | issuer trust anchor still not verified |
| **v0.3** | `delegated` / `issuer-verified` | issuer/device trust anchor verified; per-draw proof-of-possession (bearer → holder-bound) | — |

Each rung is an **integration** step, not new cryptography. A presence-only or
server-issued gate enforces *disclosure* and *binding* — **not trust**. We never present a
demo rung as a real safety control, and no doc or type implies a rung we haven't built.

## What CredentAgent is (and isn't) as an artifact

It is a **library** (two npm workspaces): the **gate** (the security surface — policy
builders + the ceremony rails that enforce them) and a reference **storefront** (a runnable
MCP shopping server that consumes it). It is **not** a hosted service, an OAuth server, or a
payment processor — deliberately. The gate runs in the host's process; the honesty and the
enforcement live in code the integrator can read. The measure of success is that a
developer reaches a correct, safe delegated spend by copying a short snippet — and that the
snippet cannot be made to lie about how much trust it actually carries.
