# DX Council Review — HNP connector architecture (2026-07-01, overnight)

> All subject matter is tentative pending maintainer decisions (the design doc itself is Draft; §10's ship-order question and §12's open items are unresolved).

**Council**: Merchant (senior TS/Express e-commerce dev), Agent (headless cron Node agent dev), Platform (MCP/hosted-assistant platform engineer), Security (footgun-focused security engineer), Identity (Kotlin/Multipaz/TS12 engineer), DevRel (SDK docs lead). Reviewing `specs/005-human-not-present/connector-architecture-design.md` against the shipped `packages/attestomcp-gate` API.

---

## 1. Verdict

This DX is ready to build toward. The council unanimously endorses the load-bearing decisions — pull-based continuation as a named principle, typed refusals as a success bar, opt-in delegation config on the configure-once client, and reference-not-artifact custody — and every persona independently found the same shape recognizable as an extension of the shipped gate. But the single biggest risk is that **the redemption choreography — the one sequence every demo beat and every success bar depends on — cannot be assembled from the document**: §6 requires the draw to be signed over the settlement's fresh `transaction_id`, yet §7's `request_draw` has no way to receive one; the merchant-side MCP tool that accepts the draw is never named or schema'd; and the cart shape crossing connectors (GTIN vs SKU) is untyped. Four of six personas hit this wall independently (Agent, Platform, Security, Identity). Until that six-call sequence is written down end to end, neither the 15-minute quickstart nor the hosted-assistant demo is implementable, and everything else in this report is refinement. The second-order risk is schedule, not design: the critical path runs through an unbuilt Kotlin wallet server whose OAuth layer is self-described as "the fiddly part," with no headless auth story.

## 2. Scorecard — the four success bars

