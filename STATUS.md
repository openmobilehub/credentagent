# Project Status — CredentAgent

_Single source of truth for what's done, what's next, and what's waiting on you._
_Updated **2026-07-12** · quickstart ladder (007) + storefront `0.2.1` (statelessMcp + serverless widget bundle) shipped · demo live on `mcp-apps-nine` · 249 tests pass._

> **How this file works.** Read it at the start of every working session and update it at the end. It is
> decisions-first: "Decisions for you" (each a checkbox + recommendation), then In flight / next, a rolling
> Done log (linked commits), then standing constraints. Keep it current.

---

## ⏳ Decisions for you

- [ ] **Send the updated naming-counsel-brief (CredentAgent) to LF counsel for the USPTO+EUIPO knockout
      (classes 9/36/42).** The maintainer waived the publish-behind-knockout gate on 2026-07-08 (packages are
      live as `@openmobilehub/credentagent-*`), so the knockout is now a **retroactive risk check** — advisory
      flags from `docs/naming-clearance.md` (generic "-Agent" suffix, cred- neighbors: Credant/CredenTek) still
      deserve the professional search. Fresh scoped packages were unpublishable-within-72h if it had surprised
      us; that window is the accepted risk.
- [ ] **Add the `CLAUDE_CODE_OAUTH_TOKEN` secret** + a `claude-code-review.yml` workflow if you want the
      automated PR review (the org-managed review also covers it).
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
- [ ] **Archive `mcp-apps-shopping-demo` (007 tail, T014).** Land the banner README ("this demo became
      CredentAgent → quickstart") and `gh repo archive` it — **archive, never delete** (external videos, the
      interoperability PDF, and partner threads link to it). Only after the quickstart is the demo of record,
      which it now is. Recommendation: do it once 007 merges.

---

## 🔨 In flight / next

- **AP2 v2 alignment — captured as [#39](https://github.com/openmobilehub/credentagent/issues/39) +
  [#40](https://github.com/openmobilehub/credentagent/issues/40)** (2026-07-08), prompted by AP2-team feedback
  (Yanhe Chen, Google, Discord 2026-06-02: v1-shaped mandate, unsigned amount, unverified issuer/deviceAuth).
  #39 = Node/TS v2 wire format (SD-JWT/KB-SD-JWT chain, `vct: mandate.payment.1`, minor units, constraints,
  receipts); #40 = bidirectional CI conformance against the official
  [AP2 Python SDK](https://github.com/google-agentic-commerce/AP2/tree/main/code/sdk/python/ap2). The signing
  swap stays #13, the issuer/device trust anchor stays #14; #12 (HNP) consumes #39's open-mandate constraints.
- **Publish `0.2.0` — DONE (2026-07-08)**: live as `@openmobilehub/credentagent-*` via release
  `v0.2.0-credentagent` (CI, provenance); `NPM_TOKEN` secret set; old names deprecated (see Done).
- **Flip + slim the reference demo** — once published, `openmobilehub/mcp-apps-shopping-demo` switches its
  dependency on `@openmobilehub/credentagent-*` from the workspace to the published `^0.2.x`, renames its own
  `AttestoMcp` / `attestoMcpManifest` imports to `CredentAgent` / `credentAgentManifest`, and deletes its
  hand-rolled adapters (3 Redis store classes + the Firestore catalog loader) in favor of `redisStorage(…)` /
  `firestoreCatalog(…)` — epic #29's scope A, now filed as
  [mcp-apps-shopping-demo#27](https://github.com/openmobilehub/mcp-apps-shopping-demo/issues/27) (2026-07-08).
- **Cart Mandate (004) `statelessOrders` — COMPLETE, in [PR #32](https://github.com/openmobilehub/credentagent/pull/32)
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
- **Storefront persistence (005) — MERGED to `main`** ([#33](https://github.com/openmobilehub/credentagent/pull/33),
  [#27](https://github.com/openmobilehub/credentagent/issues/27)/epic #29). `createStorefront({ storage: redisStorage(…) })`:
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
| **Encode domain knowledge as infrastructure (2026-07-15)** — `REVIEW.md` review checklist wired into the automated review (+ workflow self-validation, draft skip), invariant-encoding ESLint layer (`npm run lint`, in CI; each rule verified to fire), committed DCO auto-sign-off hook (`scripts/git-hooks/`), agent skills committed in-repo (`add-ceremony-rail`, `write-bypass-test`, `publish-release`). Spec: `docs/superpowers/specs/2026-07-15-encode-knowledge-as-infra-design.md` | [PR #67](https://github.com/openmobilehub/credentagent/pull/67) |
| **Quickstart ladder (007) — the 5-min try/run/own demo + hosted cutover.** `examples/quickstart` (35-line hero, own package, ladder README, Deploy button), CI `quickstart-smoke` (10 assertions incl. security-bypass + widget-resource), demo promoted onto `mcp-apps-nine` (legacy alias kept). Two serverless bugs found by real-device testing + fixed in `0.2.1`: `statelessMcp` (multi-instance MCP session loss → `No valid session`; cross-instance tests + real-Vercel 20/20 seq · 15/15 conc) and the widget HTML not bundled into the function (`includeFiles` + smoke row g). `0.2.1` published; prod on the published dep (reproducible) | `specs/007-quickstart-ladder`, PR (this branch) |
| **Rename EXECUTED: AttestoMCP → CredentAgent (2026-07-08)** — library ([PR #38](https://github.com/openmobilehub/credentagent/pull/38), 132 files, verified live both custody modes), GitHub repos renamed (`credentagent`, `credentagent-website`), website content ([credentagent-website#8](https://github.com/openmobilehub/credentagent-website/pull/8), Pages live), #31 retrofitted via the committed rename script | [#37](https://github.com/openmobilehub/credentagent/issues/37) |
| **Published `0.2.0` as `@openmobilehub/credentagent-*`** (release `v0.2.0-credentagent` → CI publish with provenance; `NPM_TOKEN` secret set). Full deprecation chain: `attesto-*` + `attestomcp-*` all point at `credentagent-*` | npm |
| `AttestoMcp` → `AttestoMCP` brand-casing rename (class, options type, ~171 sites across code + docs), version bumped `0.1.0` → `0.2.0` *(historical — pre-CredentAgent)* | [#26](https://github.com/openmobilehub/credentagent/issues/26) |
| Repo migrated out of `mcp-apps-shopping-demo` (history-preserved), CI green, branch protection on `main` | this repo |
| Dev + reference docs (`docs/reference/*`, README, ARCHITECTURE, CONTRIBUTING, SECURITY-INVARIANTS) | `docs/` |
| The full ceremony extraction (003): the demo became a thin consumer; the gate is the published library | `specs/003-…` |

---

## 📌 Standing constraints (don't regress)

- **The 6 security invariants** (`SECURITY-INVARIANTS.md`) — a change that breaks one is blocking, even in demo code.
- **Honesty:** `trust_level` stays `presence-only-demo` for the OpenID4VP rails (real wire crypto, no issuer
  trust anchor yet) — never sold as a real safety control. A pro trademark search is advised before publish.
- **DCO** `git commit -s` on every commit; bypass tests must fail with their control removed.
