# Feature Specification: Signed Cart Mandate

**Feature Branch**: `feat/attesto-gate-v0.1` (continues the 001/002/003 line; no new branch until build)

**Created**: 2026-06-28

**Status**: Draft

**Input**: Replace the integrity-free order transport (the demo's unsigned base64url JSON token; the
package's store-by-id) with a signed **`ap2.CartMandate`** — completing the AP2 mandate chain
(Cart Mandate → Payment Mandate) the gate already half-speaks. Grounding:
`docs/superpowers/research/2026-06-28-cart-mandate-design.md`.

## Overview

Payment already produces an **`ap2.PaymentMandate`** (`mandate.ts:49`, `trust_level:
"presence-only-demo"`). The **cart** it pays for has no such integrity object: in the demo the order
travels as an unsigned, hand-editable base64url JSON token (`encodeOrder`/`decodeOrder`,
`checkout.ts:65,69`), and in the package it is a server-side row keyed by id (`createdOrderStore`,
resolved + re-priced by `resolveOrder`, `mount.ts:148`). The first is tamper-prone (defended only by
server-side re-derivation — Security invariant 2); the second is tamper-proof but requires shared
store state (Redis on serverless).

This feature introduces a signed **`ap2.CartMandate`** — the cart's lines, currency, derived total,
order id, issued-at, and expiry, sealed with the gate's existing stable `signingKey` (the same
primitive `challengeToken.ts` uses) — and verifies it on every rail. It is **additive and
fail-closed**: the store remains the source of truth, the catalog remains the price authority
(invariant 2 is preserved), and the mandate adds tamper-evidence + AP2 completeness.

It is **not** a re-pricing change and **not** a user-authorization claim: v0.1 signs with the
*server's* key (proves the server issued this cart), carries `trust_level: "presence-only-demo"`, and
must never be presented as "the user signed their cart" (that is the v0.2 user/agent-signed line).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A tampered cart is refused before it can be re-priced (Priority: P1)

A cart mandate whose lines or total were edited in transit is rejected with an explicit reason on
every completion path, **before** the catalog re-pricing step — a clear, fast refusal rather than a
silent reprice-mismatch.

**Why this priority**: It is the integrity guarantee the whole feature exists to add, and it is the
one most-directly testable as a bypass test.

**Independent Test**: Issue a cart mandate for a known order; flip a line quantity / total in the
signed payload; submit it to a rail's verify handler and to `completeOrder`; assert both refuse with
reason `cart-mandate` (signature/binding failure), record nothing, and that the *unmodified* mandate
for the same order still completes (so the refusal was the signature, not an unrelated failure).

**Acceptance Scenarios**:
1. **Given** a valid cart mandate for order X, **When** its `total` is decreased and re-submitted,
   **Then** verification fails (signature mismatch) and no completion is recorded.
2. **Given** a valid cart mandate for order X, **When** it is replayed against a *different* order id,
   **Then** it is refused (order-id binding).
3. **Given** an expired cart mandate, **When** submitted, **Then** it is refused (expiry), with a
   reason distinct from a tamper failure.

### User Story 2 — The cart mandate reconciles with the payment mandate (Priority: P2)

The amount the payment mandate binds equals the cart mandate's derived total, which equals the
catalog re-priced total — across passkey, dc-payment, and instant-demo paths, with and without the
membership discount.

**Why this priority**: Invariant 3 (discounts reconcile with amount binding) must continue to hold
once a second mandate enters the chain; this pins that the two mandates never disagree.

**Independent Test**: Complete a discounted order through each payment path; assert
`cartMandate.total === paymentMandate.payment.amount === repriced.total` (e.g. 124 − 10% = 111.6).

### User Story 3 — Stateless created-order transport (opt-in) (Priority: P3)

With `statelessOrders: true`, a created order travels entirely inside the signed cart mandate (no
`createdOrderStore` row), so the checkout page and rails resolve it across serverless instances
without shared store state — while completed-order and verification state stay in their stores.

**Why this priority**: It is the payoff that shrinks the Redis dependency, but it is strictly an
opt-in optimization on top of US1/US2 and must not be required for correctness.

## Requirements *(mandatory)*

- **FR-001**: The gate MUST emit an `ap2.CartMandate` for each created order, sealed with the injected
  `signingKey` (HMAC; constant-time verify; reuse the `challengeToken` primitive), carrying: order id,
  lines (id, quantity, unit/line totals, `minimumAge`), currency, derived total, `issuedAt`, `expiresAt`,
  `alg`, and `trust_level: "presence-only-demo"`.
- **FR-002**: Every rail verify handler AND the shared `completeOrder` MUST verify the cart mandate
  (signature + order-id binding + expiry) and refuse with reason `cart-mandate` on failure, recording
  nothing — **before** catalog re-pricing.
