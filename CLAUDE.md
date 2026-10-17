# CLAUDE.md

Project guidance for Claude (and human contributors). Read this before reviewing
or changing code. It captures invariants that are easy to violate and have bitten
us before.

## What this is

**CredentAgent — the consent layer for AI agents.** An AI agent must prove a **verifiable
credential** from the user's phone wallet before a consequential action — a payment, an
age gate, an access grant — completes. **Identity leads; payments is one application:**
`age.over(21)`, a loyalty membership, a prescription, and `payment.in("usd")` are all
just credentials in the same policy.

This repo (`openmobilehub/credentagent`) is the **library**: two npm workspaces under
`packages/`.

- **`@openmobilehub/credentagent-gate`** — the Gate. `new CredentAgent()`, `credentagent.mount(app)`,
  the policy builders (`age`/`membership`/`payment`/`defineCredential`), and the
  `/credentagent/*` ceremony rails (passkey, credential, dc-payment). TypeScript/Node, ESM.
- **`@openmobilehub/credentagent-storefront`** — `createStorefront()`: a runnable,
  catalog-injected MCP shopping server + the pure pricing/order model. Reference
  consumer of the gate.

Tests run with **`npm test` from the repo root** (vitest) — that is the authoritative run,
and the only one that includes the cross-package integration suite (see *Testing
expectations*). `npm run test:workspaces` is the faster inner loop and skips it.
`npm run build` typechecks + builds each package. The end-to-end DEMO is the
**Utopia Marketplace MCP server** in a **separate** repo,
[`openwallet-foundation/multipaz-utopia`](https://github.com/openwallet-foundation/multipaz-utopia/tree/main/organizations/marketplace/mcp),
which consumes these packages from npm — link to it, don't describe it as part of this repo.

## Status & decisions — GitHub is the source of truth

**There is no status file** (`STATUS.md` was retired 2026-07-16). Project state lives in
GitHub, where it cannot rot or conflict. Read it there at the start of a session:

| What you want | Where it lives | How to read it |
| --- | --- | --- |
| **Decisions waiting on the maintainer** | issues labelled `needs-decision` — each carries a **recommendation** | `gh issue list --label needs-decision` |
| What's in flight / next | **epics + their sub-issues** (e.g. #12 → its increments), progress is automatic | `gh issue list --label epic` · `gh issue view <n>` |
| What's done | merged PRs + closed issues — **git history IS the Done log** | `gh pr list --state merged` · `git log --oneline` |
| Standing constraints / norms | **this file** — durable guidance, not state | you're reading it |

**When you need a decision from the maintainer, file an issue labelled `needs-decision`
with a recommendation** — don't bury it in prose, and don't hand-maintain a dashboard.

*Why it was retired:* a status file mixes durable guidance with live state. The live half
rots and lies — it claimed a PR was "MERGEABLE, all checks green" while that PR was in fact
conflicting with CI unable to run at all — and it conflicted on every branch that touched
it (it was the sole merge conflict in both #41 reconciles). Anything derivable from
`git`/`gh` should be **derived, not transcribed**.

## Architecture (where things live)

The gate is the security surface; the storefront is a reference consumer.

- `packages/credentagent-gate/src/`
  - `client.ts` — `CredentAgent` (`requirements()` for the tool context, `mount()` for the
    page context).
  - `credentials.ts` — the `age` / `membership` / `payment` builders, `defineCredential`,
    `dcql`, and the `gate()` / `discount()` / `authorize()` effects.
  - `manifest.ts` — `requirements()`'s code→data boundary (runs `.when()` / `appliesTo`
    server-side, sorts `payment` last, emits the JSON-safe `requires` manifest).
  - `gated.ts`, `envelope.ts` — the retained Mode-B `verification_required` blocking
    primitive.
  - `store.ts` — `VerificationStore` (default in-memory; inject a shared store for
    multi-instance deploys).
  - `src/ceremony/` — the authorization gates `mount()` serves, each a self-contained
    rail:
    - `passkey/` — WebAuthn same-device + cross-device (caBLE).
    - `dc-payment/` — Digital Credentials API + OpenID4VP, amount-bound (mdoc).
    - `credential-gate/` — age / loyalty via OpenID4VP.
    - `mandate.ts` — the AP2-shaped mandate + the deterministic gates.
- `packages/credentagent-storefront/src/` — `createStorefront()` (the runnable MCP server,
  `server.ts`) + the pure pricing/order model (`index.ts`: `priceCart`, `createOrder`,
  `requiredAgeForLines`, `SAMPLE_CATALOG`) + the widget bundle (`ui/`).
- A new ceremony rail should **mirror** the `dc-payment` / `passkey` /
  `credential-gate` structure (`dcql`/`request`/`verify`/`page`/`routes` split) and
  reuse shared helpers (e.g. `makeEncryptionKey`, the `mdoc/` parsers) rather than copy
  them.

## Security invariants — DO NOT violate

These are load-bearing. A change that breaks one is blocking, even in "demo" code.

1. **Enforce gates server-side on EVERY completion path.** Age/payment/auth checks must
   run on the gate's `/verify` handlers (passkey, dc-payment, credential) AND in the
   shared `completeOrder` path that the host's MCP tool / place-order route calls — not
   only in the rendered checkout HTML. Hiding a button is not enforcement.
2. **Never trust the order token.** Order tokens are unsigned base64url JSON and are
   hand-editable. Always **re-derive** amounts and flags from the cart/catalog
   server-side. The first gate re-sums the order lines and refuses on mismatch — keep it
   that way.
3. **Discounts must reconcile with amount binding.** Any discount must keep the line sum,
   the order total, and the signed payment amount in agreement across *all* payment paths
   (passkey, dc-payment, instant-demo). A discount that one path accepts and another
   refuses is a bug.
4. **Scope verification/cart state per session/order — never process-global.** A single
   shared key means one user's verification unlocks checkout for everyone (cross-user
   bleed). Key `VerificationStore` state by the order/session id carried in the gate URL.
