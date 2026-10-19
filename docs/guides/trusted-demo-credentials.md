# Trusted demo credentials

**Goal:** get credentials onto a real phone wallet that it actually *trusts* — so a
CredentAgent gate can be completed on-device without a red "untrusted issuer" warning.

The default trust level is `presence-only-demo`: the wire crypto is real, but nothing
is signed by an issuer the wallet recognizes, so a wallet shows the credential as
untrusted. This guide points the wallet at a small, self-generated **demo PKI** so the
cards land trusted — the concrete `presence-only-demo → issuer-verified (demo PKI)` step
(see [`trust-model.md`](../reference/trust-model.md)).

> **Still a demo.** "Trusted" here means *the wallet trusts a list you imported* — a
> self-generated issuer, not a real ecosystem anchor. Never present a passing gate as a
> real safety or payment control.

> **This whole page is optional.** The demo runs **without any of it** — a fresh clone
> (`node tools/demo-pki/run-gate.mjs`, no PKI, no VICAL/RICAL import) completes the
> ceremony end-to-end; the wallet just shows red **"untrusted issuer / unknown verifier"**
> badges. Everything below is the upgrade that *removes* those warnings. Nothing here is a
> prerequisite to running the demo — it's frustration-free by default, trusted by choice.

## Two paths — pick one

- **Consumer** — you just want credentials in your wallet to test a flow. **Download
  them** from the hosted page (below). No OpenSSL, no build. Start here.
- **Producer** — you need your own issuer/reader identity, custom claims, or a specific
  gate host. **Build the set** with [`tools/demo-pki/`](../../tools/demo-pki/README.md).

## Consumer path — download

The demo credentials + trust lists are served from a static page at
**https://credentagent.vercel.app** :

1. Open that page **on the phone**.
2. **Import the trust lists first** — the issuer list (**VICAL**) and reader list
   (**RICAL**) — so credentials land already-trusted. (Trust-then-import; doing it in
   this order avoids a transient "untrusted" state.)
3. **Then download each credential** (`.mpzpass`) and open it with the Multipaz wallet.
   The page serves them as `application/vnd.multipaz.mpzpass`, so the phone offers
   "Open with Multipaz Wallet".

The set: a driver license (mDL, carries `age_over_21` and `age_over_65`), a digital
payment instrument, a membership, and a professional license.

> **A RICAL only clears the verifier warning if the gate holds the matching reader private
> key.** The list names a reader; the gate has to sign as that reader. Import a list whose
> reader key nobody has and nothing changes — the warning stays, and the list is not at
> fault. Check which reader identity your gate presents (`readerIdentity`, above) before
> concluding a trust list is broken.

Next: **[Testing on a device](testing-on-device.md)** walks the import mechanics
(including the `adb` fallback) and running a full ceremony.

## What "trusted" covers today — and what it doesn't

Two independent trust anchors, distributed as signed lists:

| Anchor | List | Clears the warning… | What it takes |
| :-- | :-- | :-- | :-- |
| **Issuer** (who signed the card) | VICAL | "untrusted issuer" when holding the card | import the VICAL — that's all |
| **Verifier** (who's asking) | RICAL | "unknown verifier" at presentation | import the RICAL **and** run a gate that signs with the matching reader key |

Importing the VICAL makes your cards show as trusted, on its own.

The verifier side takes two halves that have to match. The wallet needs the RICAL — the
list naming which verifiers to trust. The **gate** needs the reader private key behind
that list, so it can sign each request as a reader on it. Give the gate that key and the
"unknown verifier" warning clears; leave it out and the gate self-signs a throwaway
certificate per request, which nothing on any RICAL matches.

The gate takes the key through one option:

```js
new CredentAgent({
  walletOrigin: "http://localhost:3007",
  readerIdentity: {
    key: readFileSync("reader-key.pem", "utf8"),   // private — signs the request
    cert: readFileSync("reader-cert.pem", "utf8"), // public — the wallet matches this to the RICAL
  },
});
```

> **The shipped reader is the one the hosted demo uses.** Its private key is never
> committed: the hosted demos at `credentagent.ai/marketplace` and
> `credentagent.ai/marketplace-dev` hold it, so importing the shipped `out/utopia.rical`
> clears the "unknown verifier" warning there with nothing to build. A gate *you* run
> can't sign as that reader without the key. To trust your own gate, mint your own
> reader with `./gen-pki.sh --reader-only` (see the producer path below); that keeps the
> shipped credentials valid.

## Producer path — build your own

See **[`tools/demo-pki/README.md`](../../tools/demo-pki/README.md)** for the full
pipeline (generate the PKI → mint the `.mpzpass` set → build the VICAL/RICAL → deploy the
page). The one decision that matters is the reader certificate's host (`READER_DNS`) —
it must match wherever your **gate** is served (`localhost` for local testing); see that
README's "Choose the reader SAN" section.

**For the verifier warning alone, rotate only the reader side.** `./gen-pki.sh
--reader-only` mints a new reader and trust-list signer and keeps the issuer, so the
`.mpzpass` credentials stay valid. Then: rebuild both trust lists → redeploy the download
site → point the gate at the new `reader-key.pem` → re-import both lists on the phone.

**A full `./gen-pki.sh` costs the whole chain.** It also mints a fresh issuer root, so
everything signed by the old one — the `.mpzpass` credentials, the VICAL, the RICAL — is
dead the moment you run it: regenerate → re-mint the credentials → rebuild both trust lists
→ re-import all of it on the phone → point the gate at the new `reader-key.pem`. No step can
be skipped, because each artifact is signed by the one above it.

> **For agents:** this pipeline is being packaged as a `demo-pki` skill
> ([#53](https://github.com/openmobilehub/credentagent/issues/53)) so it runs in one
> step with the host as an input. Until then, execute the README steps directly.
