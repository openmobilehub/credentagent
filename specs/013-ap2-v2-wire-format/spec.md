# Feature Specification: Real AP2 mandates (SD-JWT wire format)

**Feature branch:** `013-ap2-v2-wire-format` · **Issues:** #39 (primary), #11, #114 · **Date:** 2026-09-01
**Supersedes the mandate model assumed by:** #12, #13, #92, spec 004, spec 009
**Depends on nothing.** Deliberately does NOT depend on #142 (see "Key binding", below).

> **On the name.** "AP2 v2" is *our* shorthand, inherited from #39, for "the current AP2
> mandate model, not the one we built against in 2026". AP2 itself does not use a v2 label —
> it versions each mandate type in its `vct` claim (`mandate.payment.1`). The branch keeps
> the #39 name so the two are searchable together; the spec uses AP2's own vocabulary.

---

## In plain terms

Today CredentAgent emits three records that *look* like AP2 but are not AP2. Each one is
signed with a homemade scheme, and one of them is not really signed at all — it is a
SHA-256 digest with a note attached saying it is a mock.

This feature replaces all three with the real thing: mandates in the actual AP2 wire
format, serialized as SD-JWTs, signed with a real ES256 key, verified through one code
path.

**What changes for a developer using the library:** the mandate objects they receive
change shape and field names. That is a breaking change, shipped in 0.5.0.

**What does NOT change:** who is allowed to buy what. Every existing security check — the
server re-prices the cart, the amount is bound to the signature, a grant cannot exceed its
budget — keeps working exactly as before. This feature changes the *format* of the
evidence, not the *rules*.

**What this feature does not claim.** A correct wire format is not a trust anchor. After
this ships, a mandate proves "this server issued this record" (and, on the grant path,
"this phone signed it"). It still does not prove the credential behind it came from a real
issuer. That gap is #14 and stays open.

---

## What we found (and why the older issues are out of date)

