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
  from `node:crypto` (invariant 6-adjacent);
- no `JSON.stringify(…)` interpolated directly into a ceremony page template — values
  inside a page's `<script>` go through `scriptJson()` (page integrity, invariant
  6-adjacent; #330). It does not see a wrapped or precomputed `JSON.stringify`, a raw
  value in a script, or an unencoded `cart` join, so review those by hand.

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
is never presented as a real safety control. Check trust wording against the
**Trust and honesty** terms in [`GLOSSARY.md`](GLOSSARY.md): a word it lists under
_Avoid_ for a trust level, used as a claim about trust (e.g. calling a presence-only
proof "verified", "secure" or "trusted"), is request-changes. Saying a check ran
("the age claim was checked") is not a trust claim, and neither is an existing exported
name or wire field (`verified`); shipped UI copy that reads as a trust claim (e.g. "✓ Age
verified" on a presence-only rail) is flagged for an issue, not blocking on an unrelated
diff.

## 5. Conventions (expected; flag, don't block alone)

- Every commit carries a DCO `Signed-off-by:` line (the committed
  `prepare-commit-msg` hook automates this; the DCO check enforces it).
- Small, well-bounded modules; a new ceremony rail **mirrors** the
  `dcql`/`request`/`verify`/`page`/`routes` split (the `add-ceremony-rail` skill
  scaffolds it) rather than bolting onto an existing rail.
- The two package READMEs stay in sync with any API surface the diff changes.
- **Domain terms match [`GLOSSARY.md`](GLOSSARY.md).** New docs and copy use its terms;
  flag prose that uses a word an entry lists under _Avoid_ (e.g. "kill-switch" for
  **Revoke**, "handshake" for **Ceremony**). An entry ending in _(proposed)_ isn't settled
  yet, so don't flag its words; and exported API names keep their names.
- **Readable to someone who didn't write it.** The PR description leads with a plain-language
  summary a non-specialist follows from the first paragraph — clear and concrete, not clever.
  Every term is defined on first use; no bare cross-reference (`#85`, `invariant 4`, a rail
  name) is left unexplained; use everyday examples; an abstract idea gets at most one universal
  analogy (a prepaid card, a key), and the technical detail sits below a divider. Template:
  `.github/pull_request_template.md`.
- **Fix it or flag it:** anything broken the PR author must have seen is either
  fixed inline (small and safe) or filed as an issue — never silently ignored.

## 6. Scope: review what ships, not just the diff

The diff is where a review starts, not where it ends.

- **Release / version-bump PRs** ship every change since the previous tag to npm.
  Review `git diff <previous tag>..HEAD` (`git tag --sort=-v:refname`), and check
  the release notes (often drafted as a PR comment) against that code: every
  feature they name exists and works as described, the `trust_level` fencing is
  intact, and the known-issues list is complete. A bump-only diff is never
  "nothing to review".
- **A changed public API, README, or dependency range** puts its callers,
  `examples/`, and docs in scope. Grep for them; stale ones are findings.
- **A changed control** puts its other completion paths in scope (invariant 1):
  find every path that reaches the same outcome and check that each one enforces it.

## 7. Rigor: how deep the review goes

A local review and the automated one must reach the same findings. Shallow
approvals are the failure mode this section exists to prevent.

- Read every changed file **in full**, plus the callers and callees a finding
  depends on, not just the hunks.
- Cover each dimension separately (security + bypass tests, correctness and edge
  cases, DX + docs truthfulness, honesty fencing + PR text). Parallel sub-agents
  are the expected way to do it.
- Verify before reporting, and label each finding **CONFIRMED** (traced end to end)
  or **PLAUSIBLE** (strong evidence, one named step unproven). Drop a finding
  only when you can disprove it, not because you're unsure. A labelled PLAUSIBLE
  finding costs the author a minute; a missed bug costs a release.
- State the coverage: the scope (`base..head` or `tag..HEAD`), the files read in
  full, and the dimensions checked. An approval without stated coverage is not an
  approval.

## Output contract (automated review)

Rigor and readability are separate jobs: be as thorough as §7 asks, then write
the result so a busy person who did not write the code understands it in one
read. Long, jargon-heavy reviews get skimmed, and a skimmed review misses the one
finding that mattered.

**Visible part (what a person reads), at most ~200 words:**

1. `## Claude review`, then a verdict in plain words: **✅ Ready to merge**,
   **💬 Ready — small notes**, or **⛔ Needs changes**.
2. One or two sentences: what the PR does and whether it is safe to merge.
3. **Fix before merging** (only for ⛔, at most 3 items). For each: what is
   wrong, why it matters (an everyday example), and what to do, in one sentence each.
4. **Worth a look** (optional): at most 5 one-line, non-blocking notes.
5. On a follow-up review, one line first: "Since the last review: N fixed, M still open".

Above the details: no file paths, line numbers, invariant numbers, rubric codes or
bare issue numbers. Name the thing instead ("the payment page"). Don't list what
passed.

**Details (collapsed `<details>` block, for the author):** every finding with its
`file:line`, the invariant or principle it maps to, CONFIRMED or PLAUSIBLE, and the
evidence; then the coverage line from §7.

Findings that map to §1–§4 (or a release claim the code does not back, §6) are
⛔ Needs changes. §5 findings are 💬 notes unless they compound.
