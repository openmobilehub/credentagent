# Minting the demo credential set

`DemoCredentialMintTest.kt` mints the four demo credentials as `.mpzpass` files
that a real Multipaz Wallet can hold, each **signed by the OpenSSL demo Document
Signer** produced by `../gen-pki.sh` (not a fresh self-signed key). It
generalizes the reference `ProfessionalLicenseMintTest.kt` recipe.

## What it produces (into `../out/`)

| file | doctype | key claims (match the credentagent-gate DCQL) |
|------|---------|-----------------------------------------------|
| `mdl.mpzpass` | `org.iso.18013.5.1.mDL` | `age_over_18/21/65 = true` (65+ persona), full identity |
| `payment.mpzpass` | `org.multipaz.payment.sca.1` | issuer-signed instrument claims, `expiry_date` 2030 |
| `membership.mpzpass` | `org.multipaz.loyalty.1` | `membership_number`, `tier` |
| `professional-license.mpzpass` | `org.example.license.1` | `license_active = true` |

The amount binding for payment is **not** minted in — it is device-signed live at
ceremony time (`transaction_data_hash`), so a static credential only carries the
issuer-signed instrument claims. That is the correct shape.

## How to run

This test must compile against the `multipaz` module, so it runs from inside the
Multipaz repo, not from this repo:

1. Run `../gen-pki.sh` first (it writes `../keys/ds-key.pem` + `../certs/*`).
2. Copy this file into the Multipaz jvmTest source set:
   ```
   cp DemoCredentialMintTest.kt \
     ~/tools/git/multipaz/multipaz/src/jvmTest/kotlin/org/multipaz/mpzpass/
   ```
3. Run it:
   ```
   cd ~/tools/git/multipaz && ./gradlew :multipaz:jvmTest \
     --tests "org.multipaz.mpzpass.DemoCredentialMintTest" --rerun-tasks
   ```

The absolute paths to this repo's `certs/`, `keys/`, `cardart/`, and `out/` are
hard-coded at the top of the test (`DEMO_PKI`); edit them if the checkout moves.

## Verifying the output

`tools/demo-pki/mint/inspect_mpzpass.py` (or the inline snippet in
`MORNING-BRIEF.md`) decompresses a `.mpzpass` (top level is
`["MpzPass", raw-deflate(cbor)]`) and prints the disclosed claims and the DS/IACA
certificate subjects. Every credential's `x5chain` should show
`Utopia Demo Document Signer` chaining to `Utopia Demo IACA`.

**Unverified:** the `.mpzpass` files have NOT been imported into a real wallet.
That is Diego's device step (#51).
