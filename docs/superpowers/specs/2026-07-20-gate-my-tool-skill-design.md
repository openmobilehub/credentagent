# gate-my-tool skill + `gateTool()` facade — design

**Issue:** #17 (folds in the core of #23). **Branch:** `feat/17-gate-my-tool` (off `origin/main`).
**Date:** 2026-07-20.

## Goal

A committed repo skill, `gate-my-tool`, that lets a coding agent install a CredentAgent
consent gate onto an existing MCP tool **in one shot**: *"gate my `release-records` tool"* →
the tool is wrapped so it refuses-until-proven, plus a load-bearing bypass test. To install
**one honest call** (not ~60 lines of hand-rolled plumbing), the skill relies on a new
library facade, `gateTool()` — the general Mode-B "gate a tool" helper (the core of #23).

## Context — three enforcement surfaces, one policy language

The library gates consequential actions in three places. This work builds the **second**:

| Surface | Scenario | Shape | Returns |
| --- | --- | --- | --- |
| `requirements()` + `mount()` | HP · hosted page | resolver | a `requires` manifest; a human completes it on your page |
| **`gateTool()` (NEW)** | **HP · page-less tool** | **wrapper** | **a gated handler; an agent drives the refuse→prove→re-call loop** |
| `DelegatedGate.preApprove()`/`spend()` | HNP · delegated | stateful object | a bounded grant; agents spend later, no human |

All three enforce the **same policy language** (`age.over(21)`, `payment.in("usd")`,
`defineCredential`). This spec touches only the middle row. The HNP row and the
**mandate-chain DX** (exposing Intent/Cart/Payment mandates) are out of scope here — that
is a separate design (coordinate with the HNP session; do not redesign `DelegatedGate`).

## 1. `gateTool()` — the facade (a `CredentAgent` method)

Written caller-first (the DX test). A configured `CredentAgent` already holds the store +
walletOrigin, so wrapping a tool is **one declarative call**:

```js
const credentagent = new CredentAgent({ walletOrigin });

server.registerTool("release-records", schema, credentagent.gateTool(
  async ({ subject }) => ({ structuredContent: releaseRecords({ subject }) }),
  {
    require: [ required(age.over(21)) ],                    // same policy shape as requirements()
    order:   (args) => ({ id: args.subject, total: 0, currency: "USD" }),
  },
));
```

Behavior:
- When the order is **not yet proven** (per `credentagent.store`, keyed by order id), the
  wrapped handler returns a `verification_required` envelope with an **action-agnostic**
  instruction (NOT the checkout-worded `envelopeInstruction()` — that is #23's second half;
  derive a neutral instruction from the envelope fields).
- When **proven**, it calls the real handler.
- Built on `requirements()` internally (resolve policy → check store → block-or-run). Same
  `order` + policy nouns → consistent with `requirements()`.
- Enforce-by-construction: the wrap is the enforcement point, so a tool cannot fail open by
  "forgetting the check."

**Consistency / naming:** method on `CredentAgent` (like `requirements`/`mount`). Name is
`gateTool` — `gate` is taken by the effect builder in `credentials.ts`.

**Honesty:** the envelope keeps `trust_level: "presence-only-demo"`. `gateTool` does not
imply issuer-verified trust. The `approve_url` points at where `mount()` serves the proving
page; if the host has not mounted one, that is the dev's to wire (state it, don't fake it).

**Collision note:** as a `CredentAgent` method this edits `client.ts`, which PR #84 also
edits (additively, different region) — trivial rebase, no logic overlap.

## 2. The skill — `.claude/skills/gate-my-tool/SKILL.md`

Unprefixed (matches `add-ceremony-rail`, `write-bypass-test`, `publish-release`). When an
agent is told *"gate my `<tool>` tool"*, it:
1. Locates the named tool's `registerTool` handler.
2. Wraps it in `credentagent.gateTool(handler, { require: [ required(age.over(21)) ] /* TODO: swap credential */, order })`.
   The policy is a **placeholder** with a clear TODO — the dev picks the real credential.
3. Adds the **load-bearing bypass test** (follow the `write-bypass-test` skill): an ungated
   call returns the envelope (`isVerificationRequired` true), NOT the action result; assert
   the typed refusal precisely; the test must go **red** if the wrap is removed.

The skill authoring itself follows the `writing-skills` skill (TDD for skills, below).

## 3. The sample — `examples/gate-my-tool-sample/`

A tiny runnable MCP server with **one ungated** `registerTool` action: `release-records`
(a non-commerce disclosure action — keeps the identity-first story, not just checkout):

```js
function releaseRecords({ subject }) {
  return { released: true, subject, records: [`record:${subject}:summary`] };
}
server.registerTool("release-records", { subject: z.string() },
  async ({ subject }) => ({
    structuredContent: releaseRecords({ subject }),
    content: [{ type: "text", text: `Released records for ${subject}.` }],
  }),
);
```

It is both the skill's verification target and the before/after demo:
*ungated tool → run the skill → gated + passing bypass test.*

## 4. Testing (two layers)

- **`gateTool()`** (vitest, gate package): proven → runs the handler; unproven → returns the
  envelope. Plus a **bypass test** that fails if the proven-check is deleted (write-bypass-test
  discipline — prove it's load-bearing, say which line you deleted).
- **The skill** (writing-skills TDD): a **RED baseline** — dispatch a subagent WITHOUT the
  skill, told "gate the release-records tool," and document how it goes wrong (hides a button,
  gates only in prose, skips the bypass test, hand-rolls the envelope). Then **GREEN** with the
  skill: the sample tool ends gated + a passing, load-bearing bypass test. Close loopholes.

## 5. Scope / YAGNI — explicitly OUT

- Mode A (`requirements`/`mount` + page) wiring; credential inference (placeholder only);
  whole-server sweeps (one named tool); framework auto-detection.
- The discovery surface / `agents.md` (#20) — **and note in the PR that #17's premise that a
  discovery surface "ships in v0.1" is stale; it does not exist in the repo.**
- **Mandate exposure / the AP2 mandate-chain DX** — a separate design; keep `gateTool`
  minimal (mandates hidden) so that work extends it additively.

## 6. Deliverables

1. `packages/credentagent-gate/src/` — `gateTool()` (method on `CredentAgent`; action-agnostic
   instruction helper) + unit + bypass tests. Export nothing new that leaks internals.
2. `.claude/skills/gate-my-tool/SKILL.md` + the writing-skills baseline evidence.
3. `examples/gate-my-tool-sample/` — the runnable ungated sample.
4. README: the three-surface table + the `gateTool` snippet as the canonical explainer.
5. DCO-signed commits; PR against `main` (independent of #84).
