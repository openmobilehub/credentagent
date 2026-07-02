# DRAFT — the redemption choreography (answering DX-council finding #1)

**Status**: tentative draft (overnight 2026-07-01), written in direct response to
[dx-council-review.md](./dx-council-review.md) finding #1: *"the cross-connector redemption sequence is
undefined, and §6 vs §7 contradict on `transaction_id`."* This document IS the six-call sequence with
schemas. It amends the design doc's §7 (see the change list at the end). Maintainer review required.

## Naming fix first (the council's rename)

Two different objects were both called `transaction_id`. Renamed everywhere in AttestoMCP docs:

- **`intentId`** — the TS12 `transaction_id` field's *value* at ceremony time (commits to the bounds doc).
  We never call this "transaction id" again.
- **`pspTransactionId`** — the settlement transaction the PSP (UPay) opens per draw (its `createTransaction`
  id + nonce). Fresh per redemption; the replay guard.

## The sequence, from the agent's seat (3 tool calls + 1 status read)

```
AGENT                    MERCHANT connector                 WALLET connector              PSP (UPay-style)
  │                            │                                  │                           │
  │ 1. checkout_delegated_open │                                  │                           │
  │──────────────────────────► │ re-price cart (GTIN→SKU,         │                           │
  │                            │  catalog = price authority)      │                           │
  │                            │ 2. createTransaction ───────────────────────────────────────►│
  │                            │ ◄──────────────────────────── pspTransactionId + nonce ──────│
  │ ◄── priced offer ──────────│                                  │                           │
  │    { pspTransactionId, amount, expiresAt }                    │                           │
  │                            │                                  │                           │
  │ 3. request_draw(intentId, offer) ────────────────────────────►│ policy: scope ⊇ cart,     │
  │                            │                                  │  amount ≤ max, ledger +   │
  │                            │                                  │  amount ≤ total, window,  │
  │                            │                                  │  step-up, merchant listed │
  │ ◄── { draw } (or typed refusal / step-up approveUrl) ─────────│ sign w/ K_s over ALL of it│
  │                            │                                  │                           │
  │ 4. checkout_delegated_complete({ pspTransactionId, draw })    │                           │
  │──────────────────────────► │ gate: verify chain + envelope    │                           │
  │                            │ 5. settle(draw) ─────────────────────────────────────────────►│
  │                            │                                  │      opens the doll: chain │
  │                            │                                  │      + tally + commit      │
  │                            │ ◄── settled ──────────────────────────────────────────────────│
  │ ◄── { ok, orderId, receipt (delegationId) } ──│               │                           │
  │                            │                                  │                           │
  │ 6. get_intent(intentId) ──────────────────────────────────────►│  → remaining budget      │
```

## Tool schemas (the missing contracts)

### Merchant connector — `checkout_delegated_open` (NEW; the tool the council said was unnamed)

```jsonc
// input
{ "cart": [ { "gtin": "gtin:00195394069122", "qty": 1 } ] }   // GTIN lines — the typed cross-connector cart shape
// output (a short-lived priced offer)
{ "pspTransactionId": "tx_789",
  "amount": 11495, "currency": "USD",          // integer minor units (canonical form per bounds-schema draft)
  "merchantId": "runfast.example",
  "lines": [ { "gtin": "…", "sku": "RF-GHOST17-10", "qty": 1, "unitPrice": 11495 } ],
  "offerExpiresAt": "…+10min" }                 // the offer, not the intent, carries the short TTL
```

The merchant re-prices from ITS catalog (invariant 2: catalog is the price authority) and maps GTIN→SKU
(the council's "hidden fourth line" — this mapping lives merchant-side, priced honestly as merchant work).

### Wallet connector — `request_draw` (AMENDED: gains the offer)

```jsonc
// input — the §7 signature was request_draw(intentId, {merchant, cart, amount}); it is now:
{ "intentId": "int_pYl0ZY…",
  "offer": { "pspTransactionId": "tx_789", "merchantId": "runfast.example",
             "amount": 11495, "currency": "USD",
             "cart": [ { "gtin": "…", "qty": 1 } ] } }
// output on success
{ "draw": "<opaque token: K_s-signed over {intentId, merchantId, amount, currency, pspTransactionId, cartHash}, intent presentment embedded>" }
// output otherwise: the shared refusal union (below)
```

The wallet signs over the **offer's** `pspTransactionId` — resolving the §6/§7 contradiction: the draw is
bound to a settlement that already exists, so the PSP's replay discipline works unchanged.

### Merchant connector — `checkout_delegated_complete`

```jsonc
// input
{ "pspTransactionId": "tx_789", "draw": "<opaque>" }
// output
{ "ok": true, "orderId": "ord_…", "receipt": { "amount": 11495, "delegationId": "int_pYl0ZY…" } }
// or the shared refusal union
```

Gate verifies the chain + its own envelope (`trustedWallets`, `maxDraw`, `scopes`) fail-closed, then hands
to the PSP's delegated verifier, which re-opens the doll independently and commits the ledger.

## The refusal union (adopting the council's §9 gaps)

```jsonc
{ "ok": false,
  "reason": "over-cap" | "over-total" | "out-of-scope" | "expired" | "not-yet-valid" | "revoked"
          | "intent-pending" | "step-up" | "signature" | "replay" | "amount-mismatch"
          | "offer-expired" | "untrusted-wallet" | "wallet-unreachable" | "reauth-required",
  "enforcer": "wallet" | "merchant" | "psp",     // council: attribution across the enforcers
  "retryable": "retry" | "needs-human" | "terminal",  // council: the bit an unattended loop branches on
  // per-reason fields:
  "cap": 12000, "pricedAt": 12800,               // over-cap
  "remaining": 7000,                              // over-total (the §15 beat-2 shape, now expressible)
  "approveUrl": "…",                              // step-up / reauth-required
  "rejected": ["gtin:…"] }                        // out-of-scope
```

Wallet-side refusals may be rich (it's the user's own service); merchant/PSP refusals stay coarse
(`enforcer` + `reason`, no bounds detail) per the security persona's oracle concern.

## Properties this sequence guarantees

1. **One amount, three checks**: merchant prices it, wallet bounds it, PSP re-verifies it equals the
   settlement it opened (`amount-mismatch` otherwise). No party trusts another's number.
2. **Replay**: `pspTransactionId` is single-use at the PSP; a re-presented draw is `replay`. The intent's
   multi-draw budget is governed by the wallet ledger + PSP tally (`over-total`).
3. **Offer expiry ≠ intent expiry**: a stale offer refuses (`offer-expired`) without touching the intent.
4. **The agent still holds nothing**: it couriers an offer to the wallet and a draw to the merchant, both
   opaque, both useless to a thief (draw is merchant+amount+settlement-bound).

## Design-doc §7 amendments this draft implies (to apply on acceptance)

- `request_draw(intentId, proposedCart)` → `request_draw(intentId, offer)` (offer from
  `checkout_delegated_open`).
- Add the two merchant tools to the storefront's tool list (`delegation` config registers BOTH).
- Rename: `psp_transaction_id` wherever the settlement id is meant; `transaction_id` is reserved for the
  TS12 field name at ceremony time only.
- The §9 union gains `enforcer` + `retryable` + the lifecycle reasons above.
