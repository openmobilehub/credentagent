# Tasks: Identity-only delegated gate example

**Input**: [spec.md](./spec.md) (approved) · [plan.md](./plan.md)

**Conventions**: every commit DCO-signed (`git commit -s`). Zero diffs under `packages/` (SC-003).
The walk-through's refusal assertions are security-bearing: verify each fails when its control is
bypassed (run once with `VERDICT=ok` expectations against a refusal mode) before trusting it.

## Phase 1: The example (US1 + US2)

- [X] T001 Write `examples/delegated-verifier-identity/serve.mjs`:
      - $0 action "catalog" (`sealed-record`, `minimumAge: 21`) + in-memory request/release stores;
      - `defineHost({ catalog, orderStore, records, returnUrl, allowEphemeralKey: true })`;
      - stand-in `DelegatedVerifier` (`buildRequest` + `consume`, **no `settle` member**) with
        `VERDICT=ok|underage|declined` modes, `trust_level: "presence-only-demo"`;
      - verifier published on `app.locals.credentagent` before `host.publish(app)` (commented as
        the defineHost DX gap), zero-arg `credentagent.mount(app)`;
      - MCP-shaped `release-record` tool: unproven → `buildVerificationRequired` envelope pointing
        at `/credentagent/delegated?order=…`; proven (completed record exists) → release;
      - `/dev/release` browser route (US3);
      - scripted walk-through at boot: envelope → `GET …/delegated/request` →
        `POST …/delegated/verify` → re-call tool; prints refusals in `underage`/`declined` modes;
      - honesty fence comments (FR-005).
- [X] T002 Validate per plan §Validation: all three `VERDICT` modes; confirm the `underage` and
      `declined` runs release nothing; confirm `git diff --stat main -- packages/` is empty.

## Phase 2: Docs

- [X] T003 Add the `examples/README.md` entry under **Gating patterns** — the identity twin of
      [`delegated-verifier/`](../../examples/delegated-verifier/): same external-checker backend, no
      cart/price/payment, money path provably never fires (FR-006), honesty fence included.

## Phase 3: Ship

- [X] T004 Update `.specify/feature.json` → `specs/011-delegated-verifier-identity`.
- [X] T005 Commit (DCO), push same-repo branch (CLAUDE.md: don't fork), open the PR against `main`
      following `.github/pull_request_template.md`; link issue #141 with `Closes #141`; note the
      two declared DX warts (defineHost `verifier` gap; identity-route-to-delegated-page question →
      epic #60) as candidate follow-up issues for the maintainer.
