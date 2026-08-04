# Implementation Plan: Identity-only delegated gate example

**Branch**: `011-delegated-verifier-identity` | **Date**: 2026-07-28 | **Spec**: [spec.md](./spec.md)

**Input**: Issue #141 (docs/example task; zero package changes).

## Summary

One new runnable example, `examples/delegated-verifier-identity/serve.mjs`: an MCP-shaped
"release-a-sealed-record" tool gated behind `required(age.over(21))` — no cart, no price, no
`payment.in(...)` — where the proof runs through the **external `DelegatedVerifier` seam** (a local
stand-in with **no `settle` member**). Plus one `examples/README.md` entry. Nothing under
`packages/` changes.

## Technical Context

**Language**: plain ESM JavaScript (`.mjs`), Node ≥ 20, run against the built workspace packages
(`npm run build:packages`) like every sibling example. **Dependencies**: `express` (already a root
devDependency, used by `bring-your-own-host.mjs`) + the two workspace packages. **Port**: 3009
(3005–3007 and 4100 are taken by siblings).

### Wiring (all existing API, verified against source)

- Seams via `defineHost({ catalog, orderStore, records, returnUrl, allowEphemeralKey })`
  ([`host.ts:108`](../../packages/credentagent-gate/src/host.ts)) — the "catalog" prices the
  record-release action at $0.
- The verifier seam is published on `app.locals.credentagent` **before** `host.publish(app)`
  (publish merges onto existing locals, [`host.ts:167`](../../packages/credentagent-gate/src/host.ts));
  zero-arg `credentagent.mount(app)` then picks up `locals.verifier`
  ([`client.ts:309`](../../packages/credentagent-gate/src/client.ts)) and the delegated rail
  registers ([`mount.ts:153`](../../packages/credentagent-gate/src/ceremony/mount.ts)). This keeps
  ONE verification store everywhere (mount only injects its own store when locals has none —
  invariant 4). `defineHost` not exposing `verifier` is a noted DX gap (spec, Out of scope).
- Identity-only completion: `policyHasPayment` false ⇒ no settle thunk
  ([`delegated-payment/routes.ts:165`](../../packages/credentagent-gate/src/ceremony/delegated-payment/routes.ts));
  pinned by [`delegated-payment.test.ts:508`](../../packages/credentagent-gate/src/ceremony/delegated-payment/delegated-payment.test.ts).
- Scripted walk-through drives the rail's real HTTP legs:
  `GET /credentagent/delegated/request?order=…` → `{ referenceToken }`
  → `POST /credentagent/delegated/verify { order, referenceToken }` → `{ completed, gates }`.
- Envelope refusal via `buildVerificationRequired` / `isVerificationRequired` / `ageDcql`, same as
  `gate-any-action.mjs`; approve URL is the delegated page, built in-file (manifest routes
  `gate`-effect links to the built-in rail by design — spec Decision 4).

## Constitution Check

*Gate instantiated against Constitution v1.2.0 (Principles I–VII + Security Requirements).*

| Article | Verdict | Notes |
| :-- | :-- | :-- |
| I — Stripe-grade, example-is-the-test | **PASS (watch item)** | The example IS the deliverable. Two bounded warts are declared, not dressed up: (a) the one-line `app.locals` verifier publish (defineHost gap — filed as follow-up, not silently worked around); (b) the hand-built delegated approve URL (manifest routing is an epic-#60 design question). If either grows past a commented line, stop and fix the API. |
| II — Three execution contexts | PASS | The tool handler only mints the link + typed refusal (Context 1); the ceremony runs on the mounted `/credentagent/delegated` page (Context 2); the re-call reads the completion record (Context 3). The scripted walk-through drives the page's own HTTP legs — it does not move ceremony logic into the tool. |
| III — Consolidated checkout | PASS (n/a) | No checkout; one handoff link to one ceremony page. |
| IV — One ordered policy array | PASS | Policy is exactly `[required(age.over(21))]`. No payment ⇒ nothing to order last; amount is $0, derived server-side from the action "catalog", never passed. |
| V — Extensible to any credential | PASS | Built-in `age` keeps the file minimal; README notes a `defineCredential` licence gate drops into the same slot. |
| VI — structuredContent is data | PASS | The envelope refusal is plain JSON (`buildVerificationRequired`); no functions cross the wire. |
| VII — Honesty in types/copy | **PASS (binding copy rule)** | The stand-in reports `trust_level: "presence-only-demo"` verbatim; file + README carry the S6 fence (no real adapter yet, `multipaz-utopia#16`). No copy may present the gate as a real safety control. |
| Security Requirements | PASS | Release happens ONLY off the completed record the shared completion wrote (enforce-on-every-path); the $0 amount is re-derived from the catalog (never the token); state keyed per request id; `underage` mode proves the 18+-for-21+ refusal (explicit positive claims); the reference token stays sealed/order-bound (rail behavior, untouched). |
| Workflow gates | PASS | Spec cites real file:line; DCO on every commit; "done" claimed only after the walk-through runs green in all three VERDICT modes. |

No violations → Complexity Tracking omitted.

## Project Structure

```text
specs/011-delegated-verifier-identity/
├── spec.md              # approved
├── plan.md              # this file
└── tasks.md             # task list

examples/
├── delegated-verifier-identity/
│   └── serve.mjs        # the example (hero file — the whole deliverable)
└── README.md            # + one "Gating patterns" entry
```

No research.md / data-model.md / contracts: the feature adds no API surface, no storage, no
endpoints — every contract it exercises already exists and is cited above.

## Validation

1. `npm run build:packages` green.
2. `node examples/delegated-verifier-identity/serve.mjs` — walk-through prints refusal → completed
   ceremony (no settlement field) → released record.
3. `VERDICT=underage node …/serve.mjs` and `VERDICT=declined node …/serve.mjs` — refusal printed,
   release log empty.
4. `git diff --stat main -- packages/` is empty (SC-003).
5. Both package vitest suites untouched and green (`npm run test` per workspace) — belt-and-braces
   that nothing under `packages/` moved.
