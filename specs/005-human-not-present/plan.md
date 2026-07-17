# Implementation Plan: HNP First Increment — the shared gate seams (Option B)

**Branch**: `005-human-not-present` | **Date**: 2026-07-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification `specs/005-human-not-present/spec.md`, the ratified
[`sequencing-fork-memo.md`](sequencing-fork-memo.md) (**Option B — wallet-custody, seams-first**), and
[`connector-architecture-design.md`](connector-architecture-design.md) §9–§11. Prototype:
[`spike/intent-mandate/`](../../spike/intent-mandate/) (ES256 `K_s` + `checkDraw` + 13 tests).

## Summary

Ship the **first increment of HNP under Option B**: the four **signer-agnostic shared gate seams** in
`credentagent-gate` that both the GDC demo and the eventual wallet server depend on — built once, in service of
the wallet-custody model, **without** the merchant-side minting rail on top.

1. **Draw-verification envelope** (`checkDraw`) — a **pure, total** function that verifies a proposed
   **Payment Mandate draw** against an **Intent Mandate**'s canonical bounds: signature over the bounds →
   window → scope-contains → re-priced total ≤ cap → step-up threshold → single-use → returns a **typed refusal
   list** (never throws, never first-fails). Signer-agnostic: it verifies a signature over `canonical(bounds)` —
   the spike's **ES256 `K_s`** (the B target) via an injected verifier, HMAC still possible.
2. **`completeOrder` draw branch** — an **additive, fail-closed** branch on the shared completion seam that
   **re-runs** `checkDraw` + revocation + an **atomic single-use consume** server-side (never trusting an
   upstream verify), writes a `delegationId` onto the completion record, and **suppresses real settlement**.
3. **Revocation store** — an injectable `RevocationStore` seam (default in-memory) keyed per `intentId` with a
   per-subject kill-switch; **fail-closed** (unreachable ⇒ refuse) and TOCTOU-safe (re-checked at the seam).
4. **Typed-refusal vocabulary** (§9) — the shared refusal enum (`over-cap`, `out-of-scope`, `expired`,
   `bad-signature`, `consumed`, `step-up-required`, `revoked`, `replay`) with `enforcer` / `retryable` tags,
   used identically on every surface.

This **productizes** `spike/intent-mandate/` (already B-shaped: asymmetric `K_s`, content-addressed `intentId`,
`checkDraw`) into the library, and reuses existing primitives (`mandate.ts` AP2 shapes, `VerificationStore`
pattern, the shared `completeOrder`, `jose`).

**Out of scope this increment (later, per the memo's build order):** the settlement verifier (UPay-style,
increment 2), the **wallet server** (`credentagent-wallet`, Kotlin/JVM — increment 3, sibling repo), the thin
`credentagent-agent` (increment 4), and the **HTTP intent rail / approve page** (arrives with the wallet
connector). The **merchant-side server-HMAC minting rail is dropped** under Option B.

## Technical Context

**Language/Version**: TypeScript, Node ≥ 20, ESM (the `@openmobilehub/credentagent-gate` workspace).

**Primary Dependencies**: existing only — `jose` (ECDSA P-256 / ES256 verify + JWK, already used by the
OpenID4VP rails), the gate's own `mandate.ts`, `store.ts` (`VerificationStore`), `completion.ts`
(`completeOrder`). **No new runtime dependency.**

**Crypto / identity**: the delegate key **`K_s`** is **ES256 (P-256)** — the spike's model and the B target
(the wallet server holds `K_s`; the signed bounds name its public key). Verification is **signer-agnostic**:
`checkDraw` takes an injected `verifyBounds(sig, canonicalBounds) → bool` so the HMAC path remains expressible.
Identity is **content-addressed**: `intentId = "int_" + b64url(SHA-256(canonical(bounds \ intentId)))`; the
canonical encoding is deterministic (sorted keys, no floats-as-strings drift).

**Storage**: injectable `RevocationStore` (default in-memory `Map`), mirroring `VerificationStore` — inject a
shared store for multi-instance. **Fail-closed**: a store read that throws refuses the draw (never opens).

