# Feature Specification: Human-Not-Present (HNP) Delegation — First Increment

**Feature Branch**: `005-human-not-present` (continues the 001–004 line; based off `feat/attesto-gate-v0.1`,
not `main` — do not lose prior work)

**Created**: 2026-06-29

**Status**: Draft — **sequencing fork RATIFIED 2026-07-07: Option B (wallet-custody, seams-first)**
(`sequencing-fork-memo.md`). Group-A D1–D3 directionally settled by the ratification + the 2026-07-07 Multipaz
meeting (D1 yes; D3 signer → **DeviceKey / DPC**, not server-HMAC). The **Decision-13 constitution amendment**
remains a prerequisite before `/speckit-implement`. See the ⚠️ **Option-B reconciliation** callout below.

**Input**: A typed **`ap2.IntentMandate`** that lets an agent complete a consequential **action** when the
human is **not present**, under a **bounded, revocable, auditable** grant — the **smallest honest end-to-end
slice**. HNP is the v0.2 user/agent-signed mandate line that 004 (`specs/004-cart-mandate/spec.md`) explicitly
deferred. Grounding: `docs/superpowers/research/2026-06-29-human-not-present-scoping.md` (5-dimension research +
a 13-item decision menu).

---

> ## ✅ Decisions baked in from the research — Group-A + sequencing RATIFIED 2026-07-08
>
> Drafted **autonomously while the maintainer was asleep** from the research's **recommended** answers, then
> **hardened by a 4-lens adversarial review** (invariants / honesty / faithfulness / real-code feasibility) that
> read the actual library code. The Group-A calls (1–3) were discussed with the maintainer on 2026-07-01
> (wallet/key-architecture deep-dives) and **RATIFIED on 2026-07-08**, D3 including the v0.2 user-signing
> direction (WebAuthn + on-device DPC via Multipaz). The sequencing fork is likewise **ratified: Option B**
> (`sequencing-fork-memo.md`). Decisions 4–12 stand as baked-in. Decision 13 (the constitution amendment) is
> the remaining prerequisite for `/speckit-implement` — executed as the amendment in `.specify/memory/constitution.md`.
>
> | # | Decision | Baked-in choice (post-review) |
> | :-- | :-- | :-- |
> | 1 | Model the Intent Mandate now? | **Yes** — typed `ap2.IntentMandate` + a deterministic bounds-check gate. **Ratified 2026-07-08** |
> | 2 | Represent the absent human honestly? | **New orthogonal `presence` axis** (`live \| delegated-demo \| delegated`) AND a new weaker authorization value **`server-issued-demo`** — do NOT reuse `presence-only-demo` for HNP. **Ratified 2026-07-08** |
> | 3 | What signs the v0.1 grant? | **Server-HMAC** (reuse `signingKey`); proves *issuance only*. In v0.1 the **server**, not the user, composes + signs the bounds. `alg` is reserved (no working swap exists yet). **Ratified 2026-07-08**, incl. the v0.2 direction: two user-signing ceremonies — WebAuthn (passkey over hash-of-bounds) + on-device DPC via Multipaz (DC API / OpenID4VP)* |
> | 4 | Which effects get delegation? | **Action effects only**; age/membership **not delegable**; age-restricted ⇒ **always step up** |
> | 5 | Single-use vs reusable? | **Single-use** grant, enforced by an **atomic** per-grant consume |
> | 6 | Caps? | **Per-action cap only**, an **absolute ceiling (tolerance = 0)**; cumulative/velocity out |
> | 7 | Binding (grant predates order)? | **Scope-contains** + re-priced **≤ cap** + a **presence-required step-up** threshold (step-up limit ≤ cap) |
> | 8 | State model? | **Hybrid** — signed grant travels statelessly; the seam re-checks server-side state; never trusts a balance in the grant |
> | 9 | Revocation? | **Synchronous, fail-closed** per grant id + active-grants surface + per-subject kill-switch; `delegationId` on the completed record |
> | 10 | Where does it attach? | A new `intent` rail **and** an **additive, fail-closed branch in `completeOrder`** (the seam re-checks — not "unchanged") |
> | 11 | Scope? | **Single-origin** + product/category allowlist; a dedicated **delegate** flow reuses a live rail to sign |
> | 12 | Async step-up? | A distinct third mode; only the step-up **threshold/refusal** is in this increment |
> | 13 | Governance? | Depends on a **MINOR constitution amendment** to **Principles II, III, and VII** (separate `/speckit-constitution` step) — see Dependencies |

