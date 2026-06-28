# The trust model

This is the honesty document. Attesto is **"the consent layer for AI agents"** — an
agent must prove a verifiable credential from the user's phone wallet before a
consequential action completes. That promise is only worth as much as the truth about
what the gate actually verifies today. This page states that truth precisely, per rail,
in the project's own vocabulary.

The headline:

> **The wire crypto is real. The trust anchor is not.** v0.1 enforces *disclosure* (an
> explicit positive claim) and *binding* (nonce / ephemeral key / origin), but **not
> trust** (issuer / device signatures against a real CA). A self-crafted mdoc would
> still pass. This is a flow demo, not a real safety control — never present it as one.

That sentence is not marketing copy; it is the literal trust footer shown on every
ceremony page (`src/ceremony/theme.ts`):

```
🔒 presence-only-demo · secured by Attesto · the wire crypto is real; issuer trust anchor is not
```

## Honesty lives in the types, not in prose

Attesto's constitution (Principle VII, `.specify/memory/constitution.md`) requires the
status to be carried in the type system so it cannot be quietly dropped from a slide or a
README. Two axes do that work; both are public types and both ride on every manifest
entry and every mandate.

### Axis 1 — `enforcedAt: "tool" | "checkout"`

*Where* the gate runs. From `src/types.ts`:

```ts
enforcedAt: "tool" | "checkout";
```

- **`"checkout"`** — v0.1's consolidated **Mode A**. Every gate runs on the checkout page
  (execution Context 2) and is enforced server-side on the completion path: the MCP tool
  only mints the link and reports requirements; the phone is never in the tool's loop.
  `requirements()` stamps this on every entry (`src/manifest.ts`).
- **`"tool"`** — the Mode-B *blocking* shape, where a page-less tool refuses inline and
  returns a typed `verification_required` envelope the agent drives. The primitive exists
  (`gated()`), but the consolidated v0.1 flow is `"checkout"`.

### Axis 2 — `trust_level: "presence-only-demo" | "issuer-verified"`

*How honestly* the presented mdoc is trusted. From `src/types.ts`:

```ts
/**
 * v0.1 enforces *disclosure* (explicit positive claim) and *binding* (nonce /
 * ephemeral key), but NOT *trust* (issuer / device signatures) — a self-crafted
 * mdoc would pass. … it's a flow demo, not a real safety control yet.
 */
export type TrustLevel = "presence-only-demo" | "issuer-verified";
```

Today every code path emits **`"presence-only-demo"`** — the manifest default
(`src/manifest.ts`), the envelope default (`src/envelope.ts`), and the field hard-coded
on each mandate (`src/ceremony/mandate.ts`, `dc-payment/verify.ts`,
`credential-gate/verify.ts`). **`"issuer-verified"`** is reserved for v0.2 (see below) and
is the *only* value for which the page suppresses the presence-only footer
(`src/ceremony/checkout-page.ts`).

## What "presence-only" means, precisely

Three things must be true for a gate to be a real safety control. v0.1 has the first two
and not the third:

| Property | Meaning | v0.1 |
| :-- | :-- | :-- |
| **Disclosure** | the wallet revealed the explicit positive claim (`age_over_21 === true`), not merely "a token was present" | ✅ enforced |
| **Binding** | the response is bound to *this* request and *this* origin — nonce / ephemeral decryption key / RP-ID, with replay protection | ✅ enforced |
| **Trust** | the mdoc's issuer & device COSE signatures chain to a real issuer CA, so the claim came from a genuine issuer and a genuine device | ❌ **not yet** |

Because trust is missing, **a self-crafted mdoc would parse and pass.** The decryption
proves a response was produced for our request; it does not prove *who* issued the
credential inside it. That is the whole gap, and it is the same gap on every rail.

## What is real per rail

`mount()` serves three ceremony rails. They differ in how much cryptography is real
today — but **all three carry `trust_level: "presence-only-demo"`** because none verifies
the issuer trust anchor.

### `passkey` — same-device + cross-device (caBLE)

**The most complete rail.** This is real WebAuthn end to end
(`src/ceremony/passkey/verify.ts`, via `@simplewebauthn/server`):

- The challenge is a sealed, time-limited nonce recovered from a signed token and
  validated **before** any attestation parsing.
- The assertion is verified against **this server's origin and RP-ID** with
  `requireUserVerification: true`.
- The signing secret is an injected `signingKey` seam (`mount()` requires a stable one),
  never a process global — so verification state cannot bleed across users.

What keeps it `presence-only-demo` is **not** the WebAuthn step (that is real
cryptography) — it is the **mandate** the assertion feeds. The AP2-shaped
`PasskeyMandate` is signed by a mock dev signer: a SHA-256 digest, not a key-bound
signature (`src/ceremony/mandate.ts`):

```ts
signature: {
  alg: "MOCK-DEV-SIGNER",
  value: "mock-sig:" + digest,
  note: "Mock dev signer (presence-only-demo). Production replaces with AP2-conformant key-bound signing.",
}
```

The four post-verification gates (`runGates`) are genuinely deterministic and re-derive
everything from the mandate's own fields — amount integrity re-sums the cart lines and
refuses a tampered total, user-verification and subject-binding are re-checked — but the
mandate that carries them is dev-signed, so the rail is a flow demo, not a safety control.

### `credential` — age / membership (OpenID4VP + ISO-mdoc)

Real OpenID4VP plumbing (`src/ceremony/credential-gate/verify.ts`,
`mdoc-verify.ts`). What is **real**:

