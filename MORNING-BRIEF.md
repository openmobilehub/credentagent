# Morning brief — #92 prototypes (overnight)

Both goal increments are **built, smoke-tested green, and committed** on branch
`008-ap2-mandate-chain-dx` (worktree `.worktrees/mandate-dx`). Nothing pushed, no PR, no
`packages/` edits — all new code is under `examples/`.

## TL;DR

- **A — orders door now carries a real `mandateBundle`.** The `ok` branch returns a genuinely
  signed `ap2.CartMandate` (`issueCartMandate`, `.serialize()` → base64url) + a `paymentMandate`
  from the real settlement, `intentMandate: null` (correct for human-present), `trustLevel` on
  every object.
- **B — a runnable `grants.*` prototype** (the human-*away* half you hadn't seen) over the **real
  `DelegatedGate` engine**: `grants.create` → authorize (**the Intent Mandate is produced**) →
  `grant.spend` loop (per-spend + budget caps, `remaining`, idempotent replay) → `grant.revoke`.

## Play with it (3 things running)

| Port | What | Open | Notes |
| --- | --- | --- | --- |
| **:4010** | **orders.\*** (human present) — real ceremony | http://localhost:4010 | Start checkout → real checkout page → prove on phone → door flips to `ok` with the mandateBundle |
| **:4020** | **grants.\*** (human away) — NEW | http://localhost:4020 | Create grant (Intent Mandate) → spend loop → try the $50 case (per-spend cap) and a 6th wine (budget) → Revoke |
| **:3007** | the real gate (old API, real crypto) | http://localhost:3007/checkout?order=ORD-DEMO | the genuine engine both protos sit on |

**Fastest look:** open **:4020** and click through Create grant → Spend wine a few times → Spend the
$50 case (→ `per-spend-exceeded`) → keep spending to `budget-exceeded` → Retry (→ `replayed`) → Revoke.
No phone needed — the whole delegated engine is server-side.

**orders on your phone (:4010):** reconnect the Pixel, then `adb reverse tcp:4010 tcp:4010` (the
reverses dropped overnight when the device slept), open the `approveUrl` shown in the left pane,
prove age with your `.mpzpass` + passkey pay. It flips `pending → ok` and the webhook log shows the
real settlement.

## What's REAL vs STUBBED (honest)

**orders (:4010)** — REAL: the gate (`createStorefront` + `mount`), `orders.create` → real order +
real manifest (`requirements()`), the real OpenID4VP age proof + x402 passkey payment, the
`order.settled` webhook (the completed-store `write()`), and the door's **cartMandate** (real
`issueCartMandate`). STUBBED: the **paymentMandate** is *assembled from the real settlement record*,
not the rail's own `PaymentMandate` object (that object isn't surfaced yet — see open Q2). Also
`/api/_test/settle` is a test hook to drive the `ok` branch without a phone; on-device is the real path.

**grants (:4020)** — REAL: the `DelegatedGate` engine — bounds check, single-use ledger, revocation,
the dev-sealed Intent Mandate (`sealIntent`), per-draw signing. All enforcement is genuine. FACADE
(v10 design shown over the real engine): `usd()` Money, the `{ ok | code }` door, idempotent replay
(`{ ok:true, replayed:true }`), the split codes (`over-cap → per-spend-exceeded`, `over-total →
budget-exceeded`). HONEST GAP: **authorize is server-side today** — presence `delegated-demo`, trust
`server-issued-demo`; the phone-wallet key-signing ceremony (where the human actually signs the
Intent Mandate) is the roadmap (#71). `grant.approveUrl` is a placeholder for it.

## If the servers died (Mac slept)

```bash
cd ~/tools/git/attestomcp
# orders (:4010) and grants (:4020) — from the 008 worktree:
( cd .worktrees/mandate-dx && PORT=4010 node examples/orders-proto/server.mjs & )
( cd .worktrees/mandate-dx && PORT=4020 node examples/grants-proto/server.mjs & )
# the real gate (:3007):
( cd .worktrees/demo-pki && PORT=3007 node tools/demo-pki/run-gate.mjs & )
```

## Your calls (open questions)

1. **Naming — confirm the grants vocabulary:** `grants.create/retrieve` + `grant.spend/revoke`, and
   the door codes `per-spend-exceeded | budget-exceeded | revoked`. And the biggest one: **`orders.gate`**
   (the `requireInTool`/`gateTool` rename) — worth locking before **#17** merges so the first public
   method already speaks this grammar.
2. **The last real-ness gap:** should the orders door surface the rail's *actual* `PaymentMandate`
   object (a deeper integration into the passkey/dc-payment rail) rather than one derived from the
   settlement record? Small but it's the difference between "shaped like real" and "is the real object."
3. **Graduation:** when to move the `orders`/`grants` facade from `examples/` into
   `packages/credentagent-gate` as the real API — this touches `client.ts` (which #84 and #17 also
   touch), so it wants sequencing after those land.
4. **Roadmap check:** grants authorize is server-sealed today; the human-present phone key-sign
   ceremony is #71. Is that the ordering you want, or should the authorize ceremony come sooner?

## Where it lives

Branch `008-ap2-mandate-chain-dx` · this session's commits:

```
fe1d513 proto(#92,008): increment B — runnable grants.* (human-not-present) surface
37b9633 proto(#92,008): increment A — real mandateBundle on the orders door
8b30ef9 proto(#92,008): runnable orders.* prototype alongside its spec
e445913 spec(#92,008): completion via webhook (no poll loop) + Intent Mandate production
d4f9aa2 spec(#92,008): lock the consent SDK surface after 9-round DX council
8c7fa5e spec(#92,008): AP2 mandate-chain developer surface (MandateBundle)
```

Files: `examples/orders-proto/` (orders + real ceremony), `examples/grants-proto/` (grants), and the
spec at `specs/008-ap2-mandate-chain-dx/spec.md`. The order-lifecycle explainer artifact is at
https://claude.ai/code/artifact/a33a6e3c-84ab-4fd6-91e5-077d2c5297b4.
