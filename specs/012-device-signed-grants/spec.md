# Feature Specification: Device-signed grants — the wallet signs the Intent Mandate

**Feature branch:** `012-device-signed-grants` · **Issue:** #144 (under #12) · **Date:** 2026-07-28
**Builds on:** grants (#104, spec 009), the intent-rail design (spec 005), the ceremony rails,
`payment.mpzpass` (demo-PKI toolkit) · **Feeds:** #39 (SD-JWT mandate chains), #14 (issuer trust)

## Overview

Approving a spending grant today is one click on a server page — the server takes the human's
word for it (`trustLevel: "server-issued-demo"`). This spec makes approval **cryptographic**:
the grant — an AP2 **Intent Mandate**, the "here is what I authorize" record — is signed by a
key stored on the phone, inside the **Multipaz wallet**, presenting the **SCA payment
credential** (`org.multipaz.payment.sca.1` — the doctype the demo-PKI `payment.mpzpass`
mints, and the one the dc-payment rail already requests).

**The invariant this establishes: signed by the device first, spent by the agent second.**
A device-mode grant that was never device-signed can never be spent; a spend can always be
traced to the exact signed bounds the human authorized.

## How the signature covers the bounds (the mechanism)

A wallet signs *presentations*, not arbitrary blobs. The rail therefore derives the ceremony
challenge from the grant itself:

```
boundsHash = sha256( canonicalIntentBounds(grant) )        // FR-1
nonce      = seal( challenge ‖ boundsHash )                 // same sealed-context mechanism the
                                                            // credential rail already uses
```

The wallet's **mdoc DeviceAuth** signature covers the session transcript containing that
nonce — so the device signature cryptographically covers the exact bounds, the same binding
trick the dc-payment rail uses for amounts. Verification re-derives `boundsHash` from the
**server's own grant record** (never from anything the client sent) and refuses on mismatch.

*What the human reads:* until the OpenID4VP `transaction_data` spike (FR-7) confirms the
wallet can display the grant text itself, the **ceremony page** is where the human reads the
grant — the spec 011 approval card slots in here — and the wallet shows the payment-credential
presentation. The spec is explicit about that split: *what you saw* is page-attested; *what
you authorized* is device-signed.

## The surface (caller-first — this IS the DX test)

```js
const credentagent = new CredentAgent({ walletOrigin, catalog });

// Opt a grant into device signing (additive; the label carries the difference — FR-3/FR-4):
const gc = await credentagent.grants.create({
  merchant: "utopia", budget: 200, perSpend: 130,
  allow: { categories: ["Beverages", "Electronics"] },
  signing: "device",                      // ← new; omit = today's page-approve
});
// gc.approveUrl → ceremony page → grant summary + "Sign with your wallet" (QR / DC API)
// …human signs on the phone…
const g = await credentagent.grants.retrieve(gc.id);
g.status;      // "authorized" — ONLY after the gate verified the device signature
g.trustLevel;  // "device-signed" — real holder binding; demo trust anchor (see FR-4)
g.mandate;     // { boundsHash, signedAt, credentialDoctype } — the evidence, plain data
```

## Functional requirements

**FR-1 — Canonical Intent-Mandate bounds.** `canonicalIntentBounds(grant)` produces a stable,
JSON-canonical encoding of `{ grantId, merchant, budget, perSpend, allow: { skus: sorted,
categories: sorted }, createdAt, expiresAt?, nonce }`. One encoder, exported, pinned by a
stability test (key order, array order, number formatting). `boundsHash` is its sha256.

**FR-2 — The intent rail** (`src/ceremony/intent-sign/`, mirroring the
`dcql`/`request`/`verify`/`page`/`routes` rail split; REUSE shared helpers — `dcql()`,
`makeEncryptionKey`, the sealed-context and `mdoc/` parsers, the reader identity):
- `dcql`: requests the payment credential (`org.multipaz.payment.sca.1`), reusing the
  dc-payment rail's query so both rails ask a wallet for the same thing.
- `request`: OpenID4VP request whose nonce is bounds-bound as above; same-device (Digital
  Credentials API) and cross-device (QR) both served, exactly like the credential rail.
- `verify`: decrypt the vp_token, parse the mdoc, check the DeviceAuth signature covers the
  session transcript with the bounds-bound nonce, require the payment-credential claims,
  **re-derive `boundsHash` server-side and require equality**, mark the nonce consumed
  (single-use), then hand the gate a typed `{ ok, boundsHash, signedAt } | { ok: false,
  reason }` result.
- `page`: ceremony-styled grant summary (budget, per-purchase, allow bounds, "an agent will
  spend this while you're away") + the sign affordance + the honesty trust line. Branding
  (#132) applies; the trust line does not.
- `routes`: GET page, POST options, POST verify — origin-bound, replay-protected, keyed by
  grant id (invariant 4 scoping).

**FR-3 — Grants integration (additive, honest-by-type).** `CreateGrantOptions.signing?:
"device" | "page"` (default `"page"` — today's behavior, safe default). A **device-mode grant
only reaches `authorized` through FR-2's verify**; `_authorize` without verified evidence
refuses for device grants. Page-mode grants keep `trustLevel: "server-issued-demo"` — the
TYPE carries the difference, so no copy can blur the two. The demo/quickstart story uses
`signing: "device"`.

**FR-4 — Honesty (two verification backends, provenance always recorded).** The rail's
`verify` runs through a **seam**, not a hardcoded in-gate check, because the trust ceiling
differs by who verifies:

- **In-gate verify (v1 default):** new `trustLevel` value **`"device-signed"`** — the device
  signature is real; the trust anchor is not (the demo `payment.mpzpass` credential, no
  issuer/VICAL check — that is #14, unchanged). Docs, page copy, and release notes must state
  exactly that. The gate itself never claims `"issuer-verified"`.
- **Delegated verify (the #103 `DelegatedVerifier` seam):** the external checker
  (e.g. the UPay/utopia verifier) verifies a payment credential that is **issuer-backed in its
  own ecosystem and can settle real value**. The gate **relays the verifier's attested
  `trust_level` verbatim** — exactly the precedent the delegated-payment rail set in #103 —
  which may legitimately exceed `"device-signed"`. The mandate record then carries the
  **attestor's identity** (`verifiedBy`), so a stronger label is always traceable to who
  vouched for it, never implied to be the gate's own judgment.

Either way the mandate evidence records `{ boundsHash, signedAt, verifiedBy: "gate" | <verifier id>, trustLevel }`.
v1 implements the in-gate backend + the seam; wiring the UPay verifier end-to-end through it
is the fast-follow (it also means the SAME credential that signed the intent settles the
spends — the full signed-authority → settlement chain).

**FR-5 — The spend chain (v1).** Every spend's stored record and `SpendDoor` gains
`mandate: { id, boundsHash }` referencing the signed Intent Mandate, so a settled purchase
traces to the signed authority. The SD-JWT/KB-SD-JWT wire chain is #39, not this spec.

**FR-6 — Bypass tests (each verified red-on-revert):**
- (a) bounds tampered after page render (budget 200→2000) → verify refuses; grant stays pending.
- (b) a verify response from a DIFFERENT grant's ceremony (nonce reuse / cross-grant replay) → refused.
- (c) the server-side `boundsHash` equality check deleted → test (a) goes red.
- (d) spend on a device-mode grant before signing → `not-authorized`.
- (e) a page-mode grant never reports `trustLevel: "device-signed"`.

**FR-7 — Spike: `transaction_data` in Multipaz.** Determine whether/when Multipaz's OpenID4VP
implementation renders and signs `transaction_data` (the standards-track way for the wallet
screen itself to show "you are authorizing a $200 grant an agent will spend"), referencing the
`utopia.multipaz.org` verifier behavior. Output: a written finding in this spec's `research.md`
+ a follow-up issue if supported. Until then the page is the display surface (Overview).

## Non-goals (v1)

- Issuer/VICAL trust verification (#14). SD-JWT mandate-chain wire format (#39).
- Revoking a grant *from the wallet* (revocation stays a server action).
- Changing the default `signing` mode (a later, deliberate flip once the wallet flow is proven).

## Acceptance

- [ ] Unit-verified end-to-end in-process: create(device) → page → simulated wallet present →
      verify → authorized(device-signed) → spend carries mandate ref → tamper/replay refused.
- [ ] All FR-6 bypass tests red-on-revert.
- [ ] Full suites + build + lint green; READMEs honest per FR-4.
- [ ] **On-device (needs the maintainer + Pixel):** import `payment.mpzpass`, run the QR flow
      against the dev twin, sign, see the grant authorized — the issue #144 done-when.
- [ ] FR-7 spike finding recorded in `research.md`.
