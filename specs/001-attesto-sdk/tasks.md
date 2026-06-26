---
description: "Task list — Attesto SDK v0.1"
---

# Tasks: Attesto SDK v0.1

**Input**: Design documents from `specs/001-attesto-sdk/` — `plan.md`, `spec.md`, `research.md`,
`data-model.md`, `contracts/attesto-gate.api.md`, `quickstart.md`. Governance: `.specify/memory/constitution.md` (v1.0.0).

**Tests**: YES — TDD requested (Constitution: security-bypass paths MUST be tested; a test that passes
without the control is useless). The 7 contract tests in `contracts/attesto-gate.api.md` are written FIRST.

**Organization**: by user story so each is an independently testable increment.

## Format: `[ID] [P?] [Story] Description`
- **[P]**: parallelizable (different files, no dep on incomplete tasks)
- **[Story]**: US1 / US2 / US3
- Paths: package = `packages/attesto-gate/src/`; demo (harness) = repo root.

## User stories (derived from the spec)

- **US1 (P1 — MVP)**: A developer gates a checkout tool with a **conditional age** requirement — an
  age-restricted cart returns a serializable `verification_required` manifest (no completable link); a
  non-alcohol cart passes through. *Independently testable via `checkout-gate.test.ts` + `manifest.test.ts`.*
- **US2 (P2)**: The **full ordered policy** — `optional` membership discount + `required` payment that
  settles **last**, resolved into one manifest. *Testable via the required/optional + ordering contract tests.*
- **US3 (P3)**: **Extensibility** — add a custom credential (a `prescription` gate, conditional via
  `appliesTo`) with `defineCredential`. *Testable via the prescription `appliesTo` contract test.*

**Hard constraints (all phases)**: consolidated Mode A only; presence-only trust (real verifier deferred);
`requires` is plain JSON (functions never cross the wire); preserve the six security invariants; do NOT
break the live Vercel build / served origin; `npm run build` + `npm test` (excluding `.worktrees`) green
per task; DCO sign-off (`git commit -s`).

---

## Phase 1: Setup

- [ ] T001 Refactor `packages/attesto-gate/src/` into the module layout from `plan.md` — `client.ts`,
      `credentials.ts`, `manifest.ts`, keep `envelope.ts`; rebuild `index.ts` exports. Split the existing
      `index.test.ts`: move the envelope wire-shape asserts to `packages/attesto-gate/src/envelope.test.ts`,
      drop the old string-builder asserts (replaced in T006). Build stays green.
- [ ] T002 [P] Add the public types from `data-model.md` to `packages/attesto-gate/src/types.ts`
      (`AttestoOptions`, `GateOrder`/`OrderLine`, `Credential`, `Step`, `Effect`, `VerificationManifestEntry`, `DcqlQuery`).

## Phase 2: Foundational (blocking — the primitives every story needs)

- [ ] T003 [P] Contract test (serialization + honesty): `JSON.stringify(requirements(...))` round-trips
      with **no functions**, AND every entry carries `enforcedAt` + `trust_level` (CT8) — in
      `packages/attesto-gate/src/manifest.test.ts`.
- [ ] T004 [P] Contract test (ordering): a payment-bearing step resolves **last** even when declared
      earlier, in `packages/attesto-gate/src/manifest.test.ts`.
- [ ] T005 [P] Contract test (type-safety): `age.over(21).in("usd")` is a **compile error** (expect-error
      test) in `packages/attesto-gate/src/types.test-d.ts`.
- [ ] T006 Implement builders + `.when()`/`appliesTo` + `defineCredential` + `dcql` + effects
      (`gate()`/`discount()`/`authorize()` as tagged data) + the `required(c)`/`optional(c)` wrappers in
      `packages/attesto-gate/src/credentials.ts`. **Remove** the string-based `requireCredential` /
      `optionalCredential` and the legacy string `Step` (clean break — type-incompatible, 0.x package).
- [ ] T007 Implement `requirements()` resolver (run predicates, drop inapplicable, payment-last, emit the
      flat manifest) in `packages/attesto-gate/src/manifest.ts` → T003/T004 green.
- [ ] T008 Implement the `Attesto` client constructor + `requirements()` delegation in
      `packages/attesto-gate/src/client.ts`.
- [ ] T009 Keep `envelope.ts` (`buildVerificationRequired`/`isVerificationRequired`/`ageDcql`) as the
      Mode-B/roadmap primitive and `gated()` as a deprecated shim; re-export from `index.ts`. Keep the
      envelope **wire-shape** assertions in `packages/attesto-gate/src/envelope.test.ts` (the
      `_attesto`/`present.min_age`/`trust_level` checks moved out of `checkout-gate.test.ts` per T001).

**Checkpoint**: package builds + foundational contract tests green.

## Phase 3: User Story 1 — conditional age gate (P1, MVP)

**Goal**: an age-restricted, unverified cart → `requires` with an `age` `gate` (+ per-order `approveUrl`)
and no completable link; a non-alcohol cart → a normal link. **Independent test**: `checkout-gate.test.ts`.

- [ ] T010 [US1] Contract test (conditional drop): non-alcohol cart ⇒ no `age` entry; add an alcohol line
      ⇒ `age` at `minAge:21` with an `approveUrl` bound to that order id, in `packages/attesto-gate/src/manifest.test.ts`.
- [ ] T011 [US1] Contract/bypass test (MCP layer, in-memory transport): `checkout` for an age-restricted
      unverified cart returns the manifest (age `gate`) and **no checkout link**; approveUrl decodes to the
      same `order.id`; fails-closed if the gate is removed — in `checkout-gate.test.ts`.