5. **Require explicit positive credential claims.** Verify the actual claim
   (e.g. `age_over_21 === true`), not merely "a token was present." Thresholds must match
   the product's restriction; don't accept an 18+ proof for a 21+ gate.
6. **Keep WebAuthn / OpenID4VP bound to this server's origin / RP-ID,** with nonce/replay
   protection. Seal and check the nonce; don't accept a presentation just because it
   decrypts.

## Honesty fencing — DO NOT overclaim

Honesty is load-bearing and carried in the **types** (`trust_level`), not just prose.

- `trust_level` is **`"presence-only-demo"`** for the OpenID4VP rails. The **wire crypto
  is real** — WebAuthn on the passkey rail, OpenID4VP JWE/ECDH-ES decrypt + nonce
  binding, HPKE, ISO-mdoc parse — but there is **no issuer / device-signature trust
  anchor yet**, and the AP2 mandate is **dev-signed** (integrity hash), not key-signed. A
  self-crafted mdoc would pass.
- A presence-only gate enforces *disclosure* and *binding*, **not trust**. **Never
  present it as a real safety control.** Any gate relying on mdoc trust must be fenced
  behind an explicit demo-only mode until issuer-trust verification lands.
- **Issuer-verified trust (`trust_level: "issuer-verified"`) is the v0.2 line** — the
  integration step (Multipaz / `@auth0/mdl`), not new cryptography. Don't ship docs or
  copy that imply it's already here.

## Developer experience — Stripe-grade (DO NOT regress)

DX is load-bearing here, at the **same tier as the security invariants** — the product's thesis is
that a consent layer can be a *pleasure* to integrate (Principle I; the benchmark is `stripe-node`).
The full rubric — exemplars, 12 principles, a review checklist, and honest open gaps —
lives in **`docs/reference/architecture-principles.md`**. It is a **required review lens, not
aspirational prose:** a PR that regresses a principle is a request-changes, same as a broken invariant,
and the automated review checks it.

