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

Tests run with `npm run test` (vitest) **per workspace**; `npm run build` typechecks +
builds each package. The end-to-end reference DEMO lives in a **separate** repo,
[`openmobilehub/mcp-apps-shopping-demo`](https://github.com/openmobilehub/mcp-apps-shopping-demo),
which consumes these packages — link to it, don't describe it as part of this repo.

## Status & decisions — read/update `STATUS.md`

`STATUS.md` (repo root) is the single source of truth for project state. **Read it at the
start of every working session and update it at the end.** It is **decisions-first**: it
leads with **"Decisions for you"** (each a checkbox + recommendation the maintainer
resolves inline), then in-flight / next, a rolling Done log (linked commits), and standing
constraints. It is a *dashboard* — link out to `specs/*/tasks.md`, `docs/PUBLISHING.md`,
etc. for detail rather than duplicating them. Keep it current: move a resolved decision
into Done; don't let it rot. (Don't make the maintainer ask "what's done / pending /
blocked on me" — that's what this file answers.)

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

## Code review

PRs get both automated and human review:

> **Maintainers: push your feature branch to this repo — don't fork.** The automatic
> Claude review only runs on **same-repo** PRs (GitHub withholds secrets from fork-PR
> workflow runs on a public repo — regardless of your permission level). If you push to a
> branch here, you get the automatic review for free; if you fork, you only get a review
> on-demand by commenting `@claude`.

- **Same-repo PRs** — an automated Claude review (`anthropics/claude-code-action`) runs
  on every non-draft PR opened from a branch in this repo, grounded in this file's
  invariants **and the DX rubric** (`docs/reference/architecture-principles.md`) — it checks
  Stripe-grade ergonomics (the example-is-the-test rule, above) alongside the security invariants.
  `claude-review` is a **required status check**: a same-repo PR can't merge until it's green.
- **Fork / external-contributor PRs** — the automated job is **skipped** (fork runs can't
  read the `CLAUDE_CODE_OAUTH_TOKEN` secret), so it never blocks you. A skipped required
  check counts as passing. Those PRs are reviewed by one of:
  - a maintainer commenting **`@claude`** on the PR (on-demand; runs in base-repo context
    so it has the secret),
  - the org-hosted **managed Claude review** integration (auto-reviews forks), and/or
  - an on-demand deep multi-agent review by a maintainer.
- **Human review** — at least one approving review is required to merge to `main`, and all
  review conversations must be resolved first.
- A PR that edits `.github/workflows/claude-code-review.yml` itself will fail
  `claude-review` by design (the action validates the workflow matches `main`) and needs
  an admin merge.

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).