Several open issues describe an AP2 mandate chain of **Intent → Cart → Payment**. That
model is from AP2 v1. The protocol has moved. Verified against
[`google-agentic-commerce/AP2`](https://github.com/google-agentic-commerce/AP2) at `main`,
2026-09-01:

**1. `IntentMandate` and `CartMandate` no longer exist.** There are four mandate types,
discriminated by the SD-JWT `vct` claim:

| `vct` | Name | What it says |
| --- | --- | --- |
| `mandate.checkout.1` | Checkout Mandate | "I authorize *this specific* checkout" |
| `mandate.payment.1` | Payment Mandate | "I authorize *this specific* payment" |
| `mandate.checkout.open.1` | Open Checkout Mandate | "I authorize *future* checkouts within these constraints" |
| `mandate.payment.open.1` | Open Payment Mandate | "I authorize *future* payments within these constraints" |

The `.1` suffix is the version. The "open" pair is the human-not-present case — which is
exactly our spending grants.

**2. It is a delegation chain, not a bundle.** Mandates are SD-JWTs joined into a
`~~`-separated chain, where each delegation hop is a KB-SD-JWT signed by that hop's holder
key. The Python SDK's surface is `create(payloads, issuer_key)` → `present(holder_key,
token, ...)` → `verify(token, key_or_provider)`. Our current code assembles three
independent objects and reconciles them pairwise; that is not the same thing.

**3. Money is integer minor units.** `{ "amount": 27999, "currency": "USD" }` is $279.99.
Our code carries `total: number` in major units as a float. This is a required conversion
— and an improvement, since float money is a defect source.

**4. Key binding (`cnf`) is REQUIRED on both open mandates.** RFC 7800 §3.1. It is *not*
required on `mandate.checkout.1` / `mandate.payment.1`. This asymmetry is what lets us ship
the wire format without first resolving #142 — see below.

**5. The cart is a UCP object.** `mandate.checkout.1` does not contain line items. It
contains `checkout_jwt` — a merchant-signed JWT wrapping a UCP Checkout object (`id`,
`line_items`, `status`, `currency`, `totals`, `links`) — plus `checkout_hash` over it.

---

## Scope

### In scope

- A new `packages/credentagent-gate/src/ap2/` module: the only place the wire format lives.
- Replacing all three current mandate schemes with AP2 mandates (clean replacement, 0.5.0).
- Real ES256 issuer signatures, replacing `MOCK-DEV-SIGNER` and the server `HS256` HMAC.
- Money as integer minor units across the mandate surface.
- Separating the `presence` and `trust_level` axes (#11).
- Returning a real mandate chain from `grant.spend()` (#114).
- Bypass tests for every security control the migration touches.

### Out of scope

- **User/agent key signing on the presence path** (#13's `alg` swap, gated by #142). The
  presence path ships server-signed; that is conformant.
- **Cross-SDK conformance CI against the Python SDK** (#40). Until that lands we say
  "AP2-shaped", never "AP2-conformant".
- **Issuer trust anchor** (#14). Unchanged.
- iOS/mdoc intent signing (#149), OpenID4VP `transaction_data` (#145), external verifier
  relay (#150). Each is a separate rail change.
- The UCP merchant-signed `checkout_jwt`. v1 of this feature signs the Checkout with the
  same gate key that issues the mandate, since the gate *is* the merchant surface here. A
  distinct merchant key is a follow-up.

---

## The mapping

| Today | File | After |
| --- | --- | --- |
| `ap2.PaymentMandate` `0.1-mock`, `MOCK-DEV-SIGNER` | `ceremony/mandate.ts` | `mandate.payment.1` — SD-JWT, ES256 |
| `ap2.CartMandate`, `alg: "HS256"` server HMAC | `ceremony/cartMandate.ts` | `mandate.checkout.1` wrapping a UCP Checkout — SD-JWT, ES256 |
| `credentagent.IntentBounds/v0` | `ceremony/mandate.ts` | `mandate.checkout.open.1` + `mandate.payment.open.1` |

The grant model maps onto AP2 constraints almost exactly:

| Our grant field | AP2 constraint |
| --- | --- |
| per-spend cap | `payment.amount_range` (`max`, optional `min`) |
| total budget | `payment.budget` (`max`) |
| allowed store / payee | `payment.allowed_payees`, `checkout.allowed_merchants` |
| product allowlist | `checkout.line_items` |
| validity window | `exp` |
| binds the payment to its checkout | `payment.reference` → `conditional_transaction_id` |

Three currently-open feature requests fall out of adopting this vocabulary rather than
being built by hand: #156 (a *list* of allowed stores → `allowed_merchants` is already an
array), #159 (grants never expire → `exp`), and part of #158 (`amount_range`). They are not
claimed as done by this feature, but implementers should not build parallel mechanisms.

---

## Architecture

```
packages/credentagent-gate/src/ap2/
  types.ts     the four mandate payloads + the shared types (Amount, Merchant, Checkout)
  money.ts     Money ↔ minor units. One conversion, one place.
  keys.ts      resolves the signing key. The seam #142 plugs into later.
  issue.ts     mint a root SD-JWT; append a KB-SD-JWT delegation hop
  verify.ts    THE verification door — one function, one refusal vocabulary
  chain.ts     assemble and check a `~~` delegation chain end to end
