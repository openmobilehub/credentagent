# Plan — AP2 increment 3: the delegation chain (spec 014, FR-3 / FR-4)

Issue: #234. Stacked on #195 (spec 013 increment 2 — the signing key and `verifyMandate`).

## Shape

One purchase is **two chains**, one per mandate type, each three links joined by `~~`
(Delegate SD-JWT `draft-gco-oauth-delegate-sd-jwt-00` §5.1.1):

```
<wallet credential>~~<wallet hop: KB-SD-JWT+KB, discloses ONE open mandate>~~<agent hop: KB-SD-JWT, ONE closed mandate>~
```

- **Checkout chain:** open `mandate.checkout.open.1` → closed `mandate.checkout.1`.
- **Payment chain:** open `mandate.payment.open.1` → closed `mandate.payment.1`.

Both chains must share the same credential and the same wallet hop, or two grants could be spliced
into one purchase. This matches the AP2 Python SDK (`ap2/sdk/sdjwt/chain.py`, `*_mandate_chain.py`),
which is the interop reference.

## API (the example is the DX test)

```ts
// Agent — keep the permission once, spend it per purchase.
const intent = DelegatedIntent.fromWalletPresentation({ presentation, disclosures });
const proof = await intent.spend({ agentKey, checkoutJwt, payment, audience, nonce });

// Merchant — one call. `price` is the catalog: re-pricing still decides (invariant 2).
const verdict = await verifyDelegatedPurchase(proof, { audience, nonce, checkoutKey, spent, price });
```

## Modules — `packages/credentagent-gate/src/ap2/chain/`

| file | does |
| --- | --- |
| `serialize.ts` | split / join on `~~`; the implemented draft revision, pinned in one constant |
| `hop.ts` | mint the agent's KB-SD-JWT hop; verify one hop against the previous link's `cnf` |
| `verify.ts` | walk a chain: root via its `x5c`, each hop via the previous `cnf`, binding, `typ`, one disclosure |
| `constraints.ts` | evaluate open vs closed; **an unknown constraint fails**; budget/recurrence need `spent` |
| `purchase.ts` | `DelegatedIntent` (agent) and `verifyDelegatedPurchase` (merchant) |

## Decisions (agreed)

1. Budget and recurrence need the caller's usage (`spent`); missing ⇒ refused.
   A recurrence cadence other than `ON_DEMAND` is refused outright until it is enforced (#242).
2. A hop whose payload carries `cnf` must be typed `kb+sd-jwt+kb`; the terminal hop `kb+sd-jwt` and
   no `cnf`. The simulated wallet's default changes to `kb+sd-jwt+kb`. What a released Multipaz
   build emits is unverified and needs a device run.
3. The root credential is still demo-trust (#14): `trust_level` stays `presence-only-demo`.

## Bypass tests (spec 014 — each must fail when its control is deleted)

closed payment above `amount_range.max` · unknown constraint type · a claim the open mandate fixed,
altered in the closed one · a hop re-signed with a second key · the closed hop signed by a key the
open `cnf` does not name · a merchant outside `allowed_merchants` · a perfectly signed chain whose
total disagrees with the catalog · no key, no pass · plus: checkout and payment chains from two
different grants spliced together; binding hash removed or swapped; two open mandates disclosed.
Splice tests share one signing key, so a binding test cannot pass at the signature instead.
