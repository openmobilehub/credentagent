# Feature Specification: Gate Ceremony Extraction (attesto.mount)

**Feature Branch**: `feat/attesto-gate-v0.1` (brownfield — continues the 001/002 line; no new branch)

**Created**: 2026-06-27

**Status**: Draft

**Input**: Extract the demo's real `payment-gate/` ceremony into `@openmobilehub/attesto-gate`'s
`attesto.mount(app)`, so age + membership + payment run **through the gate** (not faked in the storefront).
The "real library, very honest" release for GDC (Sept 1–2). Mirrors how 002 extracted the storefront.
Grounding: `docs/superpowers/research/2026-06-27-003-ceremony-extraction-scope.md`.

## Overview

Today the credential/payment **ceremony** — the page where a buyer actually proves age, proves membership,
and authorizes payment — lives only in the demo (`payment-gate/`). The published gate package
(`@openmobilehub/attesto-gate`) declares *what* an order requires (`attesto.requirements(...)`) and exposes a
`mount(app)` **seam**, but that seam is empty: the real ceremony it is meant to add does not ship in the package.
So an adopter who runs the quickstart gets a storefront that *describes* requirements but has no real page to
satisfy them.

This feature **extracts the existing, working ceremony into `attesto.mount(app)`** — all three rails — so the
quickstart pattern becomes true end-to-end:

```
const store = createStorefront();
const attesto = new Attesto();
attesto.mount(store.app);          // ← this feature: adds the real ceremony routes
store.gate((o) => attesto.requirements(o, [
  required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
  optional(membership.discount(10)),
  required(payment.in("usd")),
]));
```

It is an **extraction, not new behavior**: the protocol flows already exist and work in the demo. The trust
level is unchanged — real protocol flows (WebAuthn attestation, OpenID4VP, nonce/replay, origin/RP-ID binding),
**presence-only trust fenced as demo** (the AP2 mandate is dev-signed, not key-bound; no issuer/device-signature
trust verification yet). That fencing is honest and must never be presented as a real safety control.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Age + membership run through the gate (Priority: P1)

The GDC hero. A shopper asks an agent to buy an age-restricted item; the agent hands off to a checkout page
served by `attesto.mount()`; the order **cannot complete until age is proven through the gate**, and a member
who proves membership **sees the discount applied** to the order total. The enforcement and the discount live in
`@openmobilehub/attesto-gate` (the credential-gate / OpenID4VP rail), not in the storefront.

**Why this priority**: This is the demo that makes "gate any consequential action with any credential" *real*
instead of a slide, and it is the maintainer's stated top priority. Age (a blocking gate) and membership (a
discount effect) are the two flagship credential behaviors.

**Independent Test**: With `createStorefront()` + `attesto.mount(app)` + a policy of
`required(age.over(21))` + `optional(membership.discount(10))`: POST an age-restricted order to every completion
path with no age proof and assert it is refused; prove age through the gate and assert it completes; prove
membership and assert the order total, line sum, and any payment amount all reconcile to the discounted figure.

**Acceptance Scenarios**:

1. **Given** an age-restricted order and no age proof, **When** completion is attempted on any path (the gate
   verify handler, `place-order`, and the MCP `checkout`/completion tool), **Then** it is refused with a clear
   reason and nothing is recorded or settled.
2. **Given** an age-restricted order, **When** the buyer proves `age_over_21 === true` through the gate for that
   order id, **Then** completion is allowed — and a proof of `age_over_18` alone is **not** accepted for a 21+ gate.
3. **Given** a member proves membership, **When** the order is priced, **Then** the discount is applied **once**,
   re-derived server-side from the catalog + the gate effect, and the line sum, order total, and payment amount
   agree on every path.
4. **Given** two concurrent orders, **When** one is age-verified, **Then** the other remains unverified (state is
   per order id; no cross-order/cross-user bleed).
5. **Given** the demo now consumes `attesto.mount()` for this rail, **When** the full suite and the live build run,
   **Then** the **user-visible** result (totals, gating) is identical, the pre-existing suite stays green, and the
   new bypass tests pass — the discount mechanism is intentionally unified to the gate effect (FR-005), not a regression.

---

### User Story 2 - Payment authorizes through the gate (passkey rail) (Priority: P2)

A buyer authorizes payment on the mount()-served page using a **WebAuthn passkey**, same-device (Touch ID /
Windows Hello) **and** cross-device (FIDO caBLE). The four deterministic gates run (amount integrity,
authorization present, user verification asserted, subject/credential binding); on success an AP2-shaped mandate
is produced and the order optionally settles on Hedera testnet (demo-mode x402).

**Why this priority**: Payment is the canonical "settles last" credential and the most-real rail (genuine
WebAuthn attestation + nonce/replay + origin binding). It completes the end-to-end purchase the hero story starts.

**Independent Test**: Drive the passkey ceremony for an order via `attesto.mount()` routes both same-device and
cross-device; assert the four gates run, a tampered amount is rejected by the amount-integrity gate (re-priced
from catalog), the nonce cannot be replayed, and the origin/RP-ID binding is enforced.

