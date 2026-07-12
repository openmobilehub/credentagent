# Data Model — Quickstart Ladder (007)

No new persistent entities; the feature composes published contracts. Entities below are the
shapes the example exposes/consumes and the smoke asserts.

## Quickstart Example (the artifact)

| Field | Value | Rule |
| :-- | :-- | :-- |
| Hero file | `examples/quickstart/server.mjs` | ≤ ~35 lines hard stop (SC-006; plan watch item) |
| Wrapper | `api/index.mjs` | exports the same `app` — no code fork (FR-002) |
| Dependency manifest | `package.json` + committed lockfile | published `^0.2` only; no `workspace:`/`file:` links (FR-001) |
| Modes | local / deployed | `deployed = !!process.env.VERCEL` (R1) |

## Requires Manifest (asserted contract)

Emitted by `requirements()` — the code→data boundary (Constitution VI;
`packages/credentagent-gate/src/manifest.ts`). Flat, JSON-safe array; payment sorted last:

```
[{ credential: "age" | "membership" | "payment" | <custom>,
   required: boolean,
   effect: "gate" | "discount" | "authorize",
   label: string,
   minAge?: number }]
```

Smoke rules: whiskey cart → an entry with `credential: "age"`, `required: true`, `minAge: 21`;
headphones-only cart → **no** `age` entry; `payment` is the final entry in both.

## Cart Mandate (order transport, spec 004)

Opaque signed parameter minted with `GATE_SECRET` (deployed) or the ephemeral key (local).
State transitions the smoke exercises: minted → presented (completes on an instance with no
prior order state, `statelessOrders`) → **tampered → refused** (any line mutation invalidates
the signature; completion returns not-completed).

## Environment Contract

| Variable | Mode | Required | Effect |
| :-- | :-- | :-- | :-- |
| `GATE_SECRET` | deployed | **yes — boot fails without it** (US3.3) | stable HMAC/signing key shared across instances |
| `GATE_SECRET` | local | no | overrides the ephemeral per-process key |
| `PORT` | local | no (default 3005) | listen port |
| `VERCEL` | deployed | set by platform | selects deployed mode (R1) |
| `VERCEL_PROJECT_PRODUCTION_URL` | deployed | set by platform | public origin / `walletOrigin` (R4) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Upstash aliases accepted) | both | no | switches storage to published `redis` subpath (FR-004) |
| `SMOKE_URL` | smoke only | no | run assertions against a deployed URL instead of spawning locally (R3) |

## Hosted Demo (operational entity)

`credentagent-demo` Vercel project (root `examples/quickstart`, `GATE_SECRET` set) with alias
`credentagent-demo.vercel.app`; post-cutover also serves legacy `mcp-apps-nine.vercel.app`
(FR-009 order is binding: deploy → prod smoke → alias → banner+archive).
