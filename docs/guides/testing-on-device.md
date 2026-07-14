# Testing on a device

**Goal:** import the demo credentials into a real Multipaz wallet and complete a full
CredentAgent ceremony against your local gate — the real acceptance test.

Prereqs: the Multipaz **wallet** app installed, Chrome signed into a Google account (the
Digital Credentials API needs it), the demo credentials + trust lists from
**[Trusted demo credentials](trusted-demo-credentials.md)**, and a phone on USB with
`adb devices` showing it authorized.

## 1. Import trust first (VICAL + RICAL)

Do this **before** importing credentials, so cards land already-trusted.

- **Hosted:** on the phone, open the demo page and add the **VICAL** (issuer list) and
  **RICAL** (reader list) from section 1. The wallet accepts them because it trusts the
  list signer.
- **Manual:** Wallet → **Settings → Trust manager** → add entry → import the VICAL
  (`TrustEntryVical`) and the RICAL. Prefer the hosted URL if the wallet accepts URL
  entries (updates refresh centrally); else import the downloaded file.

**Check:** the trust manager lists the demo issuer + reader; no "untrusted" state.

## 2. Import the credentials (`.mpzpass`)

- **Hosted (preferred):** open the demo page on the phone, tap a credential's download
  link. Because the server sends `Content-Type: application/vnd.multipaz.mpzpass`, Chrome
  offers **"Open with Multipaz Wallet"** → imported. Repeat per credential.
- **adb fallback (works today):** the in-app "Import pass from file" button greys
  `.mpzpass` out — Android tags the extension as generic (`application/octet-stream`), and
  the file picker filters on the wallet's MIME type. Import via an open-intent instead:

  ```bash
  adb push credential.mpzpass /sdcard/Download/
  # find its MediaStore id
  adb shell "content query --uri content://media/external/file \
    --projection _id --where \"_display_name='credential.mpzpass'\""
  # hand it to the wallet by content-URI (works where file:// and the SAF button don't)
  adb shell am start -n org.multipaz.wallet.android/.MainActivity \
    -a android.intent.action.VIEW -d content://media/external/file/<id> \
    -t application/vnd.multipaz.mpzpass --grant-read-uri-permission
  ```

**Check:** each card appears with its card art (not blank) and no "untrusted issuer"
badge.

## 3. Run a ceremony

1. Start the demo gate (from the `feat/demo-pki` checkout — it has the #51 reader-identity
   wiring and the demo certs). It mounts the gate with the demo `readerIdentity`
   (`certs/reader-cert.pem`, SAN=`localhost`) and one demo order (`ORD-DEMO`):

   ```bash
   (cd packages/credentagent-gate && npm run build)   # once — builds dist/
   node tools/demo-pki/run-gate.mjs                    # gate on :3007, prints the URLs
   ```
2. Reverse-tunnel the port so the phone sees it as `localhost` (this is why the demo reader
   cert's SAN is `localhost`; `localhost` is also a secure context, so the DC-API works over
   plain `http`):

   ```bash
   adb reverse tcp:3007 tcp:3007
   ```
3. On the phone, open one of the URLs the gate printed and drive the ceremony:
   - **Age gate** — `http://localhost:3007/credentagent/credential?cred=age&order=ORD-DEMO` (presents the mDL)
   - **Payment gate** — `http://localhost:3007/credentagent/dc-payment?order=ORD-DEMO` (presents the payment credential)

**Pass criteria:** the picker offers the right card, the order completes, and **no red trust
warnings** appear — issuer (via the imported **VICAL**) *and* verifier (via the imported
**RICAL** matched against the reader identity the gate now presents, #51).

> **The verifier side needs the gate to present the reader identity.** `run-gate.mjs` does
> this (it configures `readerIdentity`), so the "unknown verifier" warning should clear. A
> gate started WITHOUT a configured `readerIdentity` still self-signs per request, and that
> warning would persist ([#51](https://github.com/openmobilehub/credentagent/issues/51)).

## Troubleshooting

| Symptom | Cause / fix |
| :-- | :-- |
| "Import pass from file" greys the file out | Expected (SAF MIME filter). Use the open-intent (step 2) or a hosted link. Don't fight the button. |
| "Your info wasn't found" at presentation | The requested credential isn't in *this* wallet (wrong device, or not imported). Re-check step 2 on the presenting device. |
| Red "untrusted issuer" warning | The VICAL isn't imported, or the wallet doesn't trust the signer. Redo step 1. |
| "Unknown verifier" warning | Expected until #51 (see above). |
| DC-API bounces to a Google sign-in | Chrome isn't signed into an account. Sign in, then retry. **Never automate a password field.** |
| Black screenshot / no response over adb | `adb shell input keyevent KEYCODE_WAKEUP`; the screen must be unlocked. |