### ≤3 lines for a merchant — **Met in letter, misleading as stated** (unanimous)
The `delegation` config block is genuinely small and fits the shipped `AttestoMCPOptions` pattern. But the flagship §8 snippet does not compile against anything (`usd()` and `UTOPIA_DEMO_WALLET` exist nowhere — grep confirms), and the two real prerequisites are unpriced: **GTIN→SKU catalog mapping** (the shipped `Product` model has no GTIN field; for a real merchant this is a data project, not a line) and **obtaining a trust-list entry** for a wallet server that does not exist yet. Consensus reframe (DevRel's phrasing): *"one config key on the client you already have, given a GTIN-mapped catalog."* Security's dissent on tone: three lines that paste a demo trust anchor into production is "a bar met by cheating" — the honest count is ~6 lines with an explicit `demoWallet()` fence.

### Storefront ships it built-in — **Most credible bar; kill the boolean** (unanimous on both halves)
`createStorefront({ delegation: ... })` fits the existing seam-composition pattern exactly (Identity: "the most credible bar; no design changes needed"). Two conditions: (1) **`delegation: true` must die** — a boolean cannot carry a trust list, and it silently defaults the one decision that is the whole security surface (Security: "the single worst token in the document"; DevRel and Merchant concur); (2) the bar is unverifiable until the delegated-checkout MCP tool is named and schema'd (Agent, Platform).

### 15-minute agent quickstart — **Not met as designed** (unanimous)
Blockers named by four personas: the wallet server is an unhosted Kotlin/JVM service; OAuth is interactive-only (no `client_credentials`, no device-code flow specified, and the `AttestoAgent` sketch shows no auth at all); the ceremony requires an Android phone + Multipaz APK + hosted DPC provisioning (iOS developers get zero minutes); and every test run needs a human thumb. Unanimous fix: a **hosted sandbox wallet server with a pre-delegated, demo-PKI-labeled intent and a browser-click approve page**, plus a documented device-code auth path — then the 15 minutes (install → `list_intents` → `request_draw` → local storefront verify → refusal tour → revoke) is genuinely achievable, with the real Face-ID ceremony as an honestly-timed second act. Platform adds a standing caveat: the headless-refresh spike (§12.2) can independently sink the scheduled-run story regardless of quickstart quality — "a quickstart whose token dies after one scheduled run is a 15-minute demo, not a 15-minute agent."

### Readable refusals — **Strongest bar; closest to met; specific gaps** (unanimous on strength)
Every persona named §9 the best DX decision in the doc. Gaps that keep it from meeting its own standard: the design's own demo (§15 beat 2, `remaining: $70`) is not expressible in the §9 `over-cap` shape; no attribution across the four enforcers (wallet / merchant `maxDraw` / merchant `stepUpOver` / PSP tally — Merchant); no retry-vs-needs-human-vs-terminal classification, the one bit an unattended loop branches on (Agent); missing lifecycle reasons (`intent-pending`, `amount-mismatch`, `reauth-required`, `approve-expired`); `consumed` is ambiguous in the multi-draw model (DevRel); and no MCP-level encoding is pinned — the union is prose that must stay identical across three codebases in two languages (Identity: "the vocabularies will drift within two PRs"). Security's dissent: the bar survives production only after the wallet-rich/gate-coarse split, or the refusals double as a bounds-probing oracle.

## 3. Top findings, ranked by impact

**1. The cross-connector redemption sequence is undefined, and §6 vs §7 contradict on `transaction_id`.** *(Agent, Platform — high; Security, Identity — medium)*
`request_draw(intentId, {merchant, cart, amount})` cannot be signed over a settlement `transaction_id` it never receives; the merchant tool that accepts the draw is unnamed; the cart shape crossing connectors is untyped; and there are two different objects both called `transaction_id` (TS12 `transaction_id = intentId` bounds commitment vs UPay's settlement id) inside one verification chain (Identity).
**Recommendation:** Publish the six-call sequence diagram from the agent's seat with full JSON schemas: merchant tool (name it — `checkout_delegated`) opens the settlement and returns `transactionId + amount`; `request_draw` gains `transactionId`; the merchant tool accepts the draw and returns the shared §9 union. Rename the settlement id `psp_transaction_id` in all AttestoMCP docs. Nothing else in the plan should start before this exists.

**2. The trust list is load-bearing but undefined as a type, unobtainable as a value, and rotation-free — and the demo trust anchor will leak into production.** *(Merchant, Security — high; Platform — high; DevRel — medium)*
Nothing says what a `trustedWallets` entry IS; `UTOPIA_DEMO_WALLET` exists nowhere; K_s is sealed inside DeviceKey-signed bounds, so key rotation as designed orphans every active intent (so nobody will rotate — Platform); and the shipped warn-and-fallback precedent (`client.ts:41-53`), applied to a security config, silently converts a typo into a gate the merchant didn't choose (Merchant, Security independently).
**Recommendation:** Define `TrustedWallet` now (`{ id, displayName, keys: JWKS-with-kid }`, intent names K_s by `kid`, overlap-window rotation). Replace bare constants with `demoWallet()` that **throws** under `NODE_ENV=production` without `allowDemoTrust: true` (the existing `allowEphemeralKey` fence pattern). Specify strict-construction semantics that deliberately diverge from the walletOrigin warn precedent: throw on missing/empty `trustedWallets`, on `stepUpOver > maxDraw`; omitted scopes ⇒ nothing delegable. Say why in the TSDoc.

**3. GTIN→SKU mapping is the hidden fourth line — a data project priced as a parenthetical.** *(Merchant — high; Agent, Platform, Identity, DevRel — concur in scorecards)*
The shipped catalog model has no GTIN field anywhere in either package. Real catalogs mean variant GTINs, multi-packs, and private-label goods with no GTIN at all; the failure mode is silent `out-of-scope` on every unmapped product in production.
**Recommendation:** Make the mapping a typed seam — `gtinResolver(productId) → gtin | undefined` on the delegation config — with documented fail-closed behavior for unmapped products and a mount-time coverage report ("14/220 catalog products are delegable"). Price it honestly in the quickstart as a prerequisite.

**4. The 15-minute quickstart has no sandbox, no headless auth, and an Android-only hardware gate.** *(Agent, Platform, DevRel — high; Identity — concurs)*
Detailed under the scorecard. The design-level gap: §7/§8 never specify how a Node script authenticates to the wallet connector at all — "the biggest unspecified DX surface in the design" (DevRel).
**Recommendation:** Ship the hosted sandbox + pre-delegated demo intent + device-code flow + `agent.login()` with a rotation-safe token store; design the degraded auth mode now (typed `reauth-required` refusal with reconnect URL, morning "reconnect your wallet" routine template) rather than treating §12.2 as verify-later (Platform).

**5. The honesty fence lives in prose while the type says `issuer-verified` — this violates the repo's own rule.** *(Security — high)*
CLAUDE.md: honesty is "carried in the types, not just prose," and `issuer-verified` is the v0.2 line. §11's "(demo PKI)" qualifier is prose; every integrator branching on `trust_level === "issuer-verified"` — the check the current docs teach — will treat a fictitious CA as production trust. And no §7 tool return carries `presence`/`trust_level`/`disclaimer` at all; spec.md FR-014's machine-checkable disclaimer field silently vanished in the pivot.
**Recommendation:** Mint a distinct union member (`"issuer-verified-demo-pki"`). Put the honesty triple in every §7 return shape and the SettlementSeam/completed-record types, written by the library, with FR-014-style goes-red-when-dropped tests carried into §13.

**6. The refusal union has gaps its own document demonstrates.** *(all six personas, medium)*
`remaining: $70` appears in demo beat §15.2 but not in §9's `over-cap`; no enforcer attribution across four thresholds; no `resolution: "retry" | "needs-human" | "terminal"`; no reason for draws against pending/declined intents; `consumed` ambiguously means draw-replayed or intent-exhausted; no MCP encoding (structuredContent vs isError) decided; no single exported type.
**Recommendation:** One exported `DrawRefusal` union from `@openmobilehub/attestomcp-gate`, encoded as MCP structuredContent, with the field additions in §4 below and an `explainRefusal()` helper. Single-source the schema so wallet connector (Kotlin), gate, and SDK cannot drift.

**7. Intent and draw lifecycles can't express "done" and aren't idempotent — the zero-state cron pattern breaks on the first real task.** *(Agent — high; Platform — medium)*
No terminal `exhausted`/`completed` status matching the `consumed` refusal; no client label to correlate intents to tasks; `create_intent` has no idempotency key (crash-retry mints duplicate pending intents and duplicate approveUrls); overlapping cron runs can double-purchase in-bounds; a signed-but-unsettled draw is invisible (no `void_draw`, no TTL); `create_intent`'s ~90s long-poll exceeds host tool-call timeouts.
**Recommendation:** Terminal statuses carrying the settling draw's receipt; `label` echoed through all reads; `idempotencyKey` on both `create_intent` and `request_draw`; per-intent draw visibility (`signed|settled|voided|expired`) plus `void_draw`; return `pending` immediately on hosted platforms — long-polling lives only in the Node SDK.

**8. approveUrl durability vs the verifier's hourly session purge — the morning-summary link is probably dead.** *(Agent, Platform, Identity — medium)*
The autonomous story parks approveUrls for humans hours later, but the Multipaz `runServer` purges sessions hourly and the step-up approveUrl is described as a raw ceremony-session URL. No validity window is stated anywhere; the step-up choreography (whose ceremony, what it signs, how the other enforcer observes completion) is unwritten (Identity).
**Recommendation:** approveUrl is a durable wallet-controlled page keyed by intentId that mints a fresh ceremony session on load; `approveUrlExpiresAt` in the refusal shape; `get_intent` re-mints on demand; write the step-up sequence diagram.

**9. The multi-KB draw blob transits the model's context — the one place the design abandons its own custody principle.** *(Platform, Security, Identity — medium)*
An mdoc presentment + MSO + cert chain is tens of KB of base64 crossing the model twice; long opaque strings through an LLM are a known corruption mode, a mangled draw yields the least readable refusal possible ("signature"), and transcripts become bearer-token logs (Security).
**Recommendation:** `request_draw → { drawId, drawUrl, expiresAt, remaining }`; the merchant fetches the artifact server-to-server (the wallet gains redemption observability for free); short default TTL; embedded-blob mode retained for offline SDK use with a stated size cap.

**10. Vocabulary fracture and stale companion docs will fragment learning before code exists.** *(DevRel — high; Identity, Agent — concur)*
Five names for the authority artifact (grant/intent/Intent Mandate/delegation/standing envelope — the last colliding with the shipped `envelope.ts`), three for the redemption verb; the flagship 4-line SDK snippet mixes three vocabularies; "grant" collides with OAuth in the same system; "scope" names two namespaces (merchant categories vs intent GTINs) on the two ends of one check. Meanwhile §14 step 2 still scripts the consent-sheet rendering the desk verification falsified, and `delegation-walkthrough.md` — the only payload-level explainer — documents the pivoted-away merchant-side model.
**Recommendation:** Two nouns, enforced in code and prose: **intent** and **draw**, with the §7 MCP tool surface as ground truth. Retire "grant" (cede it to OAuth) and "envelope." Rename merchant `scopes` → `delegableCategories`. Fix §14 step 2 to script the real UX (approve page shows terms; wallet shows "• Payment"; narrate why). Banner every companion doc with the model it describes until §10 is decided.

## 4. API-shape changes the council recommends

Deduped across the six reviews; all contingent on the maintainer's §10 decision.

**Wallet connector tools**
```
create_intent({ bounds, label, idempotencyKey })
  → { intentId, approveUrl, approveUrlExpiresAt, status: "pending" }   // immediate on hosted platforms
get_intent(intentId)          // + terminal statuses: exhausted | completed (with receipt);
                              // re-mints approveUrl for pending/step-up
list_intents({ status, label, limit, cursor })
request_draw({ intentId, merchant, cart, quotedAmount, transactionId, idempotencyKey })
  → { drawId, drawUrl, expiresAt, remaining } | DrawRefusal            // draw by reference, short TTL
get_draw(drawId) · void_draw(drawId)
revoke_intent(intentId)       // unchanged — endorsed
```
`quotedAmount` (not `amount`) signals it is a quote, not price authority (Security). Refusals are resolved `{ ok: false }` results; exceptions are transport-only (Agent).

**Merchant side**
```js
new AttestoMCP({
  delegation: {
    trustedWallets: [demoWallet()],        // TrustedWallet: { id, displayName, keys: JWKS-with-kid }
                                           // demoWallet() throws in production without allowDemoTrust: true
    delegableCategories: ["coffee-beans"], // renamed from `scopes`
    gtinResolver: (productId) => gtin,     // fail-closed for unmapped products; coverage report at mount
    maxDraw: usd(100), stepUpOver: usd(50) // constructor throws if stepUpOver > maxDraw
  },
});
```
Ship `usd()`/`money()` as a real gate export (every snippet uses it; nothing exports it). `createStorefront({ delegation: DelegationOptions })` — boolean form removed. Named merchant tool `checkout_delegated({ orderId, drawId | drawUrl })` returning the shared union. Canonical cart line `{ gtin, qty, unitPriceMinor, currency }` exported from the gate.

**Refusal union** — one exported type, MCP structuredContent encoding:
```
{ ok: false, reason, intentId, resolution: "retry" | "needs-human" | "terminal", ... }
  over-cap:  + { enforcedBy: "wallet"|"merchant"|"psp", capKind: "per-draw"|"cumulative"|"step-up-threshold",
                 cap, remaining?, pricedAt }
  step-up:   + { approveUrl, approveUrlExpiresAt }
  new members: intent-pending · intent-not-active · amount-mismatch (+ repriced) · draw-replayed ·
               intent-exhausted (split of "consumed") · reauth-required (+ reconnect URL) ·
               approve-expired · rate-limited (+ retryAfter)
```

**SDK** — vocabulary 1:1 with the MCP tools: `agent.login()` (device-code), `agent.createIntent(bounds)`, `agent.intent(id)` resume handle whose `granted({ timeoutMs })` returns `{ status: "pending" }` instead of throwing, `agent.draw(intentId, …)`, `agent.revoke(id)`, store option `intents:` not `grants:`.

**Wire schema as the first build artifact** *(Identity)*: a cross-language schema package before the Kotlin server — JCS-canonicalized bounds doc, `intentId = b64url(SHA-256(bounds))`, draw as compact JWS ES256 with named claims (`{intentId, payee, amount, currency, psp_transaction_id, iat, jti}`), K_s as RFC 7638 JWK thumbprint, test vectors consumed by both vitest and JUnit. This is how "one union across three surfaces" survives a repo split.

## 5. Minority reports

Positions held by one persona that the maintainer should still weigh:

- **Security — merchant-minted step-up approveUrls are a phishing courier.** F2 means the approve page is the ONLY place the user ever sees the bounds; a hostile merchant connector can serve a look-alike page showing benign terms while the DeviceKey seals attacker-chosen bounds. Proposal: only the wallet connector may mint approveUrls; the gate's step-up refusal carries a machine reference the agent exchanges at the OAuth-ed wallet. This changes the §9 shape and is cheap now, expensive later.
- **Security — rich refusals are a bounds-probing and privacy oracle on merchant surfaces.** Binary-search `request_draw` extracts the cap in ~7 calls; under §16 a `prescription`-family refusal leaks medical signal; `list_intents` lets a prompt-injected orchestrator exfiltrate the whole delegation portfolio. Proposal: split `WalletRefusal` (rich, OAuth-ed agent only) from `GateRefusal` (coarse), rate-limit near-boundary probing.
- **Identity — TS12 `PaymentTransaction` is being stretched past its EUDI meaning.** The flagship multi-merchant intent has no honest `payee`, and the day the upstream "render TS12 fields" ask lands, the wallet will render partial terms that omit the delegate key and product scope — arguably worse consent UX than today's opaque sheet. Proposal: define a `payees: "any" | [id…]` bounds policy now, and change the upstream ask to include a first-class delegation display. Expect the Multipaz/EUDI community to raise this first.
- **Identity — re-verifying the STORED presentment has no stock SDK path.** The "~150 lines, no upstream changes" estimate covers the live ceremony, not offline re-verification of a persisted artifact — needed in Kotlin (PSP) and TypeScript (gate), where no Multipaz exists at all. The TS chain-walk appears in no effort table despite being what makes the 3-line merchant DX real. Proposal: spike it, pin the persisted-artifact format, or ship Model A day-one as gate-delegates-to-PSP and say so.
- **Merchant — the bring-your-own-Express bill is unpriced.** The 3-line claim holds only where the storefront pre-binds every seam; a real Express host faces the SettlementSeam delta, GTIN resolver, and per-intent state wiring — 15 minutes for the demo, 2–3 days for a real app. Proposal: a §8b "existing Express host" walkthrough with a stated integration budget per persona.

## 6. What the council explicitly endorses keeping

- **Pull-based continuation as a named principle** (all six) — matches how hosted assistants actually work, mirrors Multipaz's own polling, makes step-up one rail reused. DevRel: turn it into a standalone concept page.
- **Typed refusals as a stated success bar** (all six) — failure-path-first design; fix the gaps, keep the shape.
- **Opt-in by default** — "no config → no HNP surface" (Security: "the single most important safe default in the doc").
- **Reference-not-artifact custody** — the agent holds a name, not a token; `revoke_intent` only ever reduces authority; the §3 compromise-asymmetry table gives integrators reasoning, not just rules (Agent, Security).
- **Delegation as configure-once constructor config** on the shipped `AttestoMCPOptions` pattern — a gate user will recognize it instantly (Merchant, Identity, Agent).
- **The deliberately absent self-approval path and bound-probing helpers** (Agent, Security) — right for production; the dev-mode gap is solved by the sandbox, not by weakening this.
- **The desk-verification discipline** — F1/F2 falsified a design assumption before schemas were committed to it, F4 adopted TS12, F6 cut issuance; the doc shows its own corrected claims (Platform, Identity, DevRel: "this candor is itself a docs asset developers will trust").
- **§1's three-sentence explainer and the Russian-doll motif** carried consistently through §4/§6 (DevRel: best-in-class top-of-funnel).
- **§13's inherited testing discipline** — a bypass test per chain-walk step that fails when the control is removed, disclosure assertions kept distinct from security tests (Security).
- **The five-verb, lean wallet tool surface** — low context overhead next to merchant-connector tool sprawl (Platform).
