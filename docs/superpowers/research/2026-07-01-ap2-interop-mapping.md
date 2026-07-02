# AP2 interop mapping — AttestoMCP mandates vs. the AP2 SDK models (overnight, 2026-07-01)

**Source**: `google-agentic-commerce/AP2` → `code/sdk/python/ap2/models/mandate.py` (fetched 2026-07-01;
Apache-2.0). Data keys: `ap2.mandates.IntentMandate` / `ap2.mandates.CartMandate` /
`ap2.mandates.PaymentMandate`.

**Why this exists**: the design doc names "being an island" as kill-risk #1. This maps our (tentative)
shapes onto AP2's actual field names so we converge where it's free and diverge only where we're ahead of
their spec.

---

## 1. IntentMandate

AP2's docstring, verbatim: *"These are the initial fields utilized in the human-present flow. For
human-not-present flows, **additional fields will be added** to this mandate."* — i.e., **AP2's HNP bounds
are still TBD; our design is a candidate for exactly those fields.** This is the standards-shaping
opening.

| AP2 field | Our concept | Verdict |
| :-- | :-- | :-- |
| `user_cart_confirmation_required: bool` — *"must be true if the intent mandate is not signed by the user"* | our honesty rung: server-issued grants must not autonomously purchase; only user-signed intents unlock HNP | **Deep convergence** — AP2 encodes our exact honesty rule as a protocol flag. Adopt the field. |
| `natural_language_description: str` — NL intent, *"confirmed by the user… informed consent"* | we don't have it | **Adopt.** Belongs in our bounds doc AND on the approve page — it's the human-readable half of informed consent. |
| `merchants: list[str] \| None` (None = any suitable) | `scope.payee` / trusted-merchant list | **Rename ours to match** (`merchants`). |
| `skus: list[str] \| None` (None = any) | GTIN product allowlist | **Rename ours to match** (`skus`, GTIN values). |
| `requires_refundability: bool` | — | Adopt (cheap, useful policy knob). |
| `intent_expiry: str` (ISO 8601) | `window.expiresAt` | **Rename to match.** (AP2 has no `notBefore`; keep ours as an extension.) |
| *(absent)* per-draw cap / cumulative cap / step-up threshold / delegate key (`K_s`) / presence & trust labels / `disclaimer` | our bounds core | **Our proposed "additional fields for HNP"** — and per the TS12 finding, the money bounds already have standard names: `max_amount`, `total_amount`, `recurrence` (EUDI SCA). Propose AP2 names aligned with TS12. |

## 2. CartMandate

| AP2 | Ours (004 `ap2.CartMandate`) | Verdict |
| :-- | :-- | :-- |
| `contents: CartContents { id, user_cart_confirmation_required, payment_request (W3C PaymentRequest), cart_expiry, merchant_name }` | server-priced sealed cart (id, lines, total, TTL) | Same shape; theirs uses **W3C PaymentRequest** for items/total — worth adopting as the line-item container. |
| `merchant_authorization: JWT` — iss/sub/aud, iat/exp (5–15 min), jti (anti-replay), **`cart_hash`** over canonical JSON of CartContents | our HMAC seal over the cart | **Convergence** — their JWT ≈ our seal with a key-signed upgrade path; `cart_hash`-over-canonical-JSON is the same commit-by-hash pattern we use for `transaction_id = intentId`. Target their JWT claims for v0.2 `alg` widening. |

## 3. PaymentMandate

| AP2 | Ours (draw) | Verdict |
| :-- | :-- | :-- |
| `payment_mandate_contents { payment_mandate_id, payment_details_id, payment_details_total (PaymentItem), payment_response (W3C PaymentResponse), merchant_agent, timestamp }` | draw: exact amount, payee, intentId, tx id | Mapable 1:1; ours adds the intent reference (theirs binds via user_authorization hashes instead). |
| `user_authorization` — *"base64url VP of a VC signing over the cart_mandate and payment_mandate hashes… a KB-JWT with **`transaction_data`: array of secure hashes**"* | our intent ceremony: DeviceKey signs `transaction_data` hashes of the bounds (mdoc flavor) | **THE convergence.** AP2's user authorization IS the OpenID4VP transaction_data-hash mechanism — SD-JWT KB-JWT flavor of exactly what Multipaz does in mdoc deviceAuth (desk-verified F3). Our intent ceremony is this pattern applied at *intent* time; per-draw it's `K_s` under PoA instead of per-payment user VP — which is precisely the HNP delta AP2 says is coming. |

## 4. The three-standards composition (the talk's interop slide)

```
AP2 (protocol shapes)      Intent → Cart → Payment mandates, user_authorization via
                           transaction_data hashes, user_cart_confirmation_required honesty flag
EUDI SCA TS12 (payload)    the MIT/recurrence bounds vocabulary: max_amount, total_amount,
                           start/end, payee — in the wallet's registered PaymentTransaction type
Multipaz (wallet)          the device that seals it: DPC (org.multipaz.payment.sca.1),
                           DeviceKey over transaction_data, issuer chain
─────────────────────────────────────────────────────────────────────────────
AttestoMCP                 the composition: mints/verifies the chain, enforces the bounds,
                           carries the honesty labels — speaking all three vocabularies
```

## 5. Concrete recommendations (tentative, for maintainer confirmation)

1. **Adopt AP2 field names** where we have the same concept: `merchants`, `skus`, `intent_expiry`,
   `natural_language_description`, `requires_refundability`, `user_cart_confirmation_required`.
2. **Propose our bounds as AP2's HNP "additional fields"**, named per TS12 (`max_amount`, `total_amount`,
   `recurrence`) — one coherent proposal to both communities instead of a private vocabulary.
3. **Target AP2's `merchant_authorization` JWT claims** (jti, cart_hash, short exp) as the 004/v0.2 seal
   upgrade shape.
4. Keep as honest extensions (absent from AP2 today): `presence`, `trust_level`, `disclaimer`,
   step-up threshold, `notBefore`, the delegate key binding (`K_s` in signed bounds).
