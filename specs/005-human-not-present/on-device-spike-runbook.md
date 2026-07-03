# On-device spike runbook — 15 minutes, zero self-hosted infra

**Answers**: §12.1/§12.1b of [connector-architecture-design.md](./connector-architecture-design.md)
(confirmatory after the desk verification) and **feeds the §10 fork decision**.

**Discovery that makes this cheap (2026-07-02)**: the hosted UPay page
(`https://utopia.multipaz.org/upay/`) already drives the exact ceremony under test — its backend is the
`TransactionProcessor` we desk-read, which builds the OpenID4VP request **with the TS12
`PaymentTransaction` transaction_data** (transaction_id, payee, currency, amount). So the published
wallet + the hosted pages answer everything; nothing needs to be stood up.

## Kit

Android phone (GREEN/production build for the standard APK; Dev flavor exists for unlocked bootloaders) ·
Chrome on the phone · ~15 minutes.

## Steps

1. **Install the wallet** — `https://apps.multipaz.org/` → Multipaz Wallet APK (production flavor) →
   sideload. First-run setup as prompted.
2. **Provision credentials** (§12.1b question) — in the wallet: *Add to wallet* → the issuer list comes
   from the wallet backend (`dev.wallet.multipaz.org`). **Record**: does the list include the Utopia
   issuers (Bank of Utopia payment card / DPC; DMV mDL)? Provision the **payment card** (and the mDL if
   offered — useful for the brewery beat later).
   - *If no Utopia payment card appears in the list*: that's a finding, not a failure — record it; it
     means the demo needs the issuance question answered (upstream ask 2 in
     `multipaz-upstream-proposal-draft.md`).
3. **Run the payment ceremony** (§12.1 question) — on the phone's Chrome:
   `https://utopia.multipaz.org/upay/` → pick a payee account from the dropdown → amount e.g. `12.50` →
   keep **openid4vp** checked → Run.
4. **Observe the consent sheet — the money observation.** Screenshot it. Record exactly:
   - [ ] Does it show the **amount/payee** anywhere, or only a generic **"• Payment"** line?
     (Desk prediction F2: displayName only. If it shows MORE, our §5 approve-page mitigation can shrink
     and the upstream ask changes tone.)
   - [ ] Any **unknown-verifier warning** UX? (The wallet may flag an unrecognized relying party.)
   - [ ] Biometric prompt fires ✓
5. **Complete and record the result page** (transaction confirmation from the Bank of Utopia ledger).
6. **Optional (5 more min): the brewery beat** — `https://utopia.multipaz.org/brewery/` → attempt a
   purchase → observe the **combined age + payment** presentment. This is the live preview of
   "delegate actions, not identity."
7. **Cross-device variant (optional)**: run step 3 from a DESKTOP browser instead — expect the QR /
   cross-device handoff. Record whether it works with the published wallet (this is the shape the
   claude.ai approve page will use).

## Readout table — RUN 1, 2026-07-02 morning (published Wallet, Pixel 10 Pro, Android 16, adb-driven)

| # | Question | Result |
| :-- | :-- | :-- |
| 1 | Utopia payment card provisionable from the published APK's issuer list? | **NO — hosted issuance broken.** The card IS in the issuer list, but issuance fails with a server-side **500: `NoSuchElementException: List is empty`** (logcat `ProvisioningModel`). Reproduced on wallet **W22 AND W27** (updated mid-spike), for **payment AND core/age** record types. Also: only **1 of 8** hosted personas (Phileas Foggbottom) has a payment record at all; the local repo seed's payment personas (Pivo Miller, Nadezhda Akulova) don't exist on the hosted records server. |
| 2 | Consent sheet rendering | BLOCKED by #1 (answered in Run 2 below) |
| 3 | Unknown-verifier warning | BLOCKED (Run 2: not directly observable — secure surface) |
| 4 | Ceremony end-to-end | BLOCKED (answered in Run 2 below) |
| 5 | Cross-device QR | BLOCKED (still open after Run 2) |
| 6 | Brewery age+payment | BLOCKED (still open after Run 2) |

## Readout — RUN 2, 2026-07-02 evening (Multipaz **TestApp** route around the broken issuer)

Pivot: the **Multipaz TestApp** (blue variant, `org.multipaz.testapp`, v0.100.0-pre / build 1199)
**self-issues its sample documents on-device** — no hosted issuer in the loop. "Create Test Documents
in Platform Secure Area" → **13 documents in ~11s**, hardware-backed, including **"Erika's Payment
Card Credential"** (`DigitalPaymentCredential`) and an mDL. Ceremony driven on the hosted UPay page
via Chrome DevTools protocol (`run()` with user gesture), payee = seed account `38445565`
(hosted ledger accepts 38445565 / 79356114 / 87874773; rejects unknown accounts).