> ## ⚠️ Option-B reconciliation (2026-07-07 — read before the v0.1 prose below)
>
> This spec was authored for the **server-HMAC v0.1** path (Option A's first increment). **Option B
> (wallet-custody) is now ratified**, so the following are **superseded** and read as *historical A-path context*:
> the **Delegate flow** (server composes + signs bounds), **Decision 3** (server-HMAC signer), and the
> **v0.1 honesty framing** immediately below (bearer instrument / `server-issued-demo` / settlement-suppressed).
> Under B the **user's phone signs** the bounds (**DeviceKey + on-device DPC**), naming a wallet-server key
> `K_s`; the honesty label becomes **`issuer-verified (demo PKI)` + fake money**, presence **`delegated`** (see
> `connector-architecture-design.md` §10–§11).
>
> **What does NOT change — and ships first:** the four **shared gate seams** — draw-verification **envelope**
> (`checkDraw`), the **`completeOrder` draw branch**, the **revocation store**, and the **typed-refusal
> vocabulary** (§9). These are signer-agnostic (they verify a signature over canonical bounds — HMAC *or* the
> spike's ES256 `K_s`), so **all FRs about the seams stand as written**; only the *minting* side (who composes +
> signs) moves from the merchant gate to the wallet server (a later increment). The first-increment build plan is
> `plan.md`; the spike prototype (`spike/intent-mandate/`, ES256 + `checkDraw` + 13 tests) is already B-shaped.
>
> ## 🔎 Honesty framing (load-bearing — read before reviewing) — *v0.1 / A-path; superseded by the callout above*
>
> A v0.1 HNP grant is **server-HMAC-signed**, so it proves only **"this server issued this grant"** — NOT that
> the user authorized these specific bounds, NOT which user, and there is **no human at execution**. It is a
> **bearer instrument** (whoever holds the blob redeems it within caps; `subject` is informational only in v0.1)
> and is **doubly demo** (presence-removed **and** trust-anchor-absent). It is **strictly weaker** than the live
> rails and MUST be fenced **harder**: it never settles real value, carries an explicit `disclaimer`, and is
> never presented as user authorization or a real safety control. The demo's "pre-authorize once" UX shows the
> *shape* of delegation; the user-authored-and-signed bounds are the **v0.2** line, issuer-verified credentials +
> per-draw proof-of-possession the **v0.3** line. v0.1 has none of the three.

---

## Overview

Attesto today runs one model: **human-present (HP)**. At the moment a consequential action completes, a live
human performs a fresh ceremony (WebAuthn passkey / OpenID4VP) bound to this origin with nonce/replay
protection. This feature adds the deferred counterpart: **human-not-present (HNP)** — the agent completes an
**action** *later*, with no live human, by presenting a **server-issued, bounded, revocable grant**.

The increment is deliberately the **smallest honest end-to-end slice**:

- **Delegate (human present, once):** the user performs one live ceremony (reusing an existing rail to
  authenticate). The **server** treats that as delegation and seals **server-composed** bounds into a typed
  **`ap2.IntentMandate`** — server-HMAC via `signingKey` — carrying an (informational) subject, a
  **single-origin** payee + product/category **scope allowlist**, a **per-action cap** (amount + currency,
  absolute ceiling), a **time window**, `singleUse: true`, `presence: "delegated-demo"`,
  `trust_level: "server-issued-demo"`, and an explicit `disclaimer`.
- **Redeem (human NOT present):** the agent calls a redeem path with a proposed cart; the system verifies the
  grant (signature → window → not-revoked → not-consumed), **re-prices from the catalog** (ignoring
  membership/loyalty discounts — those are non-delegable), asserts the order is **within scope**, applies the
  **step-up** check, asserts the re-priced total **≤ the cap**, derives the payment amount from the re-priced
  total, and routes through `completeOrder` — which **re-checks every control at the seam** (fail-closed), writes
  a `delegationId`, and **suppresses real settlement** for the demo-fenced grant.

It is **additive and fail-closed**, reuses primitives that already exist (the HMAC `signingKey`, the per-order
`VerificationStore`, the shared `completeOrder`), and upholds invariants 1–5 (invariant 6 only **partially** —
see below). It **names** all three AP2 mandate types (Intent → Cart → Payment) at the shape level for the GDC /
Multipaz narrative — **none is user-signed in v0.1**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Pre-authorize once; the agent completes an in-bounds order while I'm away (Priority: P1)

A user performs one live ceremony to delegate bounded authority; the server issues a grant for a product set,
up to a cap, before an expiry. Later, with the user **not present**, the agent assembles a cart inside those
bounds and the order **completes** — re-priced from the catalog, recorded with a link back to the grant.

**Why this priority**: It is the entire point — an agent acting unattended within server-issued bounds. It is
the MVP slice and a complete GDC demo on its own.

**Independent Test**: Mint an Intent Mandate via the delegate flow under a live ceremony; with no live ceremony,
submit a proposed cart that is in-scope, under the cap, and inside the window; assert the order completes through
`completeOrder`, the completion record carries the grant's `delegationId`, the charged amount equals the catalog
re-priced total, and **no settlement is invoked**.

**Acceptance Scenarios**:

1. **Given** a valid, unexpired, not-revoked single-use grant scoped to product set P with per-action cap C,
   **When** the agent redeems it (no live human) with a cart ⊆ P whose re-priced total ≤ C, **Then** the order
   completes via `completeOrder`, the record links `delegationId`, the grant is **atomically** marked consumed,
   and `ctx.settle` is not called.
2. **Given** the grant just consumed by scenario 1, **When** the agent redeems it again, **Then** it is refused
   (single-use already consumed) and nothing is recorded.
3. **Given** an in-bounds cart whose catalog price drifted upward since delegation but still **≤ C**, **When**
   redeemed, **Then** it completes at the **re-priced** total (never a price carried in the grant) and the bound
   payment amount equals that re-priced total.

### User Story 2 — Out-of-bounds draws are refused (the bounds are load-bearing controls) (Priority: P1)

Any redemption outside the grant's bounds is refused server-side, **on every completion path** (including direct
`completeOrder` / place-order / MCP-tool calls), recording nothing — with a reason distinct enough to tell
tamper from expiry from over-cap.

