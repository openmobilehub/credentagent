# Security invariants

The contributor guardrail for [`@openmobilehub/attesto-gate`](../../packages/attesto-gate).
These six controls are **load-bearing**. A change that breaks one is **blocking — even in
demo code** — and it must be reverted or fixed before merge. They are also the standing
review rubric: the automated Claude review and every human reviewer check a diff against
this list, and they mirror Principle 8 (Security Requirements) of the
[Attesto SDK constitution](../../.specify/memory/constitution.md).

These are not aspirational. Every invariant below is enforced in real code in this package
and pinned by a **bypass test** — a test that POSTs the attack and asserts it is refused. A
test that would still pass with the security control removed is not a useful test, so the
bypass test must fail if you delete the control it guards.

> **Honesty boundary.** Attesto v0.1 is `trust_level: "presence-only-demo"`. The *wire
> crypto* is real — WebAuthn assertion verification, OpenID4VP JWE/ECDH-ES decryption with
> nonce binding, HPKE-decrypt of the iOS `org-iso-mdoc` path, and ISO 18013-5 mdoc parsing
> all run for real. What is **not** yet real is the **issuer / device-signature trust
> anchor**: the mdoc's issuer and device COSE signatures are not checked against a CA (the
> reference server self-signs its mdoc certs), and the AP2 mandate is dev-signed
> (`alg: "MOCK-DEV-SIGNER"`). A presence-only gate proves *a credential was disclosed and
> bound to this request* — it does **not** prove the issuer vouched for it. Never present a
> presence-only gate as a real safety control. Issuer-verified trust is the v0.2 line. The
> invariants below are exactly what *can* be enforced honestly today; do not let "it's a
> demo" become a reason to weaken any of them.

---

## 1. Enforce gates on EVERY completion path — never just the rendered page

**The rule.** Age / payment / authorization checks must run server-side on *every* code path
that can complete an order — the MCP completion tool, `place-order`, and each rail's
`/verify` handler — not only in the checkout HTML. **Hiding a button is not enforcement.**

**Why it's load-bearing.** The agent and a hand-crafted HTTP client can hit the completion
endpoints directly, skipping the page entirely. The page is a convenience for a human; it is
never the trust boundary. If a check lives only in the rendered checkout, an agent that POSTs
straight to the completion endpoint sails past it.

**How it's enforced.** The shared completion seam,
[`ceremony/completion.ts`](../../packages/attesto-gate/src/ceremony/completion.ts), is the
*one* path every rail records through. `completeOrder()` re-runs the deterministic gates
(`input.gates.every((g) => g.pass)`) and re-derives the age restriction from the
catalog-priced lines, refusing an age-restricted order that carries no positive per-order age
claim — **regardless of which rail called it**:

```ts
const ageRestricted = repriced.lines.some((l) => typeof l.minimumAge === "number" && l.minimumAge > 0);
if (ageRestricted && verification?.ageVerified !== true) {
  return { completed: false, reason: "age" };
}
```

Because `completeOrder()` is injected-seam based (no rail-specific imports), the passkey rail,
the `dc-payment` rail, and the storefront's `place-order` all reconcile against the *same*
logic. The honesty axis lives in the types, not prose: the manifest carries
`enforcedAt: "tool" | "checkout"`
([`manifest.ts`](../../packages/attesto-gate/src/manifest.ts) /
[`types.ts`](../../packages/attesto-gate/src/types.ts)), so a host that can only enforce on
the page says so out loud rather than implying server-side enforcement it doesn't have.

**Bypass test.** `storefront-gate.test.ts` (repo root) — *"REFUSES an age-restricted,
unverified order — the handler never runs"* — asserts the consequential handler is never
reached for an unverified age-restricted order.
[`ceremony/credential-gate/credential-gate.test.ts`](../../packages/attesto-gate/src/ceremony/credential-gate/credential-gate.test.ts)
(CT8) asserts the shared completion seam *"refuses an unverified age-restricted order … even
with a valid payment."*

---

## 2. Never trust the order token — re-derive amounts and flags from the catalog

**The rule.** The order token is **unsigned, base64url JSON, and hand-editable**. It is never
authoritative. Always **re-derive** amounts, line totals, the age restriction, and any flags
from the cart/catalog server-side, and refuse on mismatch.

**Why it's load-bearing.** An attacker can edit the token to lower the total, drop an age
restriction, or claim a discount they never earned. If any completion path reads the price (or
the `minimumAge`) *from the token*, the token becomes a self-asserted authorization — the
classic "trust the client" hole.