The one rule that catches most regressions:

- **The example IS the DX test.** Write the caller-side example FIRST. If it needs a plumbing block —
  assembling stores, a context, calling a low-level primitive by hand — the **API** failed; fix the API,
  never dress up the example. (`DelegatedGate` exists because its example was ugly — see the worked
  ugly→elegant case in the rubric, Principle 12.)

Quick gate for any new/changed public API (full list in the rubric):

- **Configure once, then declarative calls;** a zero-config default that just runs.
- **Result is typed plain data** (`{ ok, reason, … }`) — never a callback grab-bag; one error door.
- **Consistent** with sibling shapes/verbs; **names state the important thing they do** (`spend`, not `show`).
- **Every value's origin visible; no hidden magic;** additive change with safe defaults.

## Testing expectations

- Each package's `vitest` suite is the source of truth for its own behavior. Tests must
  exercise the **security-critical / bypass paths**, not just happy-path shape: e.g. POST
  an unverified age-restricted order and assert it is refused; authorize a discounted cart
  and assert amount binding passes; assert global-state bleed cannot occur.
- **A test that would still pass with the security control removed is not a useful test.**
  Every bypass test must fail when its control is deleted.
- **Verify with the ROOT `npm test`, not a per-workspace run.** `storefront-gate.test.ts`
  lives at the repo root — it checks that the two published packages compose with zero
  glue, so it belongs to neither workspace and neither workspace's vitest picks it up. The
  root run therefore includes files the per-package runs don't: that one, and repo-level
  checks such as `scripts/check-changelog.test.ts` (the release's changelog guard). A
  per-workspace run is a legitimate fast inner loop; it is **not** a verification. Claiming
  green off one is how issue #184 happened — a contributor ran every test CLAUDE.md told
  them to run, saw it all pass, and CI failed on the cross-package file they never ran.

## Conventions

- **Sign off every commit (DCO).** This repo (openmobilehub / OpenWallet Foundation /
  Linux Foundation) enforces the Developer Certificate of Origin: every commit must carry
  a `Signed-off-by:` line. Commit with `git commit -s` (and `git rebase --signoff` to fix
  existing commits) or your PR will be blocked by the DCO check.
- Match the style, naming, and comment density of surrounding code.
- Prefer small, well-bounded modules over growing a file past its one clear purpose. A new
  ceremony rail mirrors the existing rail layout; it does not bolt onto an existing one.
- Keep the two package READMEs honest and in sync with the API surface — they are the
  published docs.
- **Write PR/issue descriptions for a human who did NOT write the code.** Lead with plain
  language — clear and concrete, not clever. Define each term on first use, spell out
  cross-references (never a bare `#85` or `invariant 4`), prefer everyday use cases, use at
  most one universal analogy and only for an abstract idea, and keep the technical detail
  below a divider. Follow `.github/pull_request_template.md`; the review enforces it (REVIEW.md §5).
- **Every issue must be reproducible, through the SDK or the UI.** Give steps someone else can
  follow and see the same result: for the SDK, a minimal runnable snippet or command against the
  packages or an `examples/` script; for the UI, the URL and each click in order (storefront
  widget, checkout / wallet pages, hosted marketplace). Add what happens, what should happen,
  and the version or commit. For an enhancement, the steps show today's behavior. Follow
  `.github/ISSUE_TEMPLATE/`. `gh issue create` skips those forms, so write their sections
  (Reproduce via · Steps to reproduce · What happens · What should happen · Version or commit)
  into the body yourself.

## Code review

PRs get both automated and human review. **`REVIEW.md` (repo root) is the checklist both
run** — the automated review's prompt grounds itself there; apply it when reviewing and
anticipate it when authoring:

> **Maintainers: push your feature branch to this repo — don't fork.** The automatic
> Claude review only runs on **same-repo** PRs (GitHub withholds secrets from fork-PR
> workflow runs on a public repo — regardless of your permission level). If you push to a
> branch here, you get the automatic review for free; if you fork, you only get a review
> on-demand by commenting `@claude review this PR against REVIEW.md and post a summary`.

- **Same-repo PRs** — an automated Claude review (`anthropics/claude-code-action`) runs
  on every non-draft PR opened from a branch in this repo, grounded in this file's
  invariants **and the DX rubric** (`docs/reference/architecture-principles.md`) — it checks
  Stripe-grade ergonomics (the example-is-the-test rule, above) alongside the security invariants.
  `claude-review` is **opt-in and currently ON** (re-enabled 2026-09-29): the job only runs when
  the repo variable `ENABLE_CLAUDE_REVIEW` is `"true"`, and it posts its findings to the PR
  (`--comment`). It runs Opus at `--effort high`, or `max` for `release/*` branches and any
  change under `packages/credentagent-gate/src/`. It is **tiered**, so a review costs what the push
  changed:
  - **full** — when the PR opens, reopens or leaves draft. **To force a full re-review, mark the
    PR as draft, then ready for review.**
  - **delta** — on a later push: only the PR's own new commits since the last reviewed head (plus
    any file main also changed), with the effort picked from those commits alone. Merge commits
    aren't read on their own, so a conflict resolved by hand is reviewed only through that overlap
    (a conflict is almost always in a file `main` changed).
  - **skip** — a push that leaves the PR's own diff unchanged (merging `main` in) and where `main`
    touched none of the PR's files. CI still tests it.

  A new push cancels the review still running on the old head; a cancelled run never counts as
  reviewed. It is not a required check, so **human review is still the gate**. To pause it,
  `gh variable set ENABLE_CLAUDE_REVIEW --body false` — the job is then **skipped**. The
  `CLAUDE_CODE_OAUTH_TOKEN` secret must come from an account that can use Claude Code
  (`claude setup-token`); an unusable token errors on every PR.
