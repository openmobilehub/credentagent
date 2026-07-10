# DX crispness punch-list — the delegated surface

A multi-lens audit of the delegated public API (the `DelegatedGate` facade + the
unbuilt intent rail + the honesty types) against the Stripe-grade rubric
(`docs/reference/architecture-principles.md`). Five agents, four lenses (consistency,
first-five-minutes, honesty-in-types, naming/shapes) → one ranked list.

**Verdict:** the shipped facade is genuinely good and does **not** need a rewrite —
configure-once (`new DelegatedGate({catalog})` → `preApprove()` → `spend()`), decisions
return results and never throw, honesty labels ride on the object at runtime, the example
reads like a real quickstart. The gaps are **concentrated and mostly additive**. The one
big lever is **timing**: the intent rail is unbuilt and about to fork the vocabulary —
fixing that now costs nothing, retrofitting later is breaking.

Three findings are load-bearing: **(1)** `paymentId` is documented as an idempotency key
but does the *opposite* (a safe retry of a committed draw refuses `replay/terminal`,
teaching agents toward a double-charge); **(2)** `SpendResult` is a flat optional-bag so
`if (res.ok)` doesn't narrow — the "typed proof" isn't a proof; **(3)** honesty was
stringly-typed on the delegated side despite CLAUDE.md making `trust_level` a *types*
invariant.

---

## Already applied this session (005-intent-rail)

