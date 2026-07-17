# 005 sequencing fork — decision memo (2026-07-03)

**RATIFIED by the maintainer 2026-07-08: Option B (wallet-custody directly, seams-first).** Resolves the "Open maintainer decision" left in
`connector-architecture-design.md` §10, now that the on-device spike is complete (Runs 1–5,
`on-device-spike-runbook.md`) **including a green settlement**. This memo does not change any
load-bearing concept in `spec.md` — only *what ships first*.

## The decision

Does 005 ship the **merchant-side v0.1** (server-HMAC grants) as the first released increment with
wallet-custody as its successor (**Option A**), or is 005 **re-scoped to target wallet-custody
directly** (**Option B**)?

| | A — v0.1 merchant-side first | B — wallet-custody directly |
| :-- | :-- | :-- |
| First-increment size | small | larger (adds the wallet server) |
| Intent signer | the server (`server-issued-demo`) | the user's phone (DeviceKey + DPC) |
| Throwaway | **merchant-side minting rail** (wallet model obsoletes it) | none |
| Shared gate seams built | yes (envelope, completeOrder branch, revocation store, typed refusals) | yes — same seams, built once |
| Honesty fence | settlement suppressed | real flow, fake money (`issuer-verified (demo PKI)`) |
| New backend | none | wallet server (Kotlin/JVM on Multipaz libs) |

## What the spike changed

Option A's core rationale was **de-risking**: ship the small thing first to prove the seams before
committing to the wallet model. **The spike retired that rationale** — every hard unknown is now
answered on published/controlled infra:

- Ceremony mechanics end-to-end (DC API → OpenID4VP v1 → consent → biometric → presentation).
- Cross-device QR (the exact shape the claude.ai approve page needs).
- Consent renders displayName-only → the approve-page-carries-the-terms mitigation stands.
- Verifier-side **issuer trust is real** — and **Run 5 settled a real payment** on the self-hosted
  Utopia stack with a locally-issued card (commit to the Bank of Utopia ledger).

So the wallet-custody path is no longer a bet; it's a build with the risky parts already walked.

## Recommendation — Option B, seams-first

**Re-scope 005 to wallet-custody (B), but sequence the build so the shared gate seams land first.**

Why B over A:
1. **A's de-risk value is spent** (above). What A uniquely still buys is a *sooner, smaller shipped
   increment* — but see scheduling below: nothing in the 005 build track can start for ~a week
   regardless, so "sooner" has no pull right now.
2. **A ships a rail the wallet model obsoletes.** Merchant-side minting (server-HMAC) becomes dead
   code the moment the phone signs the intent; shipping it also means maintaining *two* honesty-fence
   stories (`server-issued-demo` + settlement-suppressed, then `issuer-verified (demo PKI)` + fake
   money). Net-negative once de-risking is off the table.
3. **The reusable core isn't throwaway** — build it directly for B. The gate seams A would have
   exercised (envelope, `completeOrder` branch, revocation store, typed refusals) are needed by the
   wallet model too. Build them **first**, in service of B, without the merchant-side minting rail on
   top.

Suggested build order under B (low-risk reusable core → custody layer):
1. **Shared gate seams** in `credentagent-gate`: draw-verification envelope, `completeOrder` draw
   branch, revocation store, the typed-refusal vocabulary (§9). Pure TS, testable in isolation,
   serves the demo regardless.
2. **Settlement verifier** (UPay-style `VerifierAssistant`, ~150 lines) — the spike already proved
   this path green.
3. **Wallet server** (`credentagent-wallet`, Kotlin/JVM) — policy engine, draw signer, OpenID4VP
   verifier, MCP connector. The single genuinely-new backend (§12.4: sibling repo, leaning).
4. **`credentagent-agent`** (thin, Node) last — nice-to-have for local agents.

Corollary (folds in the FR-002 open point): under B the **DPC rail carries the ceremony**; the
WebAuthn/passkey rail's role from the merchant-side model **defers** — DPC-only for the connector
unless a later need resurfaces it.

## Scheduling reality (why this isn't urgent to *execute*)

005 builds on **004** (Cart Mandate), which builds **after publish**, which is blocked on the
**rename** (deferred to ~week of 2026-07-06). So this decision is a **design/planning input**, not
an execution trigger — ratifying it now lets the 005 plan proceed; the build waits on the chain
above regardless.

## What ratifying this unblocks

Ratifying B (with the two still-tentative gates — the **Group-A decisions D1–D3** and the
**Decision-13 constitution amendment**, `constitution-amendment-draft.md`) clears
`/speckit-plan` → `/speckit-implement` for 005. Those two are tracked separately in `STATUS.md`;
this memo resolves only the A-vs-B fork.

---

**Ratify?**  ☐ Option B, seams-first (recommended)   ☐ Option A   ☐ discuss
