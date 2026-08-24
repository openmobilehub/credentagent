# On-device interop pre-flight — device-signed grants (spec 012)

**Purpose.** The device-signed grants rail (spec 012, PR #148) verifies a **real** mdoc
DeviceAuth signature over a session transcript that carries the bounds-bound nonce. The
in-process simulated wallet exercises that verify code end-to-end, but the **real-wallet
round-trip on a phone has not been run**. The one place our bytes can diverge from a real
Multipaz wallet is the **session transcript** — if the gate and the wallet don't construct
byte-identical transcripts, the DeviceAuth signature verifies against the wrong content and
the grant refuses with `device signature does not verify`.

This document maps the likely mismatch points **before** the maintainer is at the Pixel, so
the on-device loop is *edit → redeploy → retry* against a ranked list, not live debugging.

**Scope note.** The FR-7 research (`research.md`) verified Multipaz's `transaction_data`
support against source. It did **not** examine Multipaz's **session-transcript handover**
construction. So the "what Multipaz expects" claims below are grounded in the **OpenID4VP
1.0 / ISO 18013-7 specifications**, and every place our research has not confirmed the exact
Multipaz bytes is marked **UNVERIFIED — confirm on device**. Nothing here changes the
signing/verify logic; it is analysis, a debug aid, and a runbook.

---

## 1. The exact bytes our rail signs (source of truth: our code)

The gate builds and the wallet must reproduce this session transcript, then the device signs
a structure containing it.

### 1.1 The nonce (what binds the bounds)

`bounds.ts` → `request.ts:80–82`:

```
boundsHash = base64url( SHA-256( canonicalIntentBounds(grant) ) )     # bounds.ts:boundsHash
challenge  = base64url( 16 random bytes )                              # request.ts (per ceremony)
nonce      = base64url( SHA-256( challenge_bytes || boundsHash_bytes ) )   # bounds.ts:deriveNonce
```

`nonce` is placed in the OpenID4VP request object's `nonce` member (`request.ts:66`) and is
the *only* grant-specific value on the wire — everything else about the grant stays in the
sealed reader context server-side (FR-7 guidance: keep the request conservative).

### 1.2 The session transcript

`deviceAuth.ts`, `buildIntentSessionTranscript(origin, nonce, jwkThumbprint)` — **updated to the
DRAFT_29 3-element HandoverInfo in commit `86da8d1`** (adversarial-review finding 1):

```
HandoverInfo            = CBOR([ origin (tstr), nonce (tstr), jwkThumbprint (bstr, raw 32 bytes) ])
HandoverInfoHash        = SHA-256( HandoverInfo )                      # raw 32-byte digest
SessionTranscript       = CBOR([ null, null,
                                 [ "OpenID4VPDCAPIHandover", HandoverInfoHash (bstr) ] ])
```

- `origin` = `Origin.origin` from `deriveOrigin` (`ceremony/origin.ts:20–25`) —
  `` `${proto}://${host}` `` built from the request's `Host` (or `x-forwarded-host`) header.
- `jwkThumbprint` = the RFC 7638 SHA-256 thumbprint of the reader's response-encryption key, as a
  **base64url (no-pad) string**, computed with **jose's `calculateJwkThumbprint(jwk, "sha256")`**
  — NOT a hand-rolled canonical JSON, so the required-member canonicalization matches the wallet
  exactly (a hand-rolled member order both our sides agree on would pass our tests yet still
  mismatch a real wallet). `verify.ts` computes it from the sealed `ecdhPrivateJwk`; `simulate.ts`
  from the request's advertised `encJwk` — the same key, and `calculateJwkThumbprint` hashes only
  the required EC members, so both produce the identical string.
- CBOR is canonical/deterministic (cbor-x, `useRecords:false, variableMapSize:true,
  useTag259ForMaps:false` — `deviceAuth.ts:26–29`), matching ISO 18013-5 §9.1.1.

### 1.3 What the device signs over

`deviceAuth.ts:205–232`, `verifyDeviceAuth`:

```
DeviceAuthentication      = [ "DeviceAuthentication",
                              SessionTranscript (decoded, embedded as CBOR),
                              DocType (tstr, from the presented doc),
                              DeviceNameSpacesBytes (#6.24 tag, echoed from the presentation) ]
DeviceAuthenticationBytes = #6.24( bstr .cbor DeviceAuthentication )
Sig_structure             = [ "Signature1",
                              protectedHeader (bstr, the wallet's OWN — read from deviceSignature[0]),
                              h'' (empty external_aad),
                              DeviceAuthenticationBytes ]
signature (verified)      = ECDSA-P256-SHA256( Sig_structure ), device public key from the MSO
```

Two deliberate "echo, don't assume" choices that make several fields **match by
construction**, not by guessing the wallet:

- **`DeviceNameSpacesBytes`** is re-embedded verbatim from what the wallet sent
  (`asTag24`, `deviceAuth.ts:81–86`) — so we never reconstruct it and can't mis-encode it.
- **`protectedHeader`** is the wallet's own bytes (`deviceAuth.ts` reads
  `parsed.deviceSignature[0]`), so the COSE algorithm matches whatever the wallet signed with.

