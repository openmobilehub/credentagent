# Intent rail — tasks

**Design**: [intent-rail-design.md](intent-rail-design.md). Branch `005-intent-rail` (off the seams). TDD;
bypass tests red-when-removed; review-before-commit; draft PR (no merge).

## Phase A — mount glue (the revocation seam)
- [ ] **T101** `CeremonySeams` + `CeremonyContext` gain `revocation` (default `MemoryRevocationStore` behind the
  `allowEphemeralKey` single-process fence; shared CAS store for real deploys). Thread through `mountCeremony`.
  Test: mount without a revocation store on a single-process app → gets the memory default; the seam is on ctx.

## Phase B — mint (compose + seal the grant)
- [ ] **T102** `ceremony/intent/mint.ts`: `mintGrant(opts, ctx) -> { grant, delegateKey }` — compose the
  v0.1 server bounds (merchant, perOrder, total, window?, honesty labels), `generateDelegate` + `sealIntent`.
  Test: bounds content-address; honesty labels present (`delegated-demo` / `server-issued-demo`).

## Phase C — the agent-facing operations (the testable core)
- [ ] **T103** `ceremony/intent/redeem.ts`: `redeemDraw({ intent, draw }, ctx) -> SpendResult` — fail-closed if
  no revocation store → isRevoked → checkDraw (via the shared verifier) → run the draw through **the shared
  completion seam** → typed result. Never a rail-local completion path (invariant 1 / choke point).
- [ ] **T104** Revoke + list: `revokeGrant(intentId, ctx)`, `activeGrants(subject?, ctx)` over the store.
- [ ] **T105** Bypass tests (`redeem.test.ts`) — each red-when-removed, submitted straight to the handler:
  unsigned/tampered → `signature`; over-cap/out-of-scope/expired/replay/consumed distinct; age → always
  `step-up`; revoked → refused; store-unreachable → fail-closed; TOCTOU; concurrent single-use → exactly one.

## Phase D — HTTP surface
- [ ] **T106** `ceremony/intent/routes.ts`: `registerIntentRail(app, ctx)` — the 5 endpoints wiring B/C;
  redeem/revoke/grants as JSON; delegate page GET. Thread `?cart=` on every hop. Add to `RAILS[]` in mount.
- [ ] **T107** `ceremony/intent/page.ts`: minimal delegate approve page (shows the bounds; instant-demo mint).
- [ ] **T108** Route-level tests (supertest): redeem endpoint refuses a bad draw with the right JSON; a good
  draw completes; revoke then redeem → refused.

## Phase E — surface + docs
- [ ] **T109** Export the agent-facing types/functions; gate README + `docs/reference/api.md` gain the rail;
  an `examples/hnp-rail/` snippet at the Stripe-grade bar. Full build + test green; review-before-commit; PR.

**One open integration decision for the reviewed build** (flagged in the design): how the host binds
`completeOrder`'s ctx so the rail's `ctx.revocation` and the completion's revocation are the SAME instance
(single-use must be atomic across both). Options: mount injects a shared store into a mount-built completion,
or the host wires it. Resolve with the maintainer — do not guess in the autonomous slice.
