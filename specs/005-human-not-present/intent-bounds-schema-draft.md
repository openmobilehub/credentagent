# DRAFT — Intent bounds document, field-level schema (AP2 + EUDI TS12 aligned)

**Status**: tentative proposal (overnight 2026-07-01) — input to the §10 re-scope decision and the AP2
"additional HNP fields" conversation. Nothing here is settled. Sources:
`docs/superpowers/research/2026-07-01-ap2-interop-mapping.md` (field alignment) and
`…-multipaz-wallet-desk-verification.md` (F4/F5: TS12 expressibility + hash-commit binding).

## The bounds document (custodied by the wallet server; hash-committed into what the user signs)

```jsonc
{
  "type": "attestomcp.IntentBounds/v0",          // candidate ext of ap2.mandates.IntentMandate

  // ── identity & consent ─────────────────────────────────────────────
  "intentId": "int_pYl0ZY…",                     // content-addressed: "int_" + b64url(SHA-256(canonical(all other fields)))
  "naturalLanguageDescription":                  // AP2: natural_language_description (informed consent, rendered on the approve page)
    "Buy Brooks Ghost 17 size 10, up to $120 total, until Jul 31, from approved stores",
  "userCartConfirmationRequired": false,         // AP2 flag; false is legal ONLY because the user signs these bounds

  // ── scope ──────────────────────────────────────────────────────────
  "merchants": ["utopia-marketplace", "runfast.example"],  // AP2: merchants (None/absent = any suitable)
  "skus": ["gtin:00195394069122"],               // AP2: skus — GTIN URIs for cross-merchant identity
  "requiresRefundability": false,                // AP2

  // ── money bounds (names per EUDI SCA TS12 mit_options) ─────────────
  "currency": "USD",                             // TS12: currency (ISO 4217)
  "maxAmount": 120.00,                           // TS12: recurrence.mit_options.max_amount   (per-draw cap)
  "totalAmount": 120.00,                         // TS12: recurrence.mit_options.total_amount (cumulative cap)
  "stepUpOver": 50.00,                           // ours: presence-required threshold (≤ maxAmount)

  // ── window (names per AP2/TS12) ─────────────────────────────────────
  "intentExpiry": "2026-07-31T23:59:59Z",        // AP2: intent_expiry  = TS12 recurrence.end_date
  "notBefore":   "2026-07-01T00:00:00Z",         // ours (TS12 recurrence.start_date)

  // ── delegation & credential family ──────────────────────────────────
  "delegate": {                                  // ours: K_s, cnf-style — the ONLY key that may sign draws
    "kty": "EC", "crv": "P-256", "x": "…", "y": "…"
  },
  "mayPresent": ["membership:acme-loyalty"],     // §16: credentials the wallet may re-present per draw
                                                 // (age is NEVER listed — step-up by policy)

  // ── honesty labels (ours; machine-checkable) ─────────────────────────
  "presence": "delegated",
  "trust_level": "issuer-verified (demo PKI)",
  "disclaimer": "Demo PKI; fictitious settlement. Bounds are enforced server-side on every draw."
}
```

## The TS12 projection (what rides in OpenID4VP `transaction_data`, DeviceKey-signed)

```jsonc
{
  "type": "urn:eudi:sca:payment:1",              // the REGISTERED type — no custom type (F4)
  "payload": {
    "transaction_id": "int_pYl0ZY…",             // = intentId → commits to the FULL bounds doc (F5)
    "payee": { "name": "AttestoMCP demo wallet — delegation", "id": "wallet.example" },
    "currency": "USD",
    "recurrence": {
      "start_date": "2026-07-01",
      "end_date":   "2026-07-31",
      "mit_options": {
        "amount_variable": true,
        "max_amount": 120.00,
        "total_amount": 120.00
      }
    }
  }
}
```

**The binding rule** (content-addressing, no circularity): `intentId = "int_" + b64url(SHA-256(canonical
JSON of the bounds doc with the intentId field omitted))`. The DeviceKey signature covers
`transaction_id` (F3) → transitively covers every bounds field, including `delegate` (K_s), `skus`, and
the honesty labels. Any post-signature edit to any field changes the hash and orphans the signature.

## The draw (Payment Mandate) — signed by `delegate` (K_s), per action

```jsonc
{
  "type": "attestomcp.Draw/v0",                  // maps to ap2.mandates.PaymentMandate contents
  "intentId": "int_pYl0ZY…",
  "paymentMandateId": "draw_01H…",               // AP2: payment_mandate_id
  "merchant": "runfast.example",                 // AP2: merchant_agent
  "amount": 114.95, "currency": "USD",           // AP2: payment_details_total — EXACT, never "up to"
  "transactionId": "tx_789",                     // the PSP's fresh id (UPay createTransaction) — replay guard
  "presentments": ["membership:acme-loyalty"],   // §16 bundle riding along, if in mayPresent
  "signature": "…K_s over canonical(all above)…"
}
```

## Open questions this draft surfaces (for the maintainer, not decided here)

1. `payee` in the TS12 projection: the *wallet* as payee-of-record for the authorization vs. per-merchant
   payees (TS12 payee is singular → multi-merchant intents put merchant scope in the bounds doc, not the
   TS12 payload; the projection's payee names the delegation itself). Confirm this reading with the
   Multipaz/EUDI folks eventually.
2. Amount units: TS12 uses decimal major units; the gate uses integer minor units — pick one canonical
   form for hashing (proposal: integer minor units in the bounds doc; convert at the TS12 boundary).
3. Whether `stepUpOver`/`mayPresent`/honesty labels go into the AP2 "additional fields" proposal or stay
   AttestoMCP extensions initially (proposal: offer them; ship as extensions regardless).