**Why this priority**: The bounds are the only thing between "server-issued grant" and "blank cheque." Each must
be a real control (a test that still passes with the control removed is not a useful test).

**Independent Test**: For each bound, craft a redemption that violates exactly that bound — **submitting it
directly to `completeOrder`/place-order/the MCP tool, not only the intent rail** — and assert it is refused with
the expected reason, records nothing; then assert the otherwise-identical in-bounds redemption completes. Remove
the seam control and assert the bypass test fails.

**Acceptance Scenarios**:

1. **Given** a grant with per-action cap C, **When** a cart re-prices **above C**, **Then** it is refused
   (over-cap) and nothing is recorded.
2. **Given** a grant scoped to product set P, **When** a cart contains an item ∉ P (or a different payee/origin),
   **Then** it is refused (out-of-scope).
3. **Given** an expired grant, **When** redeemed, **Then** it is refused (expired), with a reason distinct from a
   tamper failure.
4. **Given** a grant whose HMAC payload was edited in transit, **When** redeemed, **Then** it is refused
   (signature).
5. **Given** an **age-restricted** cart, **When** redeemed unattended (regardless of any snapshot), **Then** it
   is **always refused with a step-up signal** — age can never complete from a grant; it requires a live
   ceremony ("delegate actions, not identity").