```

Mirrors the existing rail split (`request` / `verify` / `types`) so it reads like the rest
of the codebase. It is a directory inside the gate rather than a new package: the mandate
chain is the gate's security surface, not a general-purpose library, and a third published
workspace would cost a version line, a README, and a publish lane for no caller benefit. It
can be extracted later if #40 makes isolation worthwhile.

### Money

`money.ts` owns the only float↔integer conversion in the system. Everything inside `ap2/`
is integer minor units. The public `Money` type (spec 009) keeps its opaque API; it gains a
`.toMinorUnits()`. There is no rounding policy to get wrong, because there is no rounding: the
minor-unit integer is the canonical value. Prices enter as integers from the catalog and
are only ever formatted to a decimal string for display. A repriced cart and a signed
mandate therefore compare as integers, and cannot disagree by a cent.

### Key binding — the two paths differ, honestly

This is the part that makes the feature shippable without #142.

**Presence path** (`mandate.checkout.1` + `mandate.payment.1`). `cnf` is not required. The
gate signs with its own ES256 key, published at `did:web:<origin>`. The WebAuthn assertion
and the mdoc presentation stop being "the signature" and become **evidence carried inside
the mandate**. This is conformant, and it is honest: the record says the server issued it,
because the server did.

**Grant path** (`mandate.checkout.open.1` + `mandate.payment.open.1`). `cnf` is required.
We already have the key: #144 shipped device-signed grants, where the Multipaz wallet signs
the Intent Bounds. That wallet public key becomes the `cnf`, and the wallet's signature
becomes the KB-JWT of the delegation hop. The grant path therefore reaches a *stronger*
conformance than the presence path — correctly, because the user really did sign it.

A grant created without a device signature cannot produce a conformant open mandate. It
must be refused, not downgraded silently.

### Rail-by-rail impact

- **passkey** — assertion moves into the mandate as evidence. `runGates` unchanged.
- **dc-payment** — the mdoc presentation moves into the mandate as `risk_data`, and the
  rail's own record is renamed `DcPresentation` (it declared `type: "ap2.PaymentMandate"`
  while being neither AP2-shaped nor signed). Its four gates — including #146's
  hash-algorithm agility and the payee-origin re-check — are UNCHANGED: they are the rail's
  enforcement, not a wire format.
- **intent-sign** — **the one real risk.** `boundsHash` is what the wallet signs. If the
  canonical bytes change from `IntentBounds/v0` to the open-mandate payload, the nonce
  changes. The migration must keep the device signature bound to the same authorized
  content, and a bypass test must fail if that binding is broken.
- **grants** — `grant.spend()` returns the real chain (#114).
- **completeOrder** — the three pairwise reconciliations collapse into one
  `chain.verify()`. `reconciliation.ts` shrinks to the re-pricing check it should always
  have been.

---

## Honesty (#11)

`trust_level` does not improve just because the format got real. What improves is that the
two questions stop being conflated:

- **`presence`** — when did the human consent? `"live" | "delegated-demo" | "delegated"`
- **`trust_level`** — how strongly is the authorization bound?

After this feature:

| Path | `presence` | `trust_level` |
| --- | --- | --- |
| passkey / dc-payment | `live` | `server-issued-demo` (was `presence-only-demo`) |
| grant, device-signed (#144) | `delegated` | `device-signed` (unchanged) |
| grant, click-approved | `delegated-demo` | `server-issued-demo` |

`server-issued-demo` is the value #11 already defines. It is still `-demo` because there is
no issuer anchor (#14). Docs, README, and the demo copy must not say "AP2-conformant"
before #40 lands — "AP2-shaped, verified against our own suite" is the honest phrasing.

---

## Security invariants and their tests

Per `CLAUDE.md`: a test that would still pass with its control removed is not a test. Each
bullet below names the control and the test that must fail when it is deleted.

1. **Re-derivation still decides the price** (invariant 2). A mandate is a fast pre-check,
   never the price authority. *Test:* hand-craft a valid, correctly-signed mandate whose
   `payment_amount` is lower than the catalog re-price; assert refusal.
2. **Amount binding survives the unit change** (invariant 3). *Test:* a discounted cart
   whose minor-unit total differs from the mandate's by 1 cent is refused on every path —
   passkey, dc-payment, grant spend.
3. **Chain binding.** A Payment Mandate whose `payment.reference` /
   `conditional_transaction_id` points at a different checkout is refused. *Test:* swap a
   valid payment mandate onto another order's checkout mandate.
4. **Device binding on grants.** An open mandate whose `cnf` does not match the key that
   signed the KB-JWT is refused. *Test:* re-sign with a second key; assert refusal.
5. **No silent downgrade.** A grant with no device signature cannot mint an open mandate.
   *Test:* assert a typed refusal, not a server-signed fallback.
6. **Per-order scoping holds** (invariant 4). Unchanged, but re-asserted after the store
   keys move.
7. **Expiry and replay.** `exp` is enforced; a replayed chain is refused by the nonce guard
   already in `intent-sign/verify.ts`.

---

## Breaking changes (0.5.0)

Public exports that change shape:

- `CartMandate`, `CartMandateLine`, `issueCartMandate`, `verifyCartMandate`,
  `decodeCartMandateParam`, `IssueCartMandateArgs`
- `IntentBounds`, `canonicalIntentBounds`, `boundsHash`
- `PasskeyMandate` and everything reachable from `res.mandateBundle`

There is no `MIGRATING.md` in the repo today; the 0.4.0 `DelegatedVerifier` split was
documented in #161 alone. This feature **creates** `MIGRATING.md` at the repo root with a
before/after for every renamed field, and backfills the 0.4.0 entry so the file starts
honest. That is part of this feature, not a follow-up.

---

## Issue disposition

Closed by this feature: **#11** (the two axes are implemented and threaded), **#114** (the
bundle is real and returned). Also **#144** (already merged in #148; open only as
bookkeeping).

**#39 closes only in part.** Three of the four mandate types are emitted and verified in the
real AP2 wire format on every path; the fourth — the wallet signing `mandate.checkout.open.1`
directly, replacing `IntentBounds/v0` on the intent-sign rail — is deferred for the reason
above. Retitle #39 to that remaining leg rather than closing it.

Advanced but NOT closed:

- **#13** — the end-to-end issuance wiring is done here; the `alg` swap to user-key signing
  on the presence path is not. Retitle to just the remaining half.
- **#12**, **#16** — epics; reassess when their children close.

Untouched: **#142** (still needed for #13), **#40**, **#149**, **#145**, **#150**, **#14**.

Should be retitled or closed as obsolete, since they describe the v1 model this feature
replaces: **#92** (its DX spine survives; its mandate names do not), and the mandate
sections of spec 004 and spec 009.

---

## Decisions (were open questions)

**1. Where the gate's ES256 key comes from — both, with a loud warning.**
`new CredentAgent({ signingKey })` accepts a host-supplied JWK. When absent, the gate
generates an ephemeral P-256 key at construction so a zero-config install still runs, and
`doctor.ts` emits an `error`-level finding saying that mandates will not verify after a
restart and that no external party can check them. Matches the existing zero-config-default
principle without letting an ephemeral key pass silently into production.

**2. `did:web` is published — `mount()` serves `/.well-known/did.json`.**
Without it the signature is unverifiable by anyone but us, which would make "real
signatures" a hollow claim. The document carries one verification method (the gate's public
JWK) with the id `did:web:<host>#gate-signing-key`, which is also the mandates' `kid`.
Served from `mount()` alongside the ceremony rails; no new configuration.

**3. SD-JWT library — `@sd-jwt/core`.**
OpenWallet Foundation, Apache-2.0, an RFC 9901 implementation, same foundation as this
repo. `jose` (already a dependency) stays the JWS/ES256 layer underneath. Hand-rolling
RFC 9901 disclosure handling was the alternative and is not worth the defect surface.

## Sources

Verified 2026-09-01 against `google-agentic-commerce/AP2` at `main`:

- `code/sdk/schemas/ap2/{payment,open_payment,checkout,open_checkout}_mandate.json`
- `code/sdk/schemas/ap2/types/amount.json`
- `code/sdk/schemas/ucp/types/checkout.json`
- `code/sdk/python/ap2/sdk/mandate.py` (chain serialization, `~~` join, KB-SD-JWT hops)