**How it's enforced.** `completeOrder()` re-prices the lines against the catalog and refuses
if the inbound total disagrees
([`completion.ts`](../../packages/attesto-gate/src/ceremony/completion.ts)):

```ts
const repriced = ctx.catalog.createOrder(items, input.order.id, { loyaltyApplied });
if (repriced.total !== input.order.total) return { completed: false, reason: "reprice" };
```

Every credential-gate route resolves the order **through** `resolveOrder` (catalog re-pricing;
a tampered or unknown id is refused), and the required age threshold is re-derived from the
re-priced lines via `requiredAgeForOrder(order)`, never the token
([`ceremony/credential-gate/routes.ts`](../../packages/attesto-gate/src/ceremony/credential-gate/routes.ts),
[`verify.ts`](../../packages/attesto-gate/src/ceremony/credential-gate/verify.ts)). Both
payment rails re-sum the cart lines in their Gate 1 and ignore the stored `payment.amount`
([`ceremony/mandate.ts`](../../packages/attesto-gate/src/ceremony/mandate.ts),
[`ceremony/dc-payment/verify.ts`](../../packages/attesto-gate/src/ceremony/dc-payment/verify.ts)).

**Bypass test.**
[`ceremony/mount.test.ts`](../../packages/attesto-gate/src/ceremony/mount.test.ts) — *"refuses
a tampered total (re-derived from the catalog, not the token)."* CT8 in
[`credential-gate.test.ts`](../../packages/attesto-gate/src/ceremony/credential-gate/credential-gate.test.ts)
— *"re-prices a hand-edited (tampered) stored total from the catalog, never the token,"* and
*"refuses an unknown order id (400) — the amount has no catalog source."*

---

## 3. Discounts must reconcile with amount binding across ALL payment paths

**The rule.** Any discount must keep the **line sum**, the **order total**, and the **signed
payment amount** in agreement across *every* payment path (passkey, dc-payment, instant-demo).
A discount one path accepts and another refuses is a bug.

**Why it's load-bearing.** A discount lowers the amount the wallet authorizes. If the rails
disagree about how the discount is computed — or if a token can simply *claim* a discounted
total without the verification that earned it — an attacker pays less than the goods cost, or
worse, an under-charge that one rail blesses slips through another. Amount binding is the whole
point of binding the wallet's signature to a transaction; a divergent discount silently
unbinds it.

**How it's enforced.** Both rails compute the discount identically from a single shared
constant (`DEFAULT_LOYALTY_DISCOUNT_PCT` in
[`ceremony/mandate.ts`](../../packages/attesto-gate/src/ceremony/mandate.ts)) and require it to
be **exactly zero or exactly the configured percentage** of the re-summed line total — an
arbitrary discount is refused:

```ts
const discount = cart.discount ?? 0;
const discountOk = discount === 0 || discount === round2(lineSum * (pct / 100));
const payable = round2(lineSum - discount);
const amountOk = discountOk && payable === cart.total && payable === mandate.payment.amount;
```

The `dc-payment` rail additionally re-checks `payable` against the amount inside the
device-signed `transaction_data`
([`ceremony/dc-payment/verify.ts`](../../packages/attesto-gate/src/ceremony/dc-payment/verify.ts)).
Critically, a discount only *exists* when **this order's** verification opted into it:
`completeOrder()` reads `verification.loyalty.applied` and re-prices with that flag, so a token
merely *claiming* the discounted total reprices higher (no loyalty applied) and is refused
([`completion.ts`](../../packages/attesto-gate/src/ceremony/completion.ts)).

**Bypass test.** CT8 in
[`ceremony/dc-payment/dc-payment.test.ts`](../../packages/attesto-gate/src/ceremony/dc-payment/dc-payment.test.ts)
— *"a membership-discounted order authorizes the discounted total (no path divergence)"* —
asserts the bound amount equals the re-derived *discounted* total and completes, with the same
amount-binding gate that rejects a tampered (under-)amount in the same suite.

---

## 4. Scope verification / cart state per order or session id — never process-global

**The rule.** Verification and cart state must be keyed by the **order/session id** carried in
the gate URL. Never store it in a single process-global slot.

