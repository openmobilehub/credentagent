# Feature Specification: AP2 delegated intent — the wallet signs an open mandate, the agent spends it

**Feature branch:** `014-ap2-delegated-intent` · **Date:** 2026-09-08
**Builds on:** spec 012 (device-signed grants, #144), spec 013 (AP2 wire format, #39), the
grants module (spec 009), the demo-PKI credential set
**Feeds:** #12 (HNP delegation), #14 (issuer trust), #154 (multi-store epic)

## In plain terms

Today, letting an agent spend on your behalf works like this: you click a button on a web
page, and the server writes down what you agreed to. Since spec 012 your phone also signs
something — but what it signs is a record in a format this project invented.

This specification replaces that invented format with the one the Agent Payments Protocol
(AP2) actually defines, and it changes who holds which key so the permission you sign is
portable: it works at any store that respects its limits, not only at the store that asked
you for it.

The everyday version: you sign one permission slip on your phone — "this assistant may buy
groceries, up to $50 a shop, $200 a month, until December." The assistant carries that slip.
When it buys something, it adds a note to the slip saying exactly what it bought, signs the
note with its own key, and hands the whole thing to the shop. The shop checks that the note
stays inside what you allowed. **You are not there, and the shop never held any of your keys.**

## Why this exists

Three problems with the current shape, in order of how much they matter:

1. **The permission is not portable.** A grant is bound to the gate that created it. The
   multi-store epic (#154) — an agent comparing stores and buying at the best one — cannot
   be built on a permission only one store can read.
2. **The agent's spending key lives in the merchant's process.** `DelegatedGrant` holds the
   private key, and `Grants` is constructed inside `CredentAgent`. Whatever the honesty
   labels say, the party being paid currently holds the key that authorizes payment.
3. **The record is ours, not AP2's.** `credentagent.IntentBounds/v0` is a canonical JSON
   object bound to the ceremony through a nonce. It works, and nothing outside this
   repository can read it.

## What AP2 actually specifies

Verified 2026-09-08 against `google-agentic-commerce/AP2` at `main`,
`docs/ap2/agent_authorization.md`. This section is a reading of the specification, not a
design; the design starts at *The mechanism*.

AP2 defines **Mandate Delegation** and gives it two trust models:

- **User Credential** — a three-party model: a Credential Issuer, a **Trusted Surface** that
  holds the user's credential (a phone wallet), and the Agent. The Verifier trusts the
  Issuer to guarantee that the Trusted Surface only builds mandates after real user consent.
  One credential can delegate to many agents.
- **Trusted Agent Provider** — no pre-issued credential; the Verifier trusts the agent's
  provider directly, and must establish that trust with every provider.

This specification adopts the **User Credential** model. It is the one where the human's own
device is the root of authority, which is this project's entire thesis.

Mandates exist in two states, quoting the specification:

> **Closed**: When the Mandate is bound to a particular transaction with a Verifier to
> authorize the agent to perform an action. This is achieved by the Agent generating a Key
> Binding JWT (Proof-of-Possession) using the key endorsed in the open Mandate's `cnf` claim.
>
> **Open**: When the Mandate has not yet been bound to a particular transaction. It instead
> has a set of constraints on the valid content for the closed Mandate, as well as being
> bound to a particular Agent who is allowed to use the Mandate.

Two consequences worth stating plainly, because both contradict earlier assumptions in this
repository:

- **`cnf` on an open mandate is the AGENT's key, not the human's.** The specification is
  explicit that an open mandate is "bound to a particular Agent who is allowed to use the
  Mandate", and that the closed mandate is produced by the Agent with the key `cnf` endorses.
  The human is not present at spend time, so the human's key cannot be the presentation key.
  `grants.ts` already passes the delegate key as `cnf`; that was correct.
- **The human's signature IS inside the chain.** It enters as the Key Binding of the user's
  own credential presentation, carrying the open mandate content. It is not an out-of-band
  attestation.

### The delegation ceremony

Delegation happens **during an OpenID4VP presentation** of the user's credential. The Agent
(or the surface acting for it) builds an Authorization Request whose `transaction_data` array
contains an object with, quoting the required properties:

> - **type**: **REQUIRED**. MUST be the string value "*delegate*".
> - **format**: **REQUIRED**. The required VDC format of the returned Mandate.
> - **delegate_payload**: **REQUIRED**. An array containing the Mandate Content payloads as
>   JSON Objects.
> - **delegate_disclosures**: **OPTIONAL**. An array that contains any Selective Disclosures
>   in the `delegate_payload`.

and:

> When constructing the Authorization Response, the `delegate_payload` MUST be included as
> part of the Key Binding.

AP2 also RECOMMENDS the Digital Credentials API for this ceremony — which the intent-sign
rail already uses.

The specification's own example pairs the `delegate` entry with a second `transaction_data`
entry of `type: "payment"` carrying `merchant_name`, `amount` and an `additional_info` table
of line items. **That is a human-readable display payload defined by AP2.** See *Known gaps*
for why it does not yet reach the wallet screen.

### The chain format

The normative reference is **Delegate SD-JWT**
(`draft-gco-oauth-delegate-sd-jwt`, individual Internet-Draft, 21 April 2026). It extends
SD-JWT so the Key Binding JWT may itself be an SD-JWT with its own key binding. The KB-SD-JWT
carries a `_delegate_payload` array; exactly one element MUST be disclosed when presenting.
Compact serialization:

```
<SD-JWT>~~<KB-SD-JWT>~<Delegated Disclosure 1>~…~<Delegated Disclosure M>~
```

Each further delegation appends another KB-SD-JWT; a final KB-JWT may be appended for
proof-of-possession.

### The credential format

AP2's document specifies **SD-JWT VCs**, and its example uses a Digital Payment Credential
with `format: "dc+sd-jwt"` and `vct: "com.emvco.dpc"`. It twice notes that ISO mdocs "COULD
be used in their place" — and specifies nothing about how. ISO 18013-5 and 18013-7 appear
only in the *Informative* references.

This matters concretely: the chain serialization above is SD-JWT syntax. mdoc has no
equivalent, and no document defines one. **Adopting AP2 with an mdoc credential would mean
writing the missing half of the specification ourselves**, which is exactly the kind of
"AP2-shaped" improvisation this project's honesty rules exist to prevent.

## The mechanism

Four roles, four keys. The merchant never holds a private key belonging to anyone else.

| Role | Key | What it signs |
| --- | --- | --- |
| **User Credential Issuer** | `K_i` | the DPC issued into the wallet |
| **Wallet** (Multipaz) — the Trusted Surface | `K_w` (the credential's `cnf`) | the KB-SD-JWT carrying the open mandates |
| **Agent** | `K_s` (the open mandates' `cnf`) | the closed-mandate hop, per purchase |
| **Merchant** / Verifier | `K_m` | the UCP Checkout (`checkout_jwt`); verifies the chain |

**Step 0 — issuance.** A DPC is issued into the wallet as a `dc+sd-jwt` credential, with
`cnf` bound to the wallet's device key `K_w`.

**Step 1 — delegation.** The consent host builds an OpenID4VP request:

- DCQL requesting the `dc+sd-jwt` DPC
- `transaction_data[0]`: `type: "payment"` — the display payload
- `transaction_data[1]`: `type: "delegate"`, `format: "dc+sd-jwt"`, and a `delegate_payload`
  of two mandate contents:
  - `mandate.checkout.open.1` — `constraints`: `checkout.allowed_merchants`,
    `checkout.line_items`; `cnf`: `K_s`
  - `mandate.payment.open.1` — `constraints`: `payment.reference`,
    `payment.allowed_payees`, `payment.amount_range`, `payment.budget`; `cnf`: `K_s`

The human reads the terms, approves, and the wallet returns its presentation with the
delegate payload bound into the KB-SD-JWT.

**Step 2 — the intent.** The resulting dSD-JWT is **the verifiable intent**: one compact
string, signed by the human's device, naming the agent's key. The agent stores it. Nothing
about it is specific to the store that ran the ceremony.

**Step 3 — the purchase.** The merchant prices the cart and signs a UCP Checkout with `K_m`,
yielding `checkout_jwt`. The agent appends a closed hop with `K_s` carrying
`mandate.checkout.1` (naming that `checkout_jwt` and its hash) and `mandate.payment.1`
(naming the checkout hash as `transaction_id`, the payee, and the amount).

**Step 4 — verification.** Per the specification's processing rules:

1. Verify and process the SD-JWT chain per Delegate SD-JWT — each hop's `sd_hash` /
   `issuer_jwt_hash` binds it to its predecessor, validated with the predecessor's `cnf`.
2. Extract the claims from open mandate content and verify the closed content has them
   unchanged.
3. Evaluate every constraint against the closed content. **Any unknown constraint MUST be
   treated as failing evaluation.**

Then, and separately, this project's own invariant 2 still applies: re-price against the
catalog and refuse a chain whose amount disagrees, however perfect its signatures.

## Scope

### In scope

- Issuing a demo DPC as a `dc+sd-jwt` credential with device key binding (FR-1).
- The delegation request and response handling on the intent-sign rail (FR-2).
- Building, serializing and verifying the delegated SD-JWT chain (FR-3, FR-4).
- An agent-side surface so `K_s` is generated and held outside the merchant's process (FR-5).
- A distinct merchant signing key for the UCP Checkout (FR-6).
- Honesty labels and bypass tests (FR-7, FR-8).

### Out of scope

- Issuer trust (#14). A verified chain proves the wallet signed and the agent presented; it
  proves nothing about whether the DPC came from a real card issuer. The honesty labels must
  keep saying so.
- Replacing the mdoc dc-payment rail. That rail verifies a payment presentation at checkout
  and is unaffected; this specification concerns delegation.
- ~~Retiring the mdoc intent-sign path.~~ **Decided otherwise, and done.** The rail replaces
  it rather than running both: two ceremony surfaces means two verification doors and every
  control pinned twice, and the mdoc path never had a verified on-device baseline, so nothing
  proven was discarded. `credentagent.IntentBounds/v0` remains as the grant's content address
  (`boundsHash`); what the wallet SIGNS is now AP2 Mandate Content.
- The Trusted Agent Provider model.

## Functional requirements

**FR-1 — The DPC as an SD-JWT VC.** A minting tool produces a `dc+sd-jwt` DPC: an SD-JWT
signed by the demo Document Signer, `cnf` bound to a supplied device public key, and the
instrument claims selectively disclosable. The `vct` is `urn:emvco:dpc:card:1` — the value Multipaz registers for its SD-JWT payment
credential, so a wallet recognises the type. AP2's own example uses `com.emvco.dpc`; the rail
accepts both in `vct_values`, because the ecosystem has not settled on one and a naming
difference should not cost a device session. The claim set
matches what the gate already requests (`issuer_name`, `payment_instrument_id`,
`masked_account_reference`, `holder_name`, `issue_date`, `expiry_date`), so one DCQL shape
serves both credential formats. A dev mode may generate a holder key locally so the whole
flow is exercisable in-process before any phone is involved.

**FR-2 — The delegation request.** The intent-sign rail requests a `dc+sd-jwt` credential and
attaches both `transaction_data` entries. The `delegate_payload` is assembled from the
server's own grant record — never from anything the client sends — so the response can be
checked against what the server intended to ask.

**FR-3 — Chain construction.** A module builds the dSD-JWT: the user credential, the
KB-SD-JWT carrying the open mandates, and the agent's closed hop, serialized per Delegate
SD-JWT. It lives beside `ap2/` and mirrors the ceremony-rail file split.

**FR-4 — Chain verification, fail-closed.** One verification door implementing the three
processing rules, with a refusal vocabulary distinct from business refusals. Unknown
constraints fail. A chain arriving with no key to check it against is refused, never treated
as "chain checking not configured".

**FR-5 — The agent-side surface.** `K_s` is generated and held in the agent's process. The
gate package gains an agent entry point exposing key generation, intent storage and
closed-hop signing. The merchant-side import surface never exposes a private key.

**FR-6 — The merchant key.** The UCP Checkout is signed with a merchant key distinct from the
mandate-issuing key, with the `kid` making the distinction visible. Spec 013 anticipated this
in `ap2/jwt.ts`.

**FR-7 — Honesty.** A verified delegated chain reports that the human's wallet signed the
open mandate and the agent signed the closed one. It does not report issuer-verified trust.
Where the implementation follows an expired or superseded draft, the labels say which draft
revision was implemented.

**FR-8 — Bypass tests, each verified red-on-revert.** Listed under *Security invariants*.

## Security invariants and their tests

Every control below must be pinned by a test that **fails when the control is deleted**.

| Control | Bypass test |
| --- | --- |
| The closed mandate cannot exceed the open one | a closed payment above `payment.amount_range.max` is refused |
| Unknown constraints fail | inject a constraint type the verifier does not know; assert refusal, not silence |
| Open claims are preserved | alter a claim in the closed content that the open content fixed; assert refusal |
| Each hop binds to its predecessor | re-sign a hop with a second key; assert refusal |
| The agent key is the one `cnf` endorses | sign the closed hop with a key the open mandate does not name; assert refusal |
| The intent cannot be replayed at a merchant it excludes | present at a merchant outside `checkout.allowed_merchants`; assert refusal |
| Re-pricing still decides (invariant 2) | a perfectly signed chain claiming the wrong total is refused |
| No key, no pass | a chain arriving with no verification key configured is refused |

The cross-chain splice tests must deliberately share one signing key, for the reason spec 013
records: two chains signed by different keys are refused at the signature, which would let
every binding test pass without its binding ever running.

## Known gaps and risks

**The normative chain draft has no standing and expires.** `draft-gco-oauth-delegate-sd-jwt`
is an individual Internet-Draft published 21 April 2026, expiring 23 October 2026, and states
that it "has no formal standing in the IETF standards process". Building on it is a
deliberate choice with churn risk. Mitigation: isolate the serialization and verification in
one module, pin the implemented revision in a constant, and record it in the honesty label.

**The wallet will not display the terms.** `research.md` (spec 012, FR-7) found that Multipaz
renders only the transaction type's display name — "Payment" — never the amount or payee, in
either credential format. AP2 defines the display payload; Multipaz does not yet render it.
So the ceremony page remains the human-readable surface, exactly as in spec 012. The repo
already holds `multipaz-upstream-proposal-draft.md`; this is a candidate for it.

**RESOLVED — the app can hold an SD-JWT VC, via `.mpzpass`.** Confirmed on a Galaxy S24 Ultra,
Android 16. `MpzPass` already carries an `sdJwtVc` list and `DocumentStore.importMpzPass`
creates a `KeyBoundSdJwtVcCredential` from it. A bare `.sdjwt` file is NOT importable — the
wallet reads the `.mpzpass` container — and a file pushed with `adb` is not importable either,
because Android's scoped storage denies the wallet read access and the import fails with an IO
error that looks nothing like a permissions problem. Serve it over HTTP and download it.

**The on-device baseline is still unrun.** Spec 012's acceptance has one unchecked box: the
real-wallet round trip. It must be run **before** this specification changes what the wallet
signs. Without a green baseline, a failure after the change has two indistinguishable causes:
the new shape, or a session-transcript mismatch that was always there.

## What the device taught us

Verified 2026-09-09 on a Galaxy S24 Ultra, Android 16, against a Multipaz wallet built with
the AP2 `delegate` transaction type. The wallet signed both open mandates, byte-identical to
what was requested, inside its Key Binding JWT.

Getting there took four separate blockers. **Every one of them failed silently** — the same
"Your info wasn't found" a wallet holding no credential at all would give, or an error naming
something unrelated. They are written down here because the next person will hit them.

**1. Multipaz rejects an unregistered `transaction_data` type outright.**
`DocumentTypeRepository.parseJsonTransactions` throws `Unknown transaction type 'delegate'`,
and `OpenID4VP.kt` lets that kill the whole request. Multipaz registers exactly two types
(`urn:eudi:sca:payment:1` and a ping type); AP2's `delegate` is not among them. Fixed
upstream: `TheBlackBit/multipaz @ feat/ap2-delegate-transaction` adds the type, plus a
`nestSdJwtResponseClaims` flag so a type can put `_delegate_payload` at the KB-JWT top level
as an array — the previous code wrapped every type's claims in an object, which no verifier
written against Delegate SD-JWT can read.

**2. The credential must carry an `x5c` chain.** `SdJwtVcCredential.getClaimsImpl` throws
`Only X509-certified keys are supported in SD-JWT`. The export to the Android matcher catches
it and proceeds with an EMPTY claim set, so the wallet shows the card, says "ready to use",
and can never match a request.

**3. A `dc+sd-jwt` DCQL query needs a `claims` entry.** With `meta.vct_values` alone the
wallet matches nothing. An mdoc query matches on `meta.doctype_value` alone, which is what
made this hard to see.

**4. Every `transaction_data` entry must apply to the chosen credential.** AP2's example
pairs `delegate` with a human-readable `urn:eudi:sca:payment:1` entry. Multipaz's
`PaymentTransaction.isApplicable` requires `vct == org.multipaz.payment.sca.1`; ours is a
different type, so including that entry failed the presentation with "Error retrieving a
token". **This has a design consequence:** AP2's display payload and AP2's delegation
mechanism must target a credential type the wallet accepts for BOTH, or the human sees no
terms at all. Today they cannot, so the approve page stays the reading surface — on top of
the limitation already recorded, that Multipaz renders only the transaction type's name.

### And one fault of our own

The agent's keypair was minted at AUTHORIZE time. AP2 names that key in the mandates' `cnf`,
and the human's signature covers those bytes — so it has to exist BEFORE they are asked. As
written, the human signed over a key that was then discarded and replaced at authorization:
they authorized a spending authority nobody ever used. It is now minted when a device-mode
grant is created and handed to the engine at authorization, so the key that was authorized is
the key that can spend (`preApprove` takes an optional `delegateKeys`).

## Sequencing

1. **On-device baseline** — run spec 012's unchecked acceptance box on today's mdoc path.
   Establishes that the wallet round trip works at all.
2. **FR-1** — mint the SD-JWT DPC; establish whether the app can hold it.
3. **FR-3/FR-4** — the chain, built and verified in-process against a simulated wallet.
4. **FR-2** — the delegation request on the rail.
5. **FR-5/FR-6** — the key custody split.
6. **FR-7/FR-8** throughout, never after.

Steps 3 and 4 depend on spec 013 increment 2 (the SD-JWT issuer and verifier). Step 1 depends
on nothing and is the gate for everything that changes the signed bytes.

## Acceptance

- [ ] Spec 012's on-device box is checked (the baseline).
- [x] A `dc+sd-jwt` DPC is minted, and its provisioning path into the wallet is known
      (`.mpzpass`, served over HTTP — see *What the device taught us*).
- [ ] In-process end to end: delegate → store the intent → spend at a merchant → verify.
- [ ] The same intent verifies at a **second** merchant, and is refused at one outside its
      allowed merchants. This is the test that portability is real.
- [ ] All FR-8 bypass tests red-on-revert.
- [ ] `K_s` demonstrably never enters the merchant's process in the example.
- [ ] Root `npm test`, build and lint green; READMEs honest per FR-7.
- [x] On-device: a real wallet signs the delegate payload, verbatim. Proven with a standalone
      probe on 2026-09-09.
- [ ] On-device THROUGH THE RAIL. The probe answered "can the wallet do this at all"; it did
      not exercise the rail's signed request, encrypted response or sealed context. A green
      probe is not a green rail, and the difference is where the last three blockers lived.

## Open decisions

These need a maintainer call and should be filed as `needs-decision` issues rather than
settled here.

1. **Who issues the demo DPC?** The demo PKI (#48) minting its own, or an external issuer.
   *Recommendation:* the demo PKI, so the whole loop stays runnable offline.
2. **Does the agent surface ship as an entry point or a third package?**
   *Recommendation:* an entry point in the gate package, matching spec 013's reasoning for
   keeping `ap2/` a directory rather than a workspace. A package can follow if the boundary
   proves hard to hold.
3. ~~**What happens to the mdoc intent-sign path?**~~ **Answered: replaced.** See *Out of
   scope*. The code it discards was never green on a device, so the recommendation to defer
   was based on a baseline that did not exist.

## Sources

Verified 2026-09-08:

- `google-agentic-commerce/AP2` @ `main` — `docs/ap2/agent_authorization.md` (Mandate
  Delegation, the User Credential model, `transaction_data` type `delegate`, Mandate
  Structure, Verification and Processing Rules), `docs/ap2/specification.md`,
  `code/sdk/schemas/ap2/open_payment_mandate.json` (required: `vct`, `constraints`, `cnf`).
- G. Oliver, *Delegate SD-JWT*, `draft-gco-oauth-delegate-sd-jwt`, individual Internet-Draft,
  21 April 2026, expires 23 October 2026.
- RFC 9901 (SD-JWT); RFC 7800 (`cnf`); OpenID4VP 1.0 §5.1 (Transaction Data).
- This repository: `specs/012-device-signed-grants/{spec,research,on-device-interop}.md`,
  `specs/013-ap2-v2-wire-format/spec.md`, `packages/credentagent-gate/src/ap2/types.ts`,
  `packages/credentagent-gate/src/ceremony/intent-sign/`.
