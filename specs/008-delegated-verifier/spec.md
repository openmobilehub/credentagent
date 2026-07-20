# Feature Specification: Delegated External Verifier & Settlement Seam

**Feature Branch**: `feat/008-delegated-verifier-seam` (S1 #85 + S2 #86 land here; S3 #87 is a separate PR)

**Created**: 2026-07-19

**Status**: Draft

**Input**: Epic #60 — a seam so a storefront can run a **real**, issuer-trust-verified, amount-bound
payment *inside* the mounted ceremony instead of bypassing `mount()`. Grounding: the reference
integration in [`openwallet-foundation/multipaz-utopia`](https://github.com/openwallet-foundation/multipaz-utopia)
(`organizations/marketplace/.../MarketplaceHandler.kt`, `organizations/upay/.../TransactionProcessor.kt`)
and its consumer PR multipaz-utopia#15, whose review asked to *"build the seam first, then rework
this to consume it."*

## Overview

The gate's built-in rails verify **in-process** and are honestly fenced at `trust_level:
"presence-only-demo"`. The wire crypto is real — JWE/ECDH-ES decrypt, ISO-mdoc parse, and the
device-signed `transaction_data_hash` re-check (`dc-payment/verify.ts:264`) — but there is **no
issuer/device trust anchor**: the reader cert is self-signed and the COSE signatures are never
checked against a CA (`dc-payment/verify.ts:166`). A self-crafted mdoc still parses.

A storefront whose payment is a **real** rail cannot express that through the SDK today:

- `payment.in("usd")` (`credentials.ts:119`) is the SDK's own presence-only ceremony.
- `defineCredential` (`credentials.ts:143`) presents a custom mdoc, but `verify` is a JS
  `(claims) => boolean` (`types.ts:103`), `dcql()` has no `transaction_data` amount-binding
  (`credentials.ts:34`), and it cannot produce the `PresentmentRecord` an external processor's
  commit step consumes.
- The `settle` seam (`completion.ts:62`) runs **after** the SDK's own authorization and receives only
  `(order)` — so it can never stand in for a verifier whose *output* settlement must consume.

The only way to use a real verifier + processor is therefore to bypass `mount()` and run the external
ceremony around it — which a reviewer flagged (the "fix it or flag it, never ignore" #47 norm).

This feature adds a **`DelegatedVerifier` seam** on `mount()`. Verification (issuer/device trust,
disclosure) and settlement move to an external verifier/processor; the gate retains pricing, binding,
policy, and recording. The developer-facing policy is unchanged — `payment.in("usd")`,
`defineCredential`, `gate()` are byte-identical; only mount configuration gains one seam.

The load-bearing idea, and the reason this is safe:

> **Trust is delegable. Binding is not.**
> The external verifier owns what the gate genuinely lacks — an issuer trust anchor. The gate keeps
> what it must never outsource — the catalog-derived amount, the payee, and its own gate policy.

## Decisions *(locked; recorded here rather than as `needs-decision`)*

| # | Decision | Why | Rejected alternative |
| --- | --- | --- | --- |
| **D1** | **External-service redirect** — the ceremony is handed off to a real verifier; the gate is not the OpenID4VP verifier on this rail. | Matches the reference: the Multipaz verifier owns the request/response/decrypt/crypto and exposes a post-verification hook. | An in-process verification backend (`@auth0/mdl`-shaped). Deferred, not discarded — same seam, no reference fetch (Out of Scope). |
| **D2** | **Server-to-server verdict fetch by reference** — the browser carries only an opaque reference; the host re-fetches the verified presentment over an authenticated channel. | The browser sits between verifier and gate; anything it carries is forgeable. Mirrors Multipaz's own `RpcAuthorizedServerClient` topology. | A signed verdict envelope through the browser (viable, needs verifier signing keys + key distribution); trusting a browser-posted `approved` (rejected outright — fail-open). |
| **D3** | **A new `delegated-payment` rail** mirroring the `dc-payment` split. | The topology genuinely differs (redirect + reference fetch, no in-process JWE decrypt). CLAUDE.md: a new rail mirrors the rail layout, it does not bolt onto an existing one. | Branching inside `dc-payment/routes.ts` — two ceremonies tangled in one verify handler. |
| **D4** | **Combined age+payment presentation** in one delegated round-trip. | The reference requests identity and payment in one DCQL with `credential_sets`; splitting would force two wallet round-trips. | Payment-only first — cheaper, but not what the reference ceremony does. |

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A delegated verdict cannot authorize the wrong amount (Priority: P1)

An external verifier returns `approved: true` for an amount that does not match the catalog-re-priced
order. Completion is refused, nothing is recorded, and no settlement fires.

**Why this priority**: This is the invariant most at risk from delegation. A seam that lets a
third-party adapter decide the amount has moved Security invariants 2 and 3 out of the gate — the one
thing this design must never do.

**Independent Test**: Inject a `DelegatedVerifier` whose `consume` returns `approved: true` with
`binding.amount` set to less than the re-priced total; POST the rail's verify route; assert refusal,
no `CompletedRecord`, and that the *matching-amount* verdict for the same order still completes (so
the refusal was the binding check, not an unrelated failure).

**Acceptance Scenarios**:
1. **Given** an order re-pricing to X, **When** a verdict binds amount Y ≠ X, **Then** completion is
   refused and no record is written.
2. **Given** the same order, **When** the verdict binds a payee that is not this RP's re-derived
   payee, **Then** it is refused (invariant 6).
3. **Given** a verdict in a different currency from the re-priced order, **Then** it is refused.

### User Story 2 — A browser cannot forge an approval (Priority: P1)

The verified result reaches the gate only by server-to-server fetch against a sealed reference. A
reference minted for one order cannot be redeemed against another, and a tampered reference is
refused.

**Why this priority**: It is the security premise of D2. If the browser could assert `approved`, the
entire delegated rail would be fail-open, and cross-order redemption would breach invariant 4.

**Independent Test**: Mint a `referenceToken` for order A; submit it against order B; assert refusal.
Flip a byte in the token's payload and resubmit against order A; assert refusal. Assert the
unmodified token against order A still completes.

**Acceptance Scenarios**:
1. **Given** a `referenceToken` sealed for order A, **When** submitted with order B, **Then** it is
   refused (order-id binding).
2. **Given** a `referenceToken` with a tampered payload, **When** submitted, **Then** it is refused
   (HMAC).
3. **Given** a verify request carrying raw claims instead of a reference, **Then** they are ignored —
   disclosed claims are never accepted from the client.

### User Story 3 — The gate's own policy still gates, even when the verifier approved (Priority: P1)

An external verifier's business logic is not a substitute for the gate's policy. An age-restricted
order whose verdict lacks the positive claim at the order's threshold is refused, even with
`approved: true`.

**Why this priority**: The reference verifier runs its *own* age rule (`checkAge` accepts 18+ via
several claim shapes). The gate's policy may be stricter (`age.over(21)` demands `age_over_21 ===
true`). Deferring to the adapter would silently weaken invariants 1 and 5.

**Independent Test**: Configure `required(age.over(21))` on an age-restricted cart; return a verdict
with `approved: true` and claims carrying only `age_over_18: true`; assert refusal. Then return
`age_over_21: true` and assert completion.

**Acceptance Scenarios**:
1. **Given** a 21+ cart, **When** the verdict's claims prove only 18+, **Then** completion is refused.
2. **Given** an applicable custom `gate()` credential, **When** the verdict's claims do not satisfy
   its own `verify`, **Then** completion is refused.

### User Story 4 — Issuer-verified trust is reported honestly (Priority: P2)

A verdict backed by a real trust anchor is recorded as `issuer-verified`; everything else stays
`presence-only-demo`. The gate never upgrades trust it did not receive.

**Why this priority**: This is the first path on which `trust_level: "issuer-verified"` may ever be
emitted (`types.ts:45` defines it; nothing emits it today). Getting it wrong would make the honesty
axis a lie in the type system.

**Independent Test**: Return a verdict with `trust_level: "presence-only-demo"` and assert the record
and manifest say exactly that; return `issuer-verified` and assert it propagates unchanged. Assert an
unconfigured (no-verifier) mount still reports `presence-only-demo` everywhere.

### User Story 5 — Same policy, swapped backend (Priority: P2)

A storefront moves from the built-in presence-only rail to a real external verifier by adding one
seam to `mount()`. The policy, the tool surface, and the storefront code are unchanged.

**Why this priority**: It is the DX thesis of the epic and the "example IS the DX test" rule
(`architecture-principles.md`, Principle 12). If wiring a verifier needs a plumbing block, the seam
is wrong.

**Independent Test**: One storefront test completes an order on the built-in rail and a second
completes the same policy through a `FakeDelegatedVerifier`, with the only diff being the `verifier`
seam passed to `mount()`.

## Requirements *(mandatory)*

- **FR-001**: The gate MUST expose a `DelegatedVerifier` seam accepted by `mount()` as an optional
  ceremony seam, carried on `CeremonySeams` / `CeremonyContext` alongside `settlement`. Absent ⇒ every
  existing path is byte-unchanged.
- **FR-002**: The seam MUST be **implementation-agnostic**. No UPay-, Multipaz-, or PSP-specific
  symbol may appear in `packages/credentagent-gate/src`; concrete adapters are host-side. (#75)
- **FR-003**: The gate MUST derive the request's `transaction_data` (amount, currency, payee) from its
  **own catalog re-pricing**, never from the adapter or the client (invariant 2). The adapter receives
  the amount; it never supplies it.
- **FR-004**: The gate MUST seal the external reference into an HMAC `referenceToken` bound to the
  order id, using the existing `signingKey` primitive. A tampered, replayed (wrong-order), or expired
  token MUST be refused (invariant 4).
- **FR-005**: On verify, the gate MUST re-resolve and re-price the order, then refuse unless the
  verdict is `approved` AND its `binding` agrees with the re-priced order on amount, currency, and
  this RP's re-derived payee (invariants 2, 3, 6).
- **FR-006**: The gate MUST re-run its **own** policy `verify` over the verdict's disclosed claims —
  the built-in age threshold and every applicable custom `gate()` credential. An external verifier's
  approval MUST NOT substitute for the gate's policy (invariants 1, 5).
- **FR-007**: Completion MUST go through the shared `completeOrder` seam — one completion path, order-keyed
  idempotency, cart + per-order verification cleared, settlement gating preserved (a configured-but-failed
  settle records nothing). No second completion path (FR-008 of 003).
- **FR-008**: `trust_level` on the manifest entry and the completed record MUST be sourced from the
  verdict. The gate MUST NOT emit `issuer-verified` unless a verdict reported it; the default with no
  verifier stays `presence-only-demo`.
- **FR-009**: The client MUST NOT be able to supply disclosed claims or an approval to the delegated
  verify route; the only accepted input is the sealed reference (plus the order identifiers).
- **FR-010**: When a verifier is configured, `requirements()` MUST route the `authorize`-effect
  (payment) entry — and, in the combined presentation, the identity/age `gate()` entry it is presented
  with — to the delegated rail's approve URL. With no verifier configured the manifest is
  byte-unchanged. The policy builders MUST NOT change shape.
- **FR-011**: The pre-existing suites MUST stay green, and every new bypass test MUST fail with its
  control removed (constitution; FR-014 of 003). DCO sign-off on every commit.

### Key Entities

- **`DelegatedVerifier`** — the seam. `buildRequest({ order, dcql, binding, origin })` →
  `DelegatedHandoff`; `consume({ reference, order })` → `DelegatedVerdict`. Two methods mirroring
  the reference's own split (request minting in `marketplaceCheckout`, post-verification business logic
  in `VerifierAssistant.processResponse`).
- **`DelegatedVerdict`** — structural, JSON-safe result: `{ approved, trust_level, claims, binding,
  settlement?, reason? }`. Deliberately carries **no** foreign types (no `PresentmentRecord`), so the
  gate never depends on a verifier's object model.
- **`DelegatedHandoff`** — `{ reference, handoff }`: the opaque handle the verdict is later fetched by,
  plus the verifier-specific payload the browser forwards. The gate never interprets `handoff`.
- **`BindingFields`** (existing — `mandate.ts:24`) — the gate-derived amount binding handed to
  `buildRequest`: `{ amount, currency, payee: { id, name }, orderId }`. **Reused, not re-invented**:
  it is the same `buildBindingFields(order, origin)` struct the dc-payment rail's `transaction_data`
  and the passkey mandate already bind on, so the delegated rail cannot drift from them. (The name
  `TransactionData` is already taken by the OpenID4VP *wire* entry in `dc-payment/txData.ts:14`; the
  adapter builds that wire shape from these fields.)
- **`referenceToken`** — the HMAC-sealed `{ reference, orderId }` envelope carried by the browser
  between `/request` and `/verify`; the reason a browser cannot redeem someone else's verification.

## Success Criteria *(mandatory)*

- **SC-001**: A verdict binding an amount, currency, or payee that disagrees with the re-priced order
  is refused on the verify route with nothing recorded and no settlement fired (US1; each bypass test
  fails with its control removed).
- **SC-002**: A `referenceToken` is redeemable only for the order it was sealed for, and only
  unmodified (US2).
- **SC-003**: A verdict with `approved: true` whose claims fail the gate's own policy (age threshold
  or an applicable custom `gate()`) does not complete (US3).
- **SC-004**: `trust_level` in the manifest and the completed record equals the verdict's value, and is
  `presence-only-demo` on every non-delegated path (US4).
- **SC-005**: `grep -ri upay packages/credentagent-gate/src` returns nothing; the same policy completes
  on both the built-in rail and a `FakeDelegatedVerifier` with only the `verifier` seam differing (US5,
  FR-002).

## Assumptions

- The external verifier enforces the `transaction_data` binding on the wire (the wallet device-signs
  over it) — which is safe to rely on **only because** the gate mints that `transaction_data` from its
  own re-price and re-checks the returned binding (FR-003, FR-005). The gate never assumes the adapter
  checked anything.
- The host can reach the verifier over an authenticated server-to-server channel (D2). A deployment that
  cannot should use the signed-envelope variant, which is out of scope here.
- The existing stable `signingKey` seam is available wherever the delegated rail is mounted (already
  required for the challenge token).

## Design note — what moves and what does not

| Concern | Owner | Why |
| --- | --- | --- |
| Catalog re-pricing; amount / payee / currency binding | **Gate** | Invariants 2, 3, 6. The one thing an adapter must never decide. |
| Order + session scoping, idempotency, the completed record | **Gate** | Invariant 4 and the single completion path. |
| Gate policy (`age_over_N`, custom `gate()` predicates) | **Gate** | Invariants 1, 5. The verifier's business rules may be laxer than the merchant's policy. |
| OpenID4VP request/response, decryption, mdoc parsing | **External verifier** | It already does this, correctly, as a service. |
| Issuer / device trust anchor ⇒ `trust_level` | **External verifier** | Exactly the capability the gate lacks; the reason the seam exists. |
| Settlement (processor commit consuming its presentment) | **Host adapter** | Keeps the gate free of PSP types (#75); still gated by `completeOrder`. |

**Why a reference and not the payload.** The verified presentment is never carried by the browser.
The browser holds an opaque handle; the gate re-fetches the result server-to-server. This is the same
"delegate a reference, not the content" stance the 004 cart-mandate note takes — here it is not only a
size/privacy trade-off but the integrity boundary: a payload routed through the client is a payload the
client can rewrite.

## Out of Scope (v0.2+)

- **In-process verification backend** (`@auth0/mdl`-shaped): the same `DelegatedVerifier` contract
  without the reference fetch. Cheap once this lands; deliberately not bundled (D1).
- **Signed verdict envelope** through the browser (the D2 alternative), for deployments without a
  server-to-server path.
- Delegating the **passkey** or on-chain settlement rails — unchanged by this feature.
- Any claim that the gate itself performs issuer-trust verification. It does not, and must not say so;
  `issuer-verified` is only ever a value the gate *relays* from a verifier that earned it.

## Dependencies & increment map

Builds on 003 (mounted rails + shared `completeOrder`) and 007 (the credential registry the policy
sweep reads).

| Increment | Issue | Lands |
| --- | --- | --- |
| **S1** — seam contract + this spec | #85 | this branch |
| **S2** — `delegated-payment` rail: request/handoff builder | #86 | this branch |
| **S3** — verify + the non-delegable re-checks (security core) | #87 | separate PR |
| **S4** — manifest routing + honesty plumbing | #88 | separate PR |
| **S5** — storefront wiring + fake verifier + docs | #89 | separate PR |
| **S6** — rework multipaz-utopia#15 onto the seam | multipaz-utopia#16 | downstream repo |

S1+S2 land together deliberately: an interface with no caller cannot be judged against the
"example IS the DX test" rule. Note that S2 exercises **`buildRequest` only** — `consume()` and
`DelegatedVerdict` have no caller until S3 and are therefore **provisional** on this branch.