6. **Given** a single-use grant already consumed, **When** a second draw is attempted, **Then** it is refused
   (consumed) and nothing is recorded.
7. **Given** a cart above the **step-up threshold** (amount > step-up limit, age-restricted goods, or an
   off-allowlist payee), **When** redeemed unattended, **Then** it is refused and the response indicates a live
   ceremony is required.
8. **Given** a passing gate but a **revoked / consumed / out-of-bounds** grant submitted **directly to
   `completeOrder`** (bypassing the rail), **When** processed, **Then** the seam refuses fail-closed and records
   nothing (no upstream-only enforcement).

### User Story 3 — Revoke a grant and it stops working immediately (Priority: P2)

The user can revoke a standing grant (or kill all grants for a subject), and the very next redemption is refused
— fail-closed even if the revocation store is unreachable, and even if revocation lands **between** rail-verify
and `completeOrder` (TOCTOU). A "active grants" view lists outstanding grants and is the audit trail.

**Why this priority**: The moment a standing capability exists the user must be able to kill it. Revocation is
non-negotiable; the audit trail replaces the human-in-the-loop moment.

**Independent Test**: Revoke a valid grant, then attempt a previously-in-bounds redemption and assert refusal
(revoked), nothing recorded; make the revocation store unreachable and assert redemption **fails closed**; revoke
**after** rail-verify but before `completeOrder` and assert the seam still refuses; list active grants and assert
the revoked one is absent/marked.

**Acceptance Scenarios**:

1. **Given** a valid grant, **When** the user revokes it and the agent then redeems it, **Then** it is refused
   (revoked), nothing recorded.
2. **Given** the revocation store is unreachable, **When** any grant is redeemed, **Then** it is refused
   (fail-closed), never allowed by default.
3. **Given** several grants for a subject, **When** the per-subject kill-switch fires, **Then** all of that
   subject's subsequent redemptions are refused.

### User Story 4 — The honesty disclosures are present, positive, and load-bearing (Priority: P2)

Every surface representing an HNP grant carries `presence: "delegated-demo"`, `trust_level: "server-issued-demo"`,
and an explicit `disclaimer` field, and carries **no** `authorizedByUser`/`userSigned` field; no HNP draw settles
real value. These are asserted by tests. (These are **disclosure-label** tests — distinct from the **security
bypass** tests of US2/US3.)

**Why this priority**: Removing the human makes the demo-vs-real gap more dangerous to blur than for the age gate.

**Independent Test**: Assert every exposed surface reports the three honesty fields and **lacks** any
user-authorization field; assert the `completeOrder` HNP branch never calls `ctx.settle` for
`presence: "delegated-demo"` and that removing that guard turns the test red.

**Acceptance Scenarios**:

1. **Given** a minted grant, **When** inspected via any exposed surface, **Then** it reports
   `presence: "delegated-demo"` + `trust_level: "server-issued-demo"` + a non-empty `disclaimer`, and exposes no
   `authorizedByUser`/`userSigned` field.
2. **Given** an HNP redemption, **When** it completes, **Then** the HNP branch does **not** invoke `ctx.settle`
   (settlement suppression is the control; the test fails if the guard is removed).

### Edge Cases

- **Grant predates the order** — no order id to equality-bind at issuance; binding is a *scope-contains*
  predicate at redeem, never equality.
- **Bearer risk (documented limitation)** — v0.1 has no holder binding / per-draw PoP, so whoever holds the grant
  redeems it within caps; `subject` is informational (kill-switch + audit key), not enforced. A test documents
  that redeem requires no live nonce and a non-subject presenter is accepted in v0.1.
- **Price drift** — the re-priced catalog total, not any amount in the grant, is authoritative; above the cap it
  refuses (or steps up).
- **Revocation store unreachable** — fail closed (refuse), never fail open.
- **Two concurrent redemptions of one single-use grant** — the consume must be an **atomic compare-and-set**
  keyed per grant id (per-order idempotency does not cover this), so exactly one completes.