| # | Question | Result |
| :-- | :-- | :-- |
| 1b | Payment credential obtainable at all? | **YES — TestApp self-issuance.** Hosted-issuer bug stands (report still worth filing) but no longer blocks the ceremony questions. |
| 2 | Consent sheet rendering | **CONFIRMED: displayName-only.** Live run + source: `multipaz-compose … presentment/Consent.kt` renders transaction data as a red (`colorScheme.error`) banner containing only `• ${type.displayName}` → **"• Payment"** — no amount, no payee, no TS12 fields. Same composable serves TestApp AND Wallet. Desk prediction F2 confirmed; §5 approve-page-carries-the-terms stands; upstream Ask 1 unchanged. |
| 3 | Unknown-verifier warning | **Not capturable**: the entire consent UI runs on a **FLAG_SECURE surface** — `adb screencap` returns black frames for the whole ceremony (itself a correct-behavior finding: consent UI is screenshot-proof). Needs eyes-on-device. |
| 4 | Ceremony end-to-end | **Wire: YES. Settlement: REFUSED at issuer trust.** DC API (OpenID4VP v1) → TestApp presents → post-share screen "The info was shared" → UPay backend decrypts + parses the mdoc, then rejects: **`invalid_request: Payment card is not from a trusted issuer`**. The hosted UPay verifier enforces a real issuer trust list — issuer-verified verification exists in the wild on the verifier side, exactly where the design puts it. TestApp's self-signed IACA is (rightly) not in it. |
| 5 | Cross-device QR | Open — rerun from desktop browser. |
| 6 | Brewery age+payment | Open — TestApp's self-issued mDL will presumably hit the same trusted-issuer refusal at the brewery verifier; consent-sheet observation still valuable. |

Bugs found in the hosted stack along the way (upstream-reportable):
- `issuer.multipaz.org`: 500 `NoSuchElementException: List is empty` on ALL issuance (Run 1, the blocker).
- `upay/verify_credentials.js` crashes (`TypeError … reading 'digital'`) instead of surfacing backend
  400s (e.g. unknown payee) — `make_request` errors are never shown to the user.

## Readout — RUN 3, 2026-07-02 night (Pixel 9 Pro XL, Android 16, published TestApp 1193, human-observed)

Full end-to-end rerun on a second device with the maintainer at the phone. On this device the
ceremony surfaces were **screenshot-capturable** (only the biometric prompt was FLAG_SECURE), so the
complete consent stack is now captured in [`spike-evidence/`](./spike-evidence/):

| Layer | Surface | Shows the payment terms? | Evidence |
| :-- | :-- | :-- | :-- |
| 1 | **Chrome**: "Do you trust this site with your data?" (origin trust, Cancel/Continue) | NO | `1-chrome-origin-trust.png` |
| 2 | **Credential Manager** "Share info" sheet: credential card + claim names; "View details" reveals claim VALUES (Utopia Bank, pi-77AABBCC, 2028-09-01, Erika Mustermann) | NO — transaction data not rendered at this layer at all | `2-…`, `3-…` |
| 3 | **Wallet (TestApp)** consent sheet: red box **"Includes transaction data: • Payment"** + "⚠ The website requesting this data is unknown" | NO — displayName only (Consent.kt), no amount/payee | `4-wallet-consent-transaction-data.png` |
| 4 | **Biometric** (fingerprint; human presence gate) | — | secure surface (black) |
| 5 | Verifier: parsed the mdoc, then **`invalid_request: Payment card is not from a trusted issuer`** | — | reproduces Run 2 |

**The headline finding, now airtight:** the user authorizes a $12.50 payment to a specific account
and **no surface in the entire stack ever shows the amount or payee** — while the DeviceKey *does*
sign over the TS12 transaction-data hashes (sealing real, rendering absent). The unknown-verifier
warning exists at TWO layers (Chrome origin + wallet). Question #3 is answered; #2 is answered with
screenshots; #4 reproduced including the biometric gate. Incidental: the CredMan selector chose the
red (dev) TestApp variant's credential over the blue install — first-registered wins silently.

**Issuance retry (same night):** fresh published Wallet `2026.W27.1-22-git-af0e4a1` on the Pixel 9.
Got further than Run 1 — the `issuer.multipaz.org/records/authorize` page loads and the persona flow
runs — but issuance still fails at completion with the same "Something went wrong" (server-side 500).
Now reproduced across two devices, three wallet builds (W22/W27/W27.1), and multiple record types →
conclusively server-side. **Troubleshooting handed off to the Multipaz repo session**
(`~/tools/git/multipaz/TROUBLESHOOT-ISSUANCE-500.md`), since a fix belongs upstream, not here.