The device public key comes from the presented **Mobile Security Object** (issuerAuth
payload → `deviceKeyInfo.deviceKey`), which is **not** anchored to a trusted issuer — the
honest `device-signed` vs `issuer-verified` line (unchanged; issue #14).

---

## 2. What a real Multipaz / OpenID4VP DC API wallet expects

For an mdoc presentation over the **W3C Digital Credentials API** with an **encrypted**
response (our `response_mode` is `dc_api.jwt` — `request.ts:64`), OpenID4VP 1.0 (Appendix B,
"Session Transcript for the DC API") defines:

```
SessionTranscript          = [ null, null, OpenID4VPDCAPIHandover ]
OpenID4VPDCAPIHandover     = [ "OpenID4VPDCAPIHandover", OpenID4VPDCAPIHandoverInfoHash ]
OpenID4VPDCAPIHandoverInfo = [ origin, nonce, jwk_thumbprint ]        # THREE elements; thumbprint is a bstr
OpenID4VPDCAPIHandoverInfoHash = SHA-256( CBOR( OpenID4VPDCAPIHandoverInfo ) )
```

where (OpenID4VP 1.0 Appendix B + RFC 7638):

- `origin` — the **Web Origin** of the request as the browser reports it to the wallet via
  the DC API (canonical: lowercase scheme + host, default ports 443/80 omitted, no path,
  no trailing slash), e.g. `https://credentagent-demo-dev.vercel.app`.
- `nonce` — the request's `nonce` string, verbatim.
- `jwk_thumbprint` — when the response is **encrypted**, the **RFC 7638 SHA-256 JWK
  thumbprint** of the verifier's response-encryption public key (the JWK the request advertises
  in `client_metadata.jwks` — our `encJwk`). We carry it as the base64url (no-pad) string jose's
  `calculateJwkThumbprint` returns; a wallet that uses the raw 32-byte digest (bstr) instead is
  Fix A″. When the response is **unencrypted**, this element is `null`.

**Status: applied in commit `86da8d1`.** The adversarial review of PR #148 confirmed this
against Multipaz's `OpenID4VP.kt` (lines 657–681, the DRAFT_29 DC-API branch), and the rail now
builds exactly the 3-element HandoverInfo above (§1.2). **Still to confirm on device** — the
review is a source read, not a phone round-trip.

**The remaining draft-skew caveat (the first fallback to try on device).** The handover shape has
churned across OpenID4VP drafts: **DRAFT_29** is `[origin, nonce, jwk_thumbprint]` (what we ship);
**DRAFT_24** is `[origin, clientId, nonce]`. If a real wallet still rejects the signature, the
wallet build may be on the older draft — the one-line switch is in §4.4 (Fix A′). Also still
**CONFIRMED ON DEVICE (2026-08-24):** the `jwk_thumbprint` is a **raw 32-byte bstr**, not a
base64url tstr, and the literal label `"OpenID4VPDCAPIHandover"` is correct. Established by
solving a real Multipaz presentation offline against every candidate shape — exactly one
verified. The encoding is asserted by `deviceAuth.test.ts`, which checks the CBOR type of that
element rather than only its value — the captured presentation itself is NOT committed (it is
specific to one device and one wallet build; re-capture with `INTENT_DEBUG_DEVICE_RESPONSE` and
re-run the solve if you need to re-establish it).

---

