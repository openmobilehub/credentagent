# Implementation Plan: Gate Ceremony Extraction (attesto.mount)

**Branch**: `feat/attesto-gate-v0.1` | **Date**: 2026-06-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-gate-ceremony-extraction/spec.md`

## Summary

Extract the demo's real, working credential/payment **ceremony** (`payment-gate/`) into
`@openmobilehub/attesto-gate`'s `attesto.mount(app)` — all three rails (passkey same-device + caBLE,
Digital-Credentials payment, and the credential gate for age/membership) — so age + membership + payment run
**through the gate** instead of being faked in the storefront. This is an **extraction, not new behavior**: the
protocol flows already exist; the work is to move them behind the `mount()` seam, replace the demo's hardcoded
imports with **injected seams** (verification store, signing key, origin, order + completion), and have the demo
**consume** `mount()` (thin-consumer, exactly as it consumed the storefront in 002) with the full suite and live
deploy staying green. Trust stays **presence-only, fenced as demo** (Principle VII).

## Technical Context

**Language/Version**: TypeScript (NodeNext, `strict`), Node 20+ — matches the existing packages.

**Primary Dependencies**: `@modelcontextprotocol/sdk`, `express@5`, `@simplewebauthn/server` + `@simplewebauthn/browser` (WebAuthn rail, served same-origin), `zod`. Hedera/x402 settlement libs stay demo-side, invoked via an injected settlement seam. **No `@upstash/redis` dependency is added to the package** — a shared store is injected by the host (as the storefront does).

**Storage**: Injected stores (Principle: per-order, never global). Verification store (per-order age/membership/payment state), created-order store, cart store, completed-order store — in-memory default, host-injected shared/Redis on serverless. Challenge nonce is **stateless** (sealed HMAC token), not stored.

**Testing**: `vitest` + `supertest` for the mount()ed HTTP routes; fixture-based tests for WebAuthn verification (recorded registration responses); bypass tests for every security control (Security Requirements).

**Target Platform**: Node server and Vercel serverless (multi-instance). Ceremony page is a browser hand-off; no-GUI hosts get a link (documented limitation).

**Project Type**: npm **library** (`@openmobilehub/attesto-gate`) consumed by a web service (the demo) and by adopters; mirrors the 002 storefront extraction.

**Performance Goals**: Ceremony page interactive on mobile; settlement is demo-mode (Hedera testnet) and may take seconds — surfaced honestly, never blocking the gate logic.

**Constraints**: Serverless-safe — a **stable signing key** and **shared stores** must survive instance splits (the options→verify and place-order→poll requests may hit different instances; this is the class of bug already fixed in the storefront's order round-trip). All six Security Requirements hold. Presence-only trust fenced (Principle VII). `npm run build` + full `npm test` (253/1 skip) + live deploy green at every step. DCO on every commit.

**Scale/Scope**: ~28 ceremony source files extracted across 3 rails from `payment-gate/` into `packages/attesto-gate/src/`, plus the demo rewired to consume `mount()`.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Article | Verdict | How this feature complies |
|---|---|---|
| **I. Stripe-grade, MCP-idiomatic API** | ✅ PASS | `attesto.mount(app)` is one declarative call; the policy stays the single ordered array on `requirements()`. No injected-callback grab-bags — dependencies are explicit injected seams, each origin visible. |
| **II. Three execution contexts are sacred** | ✅ PASS | This feature *is* Context 2 (the page/phone where gates run). The MCP tool still only mints the link + reports requirements (Context 1); the poll reports completion (Context 3). `mount()` adds Context-2 routes only; it does not move ceremony work into the tool handler. |
| **III. Consolidated checkout flow** | ✅ PASS | One hand-off page serves all three rails; the buyer completes verifications + payment in one browser session. The agent orchestrates + polls, never runs the ceremony. |
| **IV. One ordered, conditional policy array** | ✅ PASS | `requirements(order, [required(age...).when(), optional(membership.discount()), required(payment.in())])` — array order = run order, payment settles last, amount derived server-side (re-priced from catalog), `.when()` predicate owned by the developer. |
| **V. Extensible to any credential** | ✅ PASS | The three rails are the built-in credentials (`age`/`membership`/`payment`); `defineCredential` + custom credentials by object are unaffected. mount() registers the ceremony for whatever credentials the policy names. |
| **VI. structuredContent is data, not policy** | ✅ PASS | `requirements()` stays the code→data boundary, emitting the flat manifest; mount() consumes the resolved manifest server-side; no functions cross the wire. |
| **VII. Honesty in the types; prefer simplicity** | ✅ PASS | `trust_level: "presence-only-demo"` is carried + fenced (FR-011, SC-006). Real KB-JWT signing + mdoc issuer-trust verification are explicitly deferred (v0.2) rather than overbuilt. |
| **Security Requirements (all six)** | ✅ PASS | Enforce on every completion path (FR-003); never trust the token / re-derive amounts (FR-004); discounts reconcile with amount binding (FR-005); per-order state (FR-006); explicit positive claims (FR-002); origin & replay binding (FR-007). Bypass tests required (FR-014). |

**Result: PASS — no violations.** Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/003-gate-ceremony-extraction/
├── plan.md              # This file
├── research.md          # Phase 0 — extraction decisions (grounded in the scoping spike)
├── data-model.md        # Phase 1 — mount() seams + entities
├── quickstart.md        # Phase 1 — runnable validation
├── contracts/
│   └── attesto-mount.api.md   # Phase 1 — the mount() public contract + ceremony routes
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
packages/attesto-gate/                 # the gate package gains the ceremony (extracted from payment-gate/)
├── src/
│   ├── client.ts                      # Attesto + mount(app): now wires the ceremony onto the host app
│   ├── credentials.ts                 # age / membership / payment + discount/gate/authorize effects (exists)
│   ├── requirements.ts / envelope.ts  # the code→data manifest boundary (exists)
│   ├── store.ts                       # VerificationStore (per-order) — extended/used by the rails (exists)
│   └── ceremony/                       # ← extracted from the demo's payment-gate/
│       ├── mount.ts                    # registers all rails onto app; reads injected seams; fails fast
│       ├── challengeToken.ts           # stateless sealed HMAC nonce (issue/verify)
│       ├── origin.ts                   # deriveOrigin(req) from x-forwarded-*
│       ├── mandate.ts                  # AP2-shaped mandate + the four deterministic gates
│       ├── completion.ts               # completeOrder seam (shared by all rails)
│       ├── passkey/                     # verify.ts, routes.ts, page.ts (WebAuthn same + caBLE)
│       ├── dc-payment/                  # request/verify/page/routes (DC API + OpenID4VP)
│       └── credential-gate/             # age + membership (OpenID4VP) — the GDC hero rail
├── package.json                        # exports "." and "./server" (+ ceremony served via mount)
└── ...

packages/attesto-storefront/           # consumes the gate via store.gate(...); checkout page LINKS to mount routes
payment-gate/                          # demo's original ceremony → becomes thin re-export shim, then removed (steered)
app.ts / server.ts                     # demo: consumes attesto.mount(store.app); thin consumer (US2 deep finish)
```

**Structure Decision**: The ceremony lives under `packages/attesto-gate/src/ceremony/`, registered by
`mount(app)`. Each rail mirrors the demo's existing `dcql`/`request`/`verify`/`page`/`routes` split and reuses
shared helpers (`challengeToken`, `origin`, `mandate`, `completion`) rather than copying them — same convention
`CLAUDE.md` mandates for a new gate. The demo's `payment-gate/` collapses to re-export shims that point at the
package (deletion is the steered follow-up, since `rm`/`git rm` is sandbox-blocked), so nothing imports a dead path.

## Complexity Tracking

> No Constitution violations — section intentionally empty.