## Readout — RUN 4, 2026-07-02 night (cross-device QR: desktop Chrome 149 → Pixel 9)

Question #5 answered. Ceremony fired from a **desktop** Chrome (149, macOS, fresh profile — DC API
present by default: `typeof DigitalCredential === 'function'`) on the hosted UPay page via CDP with
user gesture; Chrome showed the cross-device QR dialog; maintainer scanned it with the Pixel 9;
the phone presented Erika's payment card over the hybrid transport; the response returned to the
**desktop** page, and the UPay backend decrypted + parsed the mdoc before refusing at the same
point as same-device: `invalid_request: Payment card is not from a trusted issuer`.

| # | Question | Result |
| :-- | :-- | :-- |
| 5 | Cross-device QR with published artifacts | **YES — full loop works.** Desktop QR → phone scan → CredMan/wallet consent + biometric on phone → presentation travels back to the desktop origin → verifier parses it. Issuer-trust refusal is the expected endpoint (TestApp IACA), not a transport failure. **This is exactly the shape the claude.ai approve page needs** — the §5 design's cross-device leg is de-risked on stock, published software. |
| 6 | Brewery combined age+payment | **Wire: YES, same cross-device route.** `POST /brewery/checkout` returns ONE DCQL query with two `credential_sets` — age (`photoid \| mdl \| eupid \| aadhaar`, claim-set fallback `age_over_18` → `age_in_years` → `birth_date`) and payment — plus TS12 `urn:eudi:sca:payment:1` transaction_data bound **only to the payment credential** (`credential_ids: ["payment"]`; payee "Utopia Brewery"/38445565, amount 84.0 USD). Captured in [`spike-evidence/6-brewery-checkout-dcql.json`](./spike-evidence/6-brewery-checkout-dcql.json). Ceremony completed from the phone; verifier declined (`invalid_request` — the brewery page drops the detail string, presumably the same issuer-trust refusal). **Phone-side (maintainer-observed): both credentials were requested in the ceremony; the age disclosure was `age_over_18` ONLY (the claim-set fallback resolved to minimal disclosure — no birth date, no name); the red "Includes transaction data" box appeared, matching the DCQL's payment-only binding.** |

Two design-relevant details from the brewery DCQL:
- The age set requests **`age_over_18` for alcohol** — Utopia's jurisdictional threshold. Invariant
  #5 (threshold must match the product's restriction) is a *policy* choice the verifier makes; the
  rails don't enforce it. Our US gate stays `age.over(21)`.
- The transaction data is bound **only to the payment credential** — the age credential signs no
  transaction hashes. This is "delegate actions, not identity" already live in the reference
  verifier: identity claims disclose, only the payment instrument seals the transaction.

## Readout — RUN 5, 2026-07-03 (SELF-HOSTED Utopia stack: local issuance works, green settlement one tap away)

Goal: a settlement the verifier **accepts**, without waiting for the hosted-issuer fix. Method: run
the whole Utopia bundle locally and use its internally-consistent trust chain (registry = CA; bank
enrolls with it; UPay trusts it) — no IACA surgery.

**Stack**: `multipaz-utopia` → `./gradlew :deployment:buildDockerImage` (2m39s clean build) → one
docker image, all services behind nginx on `localhost:8100`. Phone reaches it via
`adb reverse tcp:8100 tcp:8100` — and since `http://localhost:8100` is the **default BASE_URL**,
every URL in the protocol messages is correct with zero config (and localhost is a secure context
on both Chrome desktop and Android).

