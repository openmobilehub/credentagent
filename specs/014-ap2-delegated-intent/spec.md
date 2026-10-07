# Feature Specification: AP2 delegated intent — the wallet signs an open mandate, the agent spends it

**Feature branch:** `014-ap2-delegated-intent` · **Date:** 2026-09-08
**Builds on:** spec 012 (device-signed grants, #144), spec 013 (AP2 wire format, #39), the
grants module (spec 009), the demo-PKI credential set
**Feeds:** #12 (HNP delegation), #14 (issuer trust), #154 (multi-store epic)

> **Status: every functional requirement has shipped (FR-1 – FR-8).** What remains is on-device
> verification only. Three acceptance boxes need a phone and are still open; see *Acceptance*.
>
> | Requirement | Where it lives | Pull request |
> | --- | --- | --- |
> | AP2 types and money (`src/ap2/types.ts`, `ap2/money.ts`) | spec 013 increment 1 | #187 |
> | Mandate signing key, SD-JWT issuance, one verification door (`ap2/jwt.ts`, `issue.ts`, `verify.ts`) | spec 013 increment 2 | #195 |
> | FR-1 — the DPC as an SD-JWT VC | `tools/demo-pki/mint/` | — |
> | FR-2 — the delegation request on the rail | `ceremony/intent-sign/` | #189 |
> | FR-3, FR-4 — the chain, built and verified | `src/ap2/chain/` (plan in `plan-increment-3.md`) | #235 |
> | FR-5 — the agent holds its own key | `src/agent.ts`, `ap2/chain/agent-key.ts`, `grants.create({ agentKey })` | #235 (tracked in #237) |
> | FR-6 — the merchant's checkout key | `ap2/keys.ts`, `Ap2Issuer`, `CredentAgentOptions.checkoutSigningKey` | #235 (tracked in #237) |
> | FR-7, FR-8 — honesty labels and bypass tests | throughout, with each of the above | — |

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
  The delegate key is the one to put in `cnf` — which is the shape #189 implements in
  `grants.ts`. An earlier draft of this design proposed the human's key there; that was wrong.
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
- ~~Retiring the mdoc intent-sign path.~~ **Decided otherwise: the rail replaces it rather
  than running both.** Two ceremony surfaces means two verification doors and every control
  pinned twice, and the mdoc path never had a verified on-device baseline, so nothing proven
  is discarded. `credentagent.IntentBounds/v0` remains as the grant's content address
  (`boundsHash`); what the wallet SIGNS becomes AP2 Mandate Content.
  **Decided, not done** — the replacement is written in #189. On `main`,
  `ceremony/intent-sign/` is still the mdoc path, untouched.
- The Trusted Agent Provider model.

## Functional requirements

**FR-1 — The DPC as an SD-JWT VC. SHIPPED — `tools/demo-pki/mint/mint-dpc-sdjwt.mjs`.** The
tool produces a `dc+sd-jwt` DPC with `cnf` bound to a supplied device public key and the
instrument claims selectively disclosable.

The `vct` it mints is **`com.emvco.dpc`** — the value AP2's own example uses, so a verifier
written against the specification matches the credential with no local convention to learn.
Multipaz registers `urn:emvco:dpc:card:1` for its own SD-JWT payment credential, so when FR-2
builds the DCQL query it should accept **both** in `meta.vct_values`: the ecosystem has not
settled on one, and a naming difference should not cost a device session.

**Who signs it.** `gen-pki.sh` deliberately keeps the demo Document Signer's private key out
of this repository, so there is nothing for the tool to default to. Absent `--issuer-key` it
generates a demo issuer key, self-signs a certificate for it, and says so on stdout — it does
not quietly mint under a key the caller did not choose. Pass `--issuer-key` to sign with the
demo Document Signer on a machine that has it. Either way the certificate is self-signed from
the signing key rather than chained to the demo IACA; chaining would not add trust (#14), and
the `x5c` is there because Multipaz refuses an SD-JWT VC without one, not as an assurance
claim.

The claim set matches what the gate already requests (`issuer_name`,
`payment_instrument_id`, `masked_account_reference`, `holder_name`, `issue_date`,
`expiry_date`), so one DCQL shape serves both credential formats. Absent `--device-key` the
tool generates a holder pair locally, so the whole flow is exercisable in-process before any
phone is involved.

**Key custody.** Anything carrying a private key — the generated JWKs, and `dpc.mpzpass`,
which embeds the holder's private scalar in the clear — is written to `tools/demo-pki/keys/`,
which `.gitignore` covers. `tools/demo-pki/out/` is tracked and takes only publishable
artifacts. A test pins the split and fails if it is removed.

**FR-2 — The delegation request. SHIPPED — #189.** The intent-sign rail requests a `dc+sd-jwt` credential and
attaches both `transaction_data` entries. The `delegate_payload` is assembled from the
server's own grant record — never from anything the client sends — so the response can be
checked against what the server intended to ask.

**FR-3 — Chain construction. SHIPPED — #235, `src/ap2/chain/`.** A module builds the dSD-JWT: the user credential, the
KB-SD-JWT carrying the open mandates, and the agent's closed hop, serialized per Delegate
SD-JWT. It lives beside `ap2/` and mirrors the ceremony-rail file split.

**FR-4 — Chain verification, fail-closed. SHIPPED — #235, `verifyDelegatedPurchase`.** One verification door implementing the three
processing rules, with a refusal vocabulary distinct from business refusals. Unknown
constraints fail. A chain arriving with no key to check it against is refused, never treated
as "chain checking not configured".

**FR-5 — The agent-side surface. SHIPPED — #235.** `K_s` is generated and held in the agent's process. The
gate package gains an agent entry point exposing key generation, intent storage and
closed-hop signing. The merchant-side import surface never exposes a private key.

*As built:* the entry point is `@openmobilehub/credentagent-gate/agent` (`AgentKey`,
`DelegatedIntent`); the package root exports neither. A grant names the agent's key with
`grants.create({ agentKey: agentKey.publicJwk })`. The gate then generates no key of its own,
refuses a private JWK, and once the person signs, hands the agent `grant.mandate.intent` to spend.
Such a grant is not spent through `grant.spend()`, which refuses `agent-held-key`. A grant created
without `agentKey` keeps the gate-held key and server-side spending of spec 012.
`examples/delegated-purchase/` runs the agent as a separate OS process.

*Known limit:* revoking a grant does not recall a permission the agent already holds.
`verifyDelegatedPurchase` does not consult the grant, so the permission is spendable until the
expiry it was signed with. That is a year from creation today, because grants do not yet take
their own expiry (see *Known gaps and risks*).

**FR-6 — The merchant key. SHIPPED — #235.** The UCP Checkout is signed with a merchant key distinct from the
mandate-issuing key, with the `kid` making the distinction visible.

*As built:* `new CredentAgent({ checkoutSigningKey })`, kid `#merchant-checkout-key`, published
in the DID document after the mandate key (`#gate-signing-key`). A compact JWT verified against
a key that names a `kid` must carry that `kid`. The same JWK for both roles is refused. An
ephemeral checkout key is a `doctor()` warning, not an error: a stale quote is refused and
re-quoted, not lost for good.

**FR-7 — Honesty. SHIPPED — throughout.** A verified delegated chain reports that the human's wallet signed the
open mandate and the agent signed the closed one. It does not report issuer-verified trust.
Where the implementation follows an expired or superseded draft, the labels say which draft
revision was implemented.

*As built:* the label is in the call, not only in the result. `verifyDelegatedPurchase` requires
`trust: "presence-only-demo"`. Without it the call is a type error, and at runtime it is refused
with `code: "trust"`. The root credential is checked against the certificate it carries itself,
so an agent can mint its own permission and it verifies. The caller must say that this is
presence, not trust, before getting a verdict (#246).

**FR-8 — Bypass tests, each verified red-on-revert. SHIPPED — re-verified 2026-10-05.** Listed under *Security invariants*.

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

**The wallet CAN display the terms — on a patched build, and on no wallet you can install
today.** Both halves of that sentence matter, and an earlier revision of this document only
carried the first.

The design question was settled by #192, and settled correctly. AP2 is explicit — "The User is
shown the Mandate Content on a Trusted Surface" — and in the User Credential model the wallet
IS that surface. A page served by the party asking for the signature cannot vouch for itself,
and a stock wallet answers a `delegate` request from ANY website with the same blank screen.
So the approve page must not be the record.

**What was written.** `DelegateTransaction.summarize()` renders the Mandate Content on both
consent screens, generically — it walks whatever JSON the mandate carries, so a mandate type
nobody has seen still displays, and a mandate with nothing displayable is refused at parse
rather than signed.

**Where it lives, stated plainly.** In a personal fork:
`TheBlackBit/multipaz @ feat/ap2-delegate-transaction-utopia`. The upstream proposal,
openwallet-foundation/multipaz#2011, was opened as a draft and **closed on 2026-09-18 without
being merged**. Nothing about this has landed in Multipaz. Every device result in this
document was obtained on a locally built wallet carrying that fork.

**What follows for this specification.** Getting the `delegate` transaction type accepted
upstream is a prerequisite for the display claim, not a nice-to-have — and it is the largest
unowned risk here, because it is the one item no amount of work in this repository can
finish. Until it lands, the honesty labels must say the human-readable consent screen is
demo-only, exactly as they say the mdoc trust anchor is (#14). On the patched build, what the
signature covers is what the wallet showed; on a released wallet, the human sees nothing and
the ceremony must not run.

**RESOLVED — the app can hold an SD-JWT VC, via `.mpzpass`.** Confirmed on a Galaxy S24 Ultra,
Android 16. `MpzPass` already carries an `sdJwtVc` list and `DocumentStore.importMpzPass`
creates a `KeyBoundSdJwtVcCredential` from it. A bare `.sdjwt` file is NOT importable — the
wallet reads the `.mpzpass` container — and a file pushed with `adb` is not importable either,
because Android's scoped storage denies the wallet read access and the import fails with an IO
error that looks nothing like a permissions problem. Serve it over HTTP and download it.

**A signed permission lasts a year, and revoking the grant does not end it.** AP2 requires an
`exp` on an open mandate. A grant has no expiry option yet, so the mandate falls back to a year
from creation, and the approve page does not show that date. That was tolerable while the gate
held the agent's key: revoking the grant stopped the gate from spending. Since FR-5, an agent
holding its own key spends at the merchant, and `verifyDelegatedPurchase` does not consult the
grant. The year is now the real bound, next to `budget` and `perSpend`. The fix is a grant
expiry the person sees and signs, plus a revocation check a merchant can run. Neither is in this
specification.

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
(`urn:eudi:sca:payment:1` and a ping type); AP2's `delegate` is not among them. Fixed **in a
personal fork, not upstream** — `TheBlackBit/multipaz @ feat/ap2-delegate-transaction-utopia` adds
the type, plus a `nestSdJwtResponseClaims` flag so a type can put `_delegate_payload` at the
KB-JWT top level as an array (the previous code wrapped every type's claims in an object,
which no verifier written against Delegate SD-JWT can read). The upstream proposal
(openwallet-foundation/multipaz#2011) is closed and unmerged, so a released Multipaz wallet
still rejects the request outright. See *Known gaps* for what that costs.

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
token". **This has a design consequence:** AP2's separate display payload cannot ride along
with the `delegate` entry unless both target a credential type the wallet accepts, and today
they cannot.

The terms therefore have to be rendered from the `delegate` entry itself rather than from a
second entry beside it — which is what `DelegateTransaction.summarize()` does in the fork, and
why that change is the one this design depends on. See *Known gaps*: it is a personal fork,
the upstream proposal is closed, and on a released wallet the human still sees nothing.

### And one fault of our own

The agent's keypair was minted at AUTHORIZE time. AP2 names that key in the mandates' `cnf`,
and the human's signature covers those bytes — so it has to exist BEFORE they are asked. As
written, the human signed over a key that was then discarded and replaced at authorization:
they authorized a spending authority nobody ever used.

The fix is to mint it when a device-mode grant is created and hand it to the engine at
authorization, so the key that was authorized is the key that can spend — `preApprove` taking
an optional `delegateKeys`. **Fixed in #189.** One gap remained: a grant that left `signing`
out, and so defaulted to device signing, was never minted the key. #238 fixed that in #235.
Since #235, an agent can also bring its own key (FR-5), and then the gate mints none at all.

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
- [x] In-process end to end: delegate → store the intent → spend at a merchant → verify.
      Through the real rail with a simulated wallet: `grants.agent-key.test.ts`.
- [x] The same intent verifies at a **second** merchant, and is refused at one outside its
      allowed merchants. This is the test that portability is real. `purchase.test.ts` (#235).
- [x] All FR-8 bypass tests red-on-revert. Each control in the table above was removed in turn and
      its test went red (2026-10-05).
- [x] `K_s` demonstrably never enters the merchant's process in the example:
      `examples/delegated-purchase/` runs the agent as a separate OS process importing only `/agent`.
- [x] Root `npm test`, build and lint green; READMEs honest per FR-7.
- [x] On-device: a real wallet signs the delegate payload, verbatim. Proven with a standalone
      probe on 2026-09-09.
- [ ] The consent screen shows the mandate, and the screenshot is attached to #192.
- [ ] On-device THROUGH THE RAIL. The probe answered "can the wallet do this at all"; it did
      not exercise the rail's signed request, encrypted response or sealed context. A green
      probe is not a green rail, and the difference is where the last three blockers lived.

## Open decisions

These need a maintainer call and should be filed as `needs-decision` issues rather than
settled here.

1. **Who issues the demo DPC?** The demo PKI (#48) minting its own, or an external issuer.
   *Recommendation:* the demo PKI, so the whole loop stays runnable offline.
2. ~~**Does the agent surface ship as an entry point or a third package?**~~ **Answered: an
   entry point**, `@openmobilehub/credentagent-gate/agent` (#235). The recommendation was an
   entry point in the gate package, matching spec 013's reasoning for
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
  `specs/013-ap2-v2-wire-format/spec.md`, `packages/credentagent-gate/src/ceremony/intent-sign/`,
  and `packages/credentagent-gate/src/ap2/types.ts` (#187).
- `TheBlackBit/multipaz @ feat/ap2-delegate-transaction-utopia` — a personal fork of Multipaz, the
  build every on-device result here was obtained on. The upstream proposal,
  openwallet-foundation/multipaz#2011, was closed unmerged on 2026-09-18.