**Why it's load-bearing.** A single shared key means **one user's verification unlocks
checkout for everyone**. If shopper A proves they are 21+ and that result lands in a
process-global flag, shopper B's age-restricted order completes on A's proof — cross-user
bleed. On a serverless / multi-instance deployment the same bug also lets stale state from one
request leak into an unrelated one.

**How it's enforced.** The verification store is a map keyed by `orderId`, with no global
fallback ([`store.ts`](../../packages/attesto-gate/src/store.ts)):

```ts
read(orderId: string)  { return this.records.get(orderId); }
write(orderId, record) { this.records.set(orderId, record); }
clear(orderId: string) { this.records.delete(orderId); }
```

The credential-gate verify handler persists success scoped to *this* order
(`recordVerified(ctx, order.id, …)`), and `completeOrder()` reads, refuses, and clears
strictly by `input.order.id`
([`routes.ts`](../../packages/attesto-gate/src/ceremony/credential-gate/routes.ts),
[`completion.ts`](../../packages/attesto-gate/src/ceremony/completion.ts)). Two `Attesto`
clients keep distinct stores — there is no shared static. For serverless, swap in a Redis
(Upstash) implementation of `VerificationStore`; the per-key contract is unchanged.

**Bypass test.**
[`client.test.ts`](../../packages/attesto-gate/src/client.test.ts) — *"two clients keep
distinct stores (no cross-instance bleed)."* The completion suite additionally asserts a
completed order **clears its own** per-order verification so a replay can't reuse it.

---

## 5. Require explicit positive credential claims — and match the threshold

**The rule.** Verify the **actual positive claim** (e.g. `age_over_21 === true`), not merely
that *a token was present*. The threshold must match the product's restriction: **an 18+ proof
does not satisfy a 21+ gate.**

**Why it's load-bearing.** "A credential decrypted" is not "the user is old enough." A wallet
can disclose `age_over_21 === false`, or disclose only `age_over_18 === true`. Accepting token
*presence* — or accepting a lower-threshold proof — passes a minor through a 21+ gate. For
membership/discount, accepting a bare or unrelated claim grants a discount that lowers the
bound amount, so a forged loyalty state reduces the charge (ties back to invariant 3).

**How it's enforced.** The built-in `age` credential checks the explicit positive claim *at
the requested threshold* ([`credentials.ts`](../../packages/attesto-gate/src/credentials.ts)):

```ts
age.over(minAge) → verify: (claims) => claims[`age_over_${minAge}`] === true
```

There is one definition of "verified": both the instant-demo path and the real OpenID4VP /
mdoc paths flatten the disclosed claims and run the **same**
`age.over(N).verify` / `membership.discount().verify`, so there is no second source of truth
([`ceremony/credential-gate/verify.ts`](../../packages/attesto-gate/src/ceremony/credential-gate/verify.ts)).
The strict `=== true` survives mdoc decoding because booleans are preserved as booleans when
flattening. Membership requires a real, non-empty `membership_number` — a bare token does not
grant the discount.

**Bypass test.** CT4 in
[`ceremony/credential-gate/credential-gate.test.ts`](../../packages/attesto-gate/src/ceremony/credential-gate/credential-gate.test.ts):
*"REFUSES an age_over_18 proof for a 21+ gate (no sub-threshold acceptance)"* and *"REFUSES a
token-present-but-false claim (age_over_21 === false)."* The real-crypto paths assert the same:
*"FAILS a 21+ gate when only age_over_18 = true is disclosed (wrong threshold)"*
([`presentation.test.ts`](../../packages/attesto-gate/src/ceremony/credential-gate/presentation.test.ts))
and *"REFUSES a value-bypass: a decryptable token disclosing age_over_21=false does NOT pass"*
([`mdoc-iso.test.ts`](../../packages/attesto-gate/src/ceremony/mdoc/mdoc-iso.test.ts)).

---

## 6. Keep WebAuthn / OpenID4VP bound to this server's origin / RP-ID, with replay protection

**The rule.** Every WebAuthn assertion and every OpenID4VP presentation must stay bound to
**this** server's origin / RP-ID, with **nonce / replay protection**. Seal and check the nonce;
do not accept a presentation just because it decrypts, and do not accept a request that was
re-pointed at another origin.

**Why it's load-bearing.** A presentation produced for *another* relying party — or replayed
after its window — proves nothing about *this* transaction. Without origin binding, an attacker
re-points the request at their own origin and harvests a valid-looking proof; without replay
protection, one captured assertion is reusable. Decryption alone is not authorization.

**How it's enforced.**

