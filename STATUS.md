# Project Status — AttestoMCP

_Single source of truth for what's done, what's next, and what's waiting on you._
_Updated **2026-07-06** · `005-human-not-present` (docs PR #31, rebased onto #32) · CI green · 228 tests pass._

> **How this file works.** Read it at the start of every working session and update it at the end. It is
> decisions-first: "Decisions for you" (each a checkbox + recommendation), then In flight / next, a rolling
> Done log (linked commits), then standing constraints. Keep it current.

---

## ⏳ Decisions for you

- [ ] **Publish `0.2.0` — ON HOLD pending the rename decision below (2026-07-02).** Publishing would cement
      the `attestomcp` package names counsel just ruled non-compliant. Once renamed: add the **`NPM_TOKEN`**
      secret (publish rights to the `@openmobilehub` scope), then cut a **GitHub Release** →
      `.github/workflows/publish.yml` publishes **gate first, then storefront** (with provenance). Or publish
      manually in that order. See `docs/PUBLISHING.md`.
- [ ] **Add the `CLAUDE_CODE_OAUTH_TOKEN` secret** + a `claude-code-review.yml` workflow if you want the
      automated PR review (the org-managed review also covers it).
- [ ] **Rename — DEFERRED to ~week of 2026-07-06 (maintainer, 2026-07-03).** Mandatory per LF brand counsel
      (Daniel Scales, via the Saurabh/Mike Woster thread): "MCP" in the name suggests the project is run by the
      MCP project (AgenticAI Foundation trademark) and violates the
      [LF trademark policy](https://lfprojects.org/policies/trademark-policy/) unless used **descriptively** —
      "X for MCP" is fine, a fused "XMCP" is not. Research is **done** (nine sweeps in `docs/naming-clearance.md`;
      queue leader **Consentinel**, shortlist Attorn / Creance / Assentio / Poder). **Next action is external:
      forward `docs/naming-counsel-brief.md` (drafted 2026-07-03, ready to send) to LF counsel for a USPTO+EUIPO
      knockout in classes 9/36/42.** Revisit next week. Blocks `NPM_TOKEN` / publish `0.2.0` (nothing cemented:
      `0.2.0` unpublished, GDC not public). Execution when a name clears = known-size find-replace (~171 sites).
- [ ] **005 sequencing fork — decision memo ready to ratify (2026-07-03).** Ship merchant-side v0.1
      (server-HMAC) first, or re-scope 005 to wallet-custody directly? Full analysis +
      recommendation in [`sequencing-fork-memo.md`](specs/005-human-not-present/sequencing-fork-memo.md).
      **Recommendation: Option B (wallet-custody directly), seams-first** — the spike (Runs 1–5, incl. a
      green settlement) retired Option A's de-risking rationale, so A now only ships a merchant-side minting
      rail the wallet model obsoletes. Build the shared gate seams first (envelope, completeOrder branch,
      revocation store, typed refusals), then the wallet server (the one new backend). Not urgent to
      *execute* (005 builds on 004 → publish → rename, deferred a week), but ratifying unblocks the 005 plan.
- [ ] **Confirm the 005 Group-A decisions** (D1–D3, still *tentative* per the 2026-07-01 discussion) + the
      Decision-13 constitution amendment — both gate `/speckit-plan` → `/speckit-implement` for 005.

---

## 🔨 In flight / next

- **Publish `0.2.0`** — blocked on the `NPM_TOKEN` secret (above). Pre-flight green (CI build+test).
- **Flip the reference demo** — once published, `openmobilehub/mcp-apps-shopping-demo` switches its dependency
  on `@openmobilehub/attestomcp-*` from the workspace to the published `^0.2.x`, and renames its own
  `AttestoMcp` / `attestoMcpManifest` imports to `AttestoMCP` / `attestoMCPManifest` (tracked in that repo,
  [#26](https://github.com/openmobilehub/attestomcp/issues/26)).
- **Cart Mandate (004) `statelessOrders` — COMPLETE, in [PR #32](https://github.com/openmobilehub/attestomcp/pull/32)
  (2026-07-04).** The 004 core was already on `main`; this session finished FR-007 end-to-end: the created order
  rides in the signed Cart Mandate on the link (`?order=<id>&cart=<b64>`) instead of a created-order store, and
  the gate rails + rail page JS + the storefront `/checkout` page + place-order + every approve link + the
  gate returnUrl + the passkey device-toggle + the ungated instant-demo place-order all reconstruct + **verify**
  it (fail-closed). Storefront `createStorefront({ statelessOrders })`; the harness has a `STATELESS` env toggle
  (run stateful **and** stateless side by side). **202 tests green** (172 gate + 30 storefront), incl. bypass
  tests + a both-modes full-checkout-walk, all verified red when their control is removed. Honest scope:
  drops the *created-order* store only (verification + completion state stay server-side — "stateless cart
  transport, not a stateless server"). Runnable demos in `examples/{stateless-orders,run-storefront}/`.
  **Remaining DX polish (noted in the PR):** none blocking. PR #32 was cleanly split off `main`; **PR #31 is
  now the 005 docs port, rebased onto #32** (2026-07-06) so it carries **zero code diff** — the duplicate 004
  commits dropped by patch-id, leaving only the docs/specs/spike history. Both PRs are non-conflicting; #32
  merges first, then #31 auto-retargets to `main` (see `git-branch-hygiene` memory).
- **Storefront persistence (005) — MERGED to `main`** ([#33](https://github.com/openmobilehub/attestomcp/pull/33),
  [#27](https://github.com/openmobilehub/attestomcp/issues/27)/epic #29). `createStorefront({ storage: redisStorage(…) })`:
  four stores over Upstash Redis (optional peer dep, lazy-loaded), in-memory stays the zero-config default,
  per-slot injection wins, namespace isolation, fail-closed. `main` merged into #32 cleanly for this.
- **HNP (005)** — big design day 2026-07-01 (branch `005-human-not-present`, pushed; no PR yet): the
  **connector-architecture design** (wallet-custody over MCP: stock Multipaz Wallet seals the Intent
  Mandate, a new wallet server signs bounded draws, a UPay-style verifier settles, Claude orchestrates
  holding nothing) + a delegation walkthrough + overnight desk-verification (key find: **EUDI SCA TS12's
  `PaymentTransaction` natively expresses our bounds** — `max_amount`, cumulative `total_amount`, window,
  payee — no custom transaction type needed; consent sheet renders only "• Payment", so the approve page
  carries the terms) + an AP2 field mapping + a DRAFT (unsent) Multipaz upstream proposal. Everything
  **tentative** pending the decisions above. Next concrete step: the on-device confirmatory spike
  (design doc §12). **Goal-directed overnight batch 2**: wallet-server build guide (hosted Utopia
  endpoints found; ceremony = stock SDK; OAuth is the work item; confidence 70→85%), a **six-persona DX
  council review** (`dx-council-review.md` — verdict: ready to build toward; finding #1: the redemption
  choreography was undefined), the **redemption choreography draft** answering it
  (`redemption-choreography-draft.md` — six-call sequence, pspTransactionId rename, enforcer/retryable
  refusals), the AP2+TS12 **bounds schema draft**, and a **talk outline draft**.
- **HNP §12.1 on-device spike — COMPLETE incl. GREEN SETTLEMENT (Runs 1–5 in the runbook).** All six
  opens answered on published artifacts: hosted issuance was broken (500, **bug filed upstream**;
  now apparently working again — retest); consent stack captured with screenshots (5 layers, none
  show amount/payee — `spike-evidence/`); same-device AND cross-device (desktop QR → phone)
  ceremonies work end-to-end; brewery combined age+payment: one DCQL, two credential_sets, minimal
  disclosure (`age_over_18` only). **Run 5 (2026-07-03): first GREEN settlement on a self-hosted
  Utopia stack** — locally-issued Pivo mdoc accepted by the local UPay verifier (`process_response
  200`, `transaction_data_hash` verified, committed to the Bank of Utopia ledger, Txn
  LIb144uDCQM7x3y8). This closes the design loop end-to-end on controlled infra and confirms the
  presence-only refusal was the *only* gap between wire-correct and settled. Root cause of the
  earlier two-day refusals was credential **selection** (CredMan routing to untrusted same-doctype
  cards), not trust. **Upstream-reportable**: CredMan wrong-wallet-wins silently routes a payment to
  an untrusted credential. Issuance-bug handoff: `~/tools/git/multipaz/TROUBLESHOOT-ISSUANCE-500.md`.
- **HNP §12.2 headless-auth spike — READ OUT 2026-07-05: PASS, with a discovered second gate.**
  Heartbeat succeeded `tokenGeneration 1 → 26` (Jul 2 → Jul 6 UTC), *"authenticated without re-auth"* — the
  scheduled task's OAuth refresh chain rotated headlessly for 3½ days ⇒ **claude.ai routines CAN carry the
  unattended demo leg.** Two companion findings: (1) **tool permissions are a second gate, and they are
  TASK-SCOPED** — every scheduled run stalled on a human "Allow" prompt; the permission ladder is *Allow
  once → Allow for this task / for all scheduled runs (of that task) → Allow for all tasks*
  (connector-wide); a NEW task re-prompts even after an old task was granted (verified 2026-07-05 with an
  ad-hoc task). **Standing-grant persistence CONFIRMED 2026-07-05**: a recurring test task granted once
  on run 1 ran its next cycle fully headless (server logs: refresh gen 27→28 + heartbeat, zero clicks);
  the prompt appears only on a task's first tool use, which fires immediately at creation → the grant is
  a setup-time step. Demo setup recipe: one OAuth consent + one per-task permission grant, both
  human-present; (2) claude.ai's **two DCR clients hold independent chains** — the
  web-chat client expired → "reconnect" while the task client stayed alive (per-surface auth, don't
  conflate). Ops lesson for the real wallet server: **console logs are not an audit trail** (Vercel Hobby
  retains 1h; the readout survived only in the task's own reports) — the draw log/`delegationId` record
  must be first-class state. Cleanup pending: confirmation window through ~Jul 8, then delete the Vercel
  project + connector (committed HMAC secret). Rename decision still deferred; publish remains on hold
  behind it.

---

## ✅ Done (rolling — newest first)

| What | Where |
| :-- | :-- |
| `AttestoMcp` → `AttestoMCP` brand-casing rename (class, `AttestoMCPOptions`, ~171 sites across code + docs), version bumped `0.1.0` → `0.2.0` | [#26](https://github.com/openmobilehub/attestomcp/issues/26) |
| Repo migrated out of `mcp-apps-shopping-demo` (history-preserved), CI green, branch protection on `main` | this repo |
| Dev + reference docs (`docs/reference/*`, README, ARCHITECTURE, CONTRIBUTING, SECURITY-INVARIANTS) | `docs/` |
| The full ceremony extraction (003): the demo became a thin consumer; the gate is the published library | `specs/003-…` |

---

## 📌 Standing constraints (don't regress)

- **The 6 security invariants** (`SECURITY-INVARIANTS.md`) — a change that breaks one is blocking, even in demo code.
- **Honesty:** `trust_level` stays `presence-only-demo` for the OpenID4VP rails (real wire crypto, no issuer
  trust anchor yet) — never sold as a real safety control. A pro trademark search is advised before publish.
- **DCO** `git commit -s` on every commit; bypass tests must fail with their control removed.