**Acceptance Scenarios**:

1. **Given** a valid order, **When** the buyer completes the passkey ceremony, **Then** the four gates pass, a
   mandate is produced, and the order is recorded idempotently.
2. **Given** a checkout link with a tampered amount, **When** completion is attempted, **Then** the re-pricing /
   amount-integrity gate refuses it.
3. **Given** a used or expired challenge, **When** it is replayed, **Then** it is rejected (sealed, time-limited nonce).
4. **Given** the `?xdev=1` toggle, **When** the buyer chooses cross-device, **Then** the caBLE flow is offered and
   binds to this server's origin/RP-ID.

---

### User Story 3 - Digital Credentials payment rail (Priority: P3)

A buyer authorizes an **amount-bound** payment via the Digital Credentials API + OpenID4VP (mdoc), completing
through the **shared `completeOrder` path** so recording, re-pricing, settlement, and state-clearing behave
identically to the passkey rail.

**Why this priority**: The second payment rail rounds out "do all three rails," but the hero (US1) and the
most-real payment rail (US2) deliver the demo's value first. Shipping it via the shared completion path keeps the
rails consistent and avoids a second completion code path.

**Independent Test**: Drive the dc-payment ceremony for an order via `attesto.mount()`; assert the amount is
bound, completion runs through the same `completeOrder` seam as passkey, and the same re-pricing / state rules hold.

**Acceptance Scenarios**:

1. **Given** an order, **When** the buyer authorizes via the DC API rail, **Then** completion goes through the
   shared `completeOrder` path with the amount bound and re-derived from the catalog.
2. **Given** a successful DC-payment, **When** the order is recorded, **Then** the cart is cleared and the
   verification state for that order is cleared — identically to the passkey rail.

---

### Edge Cases