## 3. Diff table — our construction vs the expected

| # | Field | Ours | Expected (OpenID4VP 1.0 DC API) | Verdict | Risk if wrong |
|---|---|---|---|---|---|
| 1 | `SessionTranscript` outer | `[null, null, Handover]` | `[null, null, Handover]` | **MATCH** | — |
| 2 | Handover tuple | `["OpenID4VPDCAPIHandover", hash]` | `["OpenID4VPDCAPIHandover", hash]` | **LIKELY-MATCH** | wrong label/shape ⇒ total transcript mismatch |
| 3 | **HandoverInfo elements** | `[origin, nonce, jwk_thumbprint]` (3) — **fixed in `86da8d1`** | `[origin, nonce, jwk_thumbprint]` (DRAFT_29) | **CONFIRMED ON DEVICE** | ruled out on device: DRAFT_24's `[origin, clientId, nonce]` does not verify |
| 4 | `jwk_thumbprint` value | RFC-7638 SHA-256 of `encJwk`, **raw bstr** (Fix A″ applied) | RFC-7638 SHA-256, raw bstr | **CONFIRMED ON DEVICE** | was the real mismatch: we shipped a base64url tstr and the phone refused every signature |
| 5 | `origin` string | `` `${proto}://${host}` `` from `Host` header | canonical browser Web Origin | **UNKNOWN** | port/case/`x-forwarded` drift ⇒ different bytes |
| 6 | `nonce` string | our request `nonce`, verbatim | request `nonce`, verbatim | **MATCH** | — (the wallet echoes the request nonce) |
| 7 | HandoverInfoHash alg | SHA-256 | SHA-256 (fixed) | **MATCH** | — |
| 8 | CBOR determinism | canonical (cbor-x flags) | deterministic (ISO 18013-5 §9.1.1) | **LIKELY-MATCH** | non-minimal encoding ⇒ different bytes |
| 9 | `DeviceAuthentication` | `["DeviceAuthentication", ST, docType, DeviceNameSpacesBytes]` | ISO 18013-5 §9.1.3 (identical) | **MATCH** | — |
| 10 | `DeviceNameSpacesBytes` | echoed verbatim from the presentation | the wallet's own | **MATCH (by construction)** | — |
| 11 | `Sig_structure` ext_aad | empty bstr `h''` | empty (ISO detached) | **MATCH** | — |
| 12 | COSE protected header / alg | the wallet's own bytes | the wallet's own | **MATCH (by construction)** | — |
| 13 | Device key source | MSO `deviceKeyInfo.deviceKey` | MSO `deviceKeyInfo.deviceKey` | **MATCH** | (anchor unverified — by design, #14) |

The #1 predicted mismatch (rows 3–4) is now **fixed in code** (`86da8d1`); everything the device
signs *except the session transcript* either matches the ISO structure or is echoed from the
wallet's own presentation. **The residual on-device risk is now the draft/encoding skew (rows 3–4,
Fixes A′/A″) and the origin canonicalization (row 5).**

---

## 4. On-device test runbook

### 4.1 Prerequisites

- A deployed **HTTPS** dev twin (e.g. `credentagent-demo-dev`) whose origin the phone can
  reach. OpenID4VP is origin-bound (invariant 6): it must be `https://` and the reader
  certificate's SAN must cover the host (`readerIdentity`, or the per-request self-signed
  default whose SAN = the request host).
- The Multipaz wallet on the Pixel with **`payment.mpzpass` imported** (registers the
  `org.multipaz.payment.sca.1` credential the request asks for — research.md §2.6: an
  unregistered type is hard-rejected, but this is a *credential*, not a `transaction_data`
  type, so it just needs to be present to be presentable).
- `INTENT_DEBUG_TRANSCRIPT=1` set on the dev-twin server process (logs the transcript bytes
  the gate hashes — see §5).

### 4.2 Happy path

1. Create a device grant against the dev twin:
   `credentagent.grants.create({ merchant, budget, perSpend, allow, signing: "device" })`.
2. Open `grant.approveUrl` on the Pixel → the **signing page** (`page.ts`), which shows the
   bounds (the human reads them **here** — research.md §6.1: Multipaz's consent screen shows
   only the type name "Payment", never the amount).
