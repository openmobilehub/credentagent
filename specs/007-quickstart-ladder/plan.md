# Implementation Plan: Quickstart Ladder (`examples/quickstart` + hosted demo cutover)

**Branch**: `007-quickstart-ladder` | **Date**: 2026-07-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-quickstart-ladder/spec.md`

## Summary

Add `examples/quickstart/` — a standalone example consuming the **published**
`@openmobilehub/credentagent-{gate,storefront}@^0.2` packages — presented as a three-rung ladder
(try hosted / run local / deploy your own). One hero server file serves both local (`:3005/mcp`)
and Vercel (2-line `api/` wrapper + rewrites); deployed mode turns `statelessOrders` on and
fail-fasts without `GATE_SECRET`. A CI smoke job boots the example against the published packages
and asserts the gate contract (age fires for whiskey, not headphones; unverified/tampered
completions refused). Rollout re-points `mcp-apps-nine.vercel.app` to the new `credentagent-demo`
deployment, then banners + archives the old demo repo.

## Technical Context

**Language/Version**: Node ≥ 20 (CI runs 22), plain ESM JavaScript (`.mjs`) — the example must run
directly, no build step.

**Primary Dependencies**: `@openmobilehub/credentagent-gate@^0.2`,
`@openmobilehub/credentagent-storefront@^0.2` (published registry versions — never workspace
links); devDependency `@modelcontextprotocol/sdk` (smoke client only).

**Storage**: in-memory by default; optional Upstash/Vercel-KV Redis via
`KV_REST_API_URL`/`KV_REST_API_TOKEN` through the published `credentagent-storefront/redis` subpath.

**Testing**: `examples/quickstart/smoke.mjs` (plain Node script: spawns the server, drives `/mcp`
with the MCP SDK client, asserts FR-006 a–e, exits non-zero on failure) + a new `quickstart-smoke`
CI job. The monorepo vitest suites are untouched.

**Target Platform**: local Node process + Vercel serverless functions (multi-instance, no shared
process memory).

**Project Type**: standalone example app + docs + CI job inside the existing monorepo.

**Performance Goals**: rung time budgets are the product metric — SC-001 ≤ 3 min, SC-002 ≤ 5 min /
≤ 3 commands, SC-003 ≤ 10 min. Cold-start must fit Vercel's function window (wrapper sets
`maxDuration: 60`, mirroring the old demo).

**Constraints**: hero file reads in one screen (≈30 lines, SC-006); no code fork between local and
deployed (FR-002); no auth on `/mcp` (edge case: ChatGPT/Goose need a plain public endpoint);
security invariants + honesty fencing unchanged.

**Scale/Scope**: 1 new example dir (~6 files), 1 CI job, 3 doc touch-ups (root README, examples
README stale script, STATUS.md), 1 operational rollout checklist. No package source changes.

## Constitution Check

*Gate instantiated against Constitution v1.1.0 (Principles I–VII + Security Requirements).*

| Article | Verdict | Notes |
| :-- | :-- | :-- |
| I — Stripe-grade, example-is-the-test | **PASS (watch item)** | The hero file IS the deliverable. Two small plumbing blocks are accepted and bounded: the deployed-mode split (`VERCEL` + `GATE_SECRET` fail-fast, ~4 lines) and env-conditional Redis storage (~3 lines). Research R5 records the DX gap and the follow-up (a `storage`-from-env convenience in the storefront package) — fix the API later, don't grow the example. If implementation pushes the hero past ~35 lines, stop and fix the package API instead. |
| II — Three execution contexts | PASS | The example only wires existing rails: tool mints link + manifest, page runs ceremonies, poll reports. No ceremony in the tool handler. |
| III — Consolidated checkout | PASS | Unchanged `mount()` rails; one handoff link. |
| IV — One ordered policy array | PASS | Hero policy is exactly `[required(age.over(21).when(…)), optional(membership.discount(10)), required(payment.in("usd"))]` — payment last, predicate explicit. |
| V — Extensible to any credential | PASS (n/a) | Built-ins only; README links `custom-credential.mjs` as "going further." |
| VI — structuredContent is data | PASS | The smoke asserts the serializable `requires` manifest — the code→data boundary is the tested contract. |
| VII — Honesty in types/copy | **PASS (binding copy rule)** | The ladder README MUST carry the presence-only-demo fencing: the age gate is a flow demo, not a safety control, until issuer-verified trust lands. No marketing copy may overclaim. |
| Security Requirements | PASS | FR-005/FR-006(d,e) assert enforcement + tamper refusal; `statelessOrders` keeps state per-order (signed mandate), never process-global; deployed key handling is fail-fast (US3.3). |
| Workflow gates | PASS | DCO on every commit; spec cites real files; deploy claimed done only after prod smoke (FR-009.2). |

No violations → Complexity Tracking omitted.

## Project Structure

### Documentation (this feature)

```text
specs/007-quickstart-ladder/
├── spec.md              # approved
├── plan.md              # this file
├── research.md          # Phase 0 — decisions R1–R6
├── data-model.md        # Phase 1 — entities + env contract
├── quickstart.md        # Phase 1 — validation guide (per-rung + smoke)
├── contracts/
│   └── quickstart-surface.md   # endpoints, env vars, smoke assertions, deploy-button URL
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
examples/quickstart/
├── server.mjs           # the hero file (~30 lines): storefront + policy + mode split
├── api/index.mjs        # 2-line Vercel wrapper: import { app } … export default app
├── vercel.json          # rewrites → /api, functions maxDuration
├── package.json         # published deps ^0.2; scripts: start, smoke
├── package-lock.json    # committed — CI runs npm ci against the registry
├── smoke.mjs            # FR-006 assertions (spawns server locally; also runs vs a URL)
└── README.md            # the three-rung ladder + honesty fencing + going-further links

.github/workflows/ci.yml # + quickstart-smoke job (independent of build-test; no workspace build)
README.md                # rung-1 hosted URL leads the quickstart section
examples/README.md       # quickstart entry + fix stale `build:packages` → `build`
STATUS.md                # session update per house rules
```

**Structure Decision**: the example is self-contained under `examples/quickstart/` with its own
`package.json`/lockfile so `npm ci` resolves only published registry packages (FR-001) and the
Vercel project can set Root Directory to this folder (R2, R4). Nothing under `packages/` changes.

## Phase Outcomes

- **Phase 0** ([research.md](./research.md)): R1 deployed-mode detection (`VERCEL` env) · R2
  deploy-button `root-directory` support confirmed · R3 smoke harness = MCP SDK client
  (`examples/_smoke.mjs` precedent) + raw fetch for bypass probes · R4 Vercel wrapper pattern
  (old demo `api/index.ts` precedent) · R5 accepted plumbing lines + DX follow-up · R6 tamper
  probe reuses the `stateless-orders` demo technique.
- **Phase 1**: [data-model.md](./data-model.md) (entities + env contract),
  [contracts/quickstart-surface.md](./contracts/quickstart-surface.md) (the testable surface),
  [quickstart.md](./quickstart.md) (per-rung validation incl. the FR-009 rollout checklist).
- **Phase 2**: `/speckit-tasks` generates `tasks.md`; implementation follows with the smoke
  written before the example is declared done (test-first on the security assertions).
