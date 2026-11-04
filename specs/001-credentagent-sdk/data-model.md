# Phase 1 — Data Model: Attesto SDK v0.1

Entities the implementation models. Two layers: **policy** (code — functions, lives in your server) and
**manifest** (data — serialized to the wire). `requirements()` is the boundary.

## Attesto (client)

The configure-once client.

| Field | Type | Notes |
|-------|------|-------|
| `walletOrigin` | `string?` | Origin the wallet ceremony binds to; per-order approve link = `walletOrigin + /credential-gate/age?order=<id>`. **Optional** — defaults to `http://localhost:<PORT\|3000>`. |
| `store` | `VerificationStore` | Per-order verification state; default in-memory, pluggable (Redis). |

**Methods**
- `mount(app): void` — mounts `/credential-gate/*` ceremony routes on the Express app; wires `store`.
- `requirements(order, policy): VerificationManifestEntry[]` — resolves policy → serializable manifest.

**Validation**: when given, `walletOrigin` SHOULD be an absolute origin. The client **warns (never throws)**
— a non-absolute value falls back to the localhost default, and a localhost origin in production warns that
buyers can't reach the approve links. (DX: `new Attesto()` works zero-config; you fix the warning for deploy.)

## GateOrder (input to `requirements`)

The server-priced order (Principle: re-derived, never the raw token).

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Stable per checkout (created once). |
| `total` | `number` | Cents; re-derived server-side. |
| `currency` | `string` | ISO 4217. |
| `lines` | `OrderLine[]` | Carries the data conditional predicates read. |

### OrderLine

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | Product id. |
| `quantity` | `number` | Quantity (matches the demo's `PricedCartLine.quantity`). |
| `unitPrice` | `number` | Cents; authoritative (catalog). |
| `minimumAge` | `number?` | Per-product age threshold (21 for alcohol), **re-derived server-side** onto the line from the catalog (inv #2). `PricedCartLine` doesn't carry it natively — the gate enriches the order. |
| `category` | `string?` | Product category (e.g. `"Beverages"`), same re-derivation; available to custom `.when()` predicates. |
| `requiresRx` | `boolean?` | Example custom flag a `prescription` `appliesTo` reads. |

## Credential (policy — code)

Built-in or custom. **Not serialized.**

| Field | Type | Notes |
|-------|------|-------|
| `id` | `string` | `"age"` / `"membership"` / `"payment"` / custom. |
| `request` | `DcqlQuery` | What to ask the wallet. |
| `verify` | `(claims) => boolean` | Reads disclosed claims → proven? (Security: explicit positive claim.) |
| `effect` | `Effect` | `gate()` \| `discount({percent})` \| `authorize()`. |
| `appliesTo?` | `(order) => boolean` | Definition-time conditional (e.g. prescription only for Rx). |
| `when?` | `(order) => boolean` | Call-site conditional, attached via `.when()`. |
| `ui` | `{ label, action }` | The card shown in Context 2. |
| `params?` | `{ minAge?, percent?, currency? }` | From the builder (`age.over(21)` → `minAge:21`). |

**Builders** (return `Credential`): `age.over(n)`, `membership.discount(pct)`, `payment.in(cur)`,
`defineCredential({...})`. All expose `.when(predicate)`.

## Step (policy entry)

| Field | Type | Notes |
|-------|------|-------|
| `credential` | `Credential` | The gate. |
| `required` | `boolean` | `required(c)` → true; `optional(c)` → false. |

A **policy** is `Step[]` — order = run order; payment-bearing step MUST resolve last.

## Effect (tagged data)

`{ kind: "gate" } | { kind: "discount"; percent?: number; amount?: number } | { kind: "authorize" }`.
Interpreted by the resolver; never a handler in v0.1.

## VerificationManifestEntry (output — data, serialized)

The flat, JSON-safe element of `requires`. **No functions.**

| Field | Type | Notes |
|-------|------|-------|
| `credential` | `string` | id. |
| `required` | `boolean` | required vs optional. |
| `effect` | `"gate" \| "discount" \| "authorize"` | the kind only. |
| `enforcedAt` | `"tool" \| "checkout"` | where it runs (Principle VII — honesty in the type). |
| `trust_level` | `"presence-only-demo" \| "issuer-verified"` | mdoc trust (Principle VII; matches the envelope's field — no regression). |
| `label` | `string` | from `ui.label`, human-readable for agent/widget. |
| `minAge?` | `number` | age only. |
| `discountPct?` | `number` | discount only. |
| `approveUrl?` | `string` | per-order link (gate/authorize effects). |

**Invariant**: `JSON.stringify(manifest)` round-trips losslessly (contract test).

## VerificationRecord (store — per order id)

| Field | Type | Notes |
|-------|------|-------|
| key | `order.id` | Never process-global (Security invariant 4). |
| `ageVerified` | `boolean` | set by `/credential-gate/age/verify`. |
| `loyalty` | `{ applied: boolean; membershipNumber: string \| null }` | discount state. |
| *(custom)* | per credential id | set by the generic ceremony on verify. |

## DcqlQuery

`{ credentials: Array<{ id, format: "mso_mdoc", meta: { doctype_value }, claims: Array<{ path, intent_to_retain? }> }> }` — mirrors the reference verifier's DCQL.

## Relationships

```
Attesto ──mount──▶ /credential-gate/* + VerificationStore (per order.id)
Attesto ──requirements(order, policy)──▶ resolve each Step.credential against GateOrder
   Step.credential.(when|appliesTo)(order) decides inclusion
   Step.credential.effect + params + ui  ──serialize──▶ VerificationManifestEntry[]   (← the wire boundary)
```
