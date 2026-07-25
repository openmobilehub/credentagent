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

1. Start the demo gate (from the `feat/demo-pki` checkout). It's the **real storefront**
   quickstart (`createStorefront` + `mount` + `store.gate`) plus the demo `readerIdentity`
   (`certs/reader-cert.pem`, SAN=`localhost`) and one **seeded order** (`ORD-DEMO`):

   ```bash
   (cd packages/credentagent-gate && npm run build)        # once
   (cd packages/credentagent-storefront && npm run build)  # once
   node tools/demo-pki/run-gate.mjs                         # gate on :3007 (~5s to boot)
   ```
2. Reverse-tunnel the port so the phone sees it as `localhost` (this is why the demo reader
   cert's SAN is `localhost`; `localhost` is also a secure context, so the DC-API works over
   plain `http`):

   ```bash
   adb reverse tcp:3007 tcp:3007
   ```
3. On the phone, open the checkout link and drive the whole flow (age → pay → done):

   ```
   http://localhost:3007/checkout?order=ORD-DEMO
   ```

   It's the real storefront checkout page — it sequences the gates and shows each as it
   completes. (The individual rails are still at `/credentagent/credential?cred=age&order=ORD-DEMO`
   and `/credentagent/dc-payment?order=ORD-DEMO` if you want to hit one directly.)

**Pass criteria:** the picker offers the right card, the order completes, and **no red trust
warnings** appear — issuer (via the imported **VICAL**) *and* verifier (via the imported
**RICAL** matched against the reader identity the gate now presents, #51).

> **The verifier side needs the reader *private key*, which is not committed.** `run-gate.mjs`
> configures `readerIdentity` **only if `keys/reader-key.pem` exists locally** — and that key is
> gitignored, so a **fresh clone does not have it**. Without it the gate falls back to a
> per-request self-signed reader, which cannot match the committed `out/utopia.rical`, so the
> "unknown verifier" warning **persists**. The committed RICAL only matches the *producer's* local
> key. To clear the warning on a fresh clone: run `./gen-pki.sh` (mints a new reader key + cert +
> RICAL), rebuild the trust lists, and **re-import that RICAL** on the phone (same ordering as the
> "re-running gen-pki orphans the RICAL" note above). ([#51](https://github.com/openmobilehub/credentagent/issues/51))

## Troubleshooting

| Symptom | Cause / fix |
| :-- | :-- |
| "Import pass from file" greys the file out | Expected (SAF MIME filter). Use the open-intent (step 2) or a hosted link. Don't fight the button. |
| "Your info wasn't found" at presentation | The requested credential isn't in *this* wallet (wrong device, or not imported). Re-check step 2 on the presenting device. |
| Red "untrusted issuer" warning **when sideloading a card** | The VICAL isn't imported, or the wallet doesn't trust the signer. Import the VICAL (step 1), then re-open the pass. NOTE: this is a *wallet-hold* check at import — the **gate does not verify the issuer yet** (`presence-only-demo`; issuer/device verification is [#14](https://github.com/openmobilehub/credentagent/issues/14)). Removing the VICAL *after* a card is imported does **not** re-flag the held card, and no gate ceremony consults the VICAL today. |
| Red "unknown website / unknown verifier" **even though a RICAL is already imported** | **Stale RICAL** — the device holds an *older* `utopia.rical` (from a prior `gen-pki` run) whose reader cert no longer matches what the gate presents. **Re-import the current `utopia.rical`** (Settings → Trusted verifiers → Import RICAL). Trust shows immediately: presentment reads *"The website requesting this data is trusted"* and names the reader. Note: `verify-reader-trust.mjs` validates the **repo's** `out/utopia.rical` and can't see a stale device copy, so a green tool run + red on-device warning ⇒ suspect the device import first. |
| "Unknown verifier" warning (no RICAL imported) | Import the RICAL (step 1) so the gate's reader identity (#84) matches. |
| DC-API bounces to a Google sign-in | Chrome isn't signed into an account. Sign in, then retry. **Never automate a password field.** |
| Black screenshot / no response over adb | `adb shell input keyevent KEYCODE_WAKEUP`; the screen must be unlocked. |
