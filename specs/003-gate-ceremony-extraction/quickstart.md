# Quickstart — Gate Ceremony Extraction (003)

Validates that `attesto.mount(store.app)` serves the **real** ceremony (all three rails) and that age + membership
+ payment run through the gate. API source of truth: [`contracts/attesto-mount.api.md`](./contracts/attesto-mount.api.md);
shapes in [`data-model.md`](./data-model.md).

## The pattern this makes true (≤ 10 lines)

```ts
import { createStorefront } from "@openmobilehub/attesto-storefront/server";
import { Attesto, age, membership, payment, required, optional } from "@openmobilehub/attesto-gate";

const store = createStorefront();
const attesto = new Attesto();
attesto.mount(store.app);                          // ← 003: the real ceremony routes
store.gate((o) => attesto.requirements(o, [
  required(age.over(21).when((l) => l.minimumAge != null)),
  optional(membership.discount(10)),
  required(payment.in("usd")),
]));
const { url } = await store.listen(3005);          // → http://localhost:3005/mcp
```

Add `http://localhost:3005/mcp` to a widget-capable host → browse → add the 21+ item → checkout opens the
mount()-served page → prove age + (optionally) membership → authorize payment → the widget shows the confirmation.

## Validation

### 1. Build (deploy-safe)
```bash
npm run build
```
**Expected**: exits 0; `build:packages` builds both `@openmobilehub/attesto-*` (incl. the widget bundle) before
the app build. Vercel runs the same command ⇒ green = deploy-safe. (CT12)

### 2. Package + composition tests (incl. bypass paths)
```bash
npx vitest run packages/attesto-gate packages/attesto-storefront storefront-gate.test.ts --exclude '**/.worktrees/**'
```
**Expected**: green — mount registers all three rails (CT1); fail-fast on missing seams (CT2); **unverified
age-restricted order refused on every path** (CT9) and `age_over_18` rejected for a 21+ gate (CT4); membership
discount applied once + reconciles (CT5); the four passkey gates + nonce/origin (CT6); tampered amount refused
(CT7); dc-payment via shared `completeOrder` (CT8); per-order isolation (CT10); presence-only honesty surfaced
(CT11). A bypass test must **fail** if its control is removed.

### 3. Demo parity (no regression)
```bash
npm test
```
**Expected**: full suite green (253 pass / 1 known skip baseline) — the demo, now consuming `attesto.mount()`,
behaves identically. (CT12)

### 4. Ceremony renders (manual)
Connect the demo (`http://localhost:3001/mcp`) or your storefront (`:3005`) to the Claude native app: add the 21+
item → check out → the mount()-served page asks for age (and membership) → after proving, payment authorizes via
passkey (try the cross-device toggle) → optional Hedera-testnet settlement receipt, **clearly labeled demo**.

## Done when
- [ ] `npm run build` green; widget bundle before app build (deploy-safe)
- [ ] package + composition tests green, including every bypass test (CT4/CT6/CT7/CT9/CT10)
- [ ] full `npm test` green — demo parity (CT12)
- [ ] ceremony renders + completes through the gate in a widget-capable host; age blocks, membership discounts,
      passkey (same + cross-device) authorizes; presence-only honesty shown
- [ ] `createStorefront()` + `attesto.mount()` + `store.gate()` works in ≤ 10 adopter lines (SC-005)
