# Tasks: Quickstart Ladder (`examples/quickstart` + hosted demo cutover)

**Input**: [spec.md](./spec.md) (approved) · [plan.md](./plan.md) · [research.md](./research.md) ·
[data-model.md](./data-model.md) · [contracts/quickstart-surface.md](./contracts/quickstart-surface.md) ·
[quickstart.md](./quickstart.md)

**Conventions**: every commit DCO-signed (`git commit -s`). The smoke assertions (a–e) are
security-bearing — a smoke that would still pass with the control removed is a defect
(Constitution, Workflow gates). Hero-file budget: ≤ ~35 lines or stop and fix the package API
(plan, Principle-I watch item).

## Phase 1: Setup

- [X] T001 Scaffold `examples/quickstart/package.json` — `"type": "module"`, scripts `start`
      (`node server.mjs`) and `smoke` (`node smoke.mjs`), dependencies
      `@openmobilehub/credentagent-gate@^0.2` + `@openmobilehub/credentagent-storefront@^0.2`
      (registry only — FR-001), devDependency `@modelcontextprotocol/sdk`; run `npm i` inside the
      dir and commit the generated `examples/quickstart/package-lock.json`.

## Phase 2: Foundational (blocking all stories)

- [X] T002 Write the hero file `examples/quickstart/server.mjs`: deployed-mode split
      (`!!process.env.VERCEL`; fail-fast without `GATE_SECRET` incl. the
      `openssl rand -hex 32` recipe — R1/US3.3), `createStorefront({ signingKey, storage })`
      with env-conditional `redisStorage` (R5, ≤3 lines), `new CredentAgent({ statelessOrders:
      deployed, walletOrigin })` with origin from `VERCEL_PROJECT_PRODUCTION_URL` (R4),
      `mount(store.app)`, the FR-002 policy array (age→membership→payment, payment last —
      Constitution IV), `export const app`, `listen(PORT ?? 3005)` only when local. Budget ≤ ~35
      lines.
- [X] T003 [P] Add `examples/quickstart/api/index.mjs` (2 lines: import `app`, default-export)
      and `examples/quickstart/vercel.json` (rewrite `/(.*)` → `/api`, `maxDuration: 60`) per R4.

**Checkpoint**: `cd examples/quickstart && npm i && npm start` boots from a clean clone with no
repo-root build (US2 acceptance 1).

## Phase 3: User Story 1 — Try it: the gate contract works (P1)

**Goal**: the storefront + gate behave per the contract, provable by machine and by conversation.
**Independent test**: `npm run smoke` green locally; whiskey vs headphones script observable in an
MCP host.

- [X] T004 [US1] Write `examples/quickstart/smoke.mjs` — spawns `server.mjs` (or targets
      `SMOKE_URL` when set — R3) and asserts contract rows **a–c**: MCP `initialize` via SDK
      `Client` + `StreamableHTTPClientTransport` (pattern: `examples/_smoke.mjs`); whiskey
      checkout → `requires` contains `age` (`required: true`, `minAge: 21`, payment last);
      headphones checkout → no `age` entry. Non-zero exit on any failure.
- [X] T005 [US1] Extend `examples/quickstart/smoke.mjs` with security rows **d–e**: unverified
      completion POST → 403/refused (Security Req. 1); tampered cart mandate (mutate a line,
      replay — technique from `examples/stateless-orders/demo.sh`, R6) → refused. Verify each
      assertion FAILS when its control is bypassed (e.g. run once against a build with the gate
      policy emptied) before trusting it.
- [X] T006 [US1] Manual pass per `quickstart.md` rung-2 script: add `http://localhost:3005/mcp`
      to Claude Code or Goose; whiskey surfaces age-21+, headphones doesn't (SC-004); hero file
      line-count ≤ ~35 (SC-006).

**Checkpoint**: US1 fully provable on localhost — this is the MVP.

## Phase 4: User Story 2 — Run it: docs + CI make the 5-minute claim true (P1)

**Goal**: a stranger's clean machine reproduces rung 2 in ≤ 3 commands; CI enforces it forever.
**Independent test**: `quickstart-smoke` CI job green on a runner that never runs the monorepo
build.

- [X] T007 [P] [US2] Write `examples/quickstart/README.md` — the three-rung ladder with time
      budgets, per-host connect instructions (Claude custom connector, Claude Code
      `claude mcp add --transport http shop <url>`, ChatGPT, Goose Streamable-HTTP), the
      whiskey-vs-headphones script, the **honesty fencing** (presence-only-demo — binding,
      Constitution VII), and "going further" links (`custom-credential.mjs`,
      `storefront-redis.mjs` + tunnel, `with-x402-settlement.mjs`) per
      `contracts/quickstart-surface.md` copy constraints.