- **WebAuthn (passkey rail).** The assertion is verified with `expectedOrigin` and
  `expectedRPID` derived from the request, and `requireUserVerification: true`. The challenge
  rides in a **sealed, time-limited, HMAC-signed token** keyed by the injected `signingKey`; a
  forged, key-swapped, or expired token is rejected *before* any attestation parsing
  ([`ceremony/passkey/verify.ts`](../../packages/attesto-gate/src/ceremony/passkey/verify.ts),
  [`ceremony/challengeToken.ts`](../../packages/attesto-gate/src/ceremony/challengeToken.ts)).
  Single-use within the window comes from binding the challenge into the assertion plus the
  idempotent completion seam, so a replay records nothing twice.
- **OpenID4VP (dc-payment + credential gate).** Each `/request` seals a **fresh ephemeral
  decryption key with a short TTL**, so a captured response only decrypts under the request
  that produced it. Nonce binding additionally rejects a response whose non-empty `apu`/`apv`
  is bound to a *different* nonce
  ([`ceremony/credential-gate/verify.ts`](../../packages/attesto-gate/src/ceremony/credential-gate/verify.ts)).
  The `dc-payment` rail re-derives the expected **payee** from the request origin and refuses a
  request re-pointed at another origin
  ([`ceremony/dc-payment/verify.ts`](../../packages/attesto-gate/src/ceremony/dc-payment/verify.ts)).
- **iOS `org-iso-mdoc`.** The `DeviceResponse` is HPKE-decrypted bound to the web origin via
  the ISO 18013-5 session transcript; a response sealed under a different origin fails to
  decrypt
  ([`ceremony/mdoc/`](../../packages/attesto-gate/src/ceremony/mdoc/)).

The origin / RP-ID is derived once from the request (honoring `x-forwarded-*` behind a
TLS-terminating proxy) in [`ceremony/origin.ts`](../../packages/attesto-gate/src/ceremony/origin.ts).

> This is real wire binding, **not** issuer trust. The COSE issuer/device signatures are *not*
> verified against a CA in v0.1 — see the honesty boundary above. Do not describe origin/replay
> binding as proof the credential is genuine; it proves it was disclosed *to us, for this
> request*.

**Bypass test.**
[`ceremony/challengeToken.test.ts`](../../packages/attesto-gate/src/ceremony/challengeToken.test.ts)
— rejects a forged/tampered signature, a token signed with a different key, and a token
replayed after its expiry window.
[`ceremony/dc-payment/dc-payment.test.ts`](../../packages/attesto-gate/src/ceremony/dc-payment/dc-payment.test.ts)
— *"fails the payee binding when the request origin/RP-ID does not match."*
[`ceremony/mdoc/mdoc-iso.test.ts`](../../packages/attesto-gate/src/ceremony/mdoc/mdoc-iso.test.ts)
— *"REJECTS a response sealed under a DIFFERENT origin's session transcript (HPKE info
mismatch)"* and *"REJECTS a tampered ReaderAuthAll signature."*

---

## Contributor checklist

Before you open a PR that touches a gate, a completion path, pricing, or a credential:

- [ ] Did you add or change a path that can **complete an order**? It must enforce gates
      server-side (invariant 1), not rely on the page.
- [ ] Did you read a **price, total, or age threshold**? Re-derive it from the catalog, not the
      order token (invariant 2).
- [ ] Did you touch **discounts** or amounts? They must reconcile across *all* payment paths and
      stay bound to the signed amount (invariant 3).
- [ ] Did you add **state**? Key it by order/session id, never process-global (invariant 4).
- [ ] Did you check a **credential claim**? Assert the explicit positive value at the correct
      threshold (invariant 5).
- [ ] Did you touch **WebAuthn / OpenID4VP / mdoc**? Keep origin/RP-ID binding and
      nonce/replay protection intact (invariant 6).
- [ ] Did you add a **bypass test** that fails if the control is removed? (A happy-path test is
      not enough.)
- [ ] `npm run build` green and `npm run test` green, including the bypass suite.
- [ ] Commit signed off (`git commit -s` — DCO).

A new gate should **mirror** the `dc-payment` / `passkey` / `credential-gate` structure
(`dcql` / `request` / `verify` / `page` / `routes` split) and reuse the shared helpers and the
shared `completeOrder` seam rather than copying them — that is how each new rail inherits these
invariants for free instead of re-deriving (and re-breaking) them.