- **Confused/buggy agent draws in-scope** — HNP cannot prevent a faithful-looking in-bounds draw; it only bounds
  and audits. High-consequence actions are reserved for live presence / step-up.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Define a typed **`ap2.IntentMandate`** carrying at least: `id` (stable per-grant, long-lived),
  `subject` (verified at delegation; **informational in v0.1 — NOT enforced at redeem; kill-switch/audit key**),
  `scope` (single-origin payee + product/category allowlist), `perActionCap` (amount + currency),
  `window` (`notBefore`/`expiresAt`), `singleUse: true`, `alg`, `signature`, `presence: "delegated-demo"`,
  `trust_level: "server-issued-demo"`, and a non-empty `disclaimer` string. It carries **no captured identity
  claim** (no `age_over_21` snapshot — age is non-delegable).
- **FR-002**: Seal the grant with the existing injected **`signingKey`** via a constant-time HMAC. The `alg`
  field is **reserved**: v0.1 fixes it to the HMAC suite; a future user/agent-key-signed variant (ES256 / KB-JWT)
  requires **widening the `alg` union AND adding a verify-dispatch that does not exist today** (this branch has
  only `mandate.ts` with `alg: "MOCK-DEV-SIGNER"`). Do not present `alg` as a working drop-in.
  **Ratified direction (2026-07-08): v0.2 ships two user-signing ceremonies for
  the intent bounds** —
  (a) **WebAuthn**: the passkey assertion's challenge = hash(intent bounds, including the agent key), mirroring
  the `passkey/` rail; (b) **on-device DPC (Multipaz)**: a device-stored Digital Payment Credential presented via
  the Digital Credentials API / OpenID4VP with the bounds bound into the session transcript, mirroring the
  `dc-payment` rail. The verify-dispatch must therefore handle **two proof formats** (WebAuthn assertion + mdoc
  deviceAuth), not one. **The two rails are NOT trust-equivalent (noted 2026-07-01).** Their trust roots
  differ: the **passkey** rail rests on prior registration with this RP — the server holds the user's public
  key, so the full chain (user key → origin → bounds-hash challenge) is live the day v0.2 ships. The **DPC**
  rail rests on the **issuer chain** (device key certified inside the credential, chained to a trust-listed
  issuer root) — which does not exist until the v0.3 issuer-trust anchor lands. Until then a DPC-signed grant
  proves **device possession + bounds sealing only** ("who" is unanchored; a self-crafted credential would
  pass), MUST carry a **weaker `trust_level` than a passkey-signed grant** (exact values fixed at v0.2 spec
  time), and MUST NOT be presented as equivalent to the passkey rail in UX or docs, even though the two
  ceremonies look symmetric to the user.
- **FR-003**: Provide a dedicated **delegate** flow that, at the end of **one live ceremony** (reusing an
  existing rail to authenticate), mints the grant and emits a manifest entry with `enforcedAt: "intent"`. The
  `enforcedAt` union MUST be **additively widened** to `"tool" | "checkout" | "intent"` (a type extension across
  the manifest types + resolver; verify no exhaustiveness switch breaks). Delegation is explicit, never a side
  effect of a purchase. **In v0.1 the server composes + signs the bounds**, not the user.
- **FR-004**: Provide a **redeem** path (`redeemIntent(intentId, proposedCart)`) executable with **no live
  human** that, before recording anything, performs in order: signature valid → within window → not revoked →
  **atomically** not-already-consumed → re-price the cart from the catalog (**ignoring membership/loyalty
  discounts**) → order ⊆ `scope` → **step-up check (before cap)** → re-priced total **≤ `perActionCap`**
  (tolerance = 0, absolute ceiling) → derive the payment amount from the re-priced total. Any failure refuses,
  records nothing, returns a reason distinct enough to separate signature / expiry / over-cap / out-of-scope /
  revoked / consumed / step-up. There is **no captured-attribute re-enforcement** (age steps up; membership
  ignored).
