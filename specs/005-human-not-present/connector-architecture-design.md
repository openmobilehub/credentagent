# HNP Connector Architecture & DX Design — wallet-custody delegation over MCP

**Status**: Draft — for maintainer review. Product of the 2026-07-01 design conversation; **tentative**, like
everything on this branch (see [spec.md](./spec.md) status). Nothing here is committed scope until confirmed.

**Companions**: [spec.md](./spec.md) (the 005 merchant-side v0.1 spec),
[delegation-walkthrough.md](./delegation-walkthrough.md) (how one biometric tap signs the bounds),
`docs/superpowers/research/2026-06-29-human-not-present-scoping.md` (the 5-dimension research).

**What this document is**: the end-to-end architecture and developer experience for Human-Not-Present
delegation as it would actually run on today's agent platforms (Claude connectors + scheduled runs), using
the Multipaz / Utopia ecosystem for wallet and settlement. It emerged from a DX brainstorm that began inside
the 005 merchant-side model and **pivoted** to a wallet-custody model; §10 records exactly what that pivot
changes relative to spec.md.

---

## 1. The idea in three sentences

1. The user performs **one biometric ceremony** that signs an **Intent Mandate** — bounded authority: a cap,
   a product scope, a time window, and the public key of a wallet server allowed to act under it.
2. The **wallet server** custodies that mandate and, while the human is absent, signs **Payment Mandates
   (draws)** — exact-amount, merchant-named, single-use — but only inside the mandate's bounds.
3. Every verifier (merchant gate, settlement backend) **walks the chain**: draw signed by the wallet key →
   wallet key named inside the intent → intent signed by the phone's hardware key → draw within bounds.

A power of attorney, expressed in digital signatures (no cryptocurrency anywhere — settlement is a plain
ledger): the phone signs *authority once*; the server signs *payments many times*; the verifier checks the
second is inside the first.

```
What the hardware key signs (ONCE, biometric):
┌──────────────────────────────────────────────┐
│  "I authorize the holder of PUBLIC KEY K_s   │    K_s = the wallet server's key
│   to sign payments on my behalf,             │
│   ≤ $120 · Ghost 17 sz 10 · until Jul 31"    │
└──────────────── signed: phone DeviceKey ─────┘

What the server signs (each draw, no human):
┌──────────────────────────────────────────────┐
│  "Pay runfast.com exactly $114.95            │
│   under intent #123 (attached)"              │
└──────────────── signed: K_s ─────────────────┘
```

## 2. Goals and success bars