- **Which account pays for Claude in CI** — the PR review and `@claude` replies **always** use the
  Claude **subscription** login (`CLAUDE_CODE_OAUTH_TOKEN` secret). The nightly `agent-e2e` and the
  `issue-agent` (both on the Agent SDK) follow one repo variable, `CLAUDE_AUTH`:
  - unset, or anything but `api` — the subscription login too. This is the default. Runs count
    against that subscription's usage limits.
  - `api` — an **API key** (`ANTHROPIC_API_KEY` secret), billed to that key's Console
    organization. If the secret is missing, or its credit runs out, the run **fails** until you
    switch back.

  Switch with `gh variable set CLAUDE_AUTH --body api` and back with
  `gh variable set CLAUDE_AUTH --body subscription`. No PR is needed, and it takes effect on the
  next run. Set the secrets in the GitHub web UI, not through a piped shell.

  Why the review is not switchable: on 2026-10-13 `CLAUDE_AUTH=api` also moved the review onto
  the key, and every review failed in under a second with "Credit balance is too low". The key's
  only funding is the Max plan's included API credit, and the API refuses that credit for requests
  from `anthropics/claude-code-action`, while accepting the same key from the Agent SDK (what
  `agent-e2e` uses) and from `claude -p`. The action hides this message; a review that dies
  instantly with `is_error: true` and `total_cost_usd: 0` is the signature.
- **Fork / external-contributor PRs** — the automated job is **skipped** (fork runs can't
  read the `CLAUDE_CODE_OAUTH_TOKEN` secret), so it never blocks you. A skipped required
  check counts as passing. Those PRs are reviewed by one of:
  - a maintainer commenting **`@claude review this PR against REVIEW.md and post a summary`** on the PR (on-demand; runs in base-repo context
    so it has the secret),
  - the org-hosted **managed Claude review** integration (auto-reviews forks), and/or
  - an on-demand deep multi-agent review by a maintainer.
