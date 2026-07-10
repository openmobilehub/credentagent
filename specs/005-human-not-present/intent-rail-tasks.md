# Intent rail — tasks

**Design**: [intent-rail-design.md](intent-rail-design.md). Branch `005-intent-rail` (off the seams). TDD;
bypass tests red-when-removed; review-before-commit; draft PR (no merge).

**Status (autonomous slice):** Phases A–C built + tested (11 bypass tests green, full gate suite 224/224,
independently reviewed before commit). Phases D–E deferred for maintainer review (HTTP wiring returns `K_s`
to the agent; the `IntentStore` seam is a prerequisite — see the DX punch-list #9).

## Phase A — mount glue (the revocation seam)  ✅ built
- [x] **T101** `CeremonySeams` + `CeremonyContext` gain `revocation` (default `MemoryRevocationStore` behind the
  single-process fence; shared CAS store for real deploys). Threaded through `mountCeremony`. Green.

## Phase B — mint (compose + seal the grant)  ✅ built
- [x] **T102** `ceremony/intent/mint.ts`: `mintGrant(opts) -> { grant, delegateKey }` — composes the v0.1 server
  bounds, `generateDelegate` + `sealIntent`. Tests: bounds content-address; honesty labels present
  (`delegated-demo` / `server-issued-demo`) as **checked literals** (honesty-in-types, punch-list #4).

## Phase C — the agent-facing operations (the testable core)  ✅ built
- [x] **T103** `ceremony/intent/redeem.ts`: `redeemDraw({ intent, order, draw }, ctx) -> RedeemResult` — runs the
  draw through **the shared completion seam** (the authority: re-verifies signature/bounds, re-checks revocation
  fail-closed/TOCTOU-safe, atomic single-use consume, suppresses settlement), adds only the running balance.
  Never a rail-local completion path (invariant 1 / choke point).
- [x] **T104a** Revoke: `revokeGrant(intentId, ctx)` + `revokeSubject(subject, ctx)` over the store.
- [ ] **T104b** List: `activeGrants(subject?)` — **deferred**, not implementable over the current
  `RevocationStore` (it tracks revoked-ids + committed draws, not the minted set). Needs the `IntentStore` seam
  (punch-list #9). Flagged in `redeem.ts`.
- [x] **T105** Bypass tests (`redeem.test.ts`, 9) — each red-when-removed, over a real `completeOrder`:
  tampered → `signature`; over-cap / out-of-scope / replay / over-total distinct; age → always `step-up`;
  revoked → refused; store-unreachable → fail-closed. (TOCTOU + concurrent single-use covered at the seam.)

## Phase D — HTTP surface  ⬜ deferred (maintainer review — key custody over HTTP)
- [ ] **T106** `ceremony/intent/routes.ts`: `registerIntentRail(app, ctx)` — endpoints under
  `/credentagent/intents/*` mirroring the SDK verbs: `POST /intents` (preApprove), `POST /intents/:id/spend`,
  `POST /intents/:id/revoke`, `GET /intents` (needs `IntentStore`), `GET /intents/new`. Thread `?cart=` on every
  hop. Add to `RAILS[]`. **Bake the `Idempotency-Key` contract in (punch-list #1) before this ships.**
- [ ] **T107** `ceremony/intent/page.ts`: minimal pre-approval page (shows the bounds; instant-demo mint).
- [ ] **T108** Route-level tests (supertest): `/spend` refuses a bad draw with the right JSON; a good draw
  completes; revoke then spend → refused.

## Phase E — surface + docs  ⬜ deferred
- [ ] **T109** Export the agent-facing types/functions; gate README + `docs/reference/api.md` gain the rail;
  an `examples/hnp-rail/` snippet at the Stripe-grade bar. Full build + test green; review-before-commit; PR.

**One open integration decision for the reviewed build** (flagged in the design): how the host binds
`completeOrder`'s ctx so the rail's `ctx.revocation` and the completion's revocation are the SAME instance
(single-use must be atomic across both). The revocation seam (T101) is built with this contract documented on
`RedeemContext`; the wiring itself (mount injects a shared store into a mount-built completion, or the host
wires it) is the D-phase decision. Resolve with the maintainer — not guessed in the autonomous slice.