3. Tap **"Sign with your wallet"** → `navigator.credentials.get({ digital })` opens Multipaz;
   it shows "• Payment" and the credential picker.
4. Approve on the phone → the page POSTs the result to `/credentagent/grants/:id/sign/verify`.
5. **SUCCESS:** the response is `{ ok: true, trustLevel: "device-signed", verifiedBy: "gate" }`
   and `grants.retrieve(id).status === "authorized"`. The page shows "device-signed".

### 4.3 Failure signatures → the fix

| `/sign/verify` reason | Meaning | First fix to try |
|---|---|---|
| `device signature does not verify` | a transcript mismatch. **Fix A″ (thumbprint as raw bstr) was the real one and is now applied** — a fresh occurrence is something new | Don't guess through the fixes: capture the wallet's DeviceResponse (`INTENT_DEBUG_DEVICE_RESPONSE=<path>`) and solve the shape offline against the real signature (§5.1). |
| `no device key in MSO` / `unparseable DeviceResponse` | the presented credential's MSO shape differs from what `parseDeviceResponse` expects | capture the raw DeviceResponse (§5) and compare the issuerAuth/MSO CBOR; adjust `unwrap24`/`coseKeyToJwk` if the nesting differs |
| `wrong credential: expected org.multipaz.payment.sca.1` | the wallet presented a different doctype | check the imported `payment.mpzpass` doctype vs the DCQL (`intent-sign/dcql.ts`, which reuses `dc-payment/dcql.ts`) — re-derive the fixture's doctype with `python3 tools/demo-pki/mint/inspect_mpzpass.py tools/demo-pki/out/payment.mpzpass` |
| `payment credential did not disclose payment_instrument_id` | no `payment_instrument_id` element disclosed (or a different element id) | check the credential's namespace/element ids against the fixture (`inspect_mpzpass.py`, above); adjust the requested claim leaf |
| no wallet picker / the wallet rejects the **request** | reader-cert/origin binding, or an https/SAN problem | verify the dev-twin is https and the reader-cert SAN covers the host; the request is already conservative (standard members only) so this is almost always cert/origin |
| `bounds mismatch` / `nonce derivation mismatch` | server-side only — the grant record changed, or a stale reader context | not an interop issue; a clean create→sign flow won't hit it |

### 4.4 The exact one-line-ish fixes (do NOT apply pre-emptively — apply on failure, on-device)

The #1 suspect — **Fix A: add the response-key JWK thumbprint to the HandoverInfo** — is
**already applied** in commit `86da8d1` (thumbprint computation hardened to jose's
`calculateJwkThumbprint` in the follow-up, §1.2): `buildIntentSessionTranscript` hashes
`[origin, nonce, jwkThumbprint]`, `verify.ts` computes the thumbprint from the sealed
`ecdhPrivateJwk` and `simulate.ts` from the request `encJwk`. So the on-device loop starts at the
fallbacks below.