**Testing**: `vitest` (gate package). Bypass tests per bound (over-cap · out-of-scope · expired · bad-signature
· consumed · step-up · revoked) submitted **directly to `completeOrder` / place-order**, not only the rail
(FR US2 scenario 8); a **TOCTOU** test (revoke lands between verify and complete → seam still refuses); an
**atomic single-use** test (two concurrent draws → exactly one completes); **age-always-step-up** (an
age-restricted cart never completes from a grant). **Each bypass test MUST go red when its control is removed.**

**Target Platform**: Node (library). **Project Type**: Library — npm workspace `credentagent-gate`.

**Performance Goals**: `checkDraw` is a pure O(lines) function; one signature verify + O(1) revocation/consume
store ops per draw. Zero cost on the existing HP paths (the branch is only taken when a draw is present).

**Constraints**: (1) **Additive + fail-closed** — HP paths unchanged; the draw branch only activates on a draw.
(2) **Re-derive amounts from the catalog** — never a price carried in the grant (Inv #2). (3) **Scope state per
`intentId`/order** — never process-global (Inv #4). (4) **Explicit positive bound checks** — over-cap/scope are
real controls; age-restricted **always** steps up (Inv #5, "delegate actions, not identity"). (5) **No
settlement** — `ctx.settle` suppressed for the demo-fenced draw; honesty label per `connector-arch` §11.
(6) DCO sign-off. (7) **Signer-agnostic envelope** — no hard dependency on HMAC or ES256 in `checkDraw` itself.

**Scale/Scope**: Small–medium — extend `mandate.ts` with the Intent/Payment-draw types + `checkDraw`
(ported from the spike), one `RevocationStore` seam, one additive `completeOrder` branch, one shared refusal
module, and their bypass-test files. No HTTP surface, no new backend.

## Constitution Check

*GATE: Must pass before Phase 0. Re-checked after design.* Instantiated against the CredentAgent SDK Constitution
(Principles I–VII + Security). **⚠️ Prerequisite:** Decision-13 requires a **MINOR amendment to Principles II,
III, VII** ([`constitution-amendment-draft.md`](constitution-amendment-draft.md)) — a separate
`/speckit-constitution` step **before `/speckit-implement`**. The rows below assume that amendment lands.

| Gate | Assessment |
| :-- | :-- |
| **I. Stripe-grade, MCP-idiomatic API** | ✅ One typed `IntentMandate` + a pure `checkDraw`; injectable `RevocationStore` mirrors the existing `VerificationStore` seam. No callback grab-bags. |
| **II. Three execution contexts sacred** | ⚠️→✅ *with amendment* — HNP adds a **fourth, no-live-human** completion path; the amendment names it explicitly rather than bending "three contexts". |
| **III. Consolidated checkout flow** | ⚠️→✅ *with amendment* — the draw redeems **through the same `completeOrder`**; the amendment records the additive branch as in-policy, not a second flow. |
| **IV. One ordered policy array / amount server-derived** | ✅ Reinforced — the draw re-prices from the catalog and derives the payment amount from the re-priced total; the grant carries bounds, never a price. |
| **V. Extensible to any credential** | ✅ The Intent Mandate bounds a **scope** of effects; `payment` is one — the same envelope bounds any delegable action effect. Age/membership explicitly **non-delegable**. |
| **VI. structuredContent is data** | ✅ Refusals are typed data (`enforcer`/`retryable`), not prose. |
| **VII. Honesty in types; prefer simplicity** | ⚠️→✅ *with amendment* — the honesty axis moves from `server-issued-demo` to **`delegated` presence + `issuer-verified (demo PKI)`** (B); the amendment records the new axis. Simplicity: reuse `mandate.ts`, the store pattern, `completeOrder`; defer the rail + wallet server. |
| **Security — enforce on every completion path (Inv #1)** | ✅ **The gate this increment defends.** The draw branch re-checks at `completeOrder`; the bypass test submits a bad draw **directly to the seam** and must be refused. |
| **Security — never trust the token; re-derive (Inv #2)** | ✅ Re-price from catalog; the grant's bounds are re-verified, never a balance/price trusted from the blob. |
| **Security — per-subject/per-intent state (Inv #4)** | ✅ Revocation + single-use consume key off `intentId`/subject; no process-global state. |
| **Security — positive claims / step-up (Inv #5)** | ✅ Age-restricted ⇒ **always** step-up; over-cap/scope are positive, explicit refusals. |
| **Security — origin/replay (Inv #6)** | ⚠️ **Partial (named)** — v0.1 seams enforce disclosure+binding+bounds, not issuer/device trust; fenced per honesty label until the wallet-server increment wires DeviceKey PoP. |
| **Dev workflow & quality gates** | ✅ Plan cites real code + the spike; bypass tests required and must fail red when the control is removed; `npm run build`+`test` green before "done"; DCO. |

**Result: PASS conditional on the Decision-13 amendment** (Principles II/III/VII). Invariant 6 is **partial by
design** and honesty-fenced. Residual items → Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/005-human-not-present/
├── plan.md                          # This file
├── spec.md                          # Feature spec (+ Option-B reconciliation callout)
├── sequencing-fork-memo.md          # RATIFIED: Option B, seams-first
├── connector-architecture-design.md # §9 refusals · §10 pivot · §11 honesty labels
├── intent-bounds-schema-draft.md    # AP2 + EUDI TS12 bounds fields
├── redemption-choreography-draft.md # the six-call redeem sequence
├── constitution-amendment-draft.md  # Decision-13 (Principles II/III/VII) — prerequisite
├── checklists/requirements.md       # Spec quality checklist
└── tasks.md                         # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/credentagent-gate/src/ceremony/
├── mandate.ts            # EXISTING (AP2 mandate + deterministic gates) — EXTEND:
│                         #   IntentMandate + PaymentMandate(draw) types; canonical(bounds);
│                         #   contentAddressId(); checkDraw(intent, draw, ctx) → Refusal[]
│                         #   (pure/total; signer-agnostic verifyBounds seam). Ported from spike/intent-mandate.
├── refusals.ts           # NEW — the §9 typed-refusal vocabulary (enum + enforcer/retryable tags),
│                         #   shared by checkDraw, the completeOrder branch, and (later) the rail.
├── revocation.ts         # NEW — RevocationStore seam (per-intentId + per-subject kill-switch);
│                         #   MemoryRevocationStore default; fail-closed; mirrors store.ts/VerificationStore.
├── completion.ts         # EXISTING completeOrder — ADD an additive, fail-closed DRAW branch:
│                         #   re-run checkDraw + revocation + ATOMIC single-use consume; write delegationId;
│                         #   suppress ctx.settle. HP paths untouched.
├── mandate.test.ts       # EXTEND / NEW — checkDraw bounds tests (port the spike's 13 + the FR US2 scenarios)
└── completion.test.ts    # EXTEND — draw-branch BYPASS tests: bad draw direct-to-completeOrder refused;
                          #   TOCTOU revoke; atomic single-use; age-always-step-up. Each red-when-control-removed.
```

**Structure Decision**: The seams land entirely in `credentagent-gate`, extending the existing `mandate.ts`
(which already holds the AP2 mandate + deterministic gates) rather than adding a rail directory — because this
increment ships **no HTTP surface**. The Intent/Payment-draw types + `checkDraw` port directly from
`spike/intent-mandate/` (already ES256/`K_s`-shaped); `RevocationStore` mirrors the `VerificationStore` seam so
multi-instance deploys inject a shared store; the `completeOrder` draw branch is additive and fail-closed so
every existing HP path is byte-unchanged. The HTTP **intent rail** (`ceremony/intent/` with the
`dcql/request/verify/page/routes` split) and the **wallet server** are deliberately deferred to the next
increments per the ratified build order.

## Complexity Tracking

| Item | Why it's allowed / how it's fenced |
| :-- | :-- |
| **Constitution Principles II/III/VII need a MINOR amendment** | Tracked as Decision-13; a separate `/speckit-constitution` step gates `/speckit-implement`. The plan does not proceed to implement until it lands. |
| **Invariant 6 only partially met** | By design for v0.1 seams (disclosure/binding/bounds, not issuer/device trust). Named + honesty-fenced (`connector-arch` §11); closed in the wallet-server increment (DeviceKey PoP). |
| **Signer-agnostic envelope (extra seam)** | Small cost, deliberate: keeps `checkDraw` reusable by the wallet server's ES256 `K_s` and the HMAC path without a rewrite. |
