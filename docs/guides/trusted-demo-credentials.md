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

Next: **[Testing on a device](testing-on-device.md)** walks the import mechanics
(including the `adb` fallback) and running a full ceremony.

## What "trusted" covers today — and what it doesn't

Two independent trust anchors, distributed as signed lists:

| Anchor | List | Clears the warning… | Status |
| :-- | :-- | :-- | :-- |
| **Issuer** (who signed the card) | VICAL | "untrusted issuer" when holding the card | ✅ works now |
| **Verifier** (who's asking) | RICAL | "unknown verifier" at presentation | ⏳ needs the gate to present the demo reader identity — [#51](https://github.com/openmobilehub/credentagent/issues/51) |

So today, importing the VICAL makes your cards show as trusted. Importing the RICAL
prepares the *verifier* side, but the "unknown verifier" warning won't fully clear until
the gate is wired to present the matching reader identity (#51) — the gate currently
self-signs an ephemeral reader cert per request, which nothing on the RICAL matches.

## Producer path — build your own

See **[`tools/demo-pki/README.md`](../../tools/demo-pki/README.md)** for the full
pipeline (generate the PKI → mint the `.mpzpass` set → build the VICAL/RICAL → deploy the
page). The one decision that matters is the reader certificate's host (`READER_DNS`) —
it must match wherever your **gate** is served (`localhost` for local testing); see that
README's "Choose the reader SAN" section.

> **For agents:** this pipeline is being packaged as a `demo-pki` skill
> ([#53](https://github.com/openmobilehub/credentagent/issues/53)) so it runs in one
> step with the host as an input. Until then, execute the README steps directly.