**Fix A′ — DRAFT_24 handover shape (row 3).** If the wallet build is on the older OpenID4VP
draft, its HandoverInfo is `[origin, clientId, nonce]` (not `[origin, nonce, jwkThumbprint]`).
One-line switch in `intentHandoverInfo` (`deviceAuth.ts`): change `cbor([origin, nonce,
jwkThumbprint])` to `cbor([origin, clientId, nonce])`, where `clientId` is
`x509_san_dns:${rpID}` (the request's `client_id`); thread `clientId` through the two call sites.
(Prefer probing the wallet's OpenID4VP version first — DRAFT_29 is the current shape.)

**Fix A″ — thumbprint encoding (row 4). ✅ THIS WAS THE BUG — APPLIED.** We carried the
thumbprint as a base64url **string**; Multipaz uses the raw 32-byte digest as a **bstr**. Same
digest, different CBOR major type — which is why every in-process test passed and every real
signature was refused. `intentHandoverInfo` now encodes `Buffer.from(jwkThumbprint, "base64url")`.
Pinned by `deviceAuth.test.ts`, which asserts the CBOR type of the element.

**Fix B — canonicalize the origin (row 5).** Ensure the `origin` string equals the browser's
Web Origin exactly: lowercase scheme+host, drop default ports, no path/slash. If the dev-twin
sits behind a proxy, confirm `deriveOrigin` reads `x-forwarded-host`/`x-forwarded-proto`
correctly (it does — `origin.ts:21–22`) and that the value has no port when it shouldn't.

**Fix C — the handover label/shape (row 2).** If the above don't fix it, the Multipaz build may
use a different handover identifier or the `response_uri`-style `OID4VPHandover`
(`[clientIdHash, responseUriHash, nonce]`). Read Multipaz's DC-API presentment/handover
builder (`OpenID4VP.kt`, ~lines 657–681) and match `buildIntentSessionTranscript` to it
byte-for-byte.

Each fix is a redeploy-and-retry with the debug log (§5) confirming the gate side changed.
Whichever fix lands, keep the simulated wallet (`simulate.ts`) in lockstep so the in-process
suite stays green.

---

## 5. The debug hook (shipped, off by default)

`buildIntentSessionTranscript` (`deviceAuth.ts`) logs the handover inputs + bytes when
`INTENT_DEBUG_TRANSCRIPT` is set:

```
[intent-sign transcript] origin="https://…" nonce="…" thumbprint=<hex> handoverInfo=<hex> transcript=<hex>
```

It fires twice in an in-process run (the simulated wallet build + the verify build — they must
be identical) and once per verify on-device. It is **pure observability**: it does not change
the returned bytes or the verification outcome, and it is off unless the env var is set — so
it never touches the security surface. Use it on-device to capture the exact bytes the gate
hashes, then compare against the OpenID4VP 1.0 construction in §2 to see which field diverged.

To also see what the *wallet* sent, set `INTENT_DEBUG_DEVICE_RESPONSE=<path>`: `verify.ts`
dumps the decrypted DeviceResponse plus the origin / nonce / thumbprint it used. Same fence as
the transcript hook — env-gated, pure observability, no effect on the verification outcome.

### 5.1 Solve the transcript offline (do this instead of guessing)

The transcript is **not** on the wire (it is the external signed content), so you cannot read
it off the DeviceResponse. But you do not need to: the wallet's signature is itself the oracle.
With a captured DeviceResponse, enumerate the candidate handover shapes locally, rebuild
`DeviceAuthentication` for each, and check which one the real signature verifies against. The
shape that verifies IS the wallet's shape.

This is how Fix A″ was found: 22 candidates (draft shapes × thumbprint encodings × handover
labels × origin variants), exactly one match, **one** phone round-trip instead of four
redeploy-and-retry cycles. Prefer it over applying the fixes below speculatively.

---

## 6. Predicted mismatches, ranked

0. **~~Missing `jwk_thumbprint` in the HandoverInfo~~ — RESOLVED IN CODE (`86da8d1`), confirm on
   device.** This was the #1 predicted mismatch and the adversarial review's finding 1: our
   encrypted (`dc_api.jwt`) response requires the DRAFT_29 HandoverInfo
   `[origin, nonce, jwk_thumbprint]`, and we now build exactly that (§1.2). Fixed in code; the
   phone round-trip has not yet confirmed it.

The **residual** on-device risks, ranked:

1. **Origin string canonicalization (MEDIUM).** The wallet uses the browser's canonical Web
   Origin; we build the origin from the `Host` header. A port, a casing difference, or a
   proxy header drift changes the bytes. **Fix B.**
2. **~~Draft / encoding skew of the thumbprint element~~ — RESOLVED ON DEVICE (2026-08-24).**
   This was the actual failure: the element was present and correctly positioned, but encoded as a
   base64url tstr where Multipaz uses a raw bstr. Fixed (Fix A″) and pinned by `deviceAuth.test.ts`.
   The draft-shape half is also ruled out — DRAFT_24 uses
   `[origin, clientId, nonce]` instead of the DRAFT_29 shape we ship, and a wallet might encode
   the thumbprint as a base64url string rather than a raw bstr. **Fix A′ / A″.**
3. **Handover label / shape churn (MEDIUM-LOW).** We believe Multipaz uses the
   `"OpenID4VPDCAPIHandover"` DC-API handover, but the FR-7 research did not read the transcript
   builder, and OpenID4VP drafts have used other shapes. **Fix C** (confirm against
   `OpenID4VP.kt` ~657–681).

Everything else the device signs is either ISO-standard or echoed from the wallet's own
presentation, so it matches by construction — the transcript is the whole ballgame.
