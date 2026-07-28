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

`deviceAuth.ts:105–124`, `buildIntentSessionTranscript(origin, nonce)`:

```
HandoverInfo            = CBOR([ origin (tstr), nonce (tstr) ])
HandoverInfoHash        = SHA-256( HandoverInfo )                      # raw 32-byte digest
SessionTranscript       = CBOR([ null, null,
                                 [ "OpenID4VPDCAPIHandover", HandoverInfoHash (bstr) ] ])
```

- `origin` = `Origin.origin` from `deriveOrigin` (`ceremony/origin.ts:20–25`) —
  `` `${proto}://${host}` `` built from the request's `Host` (or `x-forwarded-host`) header.
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
OpenID4VPDCAPIHandoverInfo = [ origin, nonce, jwk_thumbprint ]        # THREE elements
OpenID4VPDCAPIHandoverInfoHash = SHA-256( CBOR( OpenID4VPDCAPIHandoverInfo ) )
```

where (OpenID4VP 1.0 Appendix B + RFC 7638):

- `origin` — the **Web Origin** of the request as the browser reports it to the wallet via
  the DC API (canonical: lowercase scheme + host, default ports 443/80 omitted, no path,
  no trailing slash), e.g. `https://credentagent-demo-dev.vercel.app`.
- `nonce` — the request's `nonce` string, verbatim.
- `jwk_thumbprint` — when the response is **encrypted**, the **RFC 7638 SHA-256 JWK
  thumbprint** (raw 32-byte bstr) of the verifier's response-encryption public key (the JWK
  the request advertises in `client_metadata.jwks` — our `encJwk`). When the response is
  **unencrypted**, this element is `null`.

**UNVERIFIED — confirm on device / against Multipaz source.** The exact handover *label*
string and element layout have churned across OpenID4VP drafts, and ISO 18013-7:2025
presentment landed in Multipaz 0.98.0 (research.md §2). Our FR-7 research did not read
Multipaz's transcript/handover builder (`OpenID4VP.kt` / the DC-API presentment path). Treat
the structure above as the **spec's** definition and confirm Multipaz emits exactly it —
especially the `jwk_thumbprint` element and the literal `"OpenID4VPDCAPIHandover"` label.

---

## 3. Diff table — our construction vs the expected

| # | Field | Ours | Expected (OpenID4VP 1.0 DC API) | Verdict | Risk if wrong |
|---|---|---|---|---|---|
| 1 | `SessionTranscript` outer | `[null, null, Handover]` | `[null, null, Handover]` | **MATCH** | — |
| 2 | Handover tuple | `["OpenID4VPDCAPIHandover", hash]` | `["OpenID4VPDCAPIHandover", hash]` | **LIKELY-MATCH** | wrong label/shape ⇒ total transcript mismatch |
| 3 | **HandoverInfo elements** | `[origin, nonce]` (2) | `[origin, nonce, jwk_thumbprint]` (3) | **LIKELY-MISMATCH** | **the #1 suspect** — different array ⇒ different hash ⇒ signature fails |
| 4 | `jwk_thumbprint` | absent | SHA-256 thumbprint of `encJwk` (encrypted response) | **LIKELY-MISMATCH** | as #3 |
| 5 | `origin` string | `` `${proto}://${host}` `` from `Host` header | canonical browser Web Origin | **UNKNOWN** | port/case/`x-forwarded` drift ⇒ different bytes |
| 6 | `nonce` string | our request `nonce`, verbatim | request `nonce`, verbatim | **MATCH** | — (the wallet echoes the request nonce) |
| 7 | HandoverInfoHash alg | SHA-256 | SHA-256 (fixed) | **MATCH** | — |
| 8 | CBOR determinism | canonical (cbor-x flags) | deterministic (ISO 18013-5 §9.1.1) | **LIKELY-MATCH** | non-minimal encoding ⇒ different bytes |
| 9 | `DeviceAuthentication` | `["DeviceAuthentication", ST, docType, DeviceNameSpacesBytes]` | ISO 18013-5 §9.1.3 (identical) | **MATCH** | — |
| 10 | `DeviceNameSpacesBytes` | echoed verbatim from the presentation | the wallet's own | **MATCH (by construction)** | — |
| 11 | `Sig_structure` ext_aad | empty bstr `h''` | empty (ISO detached) | **MATCH** | — |
| 12 | COSE protected header / alg | the wallet's own bytes | the wallet's own | **MATCH (by construction)** | — |
| 13 | Device key source | MSO `deviceKeyInfo.deviceKey` | MSO `deviceKeyInfo.deviceKey` | **MATCH** | (anchor unverified — by design, #14) |

Everything the device signs *except the session transcript* either matches the ISO structure
or is echoed from the wallet's own presentation. **The entire interop risk collapses onto the
transcript (rows 2–8), and within that onto the HandoverInfo (rows 3–5).**

---

## 4. On-device test runbook

### 4.1 Prerequisites

- A deployed **HTTPS** dev twin (e.g. `credentagent-demo-dev`) whose origin the phone can
  reach. OpenID4VP is origin-bound (invariant 6): it must be `https://` and the reader
  certificate's SAN must cover the host (`readerIdentity`, or the per-request self-signed
  default whose SAN = the request host).