- **Serverless instance split**: the page/options request and the verify request may hit different instances. The
  signing key for challenge tokens and the order/verification state MUST be stable/shared across instances, or the
  ceremony breaks (the same class of bug fixed in the storefront's order round-trip).
- **Missing mount() dependencies**: if the host does not provide the injected seams (verification store, signing
  key, origin), `mount()` MUST fail fast with a clear error rather than silently degrade to an insecure path.
- **Tampered order token / id**: amounts MUST always be re-derived from the catalog; a hand-edited order MUST NOT
  change the charged or settled amount.
- **Wrong-threshold proof**: an `age_over_18` proof MUST NOT satisfy a 21+ gate.
- **Settlement failure**: a failed Hedera settlement MUST NOT produce a "completed/paid" record.
- **Goose / no-GUI host**: the ceremony page is a browser hand-off; in a no-GUI host the flow surfaces as a link
  (documented host limitation, as with the storefront widget).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `attesto.mount(app)` MUST register the real ceremony routes for all three rails — passkey
  (same-device + cross-device caBLE), Digital Credentials payment, and the credential gate (age + membership) —
  so the storefront's checkout page can link to them and a buyer can satisfy every declared requirement.
- **FR-002**: The credential gate MUST enforce **explicit positive claims** — e.g. `age_over_21 === true`, with
  the threshold matching the order's restriction — and MUST refuse on a lower-threshold or absent claim.
- **FR-003**: Gate enforcement MUST run server-side on **every** completion path: the gate `verify` handlers, the
  order-completion path (`place-order`), and the MCP **order-completion** tool — **not** the link-minting `checkout`
  tool, which stays Context-1 (mint link + report requirements only, per Principle II). Enforcement here means
  **refusing completion** when a required credential is unproven; it never runs the ceremony. Not only in the
  rendered page — hiding a button is not enforcement.
- **FR-004**: Amounts MUST be **re-derived from the catalog** server-side on every path; the order id/token MUST
  never be trusted to carry the price. A tampered order MUST be refused by the amount-integrity gate.
- **FR-005**: The membership **discount** MUST be owned by the gate as an effect and applied to the order total by
  the storefront's pricing, exactly **once**, such that the line sum, order total, and any payment amount agree on
  every path (passkey, dc-payment, instant/demo). There MUST be a single discount mechanism (the gate effect),
  removing the prior storefront-flag divergence.
- **FR-006**: Verification state (age / membership / payment) MUST be scoped **per order id** and never
  process-global; one order's verification MUST NOT unlock another (no cross-user bleed).
- **FR-007**: The passkey rail MUST preserve the four deterministic gates (amount integrity, authorization
  present, user verification asserted, subject/credential binding) and MUST keep WebAuthn bound to this server's
  origin / RP-ID with a sealed, time-limited, single-use challenge (nonce/replay protection).
- **FR-008**: The Digital Credentials payment rail MUST complete through the **same** `completeOrder` path as the
  passkey rail (idempotent recording, re-pricing check, optional settlement, cart + verification clear).
- **FR-009**: `mount(app)` MUST take its dependencies as **injected seams**, not hardcoded demo imports: a
  per-order verification store, an order store, a stable signing key for challenge tokens, request-derived
  origin/RP-ID, and the completion seam. Missing required seams MUST cause `mount()` to **fail fast** with a clear
  error. The signing key MUST be required explicitly; `mount()` MUST NOT infer "serverless" — a per-process
  ephemeral key is allowed only when the host opts in via an explicit `allowEphemeralKey: true` (dev-only) flag.
- **FR-010**: The order MUST be **resolved by id** via the injected order-store seam (default in-memory; a
  host-injected shared store on serverless). Re-pricing of the resolved order is governed by FR-004.
- **FR-011**: The trust level MUST remain **presence-only, fenced as demo**: real protocol flows, but the mandate
  is dev-signed (not key-bound) and there is no issuer/device-signature trust verification. The ceremony page and
  any receipt MUST state this honestly; it MUST NOT be presented as a real safety control.
- **FR-012**: The demo MUST keep working by **consuming `attesto.mount()`** (becoming a thin consumer, as it
  consumed the storefront in 002). The **pre-existing** test suite (253 pass / 1 skip *baseline*) MUST stay green
  with **no new skips**, the **new bypass tests MUST pass** (the total count rises — the baseline is a floor, not a
  target), and the live deploy MUST stay green. The **user-visible** result (totals, gating, payment) MUST be
  identical; the one intentional change is unifying the discount to the single gate-owned effect (FR-005), which
  fixes the prior storefront-flag divergence — so "identical" means user-visible behavior, not the internal mechanism.
- **FR-013**: A failed settlement MUST NOT produce a completed/paid record; settlement stays demo-mode (Hedera
  testnet, x402) and is clearly labeled as such.
- **FR-014**: Every commit MUST carry a DCO `Signed-off-by` line, and tests MUST exercise the security-critical /
  bypass paths (a test that still passes with a control removed is not acceptable).

### Key Entities *(include if feature involves data)*

- **mount() seam**: the function that registers the ceremony onto a host Express app and reads its injected
  dependencies (verification store, signing key, origin, order/completion seams) from `app.locals` / options.
- **Verification record**: per-order-id state capturing which credentials (age / membership / payment) have been
  proven for that order; scoped per order, never global.
- **Challenge token**: a sealed, time-limited, single-use nonce that binds a ceremony attempt to this origin/RP-ID.
- **AP2-shaped mandate**: the authorization artifact produced on success (dev-signed in v0.1; key-bound signing is v0.2).
- **Settlement record**: optional demo-mode on-chain settlement proof (Hedera testnet); absent on failure.
- **Requirements manifest**: the flat, serializable list the gate already emits from `requirements(order, policy)`
  describing what the page must collect (credential, required/optional, effect, threshold).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An age-restricted purchase **cannot be completed** through any path until age is proven through the
  gate — demonstrated live, and pinned by a bypass test that fails if the control is removed.
- **SC-002**: A member's discount is applied exactly once and the line sum, order total, and payment amount agree
  on 100% of completion paths (no path accepts a total another path would refuse).
- **SC-003**: Payment authorizes via passkey both same-device and cross-device, and a tampered amount or replayed
  challenge is rejected in 100% of attempts.
- **SC-004**: The demo, now consuming `attesto.mount()`, is user-visibly identical (totals, gating, payment) — the
  pre-existing suite stays green (253/1-skip baseline as a floor, no new skips), the new bypass tests pass, and the
  live deploy stays green at every step. (The discount mechanism is intentionally unified per FR-005.)
- **SC-005**: An adopter can reach a real, working ceremony with `createStorefront()` + `attesto.mount(app)` +
  `store.gate(...)` in ≤ 10 lines (the quickstart becomes true end-to-end).
- **SC-006**: Every honesty surface (page, receipt) states the presence-only/demo trust level; no surface presents
  the gate as a real safety control.

## Assumptions

- **Injected store seam is the order-resolution path** (default in-memory, host-injected shared/Redis on
  serverless), with catalog re-pricing per FR-004. *(Confirmed at `/speckit-plan` — research D2.)*
- The package stays **dependency-light**: no Redis dependency is added to the package; the shared store is injected
  by the host (as the storefront does today).
- A **stable signing key** (`GATE_SECRET` or equivalent) is provided in any multi-instance deployment; an ephemeral
  per-process key is allowed only behind an explicit `allowEphemeralKey: true` flag (single long-running process /
  local dev), never inferred from the environment (FR-009).
- The demo's existing catalog, settlement config, and checkout page remain the source of truth for products,
  pricing, and the link target; `mount()` provides the ceremony the page links to.
- `@simplewebauthn/*` (already a demo dependency) backs the WebAuthn rail and is served same-origin.
- **Out of scope (v0.2+)**: real KB-JWT / key-bound mandate signing; cryptographic mdoc issuer-trust verification;
  any *new* ceremony behavior (this is an extraction — preserve behavior, change location).
- **Dependency / sequencing**: 003 unblocks US2's deep finish from 002 (the demo's checkout tool, `app.ts` routes,
  widget bundle, and `mount()` rewire are 003-entangled). 003 lands first; then the demo consumes both packages.
