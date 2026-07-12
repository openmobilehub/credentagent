# Research — Quickstart Ladder (007)

All Technical-Context unknowns resolved. Each entry: Decision / Rationale / Alternatives.

## R1 — Deployed-mode detection & key policy

**Decision**: `const deployed = !!process.env.VERCEL` selects deployed mode. Deployed + no
`GATE_SECRET` → throw at boot with an actionable message (including the
`openssl rand -hex 32` recipe). Local mode falls back to the ephemeral per-process key.

**Rationale**: Vercel sets `VERCEL=1` in build + runtime; it's the same signal the old demo's
`api/index.ts` family relies on (`VERCEL_PROJECT_PRODUCTION_URL` for the origin). An ephemeral
key on serverless is a *correctness* bug (per-instance keys mint mutually-unverifiable
mandates), so fail-fast is the only honest behavior (spec US3.3, edge case "Local ≠ deployed").

**Alternatives**: `NODE_ENV=production` (false positives locally; not set by all hosts);
always-require `GATE_SECRET` (kills the zero-config local rung, violates SC-002).

## R2 — Deploy-to-Vercel button with a monorepo subdirectory

**Decision**: use the clone-flow URL with `root-directory`:
`https://vercel.com/new/clone?repository-url=…/openmobilehub/credentagent&root-directory=examples/quickstart&env=GATE_SECRET&envDescription=…&project-name=credentagent-demo`.

**Rationale**: `root-directory` is a documented Deploy Button parameter
([vercel.com/docs/deploy-button/build-settings](https://vercel.com/docs/deploy-button/build-settings);
confirmed pattern `…&root-directory=apps/frontend` in Vercel's own support examples). `env=GATE_SECRET`
makes the flow prompt for the secret; `envDescription` carries the recipe.

**Alternatives**: repo-root `vercel.json` routing into the example (pollutes the library repo and
breaks FR-001's self-containment); a separate template repo (rejected in brainstorming — third
repo to maintain).

## R3 — Smoke harness for `/mcp`

**Decision**: `examples/quickstart/smoke.mjs`, a plain Node script using
`@modelcontextprotocol/sdk` (`Client` + `StreamableHTTPClientTransport`) for the MCP assertions,
and raw `fetch` for the two bypass probes. It spawns `server.mjs` itself when pointed at
localhost (default) or runs against any `SMOKE_URL` (used for the FR-009.2 prod smoke).

**Rationale**: `examples/_smoke.mjs` already establishes this exact client pattern in-repo; a
plain script keeps vitest (and any build step) out of the example's dependency surface, and the
same script serves CI, local dev (`npm run smoke`), and the production cutover check.

**Alternatives**: vitest suite in the example (adds a test framework to a "look how small" demo);
raw JSON-RPC fetch for everything (re-implements the SDK's session/stream handling for no gain).

## R4 — Vercel serving shape

**Decision**: `server.mjs` exports the Express `app` (and only calls `listen()` when not
deployed); `api/index.mjs` is `import { app } from "../server.mjs"; export default app;`;
`vercel.json` rewrites `/(.*)` → `/api` with `maxDuration: 60`.

**Rationale**: byte-for-byte the pattern the old demo runs in production today
(`mcp-apps-shopping-demo/api/index.ts` + `vercel.json`) — minus its `includeFiles` monorepo
carve-outs, which are unnecessary here because the example's own `node_modules` carries the
published packages. Public origin resolves from `VERCEL_PROJECT_PRODUCTION_URL` (same precedent)
so `walletOrigin` is correct on any deployment, including rung-3 clones.

**Alternatives**: Vercel's zero-config Express detection (implicit, and the old demo already
proved the explicit wrapper); building a `dist/` (violates "runs directly").

## R5 — Accepted plumbing in the hero file (Principle I watch item)

**Decision**: the hero file accepts two bounded plumbing blocks — the R1 mode split (~4 lines)
and env-conditional Redis storage (~3 lines: read `KV_REST_API_URL`/`KV_REST_API_TOKEN` (Upstash
aliases too), pass `redisStorage({url, token})` else `undefined`). Budget: hero ≤ ~35 lines
hard stop. File a follow-up issue: the storefront should grow a first-class
"storage from standard env" convenience so the next example loses those 3 lines.

**Rationale**: FR-004 requires env-only activation today; the constitution says fix the API
rather than dress the example — the issue records exactly that, without blocking 007 on a
package release.

**Alternatives**: hide Redis in the wrapper (forks local vs deployed behavior — violates
FR-002); omit Redis entirely (violates FR-004); ship the package convenience first (couples 007
to a release train it doesn't need).

## R6 — Tampered-mandate probe

**Decision**: the smoke's tamper assertion reuses the `examples/stateless-orders/demo.sh`
technique: complete a checkout flow to obtain the signed cart param, mutate a line
(price/quantity), replay, and assert the completion is refused.

**Rationale**: that demo exists precisely to prove the fail-closed property (spec 004 FR-007);
reusing its probe keeps the assertion honest (it fails if the control is removed — the
CLAUDE.md test bar).

**Alternatives**: unit-testing mandate verification (already covered in the gate package; the
smoke's job is the deployed surface).
