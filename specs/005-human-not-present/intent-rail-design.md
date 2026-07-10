# Intent rail — design (005, the increment after the seams)

**Status**: design for review (autonomous draft, 2026-07-10). Anchors the build of `ceremony/intent/`.
**Depends on**: the merged seams + `DelegatedGate` (PR #41): `checkDraw`, `RevocationStore`, the `completeOrder`
draw branch, typed refusals. **Precedes**: the wallet server (`credentagent-wallet`), which swaps the key custody.

---

## What the intent rail is (and isn't)

The credential rails (`passkey`, `dc-payment`, `credential-gate`) all do one thing: **prove a credential at
checkout to complete one order, human present.** The intent rail is different in kind — it is the **HTTP surface
for delegation**, with a human-present *setup* and a human-not-present *execution*:

- **Delegate** (human present, once): a live ceremony mints a bounded, revocable **Intent Mandate** (a grant).
- **Redeem** (human NOT present, N times): the agent draws against the grant over HTTP; the gate re-checks
  every draw server-side and completes it through the shared `completeOrder` seam.
- **Revoke / list** (human present, anytime): the standing-capability surface — kill a grant, kill a subject,
  see what's outstanding (the audit trail that replaces the human-in-the-loop moment).

The in-process ergonomics already exist as `DelegatedGate` (PR #41). **This rail is the HTTP projection of that
same surface** — so the two must present ONE mental model (DX Principle 2: consistency). A host that mounts the
rail and a developer who calls `DelegatedGate` should see the same verbs: `preApprove` / `spend` / `revoke`.

## The one real design question: key custody over HTTP

In `DelegatedGate` (in-process) the caller holds the delegate key and `spend()` signs the draw locally. Over
HTTP the agent is remote, so *someone* must hold the key that signs each draw. Three options:

| | Who signs the draw | Honesty | Forward-compat with wallet-custody |
| :-- | :-- | :-- | :-- |
| **A. Agent holds K_s** | the agent (delegate returns the private key; agent signs, POSTs a signed draw) | grant is a bearer instrument the agent holds | ✅ the shape the wallet model keeps (wallet holds K_s) |
| **B. Gate holds K_s** | the gate (agent POSTs an unsigned purchase; gate signs) | gate both issues AND redeems — collapses the trust separation ("the Walmart case") | ❌ dead-ends; the wallet model exists to *undo* this |
| C. No key (opaque grant token) | nobody — the grant blob IS the bearer token | weakest; pure bearer | ❌ |

**Decision: A.** The delegate flow returns the grant *and* the delegate private key to the agent (a v0.1 demo
simplification, honestly fenced); the agent signs each draw and POSTs the **signed** draw; the redeem endpoint
runs `checkDraw` + `completeOrder` — never trusting an unsigned request. This keeps the wire shape identical to
the wallet model (where the wallet, not the gate, holds K_s and signs), so the wallet-server increment swaps
*where the key lives*, not the protocol. Option B is rejected precisely because the product's thesis is the
structural independence of issuer and redeemer.

**Honesty fence (load-bearing).** Because the gate *generates* K_s and hands it to the agent, v0.1 is
`presence: "delegated-demo"` + `trust_level: "server-issued-demo"`, settlement is suppressed, and the grant is a
**bearer instrument** (whoever holds the key redeems within caps; `subject` is informational). The rail MUST NOT
present the demo key handoff as user authorization. A *real* control requires the wallet to mint K_s behind the
user's biometric — the wallet-server line.

## The HTTP surface (DX-first — the whole point above the plumbing)

Mounted under `/credentagent/intents/*` — the HTTP surface MIRRORS the `DelegatedGate`
facade verb-for-verb so an agent that learned the SDK already knows the wire. The DX
audit's timing point is load-bearing: the rail is unbuilt, so it costs nothing to pick
the facade's nouns/verbs now and everything to retrofit them later. Two rules:

1. **`intents` is the resource** (RESTful, plural). Never `/intent/grants` — that leaf
   contradicts its own root. `grant` stays a prose synonym; it collides with OAuth
   grants in the wallet-server system, so it is not a path or type name.
2. **The verbs match the SDK**: `preApprove` mints, `spend` draws, `revoke` cancels —
   NOT `delegate`/`redeem` (which fork the vocabulary and overload the delegate-key noun).

**The human (browser) — pre-approve + manage:**
```
GET  /credentagent/intents/new                 → the pre-approval page: shows the bounds, one live-ceremony approve
POST /credentagent/intents                      → mint a grant  (mirrors gate.preApprove(); create = POST the collection)
GET  /credentagent/intents?subject=…            → active grants (the audit surface)
POST /credentagent/intents/:id/revoke           → revoke one grant (or ?subject= kill-switch)
```

**The agent (machine) — spend, human NOT present:**
```
POST /credentagent/intents/:id/spend            → present a SIGNED draw; gate re-checks + completes  (mirrors grant.spend())
```

Spend request/response — the SAME typed shapes as `DelegatedGate.spend`, so the mental
model carries from SDK to wire unchanged. The `:id` in the path is the intent id; the
gate re-loads the sealed bounds for it (grants store — see the open item below) and
re-checks the draw:
```jsonc
// → POST /credentagent/intents/int_…/spend
{ "draw": { /* delegate-signed Draw */ } }
// ← 200
{ "ok": true,  "amount": 18, "remaining": 82, "delegationId": "int_…" }
{ "ok": false, "amount": 54, "remaining": 82, "reason": "over-cap", "retryable": "terminal" }
```
> **Field naming (deferred, breaking):** `delegationId` IS the intent id — the SDK and
> wire should eventually rename it `intentId`, emitting both behind a deprecated alias.
> Kept as `delegationId` here so the wire does not fork from the shipped facade before
> that coordinated rename lands. See the DX punch-list.

## Mount integration (real glue, not zero-glue — FR-010)

The rail needs the revocation/single-use ledger, which the ceremony context does not carry yet. Add it as a
first-class seam, mirroring how `verificationStore` is threaded:

- `CeremonySeams` gains `revocation?: RevocationStore` (defaults to `MemoryRevocationStore` behind the same
  `allowEphemeralKey`-style single-process fence; a real deploy injects a shared CAS store).
- `CeremonyContext` gains `revocation: RevocationStore`.
- `RAILS[]` gains `registerIntentRail`.
- The rail resolves orders THROUGH `resolveOrder` (catalog re-price — invariant 2), re-runs the full bounds
  check at the seam (invariant 1), and threads `?cart=` on every hop (the statelessOrders rule).

## Files (mirroring the rail archetype)

```
ceremony/intent/
├── mint.ts     — compose + seal the bounds into an Intent Mandate (v0.1: server-composed), reusing sealIntent  ✅ built
├── redeem.ts   — redeemDraw() runs the draw THROUGH ctx.completion (never a rail-local completion) + running balance  ✅ built
├── page.ts     — the pre-approval page + its JS (shows bounds; instant-demo + live-rail hooks)                 ⬜ deferred
├── routes.ts   — register the endpoints above; /spend runs the draw through completeOrder; NEVER a rail-local completion  ⬜ deferred
└── mint.test.ts + redeem.test.ts — bypass tests, each red-when-removed  ✅ built (11 tests green)
```

## Bypass tests (mandatory, load-bearing)

Each control gets a test that fails when the control is deleted — submitted **directly to the /spend endpoint /
completeOrder**, not only the happy path:
- unsigned / tampered-signature draw → refused (`signature`)
- over-cap / out-of-scope / expired / replay / consumed → refused with the distinct reason
- age-restricted cart via a draw → always `step-up` (never completes from a grant)
- revoked grant → refused; revocation store unreachable → fail-closed refuse; TOCTOU (revoke between
  rail-verify and completeOrder) → seam still refuses
- two concurrent redeems of one single-use draw → exactly one completes

## Out of scope (kept for the wallet-server increment)

- Wallet-minted K_s behind biometric (the real trust anchor) — v0.2/v0.3.
- Per-draw proof-of-possession / holder binding (invariant 6 fully) — the bearer→bound upgrade.
- Real settlement of any draw; multi-merchant / A2A fan-out; async step-up mode.

## Why this increment is safe to build now

Every control it exercises is already tested in the seams; this adds the HTTP projection + the delegate
ceremony + the revocation seam glue. No new cryptography, no unresolved trust question left implicit — the one
real question (key custody) is resolved above (Option A) and honesty-fenced.