- **JWE decryption** of the wallet's response with `jose` ECDH-ES `compactDecrypt`
  (Android Chrome / OpenID4VP path) and **HPKE** decryption — P-256 / HKDF-SHA256 /
  AES-128-GCM — bound to the web origin via the session transcript (iOS org-iso-mdoc
  path). A response captured for a different origin fails to open.
- **Nonce binding** — a non-empty `apu`/`apv` bound to a different nonce is refused; and
  independent of that echo, every `/request` seals a fresh ephemeral decryption key with a
  short TTL, so a captured response only decrypts under the request that produced it.
- **ISO 18013-5 mdoc parsing** — deterministic CBOR, `DeviceResponse` →
  `issuerSigned.nameSpaces` → disclosed `elementIdentifier`/`elementValue`
  (`src/ceremony/mdoc/mdoc.ts`).
- **Explicit positive claim** — `age.over(N).verify` checks `age_over_${N} === true` at
  the order's threshold; an 18+ proof never satisfies a 21+ gate, and membership requires
  a real, non-empty `membership_number`. One policy definition, reused by the instant-demo
  path and the real-wallet path.

What is **not** real: the issuer / device **COSE signatures** are not verified against a
real CA. (On the iOS org-iso-mdoc path, note the *reader* side is genuinely signed —
COSE_Sign1 reader-auth and a `@peculiar/x509` reader-cert chain with mDL reader-auth
EKUs — but that authenticates *us to the wallet*; the *reader cert is self-signed*, and
the wallet's own issuer/device signatures still go unchecked.) The trust anchor is absent,
so `trust_level` stays `presence-only-demo`.

### `dc-payment` — Digital Credentials API (amount-bound mdoc)

Same OpenID4VP/JWE/HPKE/mdoc-parse foundation as the credential rail, plus one extra real
binding that makes it the most interesting payment-side proof
(`src/ceremony/dc-payment/verify.ts`):

- The wallet's **device-signed `transaction_data_hash`** is extracted from the mdoc
  `deviceSigned` block and re-checked against `SHA-256(transaction_data)` of the
  amount/payee descriptor *we* sealed (`buildDcMandateFromPresentation` / `runDcGates`
  Gate 1). That proves the wallet authorized **this** amount and payee — not merely that a
  token decrypted.
- **Amount binding** is re-derived from the catalog-priced lines on every path: line sum =
  order total = signed amount, with the payee re-checked against this RP's origin. A
  tampered amount, an arbitrary discount, or a re-pointed payee is refused.

What is still **not** real: Gate 2 ("Authorization present") inspects the structural
presence of `issuerAuth` + `deviceAuth` blocks but does **not** verify the COSE signatures
themselves — its own detail string says so: `presence-only — COSE signatures not
verified`. Issuer trust anchor absent → `presence-only-demo`.

### Per-rail summary

| Rail (`/attesto/*`) | What it proves | Real crypto | Not yet real |
| :-- | :-- | :-- | :-- |
| `passkey` (same- + cross-device caBLE) | WebAuthn assertion against this origin/RP-ID, user-verification required, nonce/replay-bound | `@simplewebauthn` WebAuthn end to end | mandate is dev-signed (`MOCK-DEV-SIGNER`), not key-bound |
| `credential` (age / membership) | OpenID4VP presentation; explicit positive claim at the order's threshold | JWE/HPKE decrypt, ECDH-ES, nonce + origin binding, ISO-mdoc parse | issuer / device COSE signatures (no real CA) |
| `dc-payment` (Digital Credentials API) | amount-bound mdoc; wallet's device-signed `transaction_data_hash` re-checked | JWE decrypt + the `transaction_data` hash binding + amount re-derivation | issuer / device COSE signatures (no real CA) |

A useful way to read this table: the **OpenID4VP plumbing is scaffolded and the wire
crypto runs for real** — issuer-trust verification is an *integration* step, not new
cryptography that has to be invented.

## What `trust_level: "issuer-verified"` (v0.2) would add

`"issuer-verified"` is already a value of `TrustLevel`; v0.2 is what makes a path emit it
honestly. It adds exactly the missing third property — **trust** — by verifying the mdoc's
issuer and device signatures against a real anchor:

- **Issuer-signature verification** — the mdoc's `issuerAuth` (the MSO COSE_Sign1) chains
  to a genuine issuer CA, and the disclosed elements match the value digests in the MSO.
  This is what defeats a self-crafted mdoc.
- **Device-signature verification** — the `deviceAuth` / device-signed block is checked,
  binding the presentation to the credential's holder device.
- A **key-bound mandate** — the AP2 payment mandate is signed with a real key
  (AP2-conformant key-bound signing), replacing the `MOCK-DEV-SIGNER` digest.

The acknowledged integration target is a real mdoc verifier (e.g. Multipaz / `@auth0/mdl`
class libraries). When a path completes those checks, it sets
`trust_level: "issuer-verified"`, the ceremony pages suppress the presence-only footer
(`src/ceremony/checkout-page.ts`), and only then is that gate a real safety control.

## Until then — the rule

Until issuer-trust verification lands, every gate that relies on the mdoc is **fenced
behind the presence-only-demo mode** and **must not be presented as a real safety
control** — in the UI, in a demo, or in a pitch. This is a load-bearing security
invariant (constitution Security Requirements; `CLAUDE.md`), and the honesty tests assert
the `presence-only-demo` token survives on every page and every mandate. The point of this
document is that the limitation is stated plainly, in the data and in the words, rather
than buried.
