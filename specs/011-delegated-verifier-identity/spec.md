# Feature Specification: Identity-only delegated gate example

**Feature Branch**: `011-delegated-verifier-identity` · **Created**: 2026-07-28 · **Status**: Approved (docs/example task)

**Input**: Issue [#141](https://github.com/openmobilehub/credentagent/issues/141) — raised in review on
PR #103 and explicitly scoped there as a follow-up example, not a feature. Part of the
delegated-verifier epic #60.

## Overview

The project's thesis is **"identity leads; payments is one application"** — but the only example of
the external-verifier seam ([`examples/delegated-verifier/serve.mjs`](../../examples/delegated-verifier/serve.mjs))
tells a **shopping** story: an outside checker verifies a card and (simulated) money moves.

The other half is missing: using the same outside checker to **prove who someone is, with no
purchase at all** — release a sealed record, confirm a licensed professional — and **nobody is
charged anything**.

The rail already supports it, and the behavior is pinned:
[`delegated-payment.test.ts:508`](../../packages/credentagent-gate/src/ceremony/delegated-payment/delegated-payment.test.ts)
(*"an identity-only delegated gate (no payment) completes with NO settlement call"*) — `settle?()`
is optional on `DelegatedVerifier` ([`ceremony/types.ts`](../../packages/credentagent-gate/src/ceremony/types.ts)),
and the verify handler only builds a settle thunk when `policyHasPayment(...)` is true
([`delegated-payment/routes.ts:165`](../../packages/credentagent-gate/src/ceremony/delegated-payment/routes.ts)).
What's missing is a **story a developer can run and read**. This is a **docs/example task — zero
package source changes**.

## Decisions *(locked; recorded here rather than as `needs-decision`)*

- **Shape = `gate-any-action`'s story on `delegated-verifier`'s backend.** The gated action is a
  plain MCP-shaped tool (release a sealed record) returning the Mode-B `verification_required`
  envelope, exactly like [`examples/gate-any-action.mjs`](../../examples/gate-any-action.mjs); the
  ceremony behind the approve link is the **delegated rail** driven by a local stand-in
  `DelegatedVerifier`, exactly like [`examples/delegated-verifier/serve.mjs`](../../examples/delegated-verifier/serve.mjs).
- **No storefront.** The seams come from `defineHost({...})` (the "bring your own host" contract,
  [`examples/bring-your-own-host.mjs`](../../examples/bring-your-own-host.mjs)) — the "catalog" prices
  every action at **$0** (it is an action, not a sale).
- **The stand-in verifier has NO `settle` member at all.** Omitting the method (not just never
  calling it) is the loudest possible proof the money path is unreachable: if the gate ever tried to
  settle, the run would fail with the rail's own "verifier has no settle()" error.
- **The example drives the delegated page directly.** `requirements()` deliberately routes identity
  (`gate`-effect) approve links to the built-in credential rail even in delegated mode
  ([`manifest.ts:60`](../../packages/credentagent-gate/src/manifest.ts)); routing identity gates to
  the delegated page when the verifier owns them is a real design question that belongs to epic #60,
  **out of scope here** — the example builds the `/credentagent/delegated?order=…` link itself and
  says so in a comment.
- **Same honesty fence as the parent PR (#103).** No real adapter ships yet (S6,
  `multipaz-utopia#16`); the stand-in reports `trust_level: "presence-only-demo"` honestly.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — An identity gate completes with the money path never firing (Priority: P1)

A developer runs the example. The gated tool first returns a typed `verification_required` refusal
(not the records). The requester proves an identity credential through the **external verifier**
(the stand-in), the gate re-runs its own policy over the disclosed claims, the action completes —
and **no settlement call ever happens** (the verifier has no `settle` to call).

**Acceptance:** the scripted walk-through prints (1) the envelope refusal, (2) a completed delegated
ceremony with `completed: true` and no `settlement` field, (3) the re-called tool releasing the
record. The verifier object provably has no `settle` member.

### User Story 2 — The gate still refuses a bad identity proof (Priority: P1, security)

Boot with `VERDICT=underage` (verifier discloses only `age_over_18` on a 21+ gate) or
`VERDICT=declined` (verifier does not vouch). The gate refuses; the record is **never** released.

**Acceptance:** in both modes the verify leg reports `completed: false` and a re-called tool still
returns the refusal envelope — the release log stays empty. (These are the example-level twins of
the rail's pinned bypass tests; the example asserts them in its walk-through, the package suite
remains the enforcement.)

### User Story 3 — A human can click it (Priority: P2)

`node examples/delegated-verifier-identity/serve.mjs`, open `/dev/release` in a browser → lands on
the delegated approve page for the $0 action, clicks through the ceremony, sees completion.

## Requirements

- **FR-001**: New runnable example `examples/delegated-verifier-identity/serve.mjs` — plain ESM,
  runs against the built workspace packages (`npm run build:packages`), no new dependencies.
- **FR-002**: The policy is a single identity credential — `required(age.over(21))` — with **no**
  `payment.in(...)` anywhere in the file.
- **FR-003**: The stand-in verifier implements `buildRequest` + `consume` and **omits `settle`**;
  `VERDICT=ok|underage|declined` env modes mirror the shopping example's.
- **FR-004**: The gated action is enforced **server-side**: the tool releases only against the
  completed-order record the shared completion wrote — never off a client flag (invariant 1).
- **FR-005**: The file carries the honesty fence: stand-in ≠ trust anchor,
  `trust_level: "presence-only-demo"`, real adapter is S6 (`multipaz-utopia#16`).
- **FR-006**: [`examples/README.md`](../../examples/README.md) gains an entry under **Gating
  patterns** presenting it as the identity twin of the shopping example.

## Success Criteria

- **SC-001**: `node examples/delegated-verifier-identity/serve.mjs` completes the scripted
  walk-through green on a fresh build; `VERDICT=underage` and `VERDICT=declined` print refusals and
  release nothing.
- **SC-002**: The hero file reads as a story (comment-led, like its two parents); no plumbing block
  a reader must reverse-engineer (Principle I). If one appears, stop and file the API gap.
- **SC-003**: Zero diffs under `packages/` (docs/example task).

## Out of scope

- Routing identity-only manifest approve links to the delegated page (design question for epic #60).
- A `verifier` option on `defineHost({...})` — the example publishes the seam via
  `app.locals.credentagent` with a comment; if that reads as plumbing, it is filed as a DX follow-up
  rather than dressed up (constitution Principle I).
- Any change to the delegated rail, its tests, or the packages.
