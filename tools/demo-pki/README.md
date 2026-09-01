# Demo PKI + credential fixtures

The operator runbook for the CredentAgent demo trust root and credential set.
It produces credentials the **real Multipaz Wallet trusts** — no red
"untrusted issuer / unknown verifier" warnings — while the issuer is down, using
a stable, reusable PKI you control. This is the concrete
`presence-only-demo → issuer-verified (demo PKI)` step (epic #48).

> **Trust level stays `presence-only-demo`.** The wire crypto is real, but the
> IACA is self-generated — "trusted" here means "matches a list you imported,"
> not a real ecosystem anchor. Never present a passing gate as a real safety or
> payment control.

## What's here

| Path | What |
|------|------|
| `gen-pki.sh`, `openssl.cnf` | Generate the ISO 18013-5 PKI (issuer + reader + trust-list signer) |
| `keys/` | **Private keys** — gitignored, chmod 700, never leave this machine |
| `certs/` | Public certs (committed) |
| `mint/` | `inspect_mpzpass.py` + pointer; the mint/trust **generators live in Multipaz** (see [`mint/README.md`](mint/README.md)) |
| `cardart/` | `make_cards.py` — the card images embedded at mint |
| `out/` | Built deliverables: the `.mpzpass` set + `utopia.vical` / `utopia.rical` |
| `site/` | The Vercel download page (`build_site.py`) — see step 4 |

## ⚠️ Pipeline order — do not shuffle

```
gen-pki.sh → mint (.mpzpass) → build VICAL/RICAL → build + deploy site → wire the gate → import on phone
```

The **wire the gate** step (copy `reader-key.pem` + `reader-cert.pem` into the
verifier — step 5) depends only on `gen-pki.sh`, so it can happen any time after
step 1; it's placed before the phone import because a ceremony needs *both* the
gate presenting the reader **and** the wallet trusting the RICAL.

**Re-running `gen-pki.sh` mints brand-new random keys**, which orphans every
already-built `.mpzpass` and the VICAL/RICAL (they were signed by the previous
keys), changes the reader key/cert the gate presents, and invalidates anything
already imported on a phone. So treat step 1 as **generate-once**. If you *do*
re-run it (e.g. to change the reader SAN, below), you must re-run **every** later
step: re-mint → rebuild trust lists → redeploy → **re-copy the reader key/cert to
the gate** → re-import on the phone.

---

## 0. Prereqs

- **OpenSSL 3.2+** — the `-not_before`/`-not_after` flags on `req`/`x509` landed in 3.2, and
  LibreSSL (the macOS system `openssl`) lacks the ISO EKU OID + `issuerAltName=URI:` syntax.
  `brew install openssl@3`. `gen-pki.sh` defaults to `/opt/homebrew/opt/openssl@3/bin/openssl`
  and **checks the version** (fails fast with a clear message on LibreSSL or < 3.2); override
  with `OPENSSL=…`. Runs on both macOS (`date -v`) and Linux (`date -d`) — auto-detected.
- For minting: the Multipaz repo checked out locally (the jvmTests compile against
  the `multipaz` module) — see [`mint/README.md`](mint/README.md).
- Python 3 (stdlib only) for `cardart/make_cards.py` and `site/build_site.py`. The
  site build also copies a QR encoder from `site/node_modules/`, so run `npm install`
  in `site/` once first — it's a site-local devDependency (`qrcode-generator`), NOT a
  dependency of the published `@openmobilehub/credentagent-*` packages.

## 1. Generate the PKI — `gen-pki.sh`

```bash
./gen-pki.sh
```

Writes the five keypairs to `keys/` (private) and `certs/` (public): IACA root +
Document Signer (issuer), reader root + reader leaf (verifier), and the trust-list
signer. Both issued chains are verified at the end.

### Choose the reader SAN (`READER_DNS`) — the one decision that matters here

The reader leaf's `subjectAltName` lists the hostname(s) the **gate** is served
from. At ceremony time the wallet checks that the request's origin matches one of
these SAN entries (anti-phishing origin binding) — so the SAN must name wherever
the gate actually runs. `READER_DNS` is a **space- or comma-separated list**;
`gen-pki.sh` bakes them all into one cert, so a single reader identity can serve
multiple origins.

```bash
# default — covers local testing + the placeholder host:
./gen-pki.sh                                   # READER_DNS="localhost credentagent-demo.example"

# add your hosted gate's STABLE host (custom domain preferred over a Vercel auto-alias):
READER_DNS="localhost gate.credentagent.dev" ./gen-pki.sh
```

- **`localhost` unblocks local testing today** — the gate at `localhost:3007`
  reached from the phone via `adb reverse` (localhost is a secure context, so the
  Digital Credentials API works over plain http). You do **not** need a hosted
  hostname to start.
- **You only need a hosted host in advance to avoid a re-mint.** Adding a host
  later means regenerate → re-mint → rebuild lists → re-import (the ordering
  warning above). So if you already know the gate's stable domain, list it now.
- This is the **gate's** host — *not* the credential-download site's host. Don't
  put the download-site URL in the reader SAN.

`BASE_URL` (IssuerAltName / CRL URIs) is cosmetic for the demo — those URIs need
not resolve — leave it at the default unless you have a reason to change it (and
note that changing it also forces a re-mint).

## 2. Mint the credential set

Produces the four `.mpzpass` into `out/`, signed by this PKI's Document Signer.
The generators live **in Multipaz** ([`openmobilehub/multipaz`](https://github.com/openmobilehub/multipaz),
branch `credentagent/demo-mpzpass-fixtures`, until merged) — they compile against the
`multipaz` module and read this PKI via the `DEMO_PKI` env var (no copying, no
hardcoded path). Full detail in [`mint/README.md`](mint/README.md). In short:

```bash
cd ~/tools/git/multipaz          # on the credentagent/demo-mpzpass-fixtures branch
DEMO_PKI=/path/to/credentagent/tools/demo-pki ./gradlew :multipaz:jvmTest \
  --tests "org.multipaz.mpzpass.DemoCredentialMintTest" --rerun-tasks --no-daemon
```

`--no-daemon` ensures the forked test JVM inherits `DEMO_PKI` (a reused daemon may
carry a stale environment).

## 3. Build the trust lists (VICAL + RICAL)

The sibling generator wraps the IACA in a signed **VICAL** and the reader cert in a
signed **RICAL**, both signed by the trust-list signer, into `out/utopia.vical` /
`out/utopia.rical`:

```bash
DEMO_PKI=/path/to/credentagent/tools/demo-pki ./gradlew :multipaz:jvmTest \
  --tests "org.multipaz.mpzpass.DemoTrustListTest" --rerun-tasks --no-daemon
```

## 4. Build + deploy the download site

`build_site.py` stages the `out/` artifacts into `site/credentials/` +
`site/trust/`, the raw `certs/` PEMs into `site/certs/`, and vendors the QR
encoder into `site/vendor/` (all gitignored build outputs), then renders
`index.html`, and `vercel` deploys. Each trust list and credential gets a
scannable QR plus a download link; the QRs are rendered **client-side** from the
page's own origin, so `index.html` is deployment-agnostic (no origin baked in —
deploy the same build to any host). The `vercel.json` sets
`Content-Type: application/vnd.multipaz.mpzpass` on the credentials,
`application/cbor` on the trust lists, and `application/x-pem-file` on the raw
certs, so the phone offers "Open with Multipaz Wallet".

```bash
cd site
npm install                                    # once — the site-local QR encoder devDependency
python3 build_site.py                          # re-run before every deploy (staging is gitignored)
vercel deploy --prod --yes --scope <your-scope>
```

Verify the live headers after deploy:

```bash
curl -sD - -o /dev/null https://<host>/credentials/mdl.mpzpass | grep -i content-type
# → content-type: application/vnd.multipaz.mpzpass
```

## 5. Wire the verifier (gate) — present the reader identity

Three files, two destinations. All three are needed; any one alone does nothing.

| File (from step 1 / step 3) | Goes to | Role |
|------|---------|------|
| `certs/reader-cert.pem` | the gate | what it **presents** (rides in `x5c` / `x5chain`) |
| `keys/reader-key.pem` | the gate | what it **signs** with |
| `out/utopia.rical` | the wallet | the list the wallet checks the cert against |

Never put the RICAL on the gate — it never reads one. Never put any other key there:
`ds-key` / `iaca-key` mint credentials, `list-signer-key` forges trust lists.

**Gate:**

```js
new CredentAgent({
  walletOrigin: "http://localhost:3007",
  readerIdentity: {
    key: readFileSync("reader-key.pem", "utf8"),
    cert: readFileSync("reader-cert.pem", "utf8"),
  },
});
```

On a hosted deployment, pass the file contents as environment variables. Omit
`readerIdentity` and the gate self-signs per request — the ceremony still completes, the
wallet just shows the verifier as unknown.

**Wallet:** Multipaz → Settings → Trust manager → add entry → import the RICAL. Remove any
previously imported RICAL first.

> A RICAL is only as good as the key behind it: it names a reader, and some gate has to
> sign as that reader. A list whose reader key nobody holds cannot clear the warning —
> which is why the RICAL and the reader key must be built and distributed together.

The gate's serving origin must match a name in the reader cert's SAN (`READER_DNS`,
step 1). Change it and you must rebuild the RICAL (step 3) and re-import it. On Vercel the
gate's `walletOrigin` is `https://${VERCEL_PROJECT_PRODUCTION_URL}`, and this repo's
shipped cert covers only `credentagent-demo.vercel.app` + `localhost`. Deploy under a
**custom production domain** and that host isn't on the SAN, so the "unknown verifier"
warning never clears — yet a SAN mismatch only logs a `console.warn` at boot (it does
**not** fail the gate), so check the startup log if a deploy you expected to fix it
doesn't. **Preview** URLs are a separate trap: `VERCEL_PROJECT_PRODUCTION_URL` stays the
*production* host, so a ceremony opened on a preview deployment is bound to the wrong
origin and won't clear either — and this one logs nothing.

**Check it without a phone** — first `./gen-pki.sh` (mints the reader **private** key,
which is gitignored) and build the gate (`cd packages/credentagent-gate && npm run build`,
which produces the un-committed `dist/`), then run
`node tools/demo-pki/verify-reader-trust.mjs`. It proves the cert rides in `x5c`, the
signature verifies under it, the origin matches, and the RICAL names that cert. A bare
clone can't run it — both inputs are absent by design.

## 6. Import trust + credentials on the phone

Open the deployed site on the phone → import the **VICAL + RICAL first** (so cards
land already-trusted) → then open each **`.mpzpass`**. Then run a ceremony and
confirm **no red trust warning**. Detailed device steps + the adb fallback live in
the guide: [`docs/guides/testing-on-device.md`](../../docs/guides/testing-on-device.md)
— including why the verifier warning survives a fresh clone.

**Done when:** a ceremony (e.g. the `age_over_65` senior-discount flow) completes
against the gate with no red issuer *or* verifier warning.
