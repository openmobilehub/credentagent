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
