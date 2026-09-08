# Minting the demo credential set

The two Kotlin generators that produce the demo `.mpzpass` set and the trust lists —
`DemoCredentialMintTest` and `DemoTrustListTest` — live **canonically in Multipaz**
(they must compile against the `multipaz` module): [`openmobilehub/multipaz`](https://github.com/openmobilehub/multipaz),
branch **`credentagent/demo-mpzpass-fixtures`** (until merged to that fork's `main`), at
`multipaz/src/jvmTest/kotlin/org/multipaz/mpzpass/`. This directory keeps only the
verifier (`inspect_mpzpass.py`) and this pointer — there is no `.kt` copy to keep in sync.

Each credential is **signed by the OpenSSL demo Document Signer** produced by
`../gen-pki.sh` (not a fresh self-signed key), so it chains to the demo IACA.

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

The generators read this PKI directory via the **`DEMO_PKI` env var** (no hardcoded
path) and **skip** when it is unset (so they are green in Multipaz CI). From a Multipaz
checkout on the fixtures branch:

1. Run `../gen-pki.sh` first (writes `../keys/*` + `../certs/*`).
2. **Mint the credentials** — point `DEMO_PKI` at this dir (the parent of `mint/`):
   ```bash
   cd ~/tools/git/multipaz
   DEMO_PKI=/path/to/credentagent/tools/demo-pki ./gradlew :multipaz:jvmTest \
     --tests "org.multipaz.mpzpass.DemoCredentialMintTest" --rerun-tasks --no-daemon
   ```
3. **Build the trust lists** (VICAL + RICAL) — same PKI, **after** mint:
   ```bash
   DEMO_PKI=/path/to/credentagent/tools/demo-pki ./gradlew :multipaz:jvmTest \
     --tests "org.multipaz.mpzpass.DemoTrustListTest" --rerun-tasks --no-daemon
   ```

`--no-daemon` ensures the forked test JVM inherits `DEMO_PKI` (a reused gradle daemon
may carry a stale environment). `DemoTrustListTest` wraps the **same IACA** that signed
the credentials, so run it after mint and do **not** re-run `gen-pki.sh` in between
(that mints new keys and orphans the lists).

## Verifying the output

`inspect_mpzpass.py` decompresses a `.mpzpass` (top level is
`["MpzPass", raw-deflate(cbor)]`) and prints the disclosed claims and the DS/IACA
certificate subjects:

```bash
python3 inspect_mpzpass.py ../out/mdl.mpzpass
```

Every credential's `x5chain` should show `Utopia Demo Document Signer` chaining to
`Utopia Demo IACA`.

**Unverified:** these `.mpzpass` files have NOT been imported into a real wallet —
that is the device step (#51).

## The SD-JWT payment credential (`mint-dpc-sdjwt.mjs`)

Everything above mints **ISO mdoc** credentials. `mint-dpc-sdjwt.mjs` mints the payment
credential in the **other** format — an SD-JWT VC (`dc+sd-jwt`) — because AP2's delegation
mechanism is specified for SD-JWT only. Its chain serialization is SD-JWT syntax, and mdoc
has no equivalent, so adopting AP2 with an mdoc credential would mean writing the missing
half of the specification ourselves. See `specs/014-ap2-delegated-intent/spec.md`, FR-1.

This one is plain Node — no Multipaz checkout, no gradle:

```bash
node mint-dpc-sdjwt.mjs                          # dev: generates both keys and writes them out
node mint-dpc-sdjwt.mjs --device-key device.jwk  # bind cnf to a real wallet's key
node mint-dpc-sdjwt.mjs --inspect ../out/dpc.sdjwt
```

| flag | meaning |
|------|---------|
| `--issuer-key <file>` | EC P-256 private key (PEM or JWK). Absent ⇒ generated and written out. |
| `--device-key <file>` | EC P-256 **public** JWK for `cnf`. Absent ⇒ a holder pair is generated. |
| `--holder <name>` | cardholder name on the credential |
| `--out <dir>` | output directory (default `../out`) |

`gen-pki.sh` deliberately keeps the demo Document Signer's private key out of the
repository, so there is nothing to default `--issuer-key` to. Absent it, the tool generates
an issuer key and says so — it does not quietly mint under a key you did not choose.

**Claims.** The same six the mdoc DPC carries (`issuer_name`, `payment_instrument_id`,
`masked_account_reference`, `holder_name`, `issue_date`, `expiry_date`), each separately
disclosable, so one DCQL shape serves both formats. `vct` is `com.emvco.dpc` — the value
AP2's own example uses.

**Is it fit for purpose?** `mint-dpc-sdjwt.test.mjs` pins the one job spec 014 needs it for:
the holder can present it with key binding carrying AP2's `_delegate_payload`, only the
requested claims are disclosed, and a presentation signed by a key the credential does not
name is refused. That last one is verified load-bearing — deleting the key-binding check
fails it. Run it with the **root** `npm test` (this file is outside both workspaces, #184).

**Unverified:** whether the installed Multipaz app can *provision* an SD-JWT credential as
easily as it imports an mdoc `.mpzpass`. The Multipaz library supports SD-JWT VC
presentation (spec 012 `research.md`); the app's import path has not been checked. That is
the first thing to establish on the device.
