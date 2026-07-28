# Research: `transaction_data` in Multipaz (spec 012, FR-7)

**Question (FR-7):** Does Multipaz's OpenID4VP implementation *render and sign*
`transaction_data` — the standards-track way for the **wallet screen itself** to show
"you are authorizing a $200 grant an agent will spend" — and if so, for which credential
formats and from which release? If it is effectively SD-JWT-only, that would couple this
upgrade to the SD-JWT mandate migration (#39), so the format answer matters.

**Method:** primary-source reading of the Multipaz source
(`github.com/openwallet-foundation/multipaz`, `main`, latest release **0.100.0**,
2026-07-08), the OpenID4VP 1.0 and EUDI TS12 specifications, and our own two rails that
already touch `transaction_data`. Every claim below carries a citation.

---

## VERDICT

**Multipaz supports OpenID4VP `transaction_data` for BOTH ISO-mdoc and SD-JWT VC today —
it is *not* SD-JWT-only.** The device cryptographically *signs* the transaction-data hash
in a `deviceSigned` namespace (mdoc) or in the Key-Binding JWT (SD-JWT), and the payment
transaction type our rail already uses — `urn:eudi:sca:payment:1` — is a first-class,
registered Multipaz type (`PaymentTransaction`), also wired into the Utopia/UPay universe.
**But the wallet consent screen renders only the transaction *type's display name*
("Payment") — never the amount or payee** — so a Multipaz wallet today tells the user "this
includes transaction data: • Payment" and *never shows* "you are authorizing a $200 grant."

**The signing half of FR-7 is here; the display half is not.** That split is decisive for
spec 012: because the wallet will not render the human-readable bounds regardless of format,
**the ceremony PAGE must remain the display surface in v1** (exactly what the spec's
Overview says), and `transaction_data` is a *forward-looking, additive* enhancement — not
the thing that moves the grant text onto the wallet screen.

### Per credential format

| Capability | ISO-mdoc | SD-JWT VC |
| --- | --- | --- |
| Verifier can **request** `transaction_data` | ✅ yes | ✅ yes |
| Device **signs** the transaction-data hash | ✅ `transaction_data_hash` (+`_alg`) in a `deviceSigned` namespace | ✅ `transaction_data_hashes` (+`_alg`) in the KB-JWT |
| Wallet **renders** the human-readable payload (amount/payee) | ❌ type name only ("Payment") | ❌ type name only ("Payment") |
| `urn:eudi:sca:payment:1` type registered | ✅ `PaymentTransaction` (multipaz-doctypes + Utopia) | ✅ same type object |
| Couples to the SD-JWT migration (#39)? | **No** | n/a |

**"Is it SD-JWT-only?" — NO, and this de-risks the upgrade:** the mdoc path is fully
implemented and symmetric to SD-JWT, so adopting `transaction_data` does **not** force the
AP2-v2 SD-JWT mandate-chain migration (#39). The only place "SD-JWT-only" is true is the
**EUDI TS12 SCA-payments spec's own scope** (see §2.4) — but Multipaz went beyond that spec
and shipped the mdoc mechanism too.

---

## 1. What `transaction_data` is (the spec mechanism)

OpenID4VP 1.0 defines `transaction_data` as a request parameter: a non-empty array of
base64url-encoded JSON objects, each a "typed parameter set with details about the
transaction that the Verifier is requesting the End-User to authorize," carrying a `type`
and a `credential_ids` array that references the DCQL credential(s) allowed to authorize it
(OpenID4VP 1.0 §5.1, "Transaction Data"). The *response* binding is format-specific: an
SD-JWT presentation puts `transaction_data_hashes` (+ `transaction_data_hashes_alg`) in the
Key-Binding JWT; the ISO-mdoc mechanism is **left to ISO 18013-7 / ecosystem profiles** —
the core OpenID4VP 1.0 text says the specific values are out of scope
(OpenID4VP 1.0 §5.1 and Appendix B.2.1). Multipaz supplies that mdoc mechanism itself (§2.2).

The purpose is **dynamic linking**: "Strong Customer Authentication that includes elements
which dynamically link the transaction to a specific amount and a specific Payee" — i.e.
the user's signature is bound to *this* amount/payee, not merely "a token was presented"
(EUDI TS12 §1.1). That is exactly the property spec 012 wants for a spending grant.

---

## 2. Multipaz support — evidence

Repo: `github.com/openwallet-foundation/multipaz` (renamed from the historical
`openwallet-foundation-labs/identity-credential`). Kotlin Multiplatform. Latest release
**0.100.0** (2026-07-08); OpenID4VP 1.0 landed in 0.93.0, ISO/IEC 18013-7:2025 presentment
in 0.98.0 (release notes). The `transaction_data` machinery below is present on `main` and
in the 0.100.0 line.

### 2.1 The type abstraction — one type, both formats

`multipaz/.../documenttype/TransactionType.kt`:

```kotlin
abstract class TransactionType<PayloadT: Any>(
    val displayName: String,
    val identifier: String,
    val kbJwtResponseClaimName: String = identifier,   // SD-JWT: KB-JWT claim name
    val mdocRequestInfoKeyName: String = identifier,   // mdoc: request key
    val mdocResponseNamespace: String = identifier,    // mdoc: deviceSigned namespace
)
```

A single `TransactionType` maps to **both** the SD-JWT KB-JWT claim and the mdoc
`deviceSigned` namespace — proof the design is format-symmetric, not SD-JWT-only.

### 2.2 The registered payment type is exactly ours — `urn:eudi:sca:payment:1`

`multipaz-doctypes/.../knowntypes/PaymentTransaction.kt`:

```kotlin
object PaymentTransaction: TransactionType<PaymentTransaction.Payload>(
    displayName = "Payment",
    identifier = "urn:eudi:sca:payment:1"
)
```

It sets only `displayName` and `identifier`, so the three defaults apply:
`kbJwtResponseClaimName == mdocRequestInfoKeyName == mdocResponseNamespace ==
"urn:eudi:sca:payment:1"`. The payload schema is the full EUDI-aligned SCA set —
`transactionId`, `currency` (ISO-4217), `amount`, `payee {name, id, logo?, website?}`,
`dateTime`, `pisp`, `executionDate`, `recurrence`, `mitOptions`, … .

**This matches our reader byte-for-byte.** Our `extractTransactionDataHash` (mdoc.ts:76–89)
defaults to `namespace = "urn:eudi:sca:payment:1"`, `element = "transaction_data_hash"` —
i.e. it reads from exactly the `deviceSigned` namespace Multipaz's `PaymentTransaction`
writes to. So our structural assumption about where the mdoc hash lands is correct against
real Multipaz. (Contrast `PingTransaction`, which *overrides* `mdocResponseNamespace =
"org.multipaz.transaction.ping.mdoc_response"` — the namespace is *not* always the
identifier, so this match was worth confirming; for `PaymentTransaction` it holds.)

### 2.3 mdoc response — the device signs `transaction_data_hash` in `deviceSigned`

- Producing it: `multipaz/.../presentment/mdocPresentment.kt` builds, per requested
  transaction, `Pair(transaction.type.mdocResponseNamespace, buildMap { put(
  "transaction_data_hash_alg", it.coseAlgorithmIdentifier!!.toDataItem()); put(
  "transaction_data_hash", transaction.computeHash(alg ?: Algorithm.SHA256)...) })` — the
  hash is a data element **inside a `deviceSigned` namespace**, so it is covered by the
  mdoc DeviceAuth signature (the device *signs over* it).
- Reading it back: `multipaz/.../mdoc/response/MdocDocument.kt` reads
  `response["transaction_data_hash"] as? Bstr` and `response["transaction_data_hash_alg"]`;
  `DeviceResponse.kt` iterates `data[transactionType.mdocResponseNamespace]`.
- Wire shape (from Multipaz's own test, `digitalCredentialsPresentmentTest.kt`,
  `test_OID4VP_mDL_withTransaction`), CBOR diagnostic of the DeviceResponse:
  ```
  DeviceNamespaces:
    FooNS:  { transaction_data_hash: 32 bytes, result: 42 }
    bar:    { transaction_data_hash_alg: -43, transaction_data_hash: 48 bytes, ... }
  ```
  `-43` is COSE SHA-384; the hash lands under the per-type namespace inside
  `DeviceNamespaces` (= `deviceSigned.nameSpaces`).

### 2.4 SD-JWT response — `transaction_data_hashes` in the KB-JWT

`multipaz/.../sdjwt/SdJwtKb.kt` reads `jwtBody["transaction_data_hashes"]` (throwing on an
invalid one), and `OpenID4VP.kt` emits `transaction_data_hashes` + `transaction_data_hashes_alg`
into the response. Multipaz's test asserts a KB-JWT with `"transaction_data_hashes_alg":
"sha-384"` and a `"transaction_data_hashes": [ … ]` array
(`digitalCredentialsPresentmentTest.kt`). This is the standard OpenID4VP / SD-JWT-VC
mechanism (EUDI TS12 §3.6). So SD-JWT is supported — but so is mdoc (§2.3), which is the
point.

*EUDI TS12 scope note (the only "SD-JWT-only" truth):* the EU's SCA-payments technical
spec explicitly limits **itself** — "This version of the document focuses on [SD-JWT-VC]
format and [OID4VP] presentation protocol only" (TS12 §1.2), and defines the
`urn:eudi:sca:payment:1` payload schema and the KB-JWT `transaction_data_hashes` binding
(TS12 §3.6, §4.2). Multipaz implemented the payment *type* per TS12 **and** added the mdoc
carriage the EU spec omits. The `urn:eudi:sca:payment:1` identifier is an ecosystem
standard: it also appears in the Android CMWallet matcher, the NXD wallet-conformance
backend, and (as the EU variant `urn:eudi:sca:eu.europa.ec:payment:single:1`) in Animo's
Paradym wallet.

### 2.5 The wallet consent screen renders the TYPE NAME only — not the amount

This is the load-bearing limitation. `multipaz-compose/.../presentment/Consent.kt`:

```kotlin
Text(text = stringResource(Res.string.credential_presentment_transaction_data)) // "Includes transaction data:"
for (data in credential.match.transactionData) {
    Text(text = "• ${data.type.displayName}")   // "• Payment"
}
```

The consent UI iterates the transactions and prints `data.type.displayName` — for our type
that string is literally **"Payment"** (§2.2). There is **no rendering of the payload** —
no amount, no payee, no free text. Neither `TransactionType` nor `PaymentTransaction`
defines any human-readable payload-summary method for the consent screen; they define only
parse/serialize/apply. So on a stock Multipaz wallet the human sees, at most:

> Includes transaction data:
> • Payment

The device still **signs over** the full payload hash (real dynamic linking), but the human
**cannot read the bounds on the wallet** — only that "a Payment transaction is bound."

### 2.6 Request parsing — unknown top-level members ignored; unknown `transaction_data` type HARD-FAILS

`multipaz/.../openid/OpenID4VP.kt`:
- **Unknown top-level request members are ignored** — the parser selectively extracts known
  fields (`nonce`, `response_mode`, `dcql_query`, `client_metadata`, `transaction_data`, …)
  with an explicit `TODO: … read through spec and … throw helpful errors`. So an *unrelated*
  new request field rides along harmlessly.
- **`transaction_data` is parsed and validated**: it calls
  `documentTypeRepository.parseJsonTransactions(...)` and wraps failures as
  `IllegalStateException("Problem processing transaction(s)", …)`. A `transaction_data`
  entry whose `type` is **not a registered `TransactionType`** (or whose payload fails the
  type's schema parse) **throws — the wallet rejects the whole request.** It is *not*
  silently skipped.

**Consequence:** `transaction_data` is safe to add **only against a wallet whose
`DocumentTypeRepository` has that type registered.** The Utopia universe registers it
(`multipaz-utopia/.../DocumentTypeRepositoryExt.kt`: `addTransactionType(PaymentTransaction)`);
a bare Multipaz wallet without it would reject `urn:eudi:sca:payment:1`.

---

## 3. The Utopia / UPay verifier (`utopia.multipaz.org`)

`multipaz-utopia` is Multipaz's "Utopia universe." It registers `PaymentTransaction` and
`PingTransaction` (`DocumentTypeRepositoryExt.kt`), and its
`knowntypes/MultiDocumentRequests.kt` issues requests carrying `"type":
"urn:eudi:sca:payment:1"`. So UPay is the concrete verifier that already drives Multipaz's
payment `transaction_data`. Our PR #103 integrates exactly this: its adapter maps
`buildRequest → PaymentProcessor.createTransaction`, `consume → verified DPC presentment +
TrustManager.verify(...).isTrusted`, `settle → commitTransaction` (PR #103 discussion), and
the delegated rail's page hands the verifier's own browser step the ceremony
(`delegated-payment/page.ts:112–128`); the gate never renders the wallet screen.

**What the wallet shows in that flow is still governed by `Consent.kt` (§2.5): the type name
"Payment", not the amount.** UPay binds and signs the amount via `transaction_data`, but the
Multipaz consent screen it drives does not display the payload. Nothing in the UPay path
changes the rendering conclusion — it is a wallet-UI fact, not a verifier choice.

---

## 4. Our own rails already emit `transaction_data` — but only against synthetic wallets

The dc-payment rail **already builds and sends** OpenID4VP `transaction_data`:
`dc-payment/request.ts:56` embeds `transaction_data: [txDataB64]` in the signed request
object; `dc-payment/txData.ts:14–37` sets `type: "urn:eudi:sca:payment:1"` with an
`{ amount, currency, payee }` payload; and the REAL verify path extracts the device-signed
hash back out (`dc-payment/verify.ts:242` → `mdoc.ts:76`).

**Caveat — this has never round-tripped against a real Multipaz wallet.** The only test that
exercises the response side, `dc-payment/presentation.test.ts`, builds a **synthetic**
DeviceResponse by hand: docType `org.multipaz.payment.sca.1` with a `deviceSigned` namespace
`urn:eudi:sca:payment:1` carrying `transaction_data_hash` (presentation.test.ts:55–61). It
models Multipaz's shape (and, per §2.2–2.3, models it correctly) but does not prove a live
wallet accepts our hand-built payload. Two concrete integration risks that a real wallet
would surface and our tests cannot:

1. **Payload schema mismatch.** Our payload uses `transaction_id` (snake) and only
   `{amount, currency, payee}`; Multipaz's `PaymentTransaction.Payload` uses `transactionId`
   (camel) and may require additional fields (e.g. `dateTime`). If `parseJsonTransactions`
   validates strictly, the wallet **rejects the request** (§2.6). Must be verified on-device.
2. **Hash-algorithm negotiation.** Multipaz reports `transaction_data_hash_alg` and can pick
   SHA-384/512 (COSE `-43`/`-44`); our reader recomputes **SHA-256 only** and ignores the
   `_alg` element (mdoc.ts:78–86). A wallet that answers in a non-SHA-256 alg would fail our
   equality check even though the binding is valid. A real integration must read
   `transaction_data_hash_alg` and match it (or constrain the request to sha-256).

---

## 5. Can we add `transaction_data` to a request TODAY without breaking Multipaz?

**Qualified yes — additive, but not "gracefully ignored" the way an unknown field is.**

- As an **unrelated new top-level field**: yes, ignored (§2.6). But `transaction_data` is a
  *known* field, so this case doesn't apply to it.
- As a **`transaction_data` array with the registered `urn:eudi:sca:payment:1` type, sent to
  a Utopia-configured wallet, with a payload that passes `PaymentTransaction`'s schema**:
  yes — the wallet renders "• Payment", the device signs the hash, and we can additionally
  verify `transaction_data_hash` in the response.
- As a **`transaction_data` array with an unregistered type, or a malformed payload, or sent
  to a wallet without `PaymentTransaction` registered**: **no — hard rejection** (§2.6).

So the answer is registration- and schema-dependent, and must be proven on-device (§4). It
is not a free, universally-ignored addition.

---

## 6. Implications for spec 012

**6.1 Is page-display v1 right? — YES, unambiguously.** The spec's Overview says the human
reads the grant on the ceremony *page* "until the OpenID4VP `transaction_data` spike (FR-7)
confirms the wallet can display the grant text itself." This spike confirms **it cannot**:
Multipaz renders only the transaction *type name* on the consent screen (§2.5), for **both**
formats. Sending `transaction_data` would not move the amount/payee onto the wallet — it
would only add "• Payment". So page-as-display-surface is correct, and the spec's honesty
split ("*what you saw* is page-attested; *what you authorized* is device-signed") is exactly
right and should stay.

**6.2 Is spec 012's nonce-binding redundant with `transaction_data`? — No; they're the same
guarantee by two routes, and nonce-binding is the lower-risk one for v1.** Spec 012 binds
`boundsHash` into the OpenID4VP nonce, so the mdoc DeviceAuth signature over the session
transcript covers the bounds (spec §"How the signature covers the bounds"). `transaction_data`
achieves the *same* cryptographic dynamic-linking via a standards-track field. Given that:
- neither approach makes the wallet render the bounds (§2.5), and
- `transaction_data` carries live-wallet fragility (schema + hash-alg + registration, §4–5)
  that nonce-binding does not,

**nonce-binding is the right v1 mechanism.** It gives the device-signs-the-bounds invariant
today with no dependency on Multipaz's transaction-type schema or the on-device round-trip
that spec 012 already defers to "maintainer + Pixel."

**6.3 When/how to add `transaction_data` (the follow-up).** Layer it in **additively** after
v1, as a second, standards-aligned binding *alongside* the nonce (belt-and-suspenders), once:
(a) the intent-sign rail's payload is made to match `PaymentTransaction.Payload` exactly,
(b) the verifier reads `transaction_data_hash_alg` instead of assuming SHA-256, and
(c) it is validated against a real Utopia-configured Multipaz wallet. Marginal benefit
**today**: standards alignment, the wallet shows "• Payment" (a signal that a payment
transaction is bound), and forward-compatibility. It does **not** deliver the wallet-screen
grant text.

**6.4 The real prize is upstream.** Moving "you are authorizing a $200 grant to Utopia" onto
the wallet screen requires **Multipaz to render the `PaymentTransaction` payload** (amount,
payee) on the consent screen — a change to `Consent.kt` / a per-type payload renderer that
does not exist today (§2.5). That is an upstream Multipaz feature request, not something our
rail can achieve by sending a better request. Until it lands, the page is the only surface
that can show the human the actual bounds.

---

## 7. Ready-to-file follow-up issue

> **Title:** Adopt OpenID4VP `transaction_data` on the intent-sign rail (additive, after
> device-signed grants v1)
>
> **Parent:** #12 (epic) · **Relates to:** #144 (spec 012), #14 (issuer trust), #39 (SD-JWT
> mandate chains — *note: NOT a blocker; see below*)
>
> **Plain terms.** Today's device-signed grant binds the amount/limits into the wallet's
> signature by hashing them into the OpenID4VP *nonce*. OpenID4VP also has a purpose-built
> field for this — `transaction_data` — and Multipaz supports it for both mdoc and SD-JWT
> credentials (verified in spec 012's research.md). This issue adds `transaction_data` as a
> **second, standards-aligned binding alongside** the nonce binding. It is additive and
> does **not** change what the human reads.
>
> **Important scoping (from the FR-7 spike):**
> - This does **not** put the grant text on the wallet screen. Multipaz's consent UI renders
>   only the transaction *type name* ("Payment"), never the amount/payee
>   (`multipaz-compose/.../Consent.kt`). Wallet-screen display of the bounds needs an
>   **upstream** Multipaz change (payload rendering) — file that separately/upstream.
> - This is **not** coupled to the SD-JWT migration (#39). Multipaz's mdoc `transaction_data`
>   path is fully implemented (`transaction_data_hash` in a `deviceSigned` namespace), so we
>   can adopt it on today's mdoc payment credential.
>
> **Scope / acceptance:**
> 1. Emit a `transaction_data` entry (type `urn:eudi:sca:payment:1`) on the intent-sign
>    request whose payload **matches `PaymentTransaction.Payload` exactly** (fix
>    `transaction_id`→`transactionId`; include any required fields such as `dateTime`).
> 2. On verify, extract `transaction_data_hash` from the `deviceSigned` namespace **and read
>    `transaction_data_hash_alg`** — recompute with the reported algorithm rather than
>    assuming SHA-256 (today's reader hardcodes SHA-256, `mdoc.ts:78`).
> 3. Keep the nonce-binding; require **both** to agree (belt-and-suspenders).
> 4. **On-device gate:** prove the round-trip against a Utopia-configured Multipaz wallet —
>    a mismatched type/payload is **hard-rejected** by Multipaz's request parser
>    (`OpenID4VP.kt`), so this cannot be validated by unit tests alone.
> 5. Honesty unchanged: `trust_level` stays `device-signed`; no issuer-trust claim (#14).

---

## Sources

Multipaz source (`github.com/openwallet-foundation/multipaz`, `main` / v0.100.0):
- `multipaz/src/commonMain/kotlin/org/multipaz/documenttype/TransactionType.kt` — the type abstraction (both formats).
- `multipaz-doctypes/src/commonMain/kotlin/org/multipaz/documenttype/knowntypes/PaymentTransaction.kt` — `urn:eudi:sca:payment:1`, displayName "Payment", payload schema.
- `multipaz/src/commonMain/kotlin/org/multipaz/presentment/mdocPresentment.kt` — writes `transaction_data_hash` + `_alg` into the `deviceSigned` namespace.
- `multipaz/src/commonMain/kotlin/org/multipaz/mdoc/response/{MdocDocument,DeviceResponse}.kt` — reads them back by `mdocResponseNamespace`.
- `multipaz/src/commonMain/kotlin/org/multipaz/sdjwt/SdJwtKb.kt` + `openid/OpenID4VP.kt` — SD-JWT `transaction_data_hashes`; request parsing (unknown members ignored, unknown transaction type throws).
- `multipaz-compose/src/commonMain/kotlin/org/multipaz/compose/presentment/Consent.kt` + `composeResources/values/strings.xml` — consent screen renders `type.displayName` only.
- `multipaz-utopia/src/commonMain/kotlin/org/multipaz/utopia/knowntypes/{DocumentTypeRepositoryExt,MultiDocumentRequests,PingTransaction}.kt` — Utopia registers `PaymentTransaction`; UPay issues `urn:eudi:sca:payment:1`; `PingTransaction` overrides `mdocResponseNamespace`.
- `multipaz/src/commonTest/kotlin/org/multipaz/presentment/digitalCredentialsPresentmentTest.kt` — `test_OID4VP_mDL_withTransaction`, the DeviceResponse/KB-JWT wire shapes.
- Release history: `github.com/openwallet-foundation/multipaz/releases` (0.100.0 2026-07-08; OID4VP 1.0 in 0.93.0; ISO 18013-7:2025 in 0.98.0).

Specifications:
- OpenID4VP 1.0 — §5.1 "Transaction Data" (request array; format-specific response; mdoc deferred to profiles): `openid.net/specs/openid-4-verifiable-presentations-1_0.html`.
- EUDI TS12 "Electronic Payments SCA implementation with wallet" — §1.1 dynamic linking, §1.2 SD-JWT-only scope, §3.6 KB-JWT `transaction_data_hashes`, §4.2 payload, `urn:eudi:sca:payment:1` schema: `github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/blob/main/docs/technical-specifications/ts12-electronic-payments-SCA-implementation-with-wallet.md`.
- Ecosystem corroboration of the `urn:eudi:sca:payment:1` type id: Android CMWallet matcher (`digitalcredentialsdev/CMWallet`), NXD wallet-conformance backend, Animo Paradym (`animo/paradym-wallet`, EU variant `urn:eudi:sca:eu.europa.ec:payment:single:1`).

Our own code (this repo, branch `012-device-signed-grants`):
- `packages/credentagent-gate/src/ceremony/dc-payment/request.ts:56` — already sends `transaction_data`.
- `.../dc-payment/txData.ts:14–37` — `type: "urn:eudi:sca:payment:1"` payload.
- `.../mdoc/mdoc.ts:76–89` — reads `deviceSigned[urn:eudi:sca:payment:1].transaction_data_hash` (SHA-256, ignores `_alg`).
- `.../dc-payment/verify.ts:242` — extracts the device-signed hash.
- `.../dc-payment/presentation.test.ts:55–61` — **synthetic** DeviceResponse (never a real wallet).
- `.../delegated-payment/page.ts:112–128` — the external (UPay) verifier drives the wallet; gate never renders it.
- PR #103 discussion — UPay adapter mapping (`PaymentProcessor.createTransaction` / `TrustManager.verify` / `commitTransaction`).
