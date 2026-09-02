# Migrating

Breaking changes, with a before/after for every renamed thing. Newest first.

---

## 0.5.0 — real AP2 mandates (spec 013, issue #39)

### In plain terms

Before 0.5.0 this library emitted three records that *looked* like AP2 but were not. One of
them was not really signed at all — it was a SHA-256 digest of its own payload with a note
attached saying it was a mock.

0.5.0 replaces all three with the real thing: mandates in the actual AP2 wire format,
serialized as SD-JWTs (RFC 9901), signed with a real ES256 key, verified through one code
path. The gate publishes its public key at `/.well-known/did.json`, so anyone can check a
signature without asking you for anything.

**What did not change:** who is allowed to buy what. Every security control still runs — the
server re-prices the cart, the amount is bound to the signature, a grant cannot exceed its
budget. This release changes the *format of the evidence*, not the *rules*.

**What is still not claimed:** a correct wire format is not a trust anchor. A verified chain
proves this gate issued these records. It does not prove the credential behind them came from
a real issuer — that is [#14](https://github.com/openmobilehub/credentagent/issues/14), still
open, and `trust_level` still says so.

### Why the shapes changed so much

The mandate model in AP2 moved on from the one this library was built against. Verified
against [`google-agentic-commerce/AP2`](https://github.com/google-agentic-commerce/AP2) at
`main` on 2026-09-01:

- **`IntentMandate` and `CartMandate` no longer exist.** There are four mandate types,
  discriminated by the SD-JWT `vct` claim: `mandate.checkout.1`, `mandate.payment.1`,
  `mandate.checkout.open.1`, `mandate.payment.open.1`. The "open" pair is the
  human-not-present case — exactly our spending grants.
- **Money is integer minor units.** `{ amount: 27999, currency: "USD" }` is $279.99.
- **Key binding (`cnf`, RFC 7800) is required on both open mandates**, and not required on
  the other two.

### New: configure a signing key

```js
// BEFORE — nothing to configure; mandates were mock-signed
const credentagent = new CredentAgent({ walletOrigin: "https://shop.example" });

// AFTER — pass a stable P-256 private JWK for any deployment
const credentagent = new CredentAgent({
  walletOrigin: "https://shop.example",
  mandateSigningKey: JSON.parse(process.env.GATE_MANDATE_KEY),
});
```

Omit it and the gate generates one at boot so a zero-config install still runs — and
`credentagent.doctor()` reports `ephemeral-mandate-signing-key` as an **error** on any
deployment, because every mandate that process signed stops verifying when it restarts.

Generate one once:

```bash
node -e "const {generateKeyPairSync}=require('node:crypto');const {privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});console.log(JSON.stringify(privateKey.export({format:'jwk'})))"
```

> `mandateSigningKey` is **not** the same thing as the ceremony seams' `signingKey`. That one
> is an HMAC secret for challenge tokens and is unchanged. This one is an asymmetric key whose
> public half the world can check. They were deliberately given different names.

### Renamed and removed exports

| 0.4.0 | 0.5.0 |
| --- | --- |
| `issueCartMandate(args, secret)` | `new Ap2Issuer(key).checkout({ checkout })` |
| `verifyCartMandate(m, orderId, secret)` | `verifyMandate(token, { publicJwk, expect: VCT.checkout })` |
| `decodeCartMandateParam(v)` | `decodeMandateChainParam(v)` |
| `CartMandate`, `CartMandateLine` | `CheckoutMandate` + `UcpCheckout` / `UcpLineItem` |
| `CartMandateRefusal`, `CartMandateVerdict` | `MandateRefusalCode`, `VerifyResult` |
| `DEFAULT_CART_MANDATE_TTL_MS` | `DEFAULT_MANDATE_TTL_MS` |
| `reconcileCartPayment(cart, payment, total)` | `verifyChain(chain, { publicJwk, expectedTotal })` |
| `PaymentBinding`, `ReconcileRefusal`, `ReconcileVerdict` | `ChainRefusalCode`, `ChainResult` |
| `buildPasskeyMandate(args)` | `issueCeremonyChain({ issuer, order, origin, evidence })` |
| `runGates(mandate)` | `runCeremonyGates(order, evidence, signedAmount)` |
| `PasskeyMandate`, `GateResult` | `PaymentMandate`, `GateOutcome` |
| `buildDcMandate(args)` | `buildDcPresentation(args)` — the object was never an AP2 mandate |
| `DcMandate` | `DcPresentation` (the old name is a deprecated alias) |

Unchanged and still exported: `IntentBounds`, `sealIntent`, `checkDraw`, `signDraw`,
`canonicalIntentBounds`, `boundsHash`, and the whole `intent-sign` rail. See "Not yet
migrated", below.

### Ceremony receipts

Both payment rails now return the SIGNED chain under `mandate`, and their own presentation
record — which never was an AP2 mandate, whatever its `type` field said — moved to a
separate field:

```jsonc
// BEFORE (dc-payment /verify)
{ "mandate": { "type": "ap2.PaymentMandate", "version": "0.1-dc-demo", … }, "gates": [ … ] }

// AFTER
{
  "mandate":      { "checkout": "eyJraWQ…", "payment": "eyJraWQ…" },   // real SD-JWTs
  "presentation": { "type": "credentagent.DcPresentation/v1", … },      // what the wallet disclosed
  "gates":        [ … ],
  "trust_level":  "server-issued-demo",
  "presence":     "live"
}
```

The passkey rail changed the same way (its receipt had no separate presentation object, so
`mandate` is simply the chain now).

### The wire parameter is now `chain`, not `cart`

Checkout links, approve links and ceremony `POST` bodies carried `cart=<base64url>`. They now
carry `chain=<base64url>` — a different format, so the name changed with it rather than
letting an old link fail obscurely.

```
BEFORE  /checkout?order=ORD-1&cart=eyJ0eXBlIjoiYXAyLkNhcnRNYW5kYXRl…
AFTER   /checkout?order=ORD-1&chain=eyJjaGVja291dCI6ImV5SmhiR2Np…
```

### Completion input

```js
// BEFORE
await completeOrder({ order, mandateId, amount, currency, method, gates, cartMandate }, ctx);

// AFTER
await completeOrder({ order, mandateId, amount, currency, method, gates, mandateChain }, ctx);
```

The context gained `mandatePublicJwk`. **Its absence is fail-closed**: a chain arriving with
no key to check it against is refused, never waved through. `mount()` supplies it
automatically; a hand-built `CompletionContext` must pass `credentagent.mandateKey.publicJwk`.

### Money

Amounts inside mandates are integers in minor units. The public `Order` / `CeremonyOrder`
surface still uses the familiar float dollars — `ap2/money.ts` owns the only conversion.

```js
import { amountFrom, formatAmount, toMinorUnits } from "@openmobilehub/credentagent-gate";
toMinorUnits(19.99, "USD");         // 1999
amountFrom(19.99, "usd");           // { amount: 1999, currency: "USD" }
formatAmount({ amount: 1999, currency: "USD" }); // "19.99 USD"
```

### Honesty labels

`trust_level` split into two axes, so "was a human there?" stops being conflated with "how
strongly is this bound?".

| Path | `presence` | `trust_level` (was) | `trust_level` (now) |
| --- | --- | --- | --- |
| passkey / dc-payment | `live` | `presence-only-demo` | `server-issued-demo` |
| grant, device-signed | `delegated` | `device-signed` | `device-signed` |
| grant, click-approved | `delegated-demo` | `presence-only-demo` | `server-issued-demo` |

Still `-demo` on both: there is no issuer trust anchor yet (#14).

### New: `grant.spend()` returns a mandate bundle (#114)

```js
const door = await grant.spend({ idempotencyKey: "k1", items: [{ sku: "coffee" }] });
if (door.ok) {
  door.mandateBundle; // { checkout, payment, openCheckout?, openPayment? } — signed SD-JWTs
}
```

Evidence, never permission: every bound was enforced before the bundle was minted, and a
**refused** spend carries no bundle at all.

### Not yet migrated

The `intent-sign` rail still signs `credentagent.IntentBounds/v0`, not
`mandate.checkout.open.1`. This is deliberate. The wallet's device signature covers
`boundsHash` — the canonical bytes of the bounds object — so changing that shape changes the
nonce the wallet signs, and would regress device-signed grants
([#144](https://github.com/openmobilehub/credentagent/issues/144)) without on-device interop
testing to prove otherwise. The bundle above already expresses those same bounds as AP2 open
mandates on the wire; making the *wallet* sign the AP2 form directly is the remaining leg.

---

## 0.4.0 — `DelegatedVerifier` splits verification from settlement

See [#161](https://github.com/openmobilehub/credentagent/issues/161) for the `consume` /
`settle` split.
