# gate-my-tool — implementation notes & evidence

Companion to [`2026-07-20-gate-my-tool-skill-design.md`](./2026-07-20-gate-my-tool-skill-design.md).
Branch `feat/17-gate-my-tool` · tracked in #92 (also #17, folds in the core of #23).

## 1. DX deviation from the spec — maintainer-directed

Mid-implementation the maintainer reviewed the spec's caller shape and rejected it
("if it's confusing we have failed"; iterate until Stripe-grade). The surface was
redesigned through a **cold-reader goal loop**: three rounds of two fresh-context
reader personas (a Stripe-fluent Node dev who's never seen MCP; an MCP server author
who's never seen wallets) each answering graded comprehension questions on the
quickstart alone.

| | Spec (`gateTool`) | Shipped (`credentagent.gate()`) |
| :-- | :-- | :-- |
| Method | `gateTool(handler, opts)` | `gate(handler, opts)` |
| Policy | `require: [ required(age.over(21)) ]` | `require: age.over(21)` (credential or array; no `required()` noise — a blocking gate is required by definition; payment/discount **throw at wrap time**) |
| Scope key | `order: (args) => ({ id, total: 0, currency: "USD" })` | `provenBy: (args) => string` (no checkout vocabulary on identity actions; totals default internally) |
| Resume | — | optional `name` (defaults to a `"this-tool"` self-reference) |

Reader-score trajectory: R1 4+4 → R2 5+6 → R3 6+6 out of 10. By round 3 both
readers had the loop and every option correct ("the `gate()` call itself I could
write blind right now"); remaining confidence loss was traced to two things **outside
this branch's scope** — see §3 — plus doc fixes that were applied (refusal shown as a
full CallToolResult, `isError` semantics stated, the `outputSchema` rule promoted,
`subject` renamed `provenBy` after both R3 readers independently misread it as the
*data* subject).

## 2. Load-bearing proof for the bypass tests (write-bypass-test step 4)

Each control was temporarily disabled, the suite run, red confirmed, control
restored (288/288 green after):

| Mutation (in `gate.ts`) | Invariant | Red tests |
| :-- | :-- | :-- |
| A — `entries.find((e) => !proven(e, record))` replaced with `undefined` (proven-check deleted) | 1 (enforce on the completion path) | 6/9, incl. all four security tests |
| B — `record?.ageVerified === true` weakened to `record != null` (token-present) | 5 (explicit positive claim) | "REFUSES a negative/absent claim" |
| C — `opts.provenBy(args)` replaced with a shared constant | 4 (never process-global) | "REFUSES a cross-subject bleed" (+3) |

## 3. Follow-ups surfaced by the DX loop (not this branch)

For `needs-decision` issues — each was flagged independently by multiple cold readers:

1. **Standalone proving-page mount for page-less servers.** `mount()` requires the
   checkout-shaped seams (orderStore/catalog/completion), so a stdio-only MCP server
   has no one-line way to serve `approve_url`. This was the single biggest remaining
   confidence blocker in round 3. `gate()` warns honestly today.
2. **`walletOrigin` naming.** Flagged by every reader in every round ("actively
   misleading — name says wallet, value is MY server"). Recommend an alias
   (`serverOrigin` or `publicOrigin`) with `walletOrigin` kept for compat.
3. **`?order=` query param on approve links** for identity actions (rail contract) —
   reads as checkout leakage on a non-commerce gate; recommend accepting a neutral
   alias param on the credential rail.
4. **Envelope v1 field polish** (wire contract, needs a version bump): `present`
   noun ambiguity, `reason.pass` redundancy, prose in `resume.poll`.
5. **`CredentAgent` class name** — repeat reader stumbles ("'agent' reads as the AI
   caller"; "a portmanteau I had to sound out"). Product-level rename question.

Also noted per spec §5: #17's premise that a discovery surface (`agents.md`, #20)
"ships in v0.1" is stale — it does not exist in the repo.

## 4. Skill TDD evidence (writing-skills RED → GREEN)

**RED baseline (no skill).** A fresh-context agent, told only *"gate my release-records
tool so it requires age verification (21+); add whatever tests you think are needed"*
against an untracked copy of the ungated sample, forbidden from reading `.claude/skills/`.

Outcome — an honest surprise: the baseline **succeeded on every core behavior.** It chose
`credentagent.gate()` over hand-rolling, keyed proof with `provenBy` per subject, omitted
`outputSchema` (verifying the SDK's validation path itself), injected one shared
`CredentAgent` for testability, wrote three precise attack tests (bypass, cross-subject
bleed, negative-claim), and ran the wrap-removed mutation proof unprompted (3 pass → wrap
removed: 3 fail → restored: 3 pass). Root causes: this branch's fresh README/api.md/jsdoc
were already committed, the repo's CLAUDE.md carries the invariants + the bypass-test bar,
and the sample README states the intended before/after. It even caught a stale
pre-rename `subject:` reference in the sample README (fixed).

Per the writing-skills discipline, that means the skill is NOT justified as a correction
of observed failures **in this repo's environment**. It is kept (as the spec requires) as
**compression + trap insurance**: the baseline burned substantial discovery (reading
`gate.ts`, `client.ts`, and SDK internals before writing the wrap), and its success leaned
on docs an agent may not read on a worse day. The skill distills the checklist — wrap,
`provenBy` footgun, delete `outputSchema`, single shared client, the write-bypass-test
loop — into one page with the traps stated explicitly.

**GREEN verification (with skill).** A second fresh-context agent, same task, told to
follow the skill, against another ungated copy. Full pass: correct wrap (shared exported
`CredentAgent`, per-caller `provenBy`, `name` matching the tool id), three precise attack
tests, and the load-bearing proof run as instructed (3 pass → wrap deleted: 3 fail →
restored: 3 pass; it named the deleted line). **Discovery cost for the wrap fell from
~a-dozen source reads (baseline) to 2** (the skill + the target file); its remaining reads
went to test assertions and SDK import specifiers. Its audit listed five friction points
(unstated import specifiers, envelope field paths, export-the-client placement, an N/A
step, the expected unmounted warning) — all folded back into the skill (REFACTOR phase),
plus one skill correction from the harness itself: vitest does **not** skip dot-dirs, so
the skill now says "use the project's test runner."

## 5. DX goal-loop verdict (round 4, on the shipped README section)

Round 4 (fresh readers, final committed text, sample linked): the wrap + agent loop are
solved — the MCP persona rated coding the detect/re-call loop "trivial… a 9" and both
walked every step correctly. Remaining scores (6 and 4–6) trace to exactly two things:

1. **The standalone proving-page mount** (§3.1) — both personas' top lookup. A capability
   gap, not confusion; stated honestly in the README and ROADMAP, tracked as the next
   increment.
2. **`provenBy` example semantics** — round 4's one new catch: keying by the *requested
   record* on a multi-user server re-creates the shared-bucket bleed per record. Fixed
   three ways: `provenBy` now receives the MCP per-request `extra` as its second argument
   (so `(_args, extra) => extra.sessionId` keys by caller; new regression test), the
   README/skill/example annotate the self-service assumption explicitly, and the skill's
   trap table names the resource-keying variant.

With those landed, every reader-flagged item is either fixed, honestly fenced with a named
follow-up (§3), or a wire-contract question deferred to an envelope version bump.