**Personas** (from the brainstorm's clarifying questions): the **merchant developer** (integrates the gate)
and the **agent developer** (builds Node-side agents); hosted assistants (Claude/ChatGPT) need no SDK at all —
connectors are their whole interface.

**Success bars** (all four selected by the maintainer):

- **≤3 added lines** for a merchant to accept delegated draws.
- **The reference storefront ships it built-in** (`delegation: true` → MCP tools appear).
- **15-minute agent quickstart** for a Node agent dev (npm install → delegate→redeem loop).
- **Readable refusals**: every failure is a typed, actionable result (`over-cap`, `revoked`, `step-up` with
  an `approveUrl`, …) — DX for the failure paths, not just the happy path.

## 3. Components and ownership

```
                        ┌─ Claude / ChatGPT (orchestrator — holds NOTHING)
                        │   reasons, searches, decides when to ask; runs on a schedule
                        │
        ┌───────────────┼──────────────────────┐
        ▼               ▼                      ▼
  Wallet connector   Merchant connector    Merchant connector
  (MCP + OAuth)      (e.g. Utopia          (Amazon, Walmart, …)
        │             Marketplace)
   ┌────┴─────────┐        │
   ▼              ▼        ▼
 Wallet SERVER   Multipaz WALLET       attestomcp-gate ── UPay-style verifier ── Bank of Utopia
 always-on       (stock app, phone)    (merchant envelope,  (opens the doll,      (fictitious
 policy engine   master key+biometric   completeOrder)       settles)              ledger)
 signs draws     approves · revokes
 (new, ours)     · audits
```

| Component | Operated by (trust domain) | Code | Status |
| :-- | :-- | :-- | :-- |
| Phone + Multipaz Wallet (DeviceKey, biometric) | **User** | stock Multipaz Wallet app — unmodified | exists |
| Wallet server (policy engine, draw signer, OpenID4VP verifier, MCP connector) | **User's chosen wallet provider** (us, for the demo) | **new component** (working name `attestomcp-wallet`; where it lives is open — §12.4), built on Multipaz server-side libs | to build |
| Agent (Claude routine / Node script) | **Agent operator** (platform or user) | none needed hosted; `attestomcp-agent` for Node devs | to build (thin) |
| Merchant storefront + gate | **Merchant** | `attestomcp-gate`, `attestomcp-storefront` | exists; gains draw verification |
| Settlement verifier (UPay-style) | **Merchant's PSP** (fictitious: UPay/Utopia) | new `VerifierAssistant` on Multipaz SDK (~150 lines, no upstream changes) | to build |
| Ledger (Bank of Utopia records server) | **PSP's system of records** (fictitious) | unchanged | exists |

**The clean division**: the **user** owns consent (DeviceKey + biometric), the **wallet server** owns policy
+ draw signing, the **agent** owns initiative only (it holds a *reference*, never authority), the
**merchant/PSP** own enforcement + settlement, and the **platform** (Android/browser) owns the referee calls
(origin binding, biometric, consent-sheet rendering).

**Compromise asymmetry** (why state lives where it does): a leaked `intentId` is a *name*, not a token —
worthless without the wallet's OAuth session and `K_s`. A compromised orchestrator can only *ask* for
in-bounds draws. A leaked wallet-server key (`K_s`) is the worst server-side asset, yet still bounded: it
can sign only in-bounds draws against existing intents (chain verification kills anything else), all
revocable. **No private user key exists server-side to steal**: the DeviceKey is non-extractable secure-element
hardware; the server holds only the user's *signature* and *public* key. Delegation transfers authority,
never keys.

## 4. The mandate chain (the Russian doll)

```
┌─ OUTER: the draw (Payment Mandate) ── signed by wallet-server key K_s ─┐
│   "pay runfast.com exactly $114.95 · transaction_id: tx_789"           │
│                                                                        │
│  ┌─ INNER: the intent ── the RECORDED DPC presentment ─────────────┐   │
│  │   bounds in OpenID4VP transaction_data:                         │   │
│  │     "intentId: int_9f2c7a · ≤$120 · GTIN(Ghost-17-sz10)         │   │
│  │      · until Jul 31 · delegate: K_s"                            │   │
│  │   signed by: phone DeviceKey (biometric, delegation day)        │   │
│  │   card's issuer chain → Utopia CA                               │   │
│  └──────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

Verified outside-in by any verifier:

1. draw signature valid under `K_s` (fresh — made for this settlement's `transaction_id`)
2. `K_s` is named **inside** the signed bounds (the delegation link)
3. inner artifact: device signature ✓, issuer chain → trust list ✓ (the original authority)
4. draw ⊆ bounds: amount ≤ cap, payee/product in scope, within window
5. settle the **outer** doll's exact amount — *value from the outer, authority from the inner*

Design details locked in during the brainstorm:

- **The intent is a *recorded presentment***, not a raw credential: the device-signed session transcript
  (bounds in `transaction_data`) + the card's issuer-signed MSO. Verifiers re-verify a stored artifact; only
  the *draw* signature must be fresh. Freshness migrates from the phone's signature (human-present) to the
  wallet server's signature (human-not-present) — same replay discipline, different key.
- **`intentId` is minted before the ceremony and sealed inside the signed bounds** — tamper-evident, and the
  revocation/policy state keys off an identifier the signature covers.
- **IDs are random but not secret** — authority comes from OAuth (wallet connector) + `K_s` (draws); a leaked
  ID is a name.
- **Scope uses universal product identifiers (GTIN)**, not one merchant's SKU namespace — what makes
  multi-merchant expressible; merchants map GTIN → their SKUs.

## 5. Multipaz usage (stock wallet, no permission needed)

Multipaz is Apache-2.0; we build **on** it, not **in** it. **Hard constraint (2026-07-01): the phone side is
the published Multipaz Wallet APK from <https://apps.multipaz.org/>** (production flavor; Dev flavor for
unlocked bootloaders) — the demo claim is "works with the wallet anyone can download," so a custom wallet
build is off the table; wallet-side changes only arrive via upstream contributions shipped in a released
APK.

- **The phone side is stock Multipaz Wallet.** The delegation ceremony is a normal OpenID4VP / Digital
  Credentials API presentment of a DPC (the DigitalPaymentCredential the wallet already holds, issued by our
  wallet server via OpenID4VCI at setup).
- **`transaction_data` SEALS the bounds — but does NOT render them today** *(corrected 2026-07-01 by desk
  verification — see `docs/superpowers/research/2026-07-01-multipaz-wallet-desk-verification.md`)*. The
  DeviceKey signature covers the transaction_data hashes (real sealing), but the consent sheet renders only
  the type's displayName ("• Payment"), not amount/payee. The **approve page we control carries the terms
  display**; richer consent-sheet rendering is the upstream ask. Better still: the registered
  `PaymentTransaction` type is **EUDI SCA TS12** and natively expresses our bounds — per-draw cap
  (`recurrence.mit_options.max_amount`), **cumulative cap** (`total_amount`), window
  (`recurrence.start_date/end_date`), payee — so **no custom transaction type is needed**; product scope
  binds via `transaction_id = intentId` committing to the full bounds doc (same pattern as AP2's
  `cart_hash`). The required credential docType (`org.multipaz.payment.sca.1`) IS the Utopia DPC.
- **The wallet server uses Multipaz server-side libraries** for the OpenID4VP verifier role (the same
  `configureVerifier` / `VerifierAssistant` machinery UPay uses).
- **The one small upstream candidate** (later, show-don't-ask): registering an *Intent-Mandate
  transaction-data type* in Multipaz known-types so stock wallets render bounds first-class. Everything else
  requires zero changes to their codebase.
- ⚠️ **Open verification item**: confirm how stock Multipaz Wallet renders an *unknown/custom*
  transaction_data type today (graceful raw display vs. refusal). This gates whether the custom type is
  needed on day one. (§12)

## 6. Settlement: the UPay integration

Findings from reading `multipaz-utopia/organizations/upay/backend` (2 files, ~230 lines on SDK machinery):

- UPay = stock Multipaz verifier + a `VerifierAssistant` (`TransactionProcessor`): `processRequest` creates a
  ledger transaction (Bank of Utopia RPC → `transaction_id` + nonce) and requests a DPC presentment with
  `transaction_data{transaction_id, payee, currency, amount}`; `processResponse` verifies the presentment,
  checks the **issuer chain against the Utopia CA trust list**, and `commitTransaction`s the ledger.
- **UPay today is strictly human-present** — no mandate/delegation concept. But it is the Model-B PSP in
  embryo: it already settles only against a cryptographically verified, amount-bound artifact.
- **The delegated path is a small delta and needs no upstream changes**: our own `VerifierAssistant`
  (working name `DelegatedTransactionProcessor`) that accepts `draw + intent` instead of a live presentment,
  walks the chain (§4), and calls the same `commitTransaction`. The draw is signed over UPay's fresh
  `transaction_id`, preserving UPay's existing replay discipline exactly.

  ```
  The doll, as UPay opens it (outside-in):

  ┌─ OUTER: the draw — signed by wallet-server key K_s ─────────┐
  │  "pay runfast.com exactly $114.95 · transaction_id: tx_789" │
  │  ┌─ INNER: the intent — the recorded DPC presentment ─────┐ │
  │  │  bounds in transaction_data: "≤$120 · Ghost 17 ·       │ │
  │  │  Jul 31" · names K_s                                   │ │
  │  │  signed: phone DeviceKey (biometric, days ago)         │ │
  │  │  card's issuer chain → Utopia CA ✓                     │ │
  │  └─────────────────────────────────────────────────────────┘ │
  └───────────────────────────────────────────────────────────────┘
  1 draw sig fresh under K_s → 2 K_s named in intent → 3 device sig ✓
  issuer chain ✓ → 4 draw ⊆ bounds → 5 commitTransaction($114.95)
  ```
- **The PSP becomes a second budget enforcer for free**: every draw against `int_9f2c7a` settles through it,
  so it can keep a per-intent tally and refuse over-budget draws *independently* of the wallet's policy
  engine. Three independent enforcers total (wallet policy, merchant envelope, PSP tally).
- **Settlement models** (industry framing): Model A — gate verifies the chain, PSP settles dumb (works today;
  maps onto the card rails' existing *merchant-initiated transaction / credential-on-file* framework — the
  mandate chain replaces the stored-credential checkbox with math). Model B — the PSP/network understands
  mandates (AP2's Payment Mandate; Visa Intelligent Commerce / Mastercard Agent Pay). The Utopia demo runs
  Model B in miniature. The gate's `SettlementSeam` must **carry the mandate + modality**
  (`presence`, `delegationId`, intent reference) so hosts can plug either adapter.

## 7. The wallet connector (MCP tool surface)

The entire agent-facing API — hosted assistants use these tools directly; the Node SDK wraps the same
endpoints:

```
create_intent(bounds)             → { intentId, approveUrl, status: "pending" }
                                    // ID minted BEFORE the ceremony; may long-poll briefly
get_intent(intentId)              → { status: "pending"|"active"|"declined"|"expired"|"revoked",
                                      bounds, remaining, history }        // planning view, no blob
list_intents({status})            → [ { intentId, bounds, remaining, expiresAt }, … ]
                                    // rediscovery: scheduled runs need no memory
request_draw(intentId, offer)     → { draw: "<opaque self-contained token>" }   // the doll, embedded intent
                                  | typed refusal (§9)
                                  // AMENDED per the DX council (finding #1): the draw is signed over a
                                  // priced OFFER (incl. the PSP's pspTransactionId) obtained from the
                                  // merchant's checkout_delegated_open tool first — the full six-call
                                  // sequence + schemas: redemption-choreography-draft.md
revoke_intent(intentId)           → { status: "revoked" }   // agent-safe: only ever reduces authority
```

**Custody rules**: the mandate artifact lives **privately** in the wallet server, keyed to the OAuth-ed
account. The agent holds a *reference* (`intentId`) and requests; it never holds or exchanges the artifact.
The one moment it touches one is couriering the opaque `draw` token (intent embedded) from wallet connector
to merchant connector, unopened.

**Pull-based continuation (named principle)**: *every async transition in the ceremony must be observable
via an idempotent status read; never require a push.* No hosted assistant accepts webhooks into a
conversation today. Three patterns all work over the same two reads:

- **Human-as-webhook** (chat): return `pending` + `approveUrl`; the human — present by definition at
  delegation — says "done"; agent re-checks.
- **Blocking tool call**: `create_intent` long-polls ~90s; fast signers get a seamless single turn.
- **Schedule-as-continuation** (autonomous): the next scheduled run starts with `list_intents(active)` and
  proceeds; latency = one schedule tick; requires zero conversation state.

Step-up uses the identical mechanism: an over-threshold draw refuses with an `approveUrl` that triggers
*another presentment ceremony* — one rail, reused; no push infrastructure.

## 8. Merchant-side and agent-side DX

**Merchant (`attestomcp-gate`)** — delegation config lives on the configure-once client (a standing envelope
is configuration, *not* a per-order policy step; the policy array keeps meaning "what this order requires
now"):

```js
const attestomcp = new AttestoMCP({
  delegation: {
    trustedWallets: [UTOPIA_DEMO_WALLET],  // whose draws we accept (single-entry trust list for the demo)
    scopes: ["coffee-beans"],              // merchant catalog categories delegable at all
                                           // (draw GTINs are matched to these via the catalog)
    maxDraw: usd(100),                     // per-draw ceiling regardless of any intent
    stepUpOver: usd(50),                   // above this → live ceremony required
  },
});
attestomcp.mount(app);   // draw-verification on the completion path; no config → no HNP surface (opt-in)
```

`requirements()` additionally emits an `enforcedAt: "intent"` manifest entry when delegation is configured,
so checkout UIs can render a "let your agent handle this" affordance.

**Storefront (`attestomcp-storefront`)** — `createStorefront({ delegation: true })` registers the
delegation-aware checkout path and forwards to the gate. Zero further merchant code in the reference demo.

**Agent SDK (`attestomcp-agent`)** — thin, key-ready, **nice-to-have** (hosted assistants don't need it):

```js
const agent  = new AttestoAgent({ wallet: "https://wallet.example", grants: fileStore("~/.agent") });
const pending = await agent.requestDelegation({ cap: usd(120), scope: [GTIN], days: 30 });
console.log(`Approve: ${pending.approveUrl}`);
const intent  = await pending.granted();                 // long-polls get_intent
const result  = await agent.redeem(intent.id, { merchant, cart });
```

Deliberately absent: any self-approval path, any bound-probing helpers. The `keys` seam is reserved so a
future per-agent key (holder binding at the wallet: "only draws requested by agent key K_a") slots in without
breaking changes.

## 9. Typed refusals (shared vocabulary on every surface)

One discriminated union across wallet connector, gate, and SDK — each refusal names the failure *and the
recovery*:

```
{ ok: false, reason: "over-cap",      cap, pricedAt }
{ ok: false, reason: "out-of-scope",  rejected: [GTIN…] }
{ ok: false, reason: "expired" | "revoked" | "consumed" | "signature" }
{ ok: false, reason: "step-up",       approveUrl }        // "here's where the human takes over"
{ ok: false, reason: "wallet-unreachable" }               // fail-closed, never fail-open
```

## 10. Relationship to the 005 spec (what the pivot changes)

This design **keeps** every load-bearing concept of spec.md: the Intent→Payment mandate chain, bounds as
real controls (cap/scope/window, absolute ceilings), catalog re-pricing as price authority, fail-closed
revocation, atomic single-use per draw, step-up, the presence/trust_level honesty axes, age non-delegable,
and control-dependent bypass tests.

It **changes custody and signing**:

| | spec.md v0.1 (merchant-side) | This design (wallet-custody) |
| :-- | :-- | :-- |
| Intent minted/held by | the merchant's gate (server-HMAC) | the **wallet server** (DeviceKey-signed) |
| Who signs the intent | the server (`server-issued-demo`) | **the user's phone** (Multipaz DPC + transaction_data) |
| The grant travels as | bearer blob held by the agent | **private record**; agent holds a reference |
| Draw authority | none (grant IS the redemption token) | wallet server's `K_s`, named in the signed bounds |
| Multi-merchant | impossible (single-origin by design) | native (GTIN scope + per-merchant draws) |
| Issuer anchor | none (`presence-only-demo`) | **Utopia CA — issuer-verified (demo PKI)** |
| Settlement | suppressed | **fictitious ledger settles for real** (real flow, fake money) |
| Agent-and-merchant collapse (the "Walmart case") | mandate is all you have | **fixed** — the wallet is structurally independent |

**Open maintainer decision** (deliberately not made here): whether 005 v0.1 (merchant-side, server-HMAC)
still ships first as the smallest library increment with this architecture as its successor, or 005 gets
re-scoped to target wallet-custody directly. Arguments both ways: v0.1 is far smaller and exercises the gate
seams the wallet model also needs (envelope, completeOrder branch, revocation store, typed refusals); but it
builds a delegate rail (merchant-side minting) that the wallet model obsoletes. Relatedly: the tentative
two-rail user-signing direction noted in spec.md FR-002 (WebAuthn + DPC) was scoped to the merchant-side
model; under wallet-custody the DPC rail carries the ceremony, and the WebAuthn rail's role, if any, folds
into this same re-scope decision.

## 11. Honesty labels in this architecture

- Within the Utopia demo PKI, the intent chain earns `trust_level: "issuer-verified"` **with the mandatory
  qualifier "(demo PKI)"** — a fictitious CA anchoring real cryptography. This is a genuine rung above
  `presence-only-demo` and must not be presented as production trust.
- `presence: "delegated"` is honest here in a way v0.1's `delegated-demo` was not: the user *did* sign the
  bounds. The remaining fiction is the PKI and the money, both disclosed.
- Settlement moves fictitious value on a fictitious ledger — **real flow, fake money** — which replaces
  v0.1's settlement suppression as the honesty fence.
- The residual trust surface is named, not hidden: the wallet server can burn budget on in-bounds junk
  (confused deputy stays inside the fence); bounded, auditable, revocable — never claimed as prevented.

## 12. Open questions / verification items

1. **~~Custom transaction_data types~~ — DESK-VERIFIED 2026-07-01** (see
   `docs/superpowers/research/2026-07-01-multipaz-wallet-desk-verification.md`): unknown types are
   **rejected outright** (spec-compliant), and even registered types render only their displayName on the
   consent sheet — the bounds are *sealed* (DeviceKey covers the hashes) but *not shown* by the wallet.
   Plan: use the registered **EUDI SCA TS12 `PaymentTransaction`** type (it expresses cap, cumulative cap,
   window, payee natively via `recurrence.mit_options`); terms display lives on the approve page; the
   upstream ask becomes "render TS12 payload fields on the consent sheet." Remaining on-device spike is
   confirmatory: TS12 presentment succeeds against the published APK + note the unknown-verifier warning UX.
1b. **~~Provisioning from our issuer~~ — DESK-VERIFIED 2026-07-01**: the published wallet provisions only
   from its backend's issuer list (arbitrary URLs are dev-mode-only). **Resolution: our wallet server is
   NOT an issuer** — reuse the Multipaz-hosted DPC issuance (user adds their Utopia payment card via the
   standard flow); our wallet server is verifier + policy engine + draw signer + MCP connector only. The
   Utopia org backends (UPay, bank, brewery) are NOT hosted on apps.multipaz.org — they come from the
   `multipaz-utopia` docker deployment. On-device confirmation of the hosted issuance flow remains.
2. **Scheduled-run connector auth** on claude.ai (durable OAuth grants for routines) — verify. ChatGPT:
   the June-2026 scheduled-tasks update indicates connected apps ARE usable in tasks on paid plans —
   verify in rehearsal. Cross-platform note: the mandate is keyed to the user at the wallet, not to the
   platform, so the same intent is orchestrator-portable (delegate in ChatGPT, redeem from a Claude
   routine, or vice versa) — a strong neutrality demo beat.
3. **Merchant trust of the wallet server** — single-entry trust list for the demo; the ecosystem answer
   (trust lists / payment networks) is out of scope and disclosed.
4. **Where the wallet server code lives** — new workspace in this repo vs. sibling repo (it's Kotlin/JVM on
   Multipaz SDK, unlike the TS packages) — leaning **sibling repo**, undecided.
5. **Multipaz team conversation** — deferred by choice: build on stock components first, show a working
   demo, then propose the transaction-data type upstream ("show, don't ask").
6. **`attestomcp-agent` priority** — nice-to-have for local agents; may trail the connector work.
7. **Cumulative caps** — the wallet-custody model makes them enforceable (single choke point), and
   desk-verification found they are **standards-expressible today**: EUDI SCA TS12's
   `recurrence.mit_options.total_amount` ("total amount of all payments") is the cumulative cap, in the
   transaction type the published wallet already registers. Still a policy-engine build item; no longer a
   modeling invention. First-increment scope remains the maintainer's call.

## 13. Testing expectations (inherited discipline)

Per CLAUDE.md and 005 FR-015: every security control gets a bypass test that **fails when the control is
removed** — chain-walk checks (each of §4's five steps individually), bounds refusals on every completion
path, fail-closed wallet-unreachable, per-draw replay (reused `transaction_id`), PSP tally vs. wallet-policy
disagreement, and the disclosure-label assertions (`presence`, `trust_level "(demo PKI)"` qualifier,
`delegationId` on completed records) kept distinct from the security tests.

## 14. The demo, end to end (the talk's storyline)

1. *"Order Brooks Ghost 17, size 10, under $120"* → Claude searches the Utopia Marketplace connector:
   $134.95, too high.
2. Claude → wallet connector `create_intent` → approveUrl → **one Face ID tap**; the Multipaz sheet shows
   *"≤$120 · Ghost 17 · until Jul 31 · delegate: My Wallet"* (transaction_data).
3. Days later, a scheduled run: `list_intents(active)` → price check → $114.95 ✓ → `request_draw` → wallet
   signs → draw couriered to the marketplace → UPay opens the doll, walks the chain, settles $114.95 on the
   Bank of Utopia ledger.
4. Morning summary: receipt, remaining budget, revoke link. The phone never woke up.
5. The counterfactuals, live: an over-cap cart refused; a revoked intent refused; a step-up draw handing
   back an approveUrl. *Delegate actions, not identity* — the age-gated demo item still refuses unattended.

## 15. Multi-vendor demo plan

The chain is merchant-agnostic by construction (intent = GTIN + cap; only the *draw* is merchant-named), so
vendors scale at connector-config cost. Cast:

- **Utopia Marketplace** (exists) — the anchor merchant.
- **2× `createStorefront()` instances** ("RunFast", "ShoeBarn") — different catalogs/prices, each an MCP
  connector + a Bank-of-Utopia payee account; all settle through the one shared delegated-UPay verifier.
- **Utopia Brewery** (exists in `multipaz-utopia`; real `age_over_18` check with tests) — the age-gate
  merchant.

Beats, in demo order:

1. **The price race** — one tap, intent ≤$120; the scheduled run watches all three shoe vendors; the
   cheapest one to cross the cap wins. *The user never chose the store — the mandate chose the price.*
   (Impossible in the merchant-side model; the wallet-custody payoff made visible.)
2. **The cumulative budget** — "$150/month across all stores": $80 at RunFast settles, the next $90 draw
   anywhere is refused with `remaining: $70`. Only enforceable because every draw crosses the wallet.
3. **The brewery punchline** — unattended beer draw → `step-up` refusal → live mDL ceremony required.
   *Delegate actions, not identity*, demonstrated at a merchant we didn't build.
4. **The rogue store** — a payee not on the wallet's list: the wallet refuses to sign at all. The wallet
   protects the user from merchants, not just from overspending.

Practicalities: each merchant is a separate connector added to Claude (3–4 is fine and makes the
multi-vendor point visceral); one UPay verifier + one ledger serve all of them, so per-vendor cost is a
catalog + a connector URL + a payee account.

## 16. Beyond payment: the credential family (identity leads)

Payment is one credential among many (the project thesis). The Multipaz wallet already holds the rest —
age, memberships, discounts/entitlements, diplomas/licenses, prescriptions — so under wallet-custody the
delegation question becomes **per-credential policy, not per-credential architecture**: the intent's bounds
gain a `mayPresent` clause, and a draw becomes a *bundle of presentments* (payment + membership + …) under
one authority.

Three axes decide delegability per credential family:

| Credential | Claim stable? | Per-use harm | Regulated human moment? | → default policy |
| :-- | :-- | :-- | :-- | :-- |
| Membership / loyalty | can lapse — re-verify per draw | low | no | **delegable** |
| Product / company discounts | entitlement, can lapse | low | no | **delegable** |
| Diploma / license | permanent | low | rarely | delegable (qualification) |
| Payment | consumable value | medium | no | delegable **within caps** |
| Age over 21 | monotonic | high (legal gate) | often — ID at handoff | **step-up by default** |
| Prescription | consumable (N refills, expiry) | high (controlled) | usually | step-up / tightly bounded draws |

Consequences worth recording:

- **Age flips from "can't" to "won't by default."** 005 excluded age delegation for lack of a trust anchor
  (technical limit). Under issuer-verified wallet-custody the wallet *could* present a fresh `age_over_21`
  unattended; the step-up is kept as **policy** — the point of an age gate is a human at the moment of
  consequence. The honesty labels should state the reason changed.
- **FR-008's discount exclusion dissolves.** 005 forces HNP to ignore membership discounts (no fresh proof
  possible unattended). The wallet presents the membership credential *fresh at each draw*, issuer-checked —
  member pricing under HNP becomes legitimate. A concrete capability unlocked by the architecture.
- **The prescription is a natural Intent Mandate**: issued by a doctor (issuer), bounded (drug, dose, N
  refills, expiry), consumable per draw, revocable, auditable. "Refill when due" is the canonical HNP
  scenario, already shaped like intent → bounded draws → atomic consume.
- **Merchant DX**: one word of policy per credential family, on the same builders the gate already ships:

  ```js
  new AttestoMCP({
    delegation: {
      payment:      { maxDraw: usd(100), stepUpOver: usd(50) },
      membership:   "presentable",        // wallet may re-present while absent
      discount:     "presentable",
      age:          "step-up",            // policy, not limitation — never unattended
      prescription: { perDraw: 1, requires: "issuer-verified" },
    },
  });
  ```

- **Positioning**: this credential generality is the differentiation vs. payments-only agentic-commerce
  stacks (ACP, network SDKs) — the consent layer spans every credential a wallet holds, with payments as
  chapter one.
