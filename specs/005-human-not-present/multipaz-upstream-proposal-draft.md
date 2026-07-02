# DRAFT — proposal to the Multipaz team (NOT SENT; for maintainer review)

**Status**: Draft written overnight 2026-07-01 from the desk-verification findings
(`docs/superpowers/research/2026-07-01-multipaz-wallet-desk-verification.md`). The maintainer decides if,
when, and in what form any of this is raised. Per the "show, don't ask" strategy, the intended moment is
**with a working demo in hand** — except Ask 1 may be worth raising earlier since it blocks polished
consent UX and benefits parties beyond us.

---

## Context (one paragraph for the Multipaz folks)

We're building an open reference for **delegated agentic authorization** on AttestoMCP
(openmobilehub, Linux Foundation): a user performs one biometric ceremony with the **published Multipaz
Wallet** that seals bounded purchase authority (an AP2-shaped Intent Mandate) via OpenID4VP
`transaction_data`; an always-on wallet service then signs per-merchant draws inside those bounds while
the human is absent; a UPay-style verifier walks the chain and settles. Everything phone-side runs on the
stock published APK + the Utopia DPC — deliberately zero Multipaz changes. Two things would make it
materially better.

## Ask 1 — Render `PaymentTransaction` payload fields on the consent sheet

Today `Consent.kt` renders transaction data as `"• ${type.displayName}"` only — for a TS12
`PaymentTransaction`, the user sees "• Payment" with **no amount, payee, or recurrence limits**, even
though those fields are in the signed payload and TS12 (EUDI SCA) exists precisely so the user sees what
they authorize (dynamic linking).

Proposal: type-aware rendering for the known type — amount + currency, payee name, and (when present) the
`recurrence`/`mit_options` limits ("up to $120/payment, $120 total, until Jul 31"). Benefits every EUDI
SCA implementer, UPay's own human-present flow, and our delegation ceremony equally. We're happy to
contribute the patch (`multipaz-compose` Consent composable + a per-type render hook on
`TransactionType`).

## Ask 2 — (Logistics, only if needed) a demo issuer path

Desk-verification shows provisioning is gated by the wallet backend's issuer list. Our current plan
avoids the question entirely (we reuse the hosted Utopia DPC issuance). If the demo ever needs its own
credential, the ask becomes: add one demo issuer to the dev backend's list, or document the supported
path for third-party issuers with the published APK.

## Explicitly NOT asked

- **No new TransactionType**: TS12's `PaymentTransaction` already expresses the bounds we need
  (`max_amount`, `total_amount`, `recurrence`, `payee`); product scope binds by hash via
  `transaction_id`. We'd rather use the standard than add a parallel type.
- **No wallet app changes**: the published APK stays the target.
- **No delegation features in Multipaz itself**: the wallet service is our component; Multipaz stays the
  presentment/credential layer.

## The later conversation (after the demo works)

Whether the **wallet-service role** (policy engine + delegated draw signing — the AP2 wallet role nobody
ships) belongs upstream as a Multipaz server component. That's the "show, don't ask" payload: arrive with
the working demo, the AP2 interop mapping (`docs/superpowers/research/2026-07-01-ap2-interop-mapping.md`),
and this repo's honesty discipline, and let them pull rather than us push.
