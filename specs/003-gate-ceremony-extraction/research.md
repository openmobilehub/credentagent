# Phase 0 Research — Gate Ceremony Extraction

Grounded in the scoping spike (`docs/superpowers/research/2026-06-27-003-ceremony-extraction-scope.md`, 4 ceremony
area maps) and the five maintainer decisions. No open `NEEDS CLARIFICATION` remain.

## D1 — Which rails ship in `mount()` v1

- **Decision**: All three — passkey (same-device + cross-device caBLE), Digital-Credentials payment, and the
  credential gate (age + membership).
- **Rationale**: GDC is a "real library" release; the hero demo (age blocks, membership discounts) needs the
  credential-gate rail, and a complete story needs payment. The rails already exist and work in the demo.
- **Alternatives**: passkey-only (the spike's terse default) — rejected: it ships payment but not the
  age/membership the maintainer flagged as top priority.

## D2 — Order resolution seam

- **Decision**: **Injected store** (id → order), default in-memory, host-injected shared/Redis on serverless.
  Amounts are **always re-derived from the catalog** server-side regardless of how the order is fetched.
- **Rationale**: Consistent with the extracted storefront (`createdOrderStore`), already proven serverless-safe
  in today's checkout round-trip fix. Re-pricing (not the token) is the source of truth → Security Req "never
  trust the token" holds either way.
- **Alternatives**: URL-encoded order token (the demo's current scheme) — kept working via decode for back-compat,
  but the **store seam is the contract** mount() depends on. *(FR-010: confirm at this plan stage — confirmed.)*

## D3 — Digital-Credentials completion path

- **Decision**: dc-payment completes through the **shared `completeOrder`** seam, identical to passkey.
- **Rationale**: "Do all rails" means one completion code path (idempotent record + re-price + optional settlement
  + cart/verification clear). A second completion path would risk the discount/amount-binding reconciliation
  (Security Req) drifting between rails.
- **Alternatives**: inline dc-payment completion — rejected (duplicate logic, reconciliation risk).

## D4 — Trust level

- **Decision**: **Presence-only, fenced as demo.** Real protocol flows (WebAuthn attestation, OpenID4VP,
  sealed/time-limited nonce, origin/RP-ID binding) are verified; the AP2 mandate is dev-signed (not key-bound) and
  there is **no issuer/device-signature trust verification**. Honesty surfaces say so.
- **Rationale**: Principle VII + Security Requirements: ship the honest current state, fenced, never sold as a
  safety control. Defer complexity.
- **Alternatives**: real KB-JWT signing / mdoc issuer-trust verification now — deferred to v0.2 (overbuild risk,
  not needed for GDC's honest demo).

## D5 — Discount ownership

- **Decision**: The **gate owns the `membership.discount` effect**; the storefront's `priceCart` applies it to the
  order total. One discount mechanism end-to-end.
- **Rationale**: Kills the storefront-flag divergence (the `feat/storefront-loyalty-discount` branch). Keeps line
  sum = total = payment amount across all paths (Security Req "discounts reconcile with amount binding").
- **Alternatives**: storefront-local loyalty flag — rejected (divergent second mechanism; contradicts the gate's
  effect model, Principle V).

## D6 — Serverless signing key + state (extraction-specific)

- **Decision**: A **stable signing key** (`GATE_SECRET` or equivalent, injected) is required wherever options and
  verify may hit different instances; per-process random is acceptable only for a single long-running process /
  local dev. Verification + order + completion state use injected shared stores on serverless.
- **Rationale**: The map showed `challengeToken` is stateless (good) but signed with a key that must be stable
  across instances; and the verification/order state must be shared — the same instance-split class of bug already
  fixed for the storefront order round-trip. `mount()` MUST fail fast if a required seam is missing (FR-009).
- **Alternatives**: rely on warm single-instance — rejected (Vercel fluid compute splits requests; unreliable).

## D7 — Extraction mechanics (rm-blocked)

- **Decision**: Move ceremony code into `packages/attesto-gate/src/ceremony/`; collapse the demo's `payment-gate/`
  files to **thin re-export shims** pointing at the package so no import path dies. Actual file deletion is a
  steered follow-up (`rm`/`git rm` are sandbox-blocked).
- **Rationale**: Preserves every existing import + test while removing duplicated *logic* (no drift). Mirrors the
  US2 catalog.ts approach that stayed green.
- **Alternatives**: big-bang delete + rewrite imports — rejected (sandbox-blocked deletion; higher regression risk).

## D8 — Test strategy

- **Decision**: `vitest` + `supertest` against the mount()ed routes; fixture-based WebAuthn verification (recorded
  responses); **bypass tests** for each control (unverified age-restricted order refused on every path; tampered
  amount refused; replayed/expired nonce rejected; cross-order state isolation; 18+ ≠ 21+; discounted total
  reconciles). A test that still passes with the control removed is rejected (FR-014, Security Req).
- **Rationale**: The demo's `payment-gate/` already has page/route/verify/fixture tests; extraction must carry them
  and keep the full suite at 253/1-skip baseline.
- **Alternatives**: happy-path-only — rejected (would not pin the security invariants).
