# Phase 1 Data Model — Gate Ceremony Extraction

Entities and the **injected seams** `attesto.mount(app)` reads. Shapes are described, not coded; field names
mirror the demo's existing ceremony so extraction preserves behavior.

## Injected seams (what the host provides to `mount()`)

`mount(app)` reads these from `app.locals.attesto` / options and **fails fast if a required one is missing** (FR-009).

| Seam | Shape | Default | Serverless |
|---|---|---|---|
| `verificationStore` | per-order: `read(orderId) → {age?, membership?, payment?}`, `write(orderId, claim)`, `clear(orderId)` | in-memory | host injects shared/Redis |
| `orderStore` | resolve order: `read(orderId) → Order \| null` | in-memory | host injects shared/Redis |
| `completion` | `completeOrder(order, ctx) → CompletedRecord` (idempotent; re-prices; optional settle; clears cart+verification) | provided | — |
| `signingKey` | stable secret for the challenge HMAC | per-process random (dev only) | **required** stable value |
| `origin` | `deriveOrigin(req) → { rpID, origin }` from `x-forwarded-proto/host`, else Host | provided | honors TLS termination |
| `catalog` | products for server-side re-pricing | required | — |
| `settlement?` | optional demo-mode Hedera/x402 settle seam | absent ⇒ mock-complete | — |

## Entities

### Order (input, re-priced)
- `id`, `lines[] {id, name, unitPrice, quantity, lineTotal, minimumAge?, category?}`, `subtotal`, `discount`, `total`, `currency`.
- **Rule**: `total`/`discount` are **re-derived from the catalog** on every path; the inbound value is never trusted (Sec Req; FR-004).

### Verification record (per order id)
- `{ age?: { over: number, verified: true }, membership?: { verified: true }, payment?: { method, verified: true } }`.
- **Rules**: scoped per order id, never global (FR-006); positive claims only — `age_over_21 === true`, threshold must match the order's `minimumAge` (FR-002, Sec Req); cleared on completion.

### Challenge token (stateless nonce)
- Sealed HMAC over `{ challenge(32B), orderId, exp }`; verified by signature + expiry; single-use within the window.
- **Rules**: bound to this origin/RP-ID; replay/expiry rejected (FR-007, Sec Req). Signing key must be stable across instances (D6).

### AP2 mandate (output of a successful ceremony)
- AP2-shaped: binding fields `{ amount, currency, payee, orderId }` + authorization metadata; `signature` is **dev-mock** (SHA-256 digest), `trust_level: "presence-only-demo"`.
- **Rules**: amount = re-derived order total (incl. discount) — must reconcile with line sum (FR-005, Sec Req). KB-JWT signing deferred (v0.2; Principle VII).

### Four deterministic gates (passkey rail)
1. **Amount integrity** — re-summed lines == total == mandate amount.
2. **Authorization present** — a verified assertion exists.
3. **User verification asserted** — authenticator UV flag.
4. **Subject/credential binding** — assertion bound to the issued challenge/credential id.
- **Rule**: all four must pass before `completeOrder`; any failure ⇒ refusal, nothing recorded.

### Requirements manifest (already emitted by `requirements()`)
- Flat data: `[{ credential, required, effect, label, minAge?, … }]` — the code→data boundary (Principle VI).
- **Rule**: functions (`.when()`, `verify`) run server-side; only data crosses the wire.

### Completed record (output of `completeOrder`)
- `{ orderId, amount, currency, method, gates[], completedAt, settlement? }`.
- **Rules**: written once (idempotent); a failed settlement yields **no** completed/paid record (FR-013); cart + verification cleared.

### Settlement record (optional, demo-mode)
- `{ network: "hedera-testnet", payer, amountTinybar, txId, hashscanUrl, settledInMs, status: "settled" }`.
- **Rule**: demo-mode only, clearly labeled; never presented as real-money settlement (Principle VII).

## State transitions (one order)

```
created ──(open ceremony page)──▶ awaiting-proofs
awaiting-proofs ──(age proven, threshold ok)──▶ age-ok       [refuse completion until all required gates pass]
awaiting-proofs ──(membership proven)─────────▶ discount-applied (re-priced)
age-ok + payment authorized (4 gates pass) ───▶ completing ──(completeOrder)──▶ completed
any required proof missing/invalid ───────────▶ refused (nothing recorded)
settlement fails ─────────────────────────────▶ refused (no paid record; FR-013)
```