- **#4 (honesty in types), at the source.** `TrustLevel` now names the real rungs
  (`presence-only-demo | server-issued-demo | issuer-verified`); added a `Presence` union
  (`live | delegated | delegated-demo`); `IntentBounds.presence`/`trust_level` narrowed
  from `string` → those unions (`mandate.ts`). The rail's `"server-issued-demo"` is now a
  checked literal, not a bare string. **Remaining:** narrow the facade getters
  `DelegatedGrant.presence`/`trustLevel` from `string` → `Presence`/`TrustLevel`
  (`delegated.ts` — on #41's branch, so folded into a facade pass, not touched here).
- **#5 + #6 (noun/verb discipline) in the design.** `intent-rail-design.md` now specs the
  rail under `/credentagent/intents/*` mirroring the SDK verb-for-verb —
  `POST /intents` (preApprove), `POST /intents/:id/spend` (spend),
  `POST /intents/:id/revoke` (revoke) — never `/intent/delegate`, `/intent/redeem`, or the
  self-contradictory `/intent/grants`. The new rail code (`redeem.ts`) keeps the
  facade's field names (`delegationId`, `reason`, `retryable`) so it does not fork.

---

## Needs your review — security-critical (do NOT ship unattended)

### #1 · Make `spend()` idempotent-echo on replay-of-committed  ·  HIGH · non-breaking
**The footgun:** `paymentId`'s JSDoc calls it an idempotency key, but a retry of an
already-committed draw returns `{ok:false, reason:"replay", retryable:"terminal"}`. An
unattended agent that safely retries a timed-out `paymentId` gets a terminal refusal and,
doing the natural next thing, uses a **new** id → passes every gate → **double-buys**.
Latent only because demo settlement is suppressed. This is the exact inverse of Stripe
idempotency.
**Change:** when `checkDraw`/`commitDraw` would refuse `replay`/`consumed`, first look up
the already-committed draw for that `pspTransactionId` on this intent and **echo its
recorded success** `{ok:true, amount, remaining, delegationId}` instead of refusing.
`RevocationStore` already holds the `CommittedDraw` — surface its amount + delegationId.
Only a previously-**refused** request replays the refusal. Add an optional
`idempotencyKey` to `PreApproveOptions` too (today `preApprove` mints a fresh keypair per
call, so a crash-retried mint yields a different `intentId`).
**Why review-gated:** it changes the behavior of the single-use control in the
security-critical `completeOrder` path (invariant 1). It is the *correct* idempotency
semantics — but it must echo the recorded result exactly, never re-execute, and be keyed
on the identical request. Wants its own tests, each red-when-removed, and your eyes.
> Applies identically to the intent rail's `/spend` — bake the `Idempotency-Key` contract
> into the rail before it ships, not after.

---

## Apply-now — additive, safe, high value (facade pass, rides #41)

### #2 · `SpendResult` → discriminated union on `ok`  ·  HIGH · source-compatible
`export type SpendResult = { ok:true; amount; remaining; delegationId }
| { ok:false; amount; remaining; reason:RefusalCode; retryable:RefusalRetryable; refusal:Refusal }`.
Runtime shape unchanged; the exported type just tightens so `if (res.ok)` narrows.
Existing readers already gate on `ok`. **Apply to `RedeemResult` in lockstep** so the
rail and facade stay identical (the new rail code is deliberately shape-matched to the
current flat `SpendResult` so they can flip together, not fork).

### #3 · Carry the full typed `Refusal`; move `remaining` into the seam  ·  HIGH · additive
`checkDraw` deliberately **accumulates** every failure with actionable detail
(over-cap→`{cap,amount}`, out-of-scope→`{merchant}`), but the facade collapses to
`refusals?.[0]` → `code` only. Add `refusal: Refusal` (or `refusals: Refusal[]`) to the
`ok:false` branch; keep `reason`/`retryable` as shortcuts. And return `remaining` from
`completeOrder`/`checkDraw` so facade and rail read **one** number instead of each
re-deriving `totalAmount − Σ priorDraws` (the rail already re-derives it in
`redeem.ts:headroom` — the predicted drift; delete it once the seam returns it).

### #7 · Disclose the rest of the bounds model through `PreApproveOptions`  ·  MED · additive
`IntentBounds` + `checkDraw` fully support `expiresAt`/`notBefore`, `stepUpOver`, `skus`,
multi-merchant, and non-USD `currency`, but `PreApproveOptions` exposes only
`merchant`(singular)/`perOrder`/`total`/`description`/`subject` and hardcodes USD. The
flagship "shop while you sleep" grant can't be given an expiry or a per-draw step-up
ceiling and is locked to one merchant — powerful-by-disclosure (#1) + no-hidden-magic
(#11). Widen `merchant: string | string[]`; thread each option into `sealIntent`.

### #8 · Fix `retryable`: `not-yet-valid` is not terminal  ·  MED · additive
`not-yet-valid` means `now < notBefore` — the grant becomes spendable **later** — yet it's
classed `terminal`, telling the unattended loop (the exact consumer this field exists for)
to give up forever on a grant that works in an hour. Map it to `retry` (or a `retry-after`
class carrying `notBefore`) and audit the whole code→retryable map.

### #11 · Facade parity: `revokeSubject`, `revoke(id)`, read-only `status()`  ·  MED · additive
The demo narrative is "you change your mind, from your phone" — a *different process* that
doesn't hold the in-memory grant object. Add `DelegatedGate.revoke(intentId)` +
`DelegatedGate.revokeSubject(subject)` (one-liners over `ctx.revocation`, already held) so
you can revoke after a restart, and `grant.status()`/`grant.remaining()` so planning
("can I afford this?") doesn't require firing a `spend`.

### #12 · Make unknown-item survivable for the loop  ·  MED · additive
`createOrder` throws on an unknown id, so one hallucinated item crashes the whole
autonomous loop. Add `gate.items(): string[]` / `gate.knows(item): boolean` to pre-filter
a model-generated list, and throw a typed `UnknownCatalogItemError` (carrying
`item` + `knownItems`) instead of a bare `Error`. Keep it a throw (a programming error,
not a gate decision) — just make it catchable by type.

### #13 · Make the honesty fence load-bearing, not prose  ·  MED · additive
The raw exported `sealIntent` will stamp any rung — a caller could seal a demo grant
labeled `issuer-verified` and `checkDraw` never reads `presence`/`trust_level`. Have
`sealIntent` (or a guard) **refuse** a not-yet-built rung (reject
`trust_level:"issuer-verified"`) until the wallet-server increment lands. The money fence
today holds only because `completeOrder` suppresses settlement for *all* draws.

---

## Rail-shape — pin before the rail ships (all free pre-ship)

### #9 · An `IntentStore` seam so the rail can feed the seam  ·  MED · additive
`completeOrder`'s draw branch needs the **full** sealed `{intent: IntentBounds, draw}` —
but nothing persists minted bounds (`RevocationStore` holds only revoked-sets + committed
draws). The facade sidesteps this by holding bounds in the in-memory `DelegatedGrant`; the
rail has nowhere to hold them, so both `{intentId, draw}` resolve and `GET /intents` (list)
are unbuildable. Add an `IntentStore` seam (`put`/`get`/`list({subject?,status?})`) that
`preApprove` + the rail's create write and `spend` + list read. **This is the
"active-grants listing needs a store extension" NOTE flagged in `redeem.ts` — same seam.**

### #10 · Pin rail result + one error door  ·  MED · free pre-ship
Rail returns exactly `SpendResult` (incl. `delegationId` + typed refusal). A gate
**decision** (any `RefusalCode`) is HTTP **200** `{ok:false, reason, retryable, refusal}`;
only a malformed request or unknown item is 4xx. Address the intent in the URL and let the
ES256-signed draw self-identify (`POST /intents/:intentId/spend` body `{draw}`; server
cross-checks `:intentId === draw.intentId`) — no redundant top-level `{intentId, draw}`.
Two error doors (branch-on-`ok` for the SDK, HTTP-status for the wire) fails consistency
(#4). *(Design doc already adopts the URL shape + `{draw}` body.)*

### #14 · Factor out `grant.sign(purchase): Promise<Draw>`  ·  LOW · additive
Same signing path for the bundled facade AND a client that posts an already-signed draw to
the rail. Document that the facade holds `K_s` only in the demo increment; the
wallet-server increment moves signing client-side **without changing the verbs**.

---

## Deferred — breaking, worth it only aliased at the next major

### #5b · `DelegatedGrant` → `Intent`, `SpendResult.delegationId` → `intentId`  ·  breaking
One object is named four ways (`DelegatedGrant`/`grant.id` · `IntentBounds`/`intentId`/
`int_` · audit `delegationId`). Unify on `intent`; `delegationId` **is** the intent id.
Emit both, old as a deprecated alias. Reserve `grant` for prose (collides with OAuth
grants in the wallet-server system).

### #15 · Naming polish (aliased): `total`→`budget`, `Purchase`→`SpendParams`, `paymentId`→`reference`  ·  breaking
`total` under-carries its "lifetime, never-resets" meaning (`budget` pairs with the
existing `remaining`); `Purchase` names a request as if it were a record; `paymentId`
implies server-issued lineage it doesn't have (maps to `draw.pspTransactionId`). Real
wins, but each renames a shipped exported name — do it only aliased.

### #16 · Give the human-present flow a `presence` axis  ·  LOW · additive but invasive
Add `presence: "live"` to the `PasskeyMandate` and share **one** `Presence`/`TrustLevel`
pair across both flows, so "when did consent happen? / how strongly bound?" is a uniform
question on every mandate the library emits. Defer until #4's shared types settle (the
`Presence` union added this session is the seed).

---

## Review follow-ups (from the pre-commit review of this increment)

The independent review confirmed the security core sound (age-non-delegable, fail-closed,
and revoked controls each verified red-when-removed by mutation). Fixed before commit: the
rail is now in the build (`tsconfig.json`), the honesty narrowing's 5 latent type errors
are resolved (`revocation` made optional to match `statelessOrders`; two fixtures moved off
the invalid `"issuer-verified (demo PKI)"` label; the fail-closed test annotation), and the
intent tests are typechecked (`tsconfig.test.json`) so honesty-in-types is enforced. Open:

- **Typecheck ALL test files, not just the rail's.** `tsconfig.test.json` still typechecks
  only `types.test-d.ts` + the intent tests. Extending it to `src/**/*.test.ts` is blocked
  on **6 pre-existing errors** unrelated to this work — a removed cbor `useTag259ForMaps`
  option (3×) + two mdoc-iso overload mismatches. Clear those, then widen the include so the
  whole suite's types are CI-enforced.
- **`redeemDraw` coarse-reason (minor).** It maps only `refusals[0].code`; a completion that
  refuses via the coarse `reason` path (`reprice`/`reconcile`) with no `refusals` returns
  `reason: undefined`. Unreachable in the normal flow (orders are catalog-priced via
  `resolveOrder`), so a hand-built order is the only trigger. Map the coarse reason if that
  path ever becomes caller-reachable.
- **`headroom` display on a ledger-read failure (minor).** On the fail-closed refusal
  (`revocation-unavailable`), `remaining` reads the full cap because the committed-draw read
  threw. Gate is correctly closed; the number is just stale. Mark it unknown when the ledger
  is down.
- **`RedeemContext` two-seam footgun (minor).** `completion` + `revocation` are injected
  independently; if a caller wires them to different stores, a revoked grant could still
  complete. `mountCeremony` wires both from one store (safe today) — in the routes phase,
  derive both from a single context so they can't disagree.

## Suggested order

1. **#1** (idempotency echo) — with your review; it's the real safety fix.
2. **#2 + #3 + #4-getters** — one facade pass: union + carry refusal + seam-owned
   `remaining` + narrow the getters. Flip `RedeemResult` in lockstep.
3. **#9 + #10** — the `IntentStore` seam + result parity, then build the rail's
   `routes.ts`/`page.ts` on top (the deferred half of this increment).
4. **#7, #8, #11, #12, #13** — additive facade crispness, any order.
5. Breaking renames (#5b, #15, #16) — batched behind deprecated aliases at the next major.