| Finding | Detail |
| :-- | :-- |
| **Published Wallet cannot issue from a local issuer — architectural** | After the offer deep-link, the wallet polls `root/getIssuingAuthority` against its **hosted wallet-server**: the OID4VCI client runs server-side, so `localhost` offers resolve on the wrong machine. Direct confirmation of the wallet-server custody architecture 005 §5 assumes — the wallet app holds keys + UI; the wallet server does the protocol legwork. |
| **On-device client works: TestApp issued from the local bank, end-to-end** | Blue TestApp → "Provision a Document from an Issuer" → `http://localhost:8100/bank_of_utopia` → PAR → authorize (persona page served by the **local** registry, personas incl. Pivo Miller with a payment record) → token 200 → **`POST /bank_of_utopia/credential` → 200 (1.1 MB)**. "Pivo's Debit Card" (mDoc, `payment_sca_mdoc`) provisioned, hardware-backed. |
| **The hosted issuance 500 does NOT reproduce locally** | Same code (fresh clone), same flow, clean seed → issuance succeeds. The upstream bug (`NoSuchElementException: List is empty`) is **hosted-deployment-specific** (data/config drift), not a code bug — key input for the filed bug report. |
| **CredMan first-registered quirk reconfirmed — now consequential** | Local UPay ceremony ran twice; both times the **red (dev) TestApp** answered with Erika's self-issued card and the verifier (rightly) refused it — while trust-chain-valid "Pivo's Debit Card" sat in the blue TestApp. The wrong-wallet-wins behavior observed in Run 3 is not cosmetic: it silently routes a payment ceremony to an untrusted credential. Upstream-reportable UX finding. |
| **Green settlement — ACHIEVED** | **`POST /upay/process_response → 200`**, `transaction_data_hash` verified, **`registry/rpc/payment/commit → 200`** (posted to the Bank of Utopia ledger). **"Payment Successful — Paid 21.00 to Utopia Brewery Owner, Transaction ID LIb144uDCQM7x3y8."** Evidence: [`spike-evidence/5-green-settlement.png`](./spike-evidence/5-green-settlement.png), card [`5-pivo-card-local-issued.png`](./spike-evidence/5-pivo-card-local-issued.png). |

**The first green settlement — what it took.** The verifier's issuer-trust check (which correctly
refused every untrusted card for two days) **accepted** the locally-issued card once the presentation
was unambiguously Pivo's local-bank mdoc. The confounder was credential selection, not trust: on a
phone with several wallets holding same-doctype payment cards (`org.multipaz.payment.sca.1`), CredMan
kept routing the ceremony to an untrusted self-signed card (red TestApp's Erika, then a stray
SD-JWT). The fix was to reduce the phone to exactly one *matching* credential:
1. Red TestApp documents cleared (removed its self-signed Erika card).
2. UPay's request is **`mso_mdoc`-only** (`org.multipaz.payment.sca.1`, claims `issuer_name` /
   `payment_instrument_id` / `expiry_date` / `holder_name`) — so a stray **SD-JWT** payment card
   (accidentally provisioned from the *hosted* issuer — incidental finding: **hosted issuance works
   again; retest the upstream 500**) does not match and can coexist harmlessly.
3. Pivo's card re-provisioned from the **local** bank as **mdoc** (`MdocCredential`,
   `mdoc_no_user_auth` — issuance `POST /bank_of_utopia/credential → 200`). Its document-signer chain
   validates to the local registry's `CREDENTIAL_SIGNING` root that UPay loaded at startup.

Then the ceremony had exactly one eligible credential → it settled. **This closes the whole design
loop end-to-end on infrastructure we control**: OID4VCI issuance → hardware-backed mdoc → DC API
presentment → OpenID4VP v1 → issuer-trust verification → TS12 transaction-data-hash check → ledger
commit. The presence-only refusal that fenced Runs 2–4 was, as designed, the *only* thing between
wire-correct and settled — supplying a trusted issuer flips it green with no other change.

Local quirks noted: the local UPay page renders payee as a dropdown fed by `accounts.json` (hosted
page is free-text; real value in `input#account`); the CredMan wrong-wallet-wins behavior is
security-relevant (silently routes a payment to an untrusted credential) — upstream-reportable.

### Verdict + next actions (2026-07-02, post Run 2)

1. **The §12.1/12.1b questions are answered without self-hosting**: ceremony mechanics work
   end-to-end; consent sheet is displayName-only (mitigation stands); verifier-side issuer trust is
   real in the hosted stack.
2. **Green-path settlement** (a presentation the verifier accepts) still needs either fixed hosted
   issuance or the **self-hosted Utopia stack** with the TestApp/our IACA added to the verifier trust
   list — now needed only for the demo's happy path, not for de-risking.
3. **Upstream bug report stays the lead item** of the Multipaz conversation, now with two bugs and
   one confirmed rendering gap (Ask 1).
4. Open observations for a human-eyes run (secure surface): consent-sheet look, biometric prompt,
   unknown-verifier warning; plus ~~#5 cross-device QR~~ (answered in Run 4) and #6 brewery beat.

## What the answers decide

- **1 = yes, 4 = yes** → the §10 recommendation firms up: re-scope toward wallet-custody is buildable on
  hosted infra; our wallet server is the only new backend.
- **2 = displayName-only (expected)** → §5's approve-page-carries-the-terms stands; upstream Ask 1
  (render TS12 payload fields) goes to the Multipaz team **before** the demo.
- **1 = no** → issuance logistics move to the front of the Multipaz conversation (Ask 2).
- Any hard failure in 4 → escalate: that contradicts the desk verification and the hosted UPay demo's
  own purpose; re-check assumptions before building anything.