- **FR-005**: Enforce a configurable **presence-required step-up threshold** with **step-up limit ≤
  `perActionCap`** and **deterministic precedence (step-up checked before cap)**: a draw above the step-up limit,
  for age-restricted goods, or for an off-allowlist payee MUST be refused unattended and signal a live ceremony.
  (In v0.1, step-up escalates to another **presence-only-demo** rail — still demo-fenced — reducing unattended
  blast radius, **not** reaching real assurance.)
- **FR-006**: `completeOrder` gains **one additive, fail-closed `intentMandate` branch** (it is **not**
  unchanged): when `input.intentMandate` is present it MUST (a) re-verify the grant signature, (b) re-check
  not-revoked + not-consumed + scope-contains + cap + window **fail-closed**, (c) write `delegationId` onto the
  completed record, and (d) **suppress real settlement** (never call `ctx.settle`) for `presence:
  "delegated-demo"`. The live rails are otherwise untouched. The intent rail's per-order verification write MUST
  either reuse a **shared, exported** `recordVerified` helper (preferred per CLAUDE.md — extract it) or
  explicitly replicate the `ctx.verificationStore.write` pattern.
- **FR-007**: The bounds-check + revocation-check MUST be enforced **server-side on every completion path**
  (place-order, the rail verify handler, AND the MCP tool) — at the **seam** (FR-006), so a producer reaching
  `completeOrder` directly with an `intentMandate` is still fully checked, including a revocation that lands
  **between** rail-verify and `completeOrder` (TOCTOU).
- **FR-008**: The system MUST NOT trust any amount/balance in the grant; **catalog re-derivation is the price
  authority** (invariant 2). The bound payment amount MUST equal the re-priced total **and** be **≤
  `perActionCap`** on every path (invariant 3). **HNP re-pricing ignores membership/loyalty discounts** (full
  catalog price); the intent rail MUST NOT write `loyalty.applied`, and a grant MUST NOT obtain a discount
  without a backing per-order verification record.
- **FR-009**: The single-use **consume** MUST be an **atomic compare-and-set** keyed by the stable grant id,
  performed **transactionally with the record write inside the `completeOrder` branch** (not process-global —
  invariant 4). Name the seam that holds the consumed flag (extend `RevocationStore` to `{ revoked, consumed }`
  per grant, or a dedicated consume store). The in-memory variant is permitted **only** for the single-instance
  local demo behind the existing `allowEphemeralKey`-style fence and is **explicitly not a real control under
  multi-instance deployment** (real deployments require Redis/Upstash `SETNX`/Lua). Rationale: `completeOrder`
  idempotency is keyed by **order id**, so two concurrent redemptions producing two order ids would both pass
  without the per-grant atomic consume.
- **FR-010**: Introduce a new injected **`RevocationStore`** seam checked **fail-closed** on every redemption
  (store unreachable ⇒ refuse), exposing revoke + a **per-subject kill-switch** + a **"active grants"** listing.
  Wiring is **real glue, not zero-glue**: add it to `CeremonySeams` + `CeremonyContext` + the `mount()` resolver
  (and its fail-fast list) where the rail consults it, and to `CompletionContext` where the seam consults it, and
  budget the `app.locals.attesto` change in every composing host.
- **FR-011**: The completed-order record MUST carry a **`delegationId`** (a type change) linking every unattended
  completion back to its authorizing grant (the audit trail).
- **FR-012**: Add a new **orthogonal `presence` axis** (`"live" | "delegated-demo" | "delegated"`) carrying only
  *when consent happened*. Do **NOT** reuse `trust_level: "presence-only-demo"` for HNP: add a new weaker
  authorization-integrity value **`server-issued-demo`** (the issuance-vs-authorization rung), and v0.1 HNP MUST
  carry `presence: "delegated-demo"` + `trust_level: "server-issued-demo"`. This **amends** the `trust_level`
  docstring (strip the live-ceremony/nonce connotation, which now lives on the presence axis) and **Principle
  VII** (governance dependency). A *real* HNP control = `presence: "delegated"` AND `trust_level:
  "issuer-verified"`.