- [ ] T012 [US1] Implement `age.over(n).when()` resolution + the age manifest entry + `approveUrl`
      derivation (`walletOrigin + order.id`) in `packages/attesto-gate/src/manifest.ts` / `credentials.ts`.
- [ ] T013 [US1] Implement `attesto.mount(app)` to mount the **existing** `/credential-gate` ceremony +
      `verificationStore` (do NOT reimplement OpenID4VP/mdoc; keep `payment-gate/credential-gate/verify.ts`
      fail-closed checks) in `packages/attesto-gate/src/client.ts`, wired in `app.ts`.
- [ ] T014 [US1] Wire `server.ts` checkout tool to `attesto.requirements(order, [required(age.over(21).when(hasAlcohol))])`.
      Enrich the `GateOrder` lines with `minimumAge` **re-derived from the catalog** server-side (inv #2 — the
      real `PricedCartLine` doesn't carry it); the grounded predicate is `hasAlcohol = (o) => o.lines.some(l => l.minimumAge != null)`
      (alcohol items have `minimumAge: 21`). Return the manifest in `structuredContent.requires`.
- [ ] T015 [US1] Verify: `npm run build` green (deploy-safe) + `checkout-gate.test.ts` green; commit (DCO).

**Checkpoint**: US1 is a shippable MVP — the gate works end to end in the demo.

## Phase 4: User Story 2 — full ordered policy (P2)

**Goal**: `optional(membership.discount(10))` + `required(payment.in("usd"))` resolve into the manifest,
payment last; the demo shows age + membership + pay cards.

- [ ] T016 [US2] Contract test (required vs optional): `optional(membership)` never blocks; `required`
      entries present; in `packages/attesto-gate/src/manifest.test.ts`.
- [ ] T017 [US2] Implement `membership.discount(n)` (optional; reconciled to `LOYALTY_DISCOUNT_PCT`) and
      `payment.in(cur)` (amount **derived** from the order, resolves last) in `packages/attesto-gate/src/credentials.ts`.
- [ ] T018 [US2] Extend the `server.ts` checkout policy to `[required(age…), optional(membership.discount(10)), required(payment.in("usd"))]`;
      assert manifest order (payment last) in `checkout-gate.test.ts`.
- [ ] T019 [US2] Verify build + `npm test` (excluding `.worktrees`) green; commit (DCO).

**Checkpoint**: the three built-ins resolve in one ordered, conditional policy.

## Phase 5: User Story 3 — extensibility (P3)

**Goal**: a custom `prescription` gate (`effect: gate()`, `appliesTo` Rx lines) drops into the same policy.

- [ ] T020 [US3] Contract test (custom `appliesTo`): a `prescription` credential appears only for an Rx
      line, absent otherwise; in `packages/attesto-gate/src/credentials.test.ts`.
- [ ] T021 [US3] Implement the `defineCredential` resolution path (custom credential in the policy, run
      `appliesTo`, honor `effect`) in `packages/attesto-gate/src/manifest.ts`.
- [ ] T022 [US3] Add the worked prescription example + an Rx fixture (a `requiresRx` flag on a test
      product), proving it gates only Rx; in `packages/attesto-gate/src/credentials.test.ts`.
- [ ] T023 [US3] Verify build + tests green; commit (DCO).

**Checkpoint**: "gate any credential" proven by a real custom example.

## Phase 6: Polish & cross-cutting

- [ ] T024 [P] Update repo-root `README.md` to the v0.1 API and point its usage section at
      `specs/001-attesto-sdk/quickstart.md` (README is stale — early `gated()` shape).
- [ ] T025 [P] No-regression check on the discovery surface: `/llms.txt` + `/.well-known/attesto.json`
      (`attesto-discovery.ts`) still serve and don't contradict the v0.1 manifest (incl. `enforcedAt` /
      `trust_level`). (The discovery surface is repo-level, not part of the SDK contract — keep it honest,
      no new shape claims.)
- [ ] T026 [P] Re-run the existing completion-path bypass tests (`app.test.ts`, passkey/dc-payment) to
      confirm the six security invariants still hold (every completion path 403s an unverified order).
- [ ] T027 Deprecate `gated()` — `@deprecated` JSDoc + a one-time console warning; keep one minor version,
      in `packages/attesto-gate/src/index.ts`.
- [ ] T028 Final gate: `npm run build` green + full `npm test` green (excluding `.worktrees`); confirm no
      change to the Vercel build pipeline / served origin. Optionally run `/speckit-analyze`.

---

## Dependencies

- **Setup (T001–T002)** → everything.
- **Foundational (T003–T009)** → all user stories (the builders + resolver + client + types).
- **US1 (T010–T015)** → MVP; depends only on Foundational.
- **US2 (T016–T019)** → depends on US1's resolver/client (extends the policy + manifest).
- **US3 (T020–T023)** → depends on Foundational + the resolver; independent of US2.
- **Polish (T024–T028)** → after the stories it documents/verifies.

## Parallel opportunities

- Foundational tests **T003, T004, T005** in parallel (different test files).
- Polish **T024, T025, T026** in parallel (README / discovery / security-regression — different files).
- US2 and US3 can proceed in parallel after US1 (US3 doesn't depend on US2).

## Implementation strategy

- **MVP = US1** (Phases 1–3): the conditional age gate working end-to-end in the demo, with the
  serialization + bypass + ordering contract tests. Ship/validate this first.
- Then **US2** (full ordered policy) and **US3** (extensibility) as independent increments.
- **Polish** last — but T024 (README→quickstart sync) and T025 (discovery) keep the docs honest with the
  shipped API, and T026/T028 are the security + deploy-safety gates that must pass before "done."
