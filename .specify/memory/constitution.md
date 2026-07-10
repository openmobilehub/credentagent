<!--
Sync Impact Report
- Version change: 1.0.0 → 1.1.0 (2026-07-10) — DX-gate amendment
- Bump rationale: MINOR — materially expanded guidance on Principle I (Stripe-grade API): the example is
  the acceptance test for ergonomics ("fix the API, not the example"), and the DX rubric
  (docs/reference/architecture-principles.md) is now a BINDING review lens at the Security-Requirements tier.
  No principle removed or redefined. Reconciliation note: a CONCURRENT branch (005-hnp-seams, PR #41) also
  bumps 1.0.0 → 1.1.0 for the HNP Principles-II/III/VII amendment. Whichever merges second must renumber to
  1.2.0 and fold both sync-impact entries — the two amendments are independent and additive.
- ── prior entry ──
- Version change: (unratified template) → 1.0.0
- Bump rationale: initial ratification of the CredentAgent SDK constitution.
- Principles: initial set — I. Stripe-grade, MCP-idiomatic API · II. The three execution contexts are
  sacred · III. Consolidated checkout flow · IV. One ordered, conditional policy array · V. Extensible to
  any credential · VI. structuredContent is data, not policy · VII. Honesty in the types; prefer simplicity
- Added sections: Security Requirements; Development Workflow & Quality Gates; Governance
- Removed sections: none
- Templates checked for alignment:
    ✅ .specify/memory/constitution.md (filled from template)
    ⚠ .specify/templates/plan-template.md — its "Constitution Check" gate is generic; first /speckit-plan
       MUST instantiate it against Principles I–VII + Security Requirements (no edit needed now)
    ✅ .specify/templates/spec-template.md — no change required (spec-grounding already practiced; see
       specs/001-attesto-sdk/spec.md)
    ⚠ .specify/templates/tasks-template.md — ensure generated tasks include security-bypass tests
       (Security Requirements) and DCO sign-off (Workflow); enforce at /speckit-tasks time
- Deferred TODOs: none
-->

# CredentAgent SDK Constitution

CredentAgent is the open consent layer for AI agents: an agent MUST prove a verifiable credential from the
user's phone wallet before a consequential MCP tool completes. Identity leads; payments is one application.
These articles are non-negotiable — a change that violates one is blocking, even in demo code.

## Core Principles

### I. Stripe-grade, MCP-idiomatic API
The public API MUST be configured once on a client (`new CredentAgent({...})`) and then driven by declarative
calls. Examples MUST show the MCP `inputSchema` inline so a handler's destructured fields trace to it, and
every value's origin MUST be visible on the page — NO injected-callback grab-bags, hidden config
variables, or mystery handler parameters. Rationale: a developer reads it once and understands it; the
benchmark is `stripe-node`.

**The example IS the acceptance test for the API's ergonomics:** write it first, from the caller's side, and
if it needs a plumbing block (assembling stores/context, calling a low-level primitive by hand), fix the API —
NOT the example (the `DelegatedGate` facade exists for exactly this reason). The concrete, binding review
rubric — exemplars, the 12-principle checklist, and honest open gaps — lives in
`docs/reference/architecture-principles.md`. It MUST be applied in every Constitution Check and PR review; a
DX regression is **blocking, at the same tier as the Security Requirements**.

### II. The three execution contexts are sacred
Every example and design decision MUST respect the split (spec §0): (1) the MCP tool handler runs ONCE when
checkout is requested and only mints the link + reports requirements — there is no phone in the loop, so it
MUST NOT perform a credential ceremony; (2) the checkout page/phone is where the gates actually run; (3) a
poll reports completion. Conflating these contexts is the documented root cause of confusion and is
forbidden.

### III. Consolidated checkout flow
Checkout MUST be one handoff: the buyer opens the link once and completes all verifications and payment in
a single browser session. The agent orchestrates URLs and polls; it MUST NOT perform the ceremony. A
blocking-tool mode (for page-less tools) is roadmap, not v0.1.

### IV. One ordered, conditional policy array
Gates MUST be expressed as a single ordered array: array position is run order, payment MUST settle last,
and the payment amount MUST be derived server-side from the order — never passed as a field. Gates are
`required(...)` or `optional(...)`. Conditionality MUST be explicit via `.when((order) => boolean)` (or a
credential's `appliesTo`); the SDK MUST NOT guess domain meaning (e.g. what counts as "alcohol") — the
predicate is the developer's.

### V. Extensible to any credential
The SDK MUST let a developer gate any consequential action with any credential via
`defineCredential({ id, request, verify, effect, ui })`, where effect is `gate()`, `discount()`, or
`authorize()`. The built-ins (`age` / `membership` / `payment`) are merely pre-defined credentials. Custom
credentials MUST be usable by object, with no registration step. This is the core promise of the product.

### VI. structuredContent is data, not policy
A tool result is JSON over the MCP wire to BOTH the agent and the widget, so it MUST be plain JSON.
`requirements()` MUST resolve the policy server-side (running the `.when()` / `verify` functions) and emit
a flat data manifest (`[{ credential, required, effect, label, minAge? }]`). Functions MUST NOT cross the
wire; `requirements()` is the code→data boundary.

### VII. Honesty in the types; prefer simplicity
Status MUST be carried in types, not prose: `enforcedAt: "tool" | "checkout"` and
`trust_level: "presence-only-demo" | "issuer-verified"`. v0.1 is presence-only (disclosure + nonce
binding, NOT issuer/device signatures) and MUST be fenced as a demonstration, never sold as a real safety
control. Prefer simplicity — defer complexity (e.g. real mdoc-verifier integration) rather than overbuild.

## Security Requirements

Load-bearing controls; a change that breaks one is blocking even in demo code (mirrors `CLAUDE.md`):

- **Enforce on every completion path.** Gates MUST run server-side on every path that can complete an
  order (the MCP tool, `place-order`, passkey/verify, dc-payment/verify), not just the rendered page.
  Hiding a button is not enforcement.
- **Never trust the order token.** Amounts and flags MUST be re-derived from the catalog server-side; the
  unsigned, hand-editable token is never authoritative.
- **Discounts reconcile with amount binding** across all payment paths (line sum = total = signed amount).
- **Per-order state.** Verification/cart state MUST be keyed by order/session id — never process-global
  (no cross-user bleed).
- **Explicit positive claims.** Verify the actual claim (`age_over_21 === true`), not token presence; an
  18+ proof MUST NOT satisfy a 21+ gate.
- **Origin & replay binding.** OpenID4VP / WebAuthn MUST stay bound to this server's origin with
  nonce/replay protection.

Until cryptographic mdoc trust verification (issuer/device signatures) lands, any gate relying on it MUST
be fenced behind a demo-only mode and MUST NOT be presented as a real safety control.

## Development Workflow & Quality Gates

- **Spec-grounded.** The spec and docs MUST cite real code (file/line). Claims that drift from the code are
  defects to fix.
- **Tested where it matters.** Security-critical / bypass paths MUST have tests; a test that still passes
  with the security control removed is not a useful test.
- **DCO.** Every commit MUST carry a `Signed-off-by:` line (`git commit -s`).
- **Deploy care.** Changes affecting the served origin or the build pipeline MUST be verified
  (`npm run build` green + a runtime smoke) before being claimed done.

## Governance

This constitution supersedes other practices for the CredentAgent SDK. Amendments MUST be made by editing this
file with a written rationale, MUST bump the version per the policy below, and MUST keep the dependent Spec
Kit templates (`plan`, `spec`, `tasks`) in sync. Every plan's Constitution Check and every review MUST
verify compliance with these articles; a deviation MUST be justified in writing, or the change is blocked.

Versioning (semantic): **MAJOR** — backward-incompatible principle removal or redefinition; **MINOR** — a
new principle/section or materially expanded guidance; **PATCH** — clarifications and wording. Runtime
guidance for agents lives in `CLAUDE.md` and `specs/001-attesto-sdk/spec.md`.

**Version**: 1.1.0 | **Ratified**: 2026-06-25 | **Last Amended**: 2026-07-10