- **FR-013**: Delegation MUST be limited to **action effects** (`authorize` / custom action gates). Attribute
  gates (age, membership) MUST NOT be delegable: **age-restricted goods always step up** to a live ceremony and
  never complete unattended; membership discounts are ignored under HNP. There is no captured-identity
  re-enforcement.
- **FR-014**: Honesty MUST be expressed as **machine-checkable positives**: every HNP surface carries a mandatory
  `disclaimer` (e.g. *"server-issued; not user authorization; demo only — not a safety control"*) and carries
  **no** `authorizedByUser`/`userSigned` field; tests assert the disclaimer is present and the authorization
  field is absent on every enumerated surface. No HNP draw settles real value (the FR-006 suppression is the
  control). These are **disclosure-label** assertions, kept distinct from the **security bypass** tests.
- **FR-015**: The pre-existing suite MUST stay green, and **every security bypass test MUST fail with its control
  removed** (constitution; 003 FR-014; 004 FR-009). DCO sign-off on every commit.

### Key Entities

- **IntentMandate** — `type: "ap2.IntentMandate"`; the server-issued, single-use, bounded grant. Names the
  top-of-chain AP2 type (shape only; server-HMAC, not user-signed in v0.1).
- **Presence axis** — `live | delegated-demo | delegated`; *when* consent happened. Separate from `trust_level`
  (*how strongly* the authorization/credential is bound), which gains `server-issued-demo`.
- **RevocationStore** (extended to hold the per-grant **consumed** flag) — fail-closed per-grant state behind the
  active-grants surface + kill-switch; wired through the ceremony + completion seams.
- **Intent rail** — a new `ceremony/intent/` rail that verifies a grant (first pass) and projects into
  `completeOrder`, whose **additive `intentMandate` branch** re-checks every control at the seam.
- **CompletedRecord.delegationId** — the audit link from an unattended completion to its grant.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user pre-authorizes once (one live ceremony) and the agent then completes an in-bounds order
  **with no human present**, end-to-end on the single-server demo, with `delegationId` recorded and **no
  settlement** invoked (US1).
- **SC-002**: **100%** of the defined bypass conditions are refused with nothing recorded **when submitted
  directly to `completeOrder`/place-order/the MCP tool**, each control-dependent: over-cap, out-of-scope,
  expired, tampered-HMAC, consumed/replay, revoked, age-restricted (step-up), and over-step-up-threshold (US2).
  Removing any seam control turns its bypass test red.
- **SC-003**: A revoked grant (or per-subject kill-switch) refuses the **next** redemption; an unreachable
  revocation store refuses **fail-closed**; a revocation landing between rail-verify and `completeOrder` still
  refuses (US3).
- **SC-004**: The bound payment amount equals the catalog re-priced total **and ≤ `perActionCap`** on the HNP
  path (invariants 2 + 3); HNP applies no membership discount; no surface trusts an amount carried in the grant.
- **SC-005**: Two simultaneous redemptions of one single-use grant yield **exactly one** completion (atomic
  consume) (US1.2 + concurrency).
- **SC-006**: Every HNP surface reports `presence: "delegated-demo"` + `trust_level: "server-issued-demo"` + a
  non-empty `disclaimer`, exposes no user-authorization field, and the HNP `completeOrder` branch never invokes
  `ctx.settle` — each assertion control-dependent (US4).
- **SC-007**: `completeOrder` gains only the additive `intentMandate` branch + `delegationId`; the live rails are
  otherwise untouched and the full pre-existing suite stays green.

## Assumptions

- The stable injected `signingKey` seam (already required on serverless for the challenge token and the 004 cart
  mandate) is available wherever Intent Mandates are minted/verified (verified: `mount.ts`).
