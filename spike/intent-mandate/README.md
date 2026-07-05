# Spike — Intent Mandate bounds model + deterministic draw gates (HNP / 005)

A runnable design prototype validating
[`specs/005-human-not-present/intent-bounds-schema-draft.md`](../../specs/005-human-not-present/intent-bounds-schema-draft.md)
— the **top of the "Russian doll"**: the user signs BOUNDS (cap / cumulative cap / window / scope /
delegate key), and every DRAW (a Payment Mandate signed by the delegate key `K_s`) is checked
**in-bounds server-side on every action** (§4/§9 of the connector design).

> **This is a spike, not shipped code.** It de-risks the hardest, most decision-independent 005
> modeling before the formal build (which is gated on the Group-A / D13 ratifications). It doesn't
> touch the `packages/`. When the wallet server is built, its policy engine wires in *this* logic.

## Run

```bash
node --test spike/intent-mandate/intent-mandate.test.mjs      # 13 tests
```

## What it establishes

- **Content-addressing works, no circularity.** `intentId = "int_" + b64url(SHA-256(canonical(bounds \ intentId)))`
  — omitting the id field from the hash. It commits to *every* other field (delegate key, skus, honesty
  labels), so any post-signature edit re-hashes and orphans the DeviceKey signature. Tested.
- **The gates are deterministic + total.** `checkDraw(intent, draw, { now, priorDraws })` is a pure
  function returning a **typed refusal list** (not first-fail): `intent-mismatch`, `bad-signature`,
  `currency-mismatch`, `over-cap`, `over-total`, `before-window` / `expired`, `out-of-scope-merchant`,
  `replay`, `unpermitted-presentment`, `step-up-required`. Each carries `enforcer: true` (hard stop) or
  `retryable: true` (agent surfaces an approve link → human taps → retry) — the §9 vocabulary, machine-checkable.
- **Real ES256 (the wire crypto is real).** The delegate `K_s` (P-256) signs the canonical draw; a
  tampered draw or one signed by a *different* key is refused. Only the PKI + money are fictitious.
- **Age is never delegable** — it can't appear in `mayPresent`, so a draw presenting an age credential
  is refused (`unpermitted-presentment`). Step-up-by-policy, as the design requires.

## Findings surfaced (for the schema/design conversation)

1. **`over-cap` can never fire alone.** With the schema's `stepUpOver ≤ maxAmount` (and a demo where
   `maxAmount == totalAmount`), any over-cap draw also trips `over-total` and `step-up-required`. That's
   *correct* (the typed list accumulates), but it means UX copy should lead with the enforcer refusal
   (`over-cap`) and treat the co-fired `step-up-required` as moot. Worth stating in the design.
2. **Amount units, unresolved (schema open-Q #2).** This spike compares in the doc's numeric units
   (major units) directly. For canonical *hashing* the draft proposes integer **minor** units — the two
   must agree, so pick one canonical form before the build (proposal stands: minor units in the bounds
   doc, convert at the TS12 boundary). The gate arithmetic is unit-agnostic as long as it's consistent.
3. **`skus` scope is modeled but not yet enforced** in `checkDraw` (the draw carries a merchant, not a
   line-item GTIN, in this draft). When the draw model gains line items, add a `skus` gate mirroring the
   merchant one. Flagged so it isn't forgotten.

## Next (real build, post-ratification)

Wire this into the wallet server's policy engine (Option B, seams-first): the `delegate`/`K_s` model,
the cumulative-cap ledger (`priorDraws` becomes the committed-draws store), and the TS12 projection that
rides in OpenID4VP `transaction_data`. The `checkDraw` gate list is the reference for that engine.