- **Human review** — at least one approving review is required to merge to `main`, and branch
  protection **requires every review conversation to be resolved** (enforced since 2026-10-14;
  before that it wasn't, and bot findings were merged unanswered). Resolve a thread by fixing
  it, or reply with a won't-fix reason and then resolve — this includes bot threads. A branch
  does **not** have to be up to date with `main` to merge (since 2026-10-15): CI tested the PR
  merged onto `main` when it ran, and re-runs on `main` after every merge. Merging `main` in only
  to clear "out-of-date" just re-ran CI and the review. (A merge queue isn't used: the DCO app
  doesn't report on merge-queue runs, and DCO is a required check.)
- A PR that edits `.github/workflows/claude-code-review.yml` itself will fail
  `claude-review` by design (the action validates the workflow matches `main`) and needs
  an admin merge. Since nothing reviews those PRs automatically, a maintainer comments
  **`@claude review this PR against REVIEW.md and post a summary`** on them — that runs
  `.github/workflows/claude.yml`, a separate workflow the edit doesn't break. Give it those
  words: `claude.yml` has no review prompt of its own and only does what the comment asks.
- **Codex** (`chatgpt-codex-connector[bot]`) — automatic reviews are **off** (turned off
  2026-10-14). Why: across 23 PRs it reviewed once per PR, only for one author, often after
  merge, and caught nothing the Claude review missed. On-demand `@codex` doesn't work here
  either — it replies asking for a Codex environment this repo doesn't have — so don't
  write `@codex` in PR descriptions or comments.

## Issue agent — label an issue `agent`

Labelling an issue **`agent`** (write access needed) runs `.github/workflows/issue-agent.yml`:
agents spec, implement and review it, and it comes back as a **draft PR** with acceptance criteria,
the pipeline's own gate runs, a mutation check (the changed tests fail with the fix reverted),
three review verdicts, and before/after screenshots + video. It skips an issue that is closed,
labelled `needs-decision`, `epic`, `wontfix`, `duplicate` or `question`, assigned to someone other
than whoever labelled it, or already has an open PR,
and says why in a comment on the issue. **Only words by people with write access reach the agents**
(the title and body if their author has it, and such people's comments, frozen at the label) — so to give
it a request from an outside contributor, restate it in a comment. The agents run in a job with no
GitHub token; a separate job publishes their reviewed change. It never merges; its PRs go through
the same human review as any other. Media lives on the `agent-evidence` branch — never merge it.
With an `AGENT_GH_TOKEN` secret, the agent also works through the Claude review on its own PR
(`.github/workflows/issue-agent-review.yml`): it fixes or answers every thread, pushes, resolves the
threads, and repeats — labelled `agent:in-review` meanwhile — and **asks for a human review only
when the review is ✅, or 💬 with nothing open** (`agent:ready-for-human`). After 3 cycles a 💬
also goes to a human as ready, with the open small notes listed; a ⛔ stops as `agent:needs-human`,
as does any other stated reason. Before any hand-over as ready it checks the issue's acceptance
criteria on the final code and ticks the PR's checklist. If `main` moves and an agent PR now
conflicts with it, the loop resolves the conflict itself (a sweep runs on every push to `main`) or
hands over. Don't review an `agent:in-review` PR yet; you'll be asked.
To see what it's working on: the 🤖 status comment on the issue (edited at each step), the
`agent:working` label (`is:open label:agent:working`), and Actions runs named `issue-agent #<n> · …`.
How it works and how to run it locally: [`ci/issue-agent/README.md`](ci/issue-agent/README.md).

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).

<!-- SPECKIT START -->
For additional context about the technologies to be used, project structure, and validation
commands for the active feature, read the current plan at
`specs/007-quickstart-ladder/plan.md`.
<!-- SPECKIT END -->