- **FR-003**: Catalog re-derivation (invariant 2) MUST remain the price authority: a *valid-signature*
  mandate whose total disagrees with the re-priced catalog total is STILL refused (defense in depth;
  signature ≠ price authority).
- **FR-004**: The cart mandate's `total` MUST reconcile with the payment mandate's bound amount and the
  re-priced total on all payment paths, with and without the membership discount (invariant 3).
- **FR-005**: The signature primitive MUST be swappable: an `alg` field admits a future ES256 /
  user-agent-signed variant additively, without changing the seam contract.
- **FR-006**: Expiry MUST be configurable with a safe default; an expired mandate is refused with a
  reason distinct from a tamper failure (so a slow buyer sees "expired," not "tampered").
- **FR-007**: `statelessOrders: true` (opt-in) MUST let `resolveOrder` reconstruct the created order
  from a verified cart mandate with no `createdOrderStore` read; default (false) keeps the store as the
  source of truth and the mandate as an additive integrity envelope.
- **FR-008**: The cart mandate MUST be honestly fenced: surfaced as server-issued integrity, never as
  user authorization, while `trust_level` is `presence-only-demo`.
- **FR-009**: The pre-existing suite MUST stay green and every new bypass test MUST fail with its
  control removed (constitution; FR-014 of 003). DCO sign-off on every commit.

### Key Entities

- **CartMandate** — `type: "ap2.CartMandate"`; `{ id, orderId, lines[], currency, total, issuedAt,
  expiresAt, alg, signature, trust_level }`. The signed sibling of the existing `ap2.PaymentMandate`.
- **CartMandate seam config** — `signingKey` (existing), `cartMandateTtl?` (new, default), and
  `statelessOrders?` (new opt-in) on the `mount()` seam contract.

## Success Criteria *(mandatory)*

- **SC-001**: A tampered cart mandate is refused on the verify handlers AND `completeOrder`, recording
  nothing; the unmodified mandate completes (US1, bypass test fails with the control removed).
- **SC-002**: `cartMandate.total === paymentMandate.payment.amount === repriced.total` on passkey,
  dc-payment, and instant-demo, discounted and full price (US2).
- **SC-003**: With `statelessOrders: true`, a created order completes across two instances with **no**
  shared `createdOrderStore` (US3).
- **SC-004**: Invariants 2 and 3 demonstrably still hold (a valid-signature wrong-price mandate is
  refused; discount reconciliation unchanged).
- **SC-005**: No surface presents the server-HMAC cart mandate as user authorization; `trust_level`
  stays `presence-only-demo`.

## Assumptions

- The existing stable `signingKey` seam is available wherever cart mandates are issued/verified
  (already required on serverless for the challenge token).
- The AP2 `CartMandate` shape can mirror the existing `PaymentMandate` structure closely enough to reuse
  the mandate module's conventions.

## Design note — reference vs. payload (FR-007)

`statelessOrders` is a deliberate **custody trade-off**, not just a storage tweak:

- **Off (default) — the client holds a *reference*.** Only the **order id** travels; the line items
  live server-side in the `createdOrderStore`. The agent/orchestrator carries an opaque handle, sees
  no cart contents, and the token stays tiny.
- **On — the client holds the *payload*.** The **whole signed cart** (product ids, quantities, sealed
  prices) travels on the wire, back and forth, and is reconstructed from the mandate on each instance.
  It is HMAC-signed so it is **tamper-evident**, but it is **not encrypted** — anything the token passes
  through (the agent, a hosted orchestrator) can *read* the cart — and a large cart means a larger token.

You buy **instance-independence** (a checkout survives serverless bouncing with no shared store) and pay
in **content-on-the-wire + token size**. Enable it only when server-side order state genuinely can't be
shared; otherwise prefer off so the agent holds a reference, never the payload — the same
"delegate a reference, not the content" stance the 005 connector design takes for the agent.

## Out of Scope (v0.2+)

- A **user/agent-signed** Cart Mandate (the true AP2 user-authorization semantic) and
  `trust_level: "issuer-verified"`.
- ES256 / third-party-verifiable cart mandates (the `alg` field reserves room; not implemented now).
- Migrating the **demo's** `encodeOrder`/`decodeOrder` token to a cart mandate (the package ships
  option (b) additively; the demo token is a separate, later step that keeps demo tests green).

## Dependencies

- Builds on 003 (the mounted rails + shared `completeOrder` + the `ap2.PaymentMandate` in
  `mandate.ts`). Should land after the 003 tail (demo-consumes-`mount()`) settles, to avoid churning
  the same files twice.
