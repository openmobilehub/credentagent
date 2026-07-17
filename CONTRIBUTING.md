# Contributing to CredentAgent

Thanks for helping build **CredentAgent** — the consent layer for AI agents. This repo holds two
npm workspaces:

- **`@openmobilehub/credentagent-gate`** — the Gate (`new CredentAgent()`, `credentagent.mount(app)`): the
  `/credentagent/*` ceremony rails (passkey / OpenID4VP credential / Digital-Credentials payment) and
  the policy resolver.
- **`@openmobilehub/credentagent-storefront`** — the agentic storefront core (`createStorefront()`):
  the cart → priced-cart → order model, the MCP shopping tools, and the widget bundle.

CredentAgent is part of [Open Mobile Hub](https://openmobilehub.org) under the OpenWallet Foundation /
Linux Foundation, and the contribution rules below reflect that posture — most importantly the
**DCO sign-off** and the **security-test bar**. Please read this file before opening a PR.

The runnable end-to-end reference — a credential-gated agentic shopping app on every MCP surface —
lives in a separate repo, [`mcp-apps-shopping-demo`](https://github.com/openmobilehub/mcp-apps-shopping-demo).
Use it to see the packages in action; contribute library changes here.

## Dev setup

You need **Node ≥ 20** (CI runs Node 22; both packages declare `engines.node >= 20`).

```bash
npm install        # installs the workspace + dev deps (use `npm ci` for a clean, lockfile-exact install)
npm run build      # builds both packages, then typechecks, then builds the server
npm run test       # runs the full vitest suite (vitest run)
```

Useful per-task commands:

| Command | What it does |
| :-- | :-- |
| `npm run build` | Build both workspaces (`build --workspaces --if-present`) → typecheck → build the server. |
| `npm run test` | Run every test once (`vitest run`). |
| `npm run typecheck` | `tsc --noEmit` — types only, no emit. |
| `npm run lint` | The invariant-encoding lint rules (`eslint.config.js`) — the mechanically-checkable slice of `SECURITY-INVARIANTS.md`. |

You can also build or test a single package from its directory (each workspace exposes its own
`build` and `test` scripts), but **`npm run build` and `npm run test` from the repo root must both
pass before you open a PR** — that is exactly what CI runs (`npm ci` → `npm run build` → `npm test`).

## Sign off every commit (DCO)

This is an OpenWallet Foundation / openmobilehub repo, so it enforces the
[Developer Certificate of Origin](https://developercertificate.org/). **Every commit must carry a
`Signed-off-by:` line** asserting you have the right to contribute the change under the project's
license (Apache-2.0).

**This is automated for you:** `npm install` activates the committed
`scripts/git-hooks/prepare-commit-msg` hook (via `core.hooksPath`), which appends the
`Signed-off-by:` trailer from your git identity to any commit that lacks one. You can
still sign off explicitly — the hook never duplicates an existing trailer:

```bash
git commit -s -m "your message"
```

`-s` appends a trailer like:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email **must match your Git identity** (`git config user.name` / `user.email`). If you
forgot to sign off, fix the existing commits before pushing:

```bash
git rebase --signoff main      # add the sign-off to every commit on your branch
```

The DCO check is a hard gate — a PR with any unsigned commit will be **blocked** until it's clean.

## Push your branch — don't fork

**Maintainers: push your feature branch to this repo rather than working from a fork.** The
automated Claude review only runs on **same-repo** PRs. GitHub withholds repository secrets (the
`CLAUDE_CODE_OAUTH_TOKEN` the review action needs) from workflow runs triggered by fork PRs on a
public repo — regardless of your permission level — so a fork PR can't run the always-on review. If
you push to a branch here, you get that review for free.

## Code review

PRs get both automated and human review. The checklist both run is
[`REVIEW.md`](REVIEW.md) (repo root) — read it before opening a PR to know exactly what
your diff will be held against.

### Automated Claude review

- **Same-repo PRs** — an automated Claude review (`anthropics/claude-code-action`) runs on every
  non-draft PR opened from a branch in this repo. It's grounded in this project's security
  invariants. **The review is opt-in and currently OFF** — it only runs when the repo variable
  `ENABLE_CLAUDE_REVIEW` is `"true"`; otherwise `claude-review` is skipped, which counts as passing,
  so it doesn't block merges (human review is the gate). (Draft PRs are also skipped to save cost;
  mark a PR ready for review to trigger a run.)
- **Fork / external-contributor PRs** — the automated job is **skipped** (fork runs can't read the
  secret), and a skipped required check counts as passing, so it never blocks you. External PRs are
  reviewed instead by a maintainer commenting **`@claude`** on the PR (which runs in base-repo
  context, so it has the secret), the org-hosted managed Claude review integration, and/or an
  on-demand deeper review by a maintainer.
- A PR that edits the review workflow (`.github/workflows/claude-code-review.yml`) itself will fail
  `claude-review` by design and needs an admin merge.

### Human review

- At least **one approving human review** is required to merge to `main`.
- **All review conversations must be resolved** before merge.
- Keep PRs small and well-scoped — one clear purpose per PR. Prefer a new, well-bounded module over
  growing a file past its single responsibility, and match the style, naming, and comment density of
  the surrounding code.

## Tests must exercise the bypass paths

CredentAgent is a consent layer; a test that only checks the happy-path shape is not enough.

- **Cover the security-critical / bypass paths**, not just the happy path. For example: POST an
  unverified age-restricted order and assert it is **refused**; authorize a discounted cart and
  assert amount binding **passes**; assert one session's verification can't unlock another's
  (no process-global state bleed).
- **A test that would still pass with the security control removed is rejected.** If deleting the
  gate doesn't turn your test red, the test isn't protecting anything — add an assertion that fails
  when the control is gone.

These mirror the load-bearing invariants the gate enforces: gates run server-side on **every**
completion path, amounts/flags are re-derived from the catalog (never trusted from the order token),
verification state is scoped per order/session, and a credential is accepted only on an **explicit
positive claim** (e.g. `age_over_21 === true`, not "a token was present").

## Honesty bar

CredentAgent's current `trust_level` is **`presence-only-demo`**. The wire cryptography is real — real
WebAuthn on the passkey rail; OpenID4VP JWE / ECDH-ES decrypt with nonce binding; HPKE; ISO-mdoc
parse — **but there is no issuer / device-signature trust anchor yet**, and the AP2-shaped mandate is
dev-signed (integrity hash), not key-signed. A self-crafted mdoc would pass a presence-only gate.

Carry this honesty in the code, the types, and the docs you touch. **Never describe a presence-only
gate as a real safety control.** Issuer-verified trust (`trust_level: "issuer-verified"`) is the
v0.2 line — if a change relies on cryptographic mdoc trust that doesn't exist yet, it must be fenced
behind an explicit demo-only mode and labeled as such.

## Fix it or flag it — never leave it unremarked

If you notice something broken while working — even if it's outside your change, not your ticket,
or code you didn't write — **do not scroll past it.** Silently ignoring a defect you saw is the one
thing we don't do here.

- **Small and safe → fix it** in your PR (a one-line guard, an obvious typo, a mislabeled string).
- **Bigger, risky, or out of scope → open an issue** (or leave a review comment) that names it. The
  bar for surfacing is deliberately low: a one-sentence "spotted this, out of scope, filed #NN" is
  enough. The point is that nothing broken goes **unrecorded**.

The guardrail is to **keep PRs focused** — don't balloon your change to chase everything you find.
The issue tracker is the pressure valve: fix the small thing inline, spin the rest into its own issue.
The two are not in tension.

You mostly find these by **actually running the thing** — and *running it* means **reading every
screen critically**, not just confirming the happy path finishes. A stepper that claims steps the
buyer never did, or a page that stays "Payment locked" for an order the server already marked paid,
is invisible in a unit test, sails through a "does it complete?" click-through, and is obvious the
moment you *look* at what the UI is saying. "Did you test it visually? yes" is not the bar —
**does every screen tell the truth?** is. So run what you ship (see the bypass-tests and
[DX rubric](docs/reference/architecture-principles.md) sections), read what it shows, and when it
turns up something off, fix it or flag it.

## Checklist before you open a PR

- [ ] `npm run build` passes (both packages build, typecheck, server builds).
- [ ] `npm run lint` passes — a new `eslint-disable` needs a one-line justification.
- [ ] `npm run test` passes, and new tests cover the security-critical / bypass paths.
- [ ] For any UI/flow change: you drove the real UI end-to-end and confirmed **every screen tells the truth** — not just that the happy path completes (no stale/locked page for a paid order, no step or label claiming something that didn't happen).
- [ ] Every commit is signed off (`git commit -s`); the DCO check will be green.
- [ ] You pushed a branch to this repo (not a fork) so the automated review can run.
- [ ] No presence-only gate is presented as a real safety control.
- [ ] Anything broken you noticed along the way is fixed or filed — never silently ignored.

Apache-2.0 · part of [Open Mobile Hub](https://openmobilehub.org) (Linux Foundation).
