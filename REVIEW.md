# REVIEW.md — the review checklist

The checklist every review of a PR to this repo runs — the automated Claude review
(`.github/workflows/claude-code-review.yml` grounds its prompt here) and human
reviewers alike. It **orchestrates** the standing documents rather than duplicating
them: [`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md) holds the six load-bearing
controls, [`docs/reference/architecture-principles.md`](docs/reference/architecture-principles.md)
holds the DX rubric, [`CONTRIBUTING.md`](CONTRIBUTING.md) holds the contributor bar.
A reviewer — human or agent — should be able to run this list with zero additional
context.

## 0. Mechanical checks come first (don't re-review what the machine checks)

CI runs `npm run build`, `npm run typecheck`, `npm test`, and `npm run lint` — a red
check is request-changes with no further analysis needed. The lint layer already
enforces mechanically:

- a ceremony rail may not import `completion.js` — completion goes through the
  injected `ctx.completion` seam (invariant 1);
- no module-level `let`/`var`/`new Map()`/`new Set()` in package `src` — per-order
  state lives behind `VerificationStore` (invariant 4);
- no `Math.random()` in the gate package — randomness in the security surface comes
  from `node:crypto` (invariant 6-adjacent).

Spend zero review attention re-checking those. **Do** review any new
`eslint-disable` in the diff: it must carry a one-line justification, and the
justification must hold.

## 1. Security invariants (blocking — even in demo code)

Read [`SECURITY-INVARIANTS.md`](SECURITY-INVARIANTS.md), then map the diff:

| If the diff touches… | Check invariant |
| :-- | :-- |
| a completion path — MCP tool, `place-order`, a rail's `/verify` handler | **1** — gates enforced server-side on *every* completion path; hiding a button is not enforcement |
| a price, total, `minimumAge`, or anything read from an order token | **2** — re-derive from the catalog server-side; the token is unsigned and hand-editable |
| a discount or authorized amount | **3** — line sum, order total, and signed payment amount agree across *all* payment paths |
| new state (caches, maps, stores) | **4** — keyed by order/session id, never process-global |
| a credential claim check | **5** — explicit positive claim at the exact threshold (`age_over_21 === true`; an 18+ proof never satisfies a 21+ gate) |
| WebAuthn, OpenID4VP, mdoc, nonces, or origins | **6** — origin/RP-ID binding and nonce/replay protection intact; decryption alone is not authorization |

A broken invariant is **request-changes, full stop**.

## 2. The bypass-test rule (blocking)

Every new or changed security control must name a test that **goes red if the
control is deleted**. The reviewer's question for each control in the diff:

> *Which test fails if this line is reverted?*

No answer → request changes. A happy-path test that would still pass with the
control removed is not a useful test. (Writing one: the
`write-bypass-test` skill in `.claude/skills/` encodes the discipline with this
repo's exemplar tests.)

## 3. DX rubric (blocking — same tier as the invariants)

The rubric is [`docs/reference/architecture-principles.md`](docs/reference/architecture-principles.md);
a regressed principle is request-changes. The one rule that catches most
regressions:

- **The example IS the DX test.** If the caller-side example for a new/changed
  public API needs a plumbing block — assembling stores, a context, calling a
  low-level primitive by hand — the API failed; fix the API, never dress up the
  example.

Quick gate: configure once then declarative calls; result is typed plain data
(`{ ok, reason, … }`); consistent with sibling shapes/verbs; names state the
important thing they do; every value's origin visible; additive change with safe
defaults.

## 4. Honesty fencing (blocking)

`trust_level` stays **`presence-only-demo`** for the OpenID4VP rails until
issuer-trust verification lands (the v0.2 line). No doc, README, comment, or UI
copy in the diff may imply issuer-verified trust exists, and a presence-only gate
is never presented as a real safety control.

## 5. Conventions (expected; flag, don't block alone)

- Every commit carries a DCO `Signed-off-by:` line (the committed
  `prepare-commit-msg` hook automates this; the DCO check enforces it).
- Small, well-bounded modules; a new ceremony rail **mirrors** the
  `dcql`/`request`/`verify`/`page`/`routes` split (the `add-ceremony-rail` skill
  scaffolds it) rather than bolting onto an existing rail.
- The two package READMEs stay in sync with any API surface the diff changes.
- **Readable to someone who didn't write it.** The PR description leads with a plain-language
  summary a non-specialist follows from the first paragraph — clear and concrete, not clever.
  Every term is defined on first use; no bare cross-reference (`#85`, `invariant 4`, a rail
  name) is left unexplained; use everyday examples; an abstract idea gets at most one universal
  analogy (a prepaid card, a key), and the technical detail sits below a divider. Template:
  `.github/pull_request_template.md`.
- **Fix it or flag it:** anything broken the PR author must have seen is either
  fixed inline (small and safe) or filed as an issue — never silently ignored.

## Output contract (automated review)

Report a verdict plus findings, each anchored to `file:line` and naming the
invariant or principle it violates. Findings that map to §1–§4 are
request-changes; §5 findings are comments unless they compound.
