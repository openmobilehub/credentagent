# Project Status — AttestoMCP

_Single source of truth for what's done, what's next, and what's waiting on you._
_Updated **2026-07-02** · `005-human-not-present` · CI green · 189 tests pass._

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
- [ ] **Rename — no longer optional (2026-07-02).** LF brand counsel (Daniel Scales, via the Saurabh/Mike
      Woster thread) ruled that "MCP" in the name suggests the project is run by the MCP project (AgenticAI
      Foundation trademark) and violates the [LF trademark policy](https://lfprojects.org/policies/trademark-policy/)
      unless used **descriptively** — "X for MCP" is fine, a fused "XMCP" is not. Decide the new name **before**
      adding `NPM_TOKEN` / publishing `0.2.0` (nothing is cemented: `0.2.0` unpublished, GDC not public).
      Wrinkle: plain "Attesto" was itself rated *contested* commercially (`docs/naming-clearance.md` — note that
      doc's history was mangled by the #8 bulk rename; its collision analysis reads "AttestoMCP" but is about
      "Attesto"). Vetted coined shortlist: **Heralda / Warrend / Avowa**. Suggested path: confirm the acceptable
      descriptive pattern with counsel (e.g. "Attesto — a consent gate for MCP agents"), then pick and do the
      known-size find-replace (~171 sites, same job as #8/#30).
- [ ] **005 sequencing fork — the spike input is now IN (2026-07-02).** Ship merchant-side v0.1
      (server-HMAC grants) first, or re-scope 005 to the wallet-custody connector architecture directly?
      The on-device spike answered all six opens (`specs/005-human-not-present/on-device-spike-runbook.md`,
      Runs 1–4): ceremony mechanics work end-to-end on published artifacts **including the cross-device QR
      leg the approve page needs**; consent renders displayName-only (approve-page mitigation stands);
      verifier-side issuer trust is real. **Recommendation: wallet-custody is buildable** — the only infra
      gap is hosted issuance (bug filed upstream by the maintainer 2026-07-02; self-hosted Utopia stack
      with our IACA is the proven fallback). Note: 005 builds on 004, which builds after publish.
- [ ] **Confirm the 005 Group-A decisions** (D1–D3, still *tentative* per the 2026-07-01 discussion) + the
      Decision-13 constitution amendment — both gate `/speckit-plan` → `/speckit-implement` for 005.

---

## 🔨 In flight / next

- **Publish `0.2.0`** — blocked on the `NPM_TOKEN` secret (above). Pre-flight green (CI build+test).
- **Flip the reference demo** — once published, `openmobilehub/mcp-apps-shopping-demo` switches its dependency
  on `@openmobilehub/attestomcp-*` from the workspace to the published `^0.2.x`, and renames its own
  `AttestoMcp` / `attestoMcpManifest` imports to `AttestoMCP` / `attestoMCPManifest` (tracked in that repo,
  [#26](https://github.com/openmobilehub/attestomcp/issues/26)).
- **Cart Mandate (004)** — spec ready (`specs/004-cart-mandate/spec.md`); build after publish.
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
- **HNP §12.1 on-device spike — COMPLETE (2026-07-02, Runs 1–4 in the runbook).** All six opens
  answered on published artifacts: hosted issuance broken (500, **bug filed upstream by the
  maintainer**; reproduced across 2 devices × 3 wallet builds); consent stack captured with
  screenshots (5 layers, none show amount/payee — `spike-evidence/`); same-device AND cross-device
  (desktop QR → phone) ceremonies work end-to-end; brewery combined age+payment: one DCQL, two
  credential_sets, minimal disclosure (`age_over_18` only), transaction data bound to the payment
  credential alone. Everything terminates at the expected issuer-trust refusal (TestApp IACA).
  **Next session: self-hosted Utopia stack** (`/tmp/multipaz-utopia` docker; UPay trust manager takes
  IACA roots from a configured CA URL — `organizations/upay/backend/.../Main.kt:49`) with the TestApp
  IACA trusted → first **green settlement** without waiting for the upstream fix. Troubleshooting
  handoff for the issuance bug lives at `~/tools/git/multipaz/TROUBLESHOOT-ISSUANCE-500.md`.
- **HNP §12.2 headless-auth spike — LIVE (2026-07-02).** `spike/headless-auth/` deployed to
  `https://headless-auth-coral.vercel.app/mcp`; connector added to claude.ai and verified server-side
  (DCR → consent → token gen=1 → heartbeat 200 in the Vercel logs; claude.ai registered two DCR clients,
  confirming the predicted proliferation). Daily scheduled task created 2026-07-02; **read out
  ~2026-07-05** per the README rubric (rising tokenGeneration + no re-auth = PASS → routines can carry
  the unattended demo leg). Rename decision consciously deferred by the maintainer (2026-07-02); publish
  remains on hold behind it.

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