- [X] T008 [P] [US2] Add the `quickstart-smoke` job to `.github/workflows/ci.yml` — independent
      of `build-test`: checkout → setup-node 22 (cache keyed on
      `examples/quickstart/package-lock.json`) → `cd examples/quickstart && npm ci && npm run
      smoke`.
- [X] T009 [P] [US2] Root `README.md`: quickstart section leads with rung 1 (hosted URL) and
      links `examples/quickstart/README.md`; fix stale `npm run build:packages` → `npm run
      build` in `examples/README.md` and add the quickstart to its index (FR-008).

**Checkpoint**: fresh-clone CI proves US2 without human hands.

## Phase 5: User Story 3 — Own it: deployable by button, safe when stateless (P1)

**Goal**: one click → their own gated storefront; serverless correctness enforced.
**Independent test**: a fresh Vercel deployment passes `SMOKE_URL=<url> npm run smoke` (a–e).

- [X] T010 [US3] Add the Deploy button to `examples/quickstart/README.md` using the exact
      clone-URL from `contracts/quickstart-surface.md` (`root-directory=examples/quickstart`,
      `env=GATE_SECRET`, `envDescription` recipe, `envLink` → #own-it anchor).
- [X] T011 [US3] Add the fail-fast check to the smoke or a tiny assert step: `VERCEL=1 node
      server.mjs` without `GATE_SECRET` exits non-zero with the actionable message (US3.3) —
      wire it into `npm run smoke` so CI covers it.
- [X] T012 [US3] **Maintainer-gated**: create Vercel project `credentagent-demo` (root
      `examples/quickstart`, `GATE_SECRET` set), then `SMOKE_URL=https://credentagent-demo.vercel.app
      npm run smoke` → a–e green including tamper-on-stateless (FR-009 steps 1–2; quickstart.md
      rung-1 order is binding).

**Checkpoint**: hosted demo of record live and smoke-verified.

> **As executed (2026-07-12)**: instead of a separate `credentagent-demo` Vercel project, the quickstart
> was promoted to production on the existing `mcp-apps` project — so `mcp-apps-nine.vercel.app` serves it
> directly (T013's re-point collapsed into the promote; prod smoke green on the alias). Open item: claim
> `credentagent-demo.vercel.app` as a second alias on this project so the README's canonical URL resolves,
> or update the READMEs to the nine URL.

## Phase 6: User Story 4 — Partner links keep working (P2)

**Goal**: cutover with zero broken partner-held URLs.
**Independent test**: legacy alias serves the new deployment; old repo archived + readable.

- [X] T013 [US4] **Maintainer-gated**: re-point the `mcp-apps-nine.vercel.app` alias to the
      `credentagent-demo` deployment; rerun `SMOKE_URL=https://mcp-apps-nine.vercel.app npm run
      smoke` (SC-005; FR-009 step 3 — only after T012 green).
- [ ] T014 [US4] Open the banner PR in `openmobilehub/mcp-apps-shopping-demo`: README banner
      "This demo became CredentAgent → github.com/openmobilehub/credentagent (quickstart:
      examples/quickstart)"; after merge, **maintainer** runs `gh repo archive
      openmobilehub/mcp-apps-shopping-demo` (FR-009 step 4; archive, never delete).

## Phase 7: Polish & cross-cutting

- [ ] T015 [P] File the R5 DX follow-up issue on `openmobilehub/credentagent`: storefront
      "storage from standard env" convenience so the hero loses its 3 Redis lines
      (Principle I — fix the API, not the example).
- [ ] T016 Update `STATUS.md` per house rules: 007 into Done log with linked commits; add the
      cutover decisions (T012/T013/T014 maintainer gates) to "Decisions for you" until executed.
- [ ] T017 Open the PR from `007-quickstart-ladder` (same-repo branch — automated review runs),
      confirm `claude-review` + `ci` (incl. `quickstart-smoke`) green, request human review.

## Dependencies & execution order

```
T001 → T002 → T003(P w/ nothing) → T004 → T005 → T006   [US1 = MVP]
T002..T006 → { T007 ∥ T008 ∥ T009 }                      [US2]
T007 → T010 → T011 → T012 (maintainer)                   [US3]
T012 → T013 (maintainer) → T014 (maintainer archive)     [US4]
T015 anytime after T002 · T016/T017 last
```

**Parallel opportunities**: T003 with T004-prep; T007/T008/T009 fully parallel; T015 anytime.

**MVP scope**: Phases 1–3 (T001–T006) — a locally provable gated quickstart with the full
security smoke. Everything after is docs, CI, and rollout.