- The Multipaz wallet on the Pixel with **`payment.mpzpass` imported** (registers the
  `org.openwallet.payment.1` credential the request asks for — research.md §2.6: an
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
| `device signature does not verify` | **the transcript mismatch** (the expected failure) | Apply **Fix A** (add `jwk_thumbprint`), redeploy, retry. Then **Fix B** (origin), then **Fix C** (label). |
| `no device key in MSO` / `unparseable DeviceResponse` | the presented credential's MSO shape differs from what `parseDeviceResponse` expects | capture the raw DeviceResponse (§5) and compare the issuerAuth/MSO CBOR; adjust `unwrap24`/`coseKeyToJwk` if the nesting differs |
| `wrong credential: expected org.openwallet.payment.1` | the wallet presented a different doctype | check the imported `payment.mpzpass` doctype vs the DCQL (`dcql.ts` / `payment.in`) |
| `payment credential did not disclose an account` | no `account` element disclosed (or a different element id) | check the credential's namespace/element ids; adjust the requested claim leaf |
| no wallet picker / the wallet rejects the **request** | reader-cert/origin binding, or an https/SAN problem | verify the dev-twin is https and the reader-cert SAN covers the host; the request is already conservative (standard members only) so this is almost always cert/origin |
| `bounds mismatch` / `nonce derivation mismatch` | server-side only — the grant record changed, or a stale reader context | not an interop issue; a clean create→sign flow won't hit it |

### 4.4 The exact one-line-ish fixes (do NOT apply pre-emptively — apply on failure, on-device)

**Fix A — add the response-key JWK thumbprint to the HandoverInfo (row 3/4; the #1 suspect).**
This is the interop-correct construction for an encrypted DC API response. It touches three
spots so both sides and the wallet agree:

1. In `request.ts`, compute `jwkThumbprint = SHA-256(RFC7638-canonical(encJwk))` (raw bytes)
   and seal it in the reader context alongside the nonce.
2. In `deviceAuth.ts`, change `buildIntentSessionTranscript(origin, nonce, jwkThumbprint?)`
   to hash `CBOR([origin, nonce, jwkThumbprint ?? null])`.
3. In `verify.ts`, pass the sealed thumbprint through; in `simulate.ts`, compute the same
   thumbprint from `encJwk` so the in-process tests stay green.

The RFC 7638 thumbprint for an EC key is `SHA-256` of
`{"crv":"P-256","kty":"EC","x":"<b64url>","y":"<b64url>"}` (members sorted, no whitespace).

**Fix B — canonicalize the origin (row 5).** Ensure the `origin` string equals the browser's
Web Origin exactly: lowercase scheme+host, drop default ports, no path/slash. If the dev-twin
sits behind a proxy, confirm `deriveOrigin` reads `x-forwarded-host`/`x-forwarded-proto`
correctly (it does — `origin.ts:21–22`) and that the value has no port when it shouldn't.

**Fix C — the handover label/shape (row 2).** If A+B don't fix it, the Multipaz build may use
a different handover identifier or the `response_uri`-style `OID4VPHandover`
(`[clientIdHash, responseUriHash, nonce]`). Read Multipaz's DC-API presentment/handover
builder (`OpenID4VP.kt`) and match `buildIntentSessionTranscript` to it byte-for-byte.

Each fix is a redeploy-and-retry with the debug log confirming the gate side changed.

---

## 5. The debug hook (shipped, off by default)

`buildIntentSessionTranscript` (`deviceAuth.ts`) logs the handover inputs + bytes when
`INTENT_DEBUG_TRANSCRIPT` is set:

```
[intent-sign transcript] origin="https://…" nonce="…" handoverInfo=<hex> transcript=<hex>
```

It fires twice in an in-process run (the simulated wallet build + the verify build — they must
be identical) and once per verify on-device. It is **pure observability**: it does not change
the returned bytes or the verification outcome, and it is off unless the env var is set — so
it never touches the security surface. Use it on-device to capture the exact bytes the gate
hashes, then compare against the OpenID4VP 1.0 construction in §2 (add the `jwk_thumbprint`
mentally / with Fix A) to see which field diverged.

To also see what the *wallet* sent, temporarily log the decrypted `vp_token` DeviceResponse
in `verify.ts` and decode it (`cbor-x`) — note the transcript itself is **not** in the
DeviceResponse (it is the external signed content), so the transcript diff is inferred from
the spec + the debug log, not read off the wire.

---

## 6. Predicted mismatches, ranked

1. **Missing `jwk_thumbprint` in the HandoverInfo (HIGH).** Our response is encrypted
   (`dc_api.jwt`), so OpenID4VP 1.0 requires the HandoverInfo to be
   `[origin, nonce, jwk_thumbprint]`; we hash `[origin, nonce]`. Different array ⇒ different
   hash ⇒ different transcript ⇒ `device signature does not verify`. **Fix A.**
2. **Origin string canonicalization (MEDIUM).** The wallet uses the browser's canonical Web
   Origin; we build the origin from the `Host` header. A port, a casing difference, or a
   proxy header drift changes the bytes. **Fix B.**
3. **Handover label / shape churn (MEDIUM-LOW).** We believe Multipaz uses the
   `"OpenID4VPDCAPIHandover"` DC-API handover, but the FR-7 research did not confirm the
   transcript builder, and OpenID4VP drafts have used other shapes. **Fix C** (confirm
   against `OpenID4VP.kt`).

Everything else the device signs is either ISO-standard or echoed from the wallet's own
presentation, so it matches by construction — the transcript is the whole ballgame.