- A single-server, single-origin demo (this server's payee) suffices to demonstrate HNP end-to-end; no issuer,
  merchant discovery, or A2A fan-out is required.
- The injected `RevocationStore`/consume store defaults to in-memory for the local single-instance demo (behind
  the explicit ephemeral fence) and Redis/Upstash (atomic CAS) for any real deployment.

## Out of Scope (v0.2+)

- **Holder binding + per-draw proof-of-possession** (the grant is a bearer token in v0.1) — the v0.2/v0.3 line
  where invariant 6 becomes fully upheld.
- **User/agent-key signing** — the v0.2 bridge (widening `alg` + a two-format verify-dispatch).
  **Ratified direction (2026-07-08): two user-signing rails** — (a) **WebAuthn** passkey assertion over hash(bounds) and
  (b) an **on-device DPC (Multipaz)** presented via the DC API / OpenID4VP with the bounds in the transcript.
  **Issuer-verified credentials** — the v0.3 destination where an HNP grant becomes a *real* control (the DPC
  rail is the natural bridge: device-bound today, issuer-verifiable once the trust anchor lands — but **not
  trust-equivalent to the passkey rail until v0.3**; the asymmetry and its honesty obligations are pinned in
  FR-002).
- **Reusable spending envelopes** + **cumulative / velocity caps** + the **atomic per-grant ledger** — the next
  increment; a cumulative cap is only a real control with atomic compare-and-set.
- **Attribute-gate delegation** (age / membership) and any **captured-claim staleness** machinery — excluded by
  design (v0.1 has no credential-validity anchor; age steps up).
- **`presence` on `PaymentMandate`/other surfaces** — a broad cross-cutting type change; non-normative note only,
  out of this increment's test/SC obligations.
- **Full async step-up mode**, **multi-merchant / A2A fan-out**, **sub-delegation**, and **real settlement** of
  any HNP draw.

## Dependencies

- Builds on **004** (`ap2.CartMandate`, the reconciliation with `ap2.PaymentMandate`) and **003** (the mounted
  rails + the shared `completeOrder` + the per-order `VerificationStore`).
- **Governance (Decision 13) — flag for the maintainer:** depends on a **MINOR amendment** to the constitution
  covering **Principle II** (Context 1 performs no ceremony but *verifies a pre-existing delegation created in an
  earlier, separate ceremony*), **Principle III** (Consolidated checkout — HNP redeem has **no browser session**;
  reconcile), and **Principle VII** (the new `presence` axis, the `server-issued-demo` value, and
  `enforcedAt: "intent"`). It also disambiguates "verification_required envelope" vs "spending envelope" and
  decides the Mode-B `gated()` primitive's fate (decoupled from this increment; async step-up is out of scope).
  The amendment is a separate `/speckit-constitution` step, not performed by this spec.

## Constitution Check

- **Principle VII (Honesty in the types) — AMENDED, not merely satisfied:** v0.1 HNP gets its own `presence:
  "delegated-demo"` + `trust_level: "server-issued-demo"` (never reusing `presence-only-demo`), an explicit
  `disclaimer`, and is fenced harder than the live rails. The type/docstring edits + the presence axis are
  **in-scope work**, governed by the Decision-13 amendment.
- **Security Requirements (the six controls):** invariants **1–5 upheld** (FR-004/006/007/008/009/013/014).
  **Invariant 6 only PARTIALLY**: origin-bound + single-use, but **no holder binding and no per-draw PoP** — the
  grant is a bearer token (disclosed in FR-001/edge cases; holder-binding/PoP is v0.2/v0.3). Note: re-enforcing a
  captured snapshot would be *weaker* than invariant 5's contemporaneous positive claim — which is exactly why
  attribute delegation is excluded and age always steps up.
- **Principle II (three execution contexts) — REQUIRES amendment:** Context 1 now *verifies a pre-existing
  delegation* rather than *performs no credential ceremony*. **Principle III (Consolidated checkout) — strained:**
  HNP redeem has no single browser session. Both are recorded as the Decision-13 dependency, resolved before
  `/speckit-implement`.
