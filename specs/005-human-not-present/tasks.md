# Tasks: HNP First Increment — the shared gate seams (Option B)

**Input**: [plan.md](plan.md) (ratified 2026-07-08) · [spec.md](spec.md) (Group-A ratified) ·
constitution **v1.1.0** (Decision-13 amendment applied — the `/speckit-implement` gate is OPEN)

**Discipline** (constitution · Development Workflow): TDD; every security-bypass test MUST go red when its
control is removed (spot-verified during implementation); DCO on every commit; build + full suite green
before "done".

## Phase A — Typed refusals (the shared vocabulary)

- [ ] **T001** `src/ceremony/refusals.ts` (NEW): the §9/choreography-draft discriminated refusal —
  `code` union (`signature · intent-mismatch · currency-mismatch · over-cap · over-total · not-yet-valid ·
  expired · out-of-scope · unpermitted-presentment · replay · step-up · revoked · consumed ·
  revocation-unavailable`), `enforcer: "wallet" | "merchant" | "psp"` (attribution), `retryable: "retry" |
  "needs-human" | "terminal"` (the bit an unattended loop branches on), per-reason detail fields. Pure data.

## Phase B — Intent bounds + checkDraw (port `spike/intent-mandate/`)

- [ ] **T002** Extend `src/ceremony/mandate.ts`: `IntentBounds` + `Draw` types (typed `ap2.IntentMandate`
  bounds per `intent-bounds-schema-draft.md`), `canonical()` (stable recursive key sort),
  `contentAddressId()` / `sealIntent()` (`int_` + b64url(SHA-256(canonical(bounds \ intentId)))),
  ES256 (P-256, WebCrypto) draw signing/verification with a **signer-agnostic injectable verifier**,
  `checkDraw(intent, draw, ctx) → { ok, refusals }` — pure, total, never throws, accumulates (no first-fail).
- [ ] **T003** `src/ceremony/mandate.intent.test.ts` (NEW): port the spike's 13 tests to vitest/TS —
  content-addressing commits to every field · canonical order-independence · in-bounds passes · over-cap
  (documents the co-fire finding) · over-total · window both edges · out-of-scope merchant · replay ·
  unpermitted-presentment (age never delegable) · step-up is `needs-human` · tamper-after-sign refused ·
  wrong-key refused · refusals accumulate.

## Phase C — RevocationStore seam

- [ ] **T004** `src/ceremony/revocation.ts` (NEW): `RevocationStore` interface — `isRevoked(intentId,
  subject?)`, `revoke(intentId)`, `revokeSubject(subject)` (kill-switch), `priorDraws(intentId)`,
  **`commitDraw(intentId, draw)` atomic check-and-append** (returns false on duplicate
  `pspTransactionId` — the single-use control; per-order idempotency does NOT cover two orders drawing one
  intent). `MemoryRevocationStore` default (mirrors `MemoryVerificationStore`); multi-instance deploys
  inject Redis/CAS.
- [ ] **T005** Revocation tests (in T007's file or standalone): revoke → next draw refused ·
  kill-switch by subject · commitDraw atomicity (same pspTransactionId twice → second false).

## Phase D — `completeOrder` draw branch (additive, fail-closed)

- [ ] **T006** Extend `src/ceremony/types.ts` + `completion.ts`: `CompletionInput.draw?: { intent, draw }`;
  `CompletionContext.revocation?: RevocationStore`, `now?()`; `CompletedRecord.delegationId?`;
  `CompletionResult.refusals?`. Branch order (only when `input.draw` present, HP paths byte-unchanged):
  missing store ⇒ refuse fail-closed → `isRevoked` (throw ⇒ `revocation-unavailable`, fail-closed) →
  `checkDraw` with store-sourced `priorDraws` → existing catalog re-price stays authoritative →
  **draw.amount must equal the re-priced total** (invariants 2+3) → **age-restricted ⇒ always `step-up`**
  (never completes from a grant; invariant 5) → **atomic `commitDraw`** (false ⇒ `consumed`/`replay`) →
  write record with `delegationId = intentId` → **suppress `ctx.settle`** for the demo-fenced draw.
- [ ] **T007** `completion.test.ts` EXTEND — bypass tests, each control-dependent (spot-verify red):
  in-bounds draw completes: `delegationId` written, settle spy NOT called · over-cap draw direct to
  `completeOrder` refused, nothing recorded · tampered signature refused · revoked refused (incl. TOCTOU:
  revocation lands after a passing pre-check → seam still refuses) · store-throws ⇒ fail-closed refuse ·
  two draws, one `pspTransactionId`, two order ids ⇒ exactly one completes · age-restricted cart via draw ⇒
  refused `step-up` even with `ageVerified` in the verification store · amount-mismatch (draw.amount ≠
  re-priced total) refused.

## Phase E — Surface + docs

- [ ] **T008** Export the new types/functions from `src/index.ts`; gate README gains a short
  "Delegated draws (HNP seams, v0-preview)" section with the honesty labels (presence axis per
  constitution VII v1.1.0).
- [ ] **T009** Full suite green (`npm run build` + `npm test`); red-verification spot checks recorded in
  the PR body; draft PR referencing this tasks.md (progress is tracked on the epic's sub-issues —
  there is no status file to update).

**Out of scope** (per plan): HTTP intent rail, wallet server, settlement verifier, `credentagent-agent`.
