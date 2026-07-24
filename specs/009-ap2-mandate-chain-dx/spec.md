# Feature Specification: The Consent SDK Surface (AP2 mandate chain, three enforcement paths)

**Feature branch:** `009-ap2-mandate-chain-dx` · **Issue:** #92 · **Date:** 2026-07-20
**Informs:** #17 (`credentagent.gate()`), #12/#69–71 (delegated grants), #39/#40 (wire format)

## Overview

This is the authoritative developer surface for CredentAgent's consent flow: how a developer
gates a consequential agent action behind a proven wallet credential, across the **three
situations** that genuinely differ — a hosted page, a page-less MCP tool, and a human-not-present
delegated spend — plus how the AP2 mandates (Intent / Cart / Payment) are exposed.

The surface below is the output of a **9-round adversarial DX review** (four cold-reader personas
+ a four-lens Stripe-grade council per round; see "Design journey"). The architecture was
validated and the council directed it to be **frozen**; the final version applies its full set of
consistency/naming fixes. The **spine** — one configured client, one catalog price source, one
policy array, one typed result door, Money-as-type, `trustLevel` on every branch — is Stripe-grade
and MUST NOT regress.

## The surface (caller-first — this IS the DX test)

```js
import { CredentAgent, required, age, payment, usd } from "@openmobilehub/credentagent-gate";

// ── Configure once ─────────────────────────────────────────────
const credentagent = new CredentAgent({
  origin: "https://shop.example",            // your RP origin; mount() serves the /approve ceremony here
  catalog: { wine: usd.dollars(20) },        // the ONE price source. Money is OPAQUE: compare with .lt()/.gte()/.eq(); .serialize() to the wire
});
credentagent.mount(app);
const policy = [ required(age.over(21)), required(payment.in("usd")) ];   // credentials — payment is just one of them

// ══ ONE CONTRACT (learn once) ═════════════════════════════════
//   PRICED INPUT:  order = { id?, items: [{ sku, qty }] }   // priced from the catalog; you NEVER pass an amount
//   RESULT DOOR:   if (res.ok)            res.mandateBundle  // + res.authorization: "direct" | "delegated"
//                  else if (res.pending)  res.approveUrl     // send to the human; then re-check / the agent re-calls
//                  else                   res.code           // switch on this; res.credential names which credential, when relevant
//   res.trustLevel ALWAYS present (every branch): "presence-only-demo" today — disclosure+binding, NOT issuer trust.
//   res.code ∈ "under-age" | "payment-declined" | "no-membership" | "budget-exceeded" | "per-spend-exceeded" | "revoked" | …
//
//   TWO RESOURCES + one top-level wrapper:
//     orders   one-shot verification   ≈ Checkout Session / PaymentIntent    orders.create()→{id,approveUrl} · orders.retrieve(id)→door
//     grants   durable spend authority ≈ SetupIntent + off_session           grants.create()→grant · grants.retrieve(id)→grant · grant.spend()/.revoke()
//     credentagent.gate(handler,{policy})  gate ANY page-less tool — ACTION-AGNOSTIC (a purchase, a records release,
//                                          a deploy). Top-level, NOT under `orders`: identity leads, payment is one
//                                          application. Its RETURN is the door.

// ── orders — you host the consent page ─────────────────────────
server.registerTool("checkout", inputSchema, async (args) => {
  const { id, approveUrl, manifest } = await credentagent.orders.create({ order: { items: cartItems(args) }, policy });
  return { structuredContent: { id, approveUrl, manifest } };   // keep id — retrieve the door by it
});
// later — the gate fires "order.settled"; your handler does ONE retrieve (never a poll loop):
credentagent.on("order.settled", async ({ id }) => {
  const res = await credentagent.orders.retrieve(id);          // the DOOR: res.ok / res.pending+approveUrl / res.code
  if (res.ok) { /* complete + settle res.mandateBundle.paymentMandate */ }
});

// ── credentagent.gate() — gate ANY page-less tool (here a NON-commerce action) ──
server.registerTool("release-records", inputSchema, credentagent.gate(
  async (args) => ({ structuredContent: await releaseRecords(args) }),   // runs ONLY on ok — an unverified caller never reaches it
  { order: (args) => ({ id: args.subject }), policy: [ required(age.over(21)) ] },   // no items → a pure identity gate; no purchase
));
//   { ok:true,  structuredContent, mandateBundle, authorization, trustLevel }
//   { ok:false, pending:true, approveUrl, resume:"release-records", trustLevel }    // agent proves, re-calls
//   { ok:false, code:"under-age", credential:"age", trustLevel }                    // proven but failed policy

// ── grants — authorize once, spend later (human not present) ──
// (A) human PRESENT — create, persist id (exists before they prove), send approveUrl:
const grant = await credentagent.grants.create({ merchant: "utopia", budget: usd.dollars(100), perSpend: usd.dollars(30), policy });
await store.save(userId, grant.id);
sendToUser(grant.approveUrl);
// (B) LATER, worker/cron — human AWAY — rehydrate, gate on status, spend:
const grant = await credentagent.grants.retrieve(await store.load(userId));   // grant.status: "pending" | "authorized" | "revoked" | "denied"
if (grant.status !== "authorized") return;
for (const purchaseId of purchasesToMake()) {
  const s = await grant.spend({ idempotencyKey: purchaseId, items: [{ sku: "wine", qty: 1 }] });   // durable key → s.replayed on a safe retry
  if (!s.ok) { if (s.code === "budget-exceeded") break; throw new Error(s.code); }   // "per-spend-exceeded" | "revoked"
  forwardToPsp(s.mandateBundle.paymentMandate.serialize());     // authorization:"delegated" is stamped INTO the serialized mandate
  if (s.remaining.lt(usd.dollars(20))) break;                   // Money comparison — never a raw scalar
}
await grant.revoke();                                           // grant.status → "revoked"; next spend → { ok:false, code:"revoked" }
```

## Requirements

### Functional Requirements

- **FR-001 — One configured client.** `new CredentAgent({ origin, catalog })` + `mount(app)`; every
  path hangs off it. No second client, no per-path config door.
- **FR-002 — One priced input.** `order = { id?, items: [{ sku, qty }] }` on every path; the gate
  re-prices from the catalog server-side. A caller NEVER passes an amount (invariant #2).
- **FR-003 — One result door.** `{ ok } | { ok:false, pending, approveUrl } | { ok:false, code,
  credential? }`, with `res.trustLevel` and (on `ok`) `res.authorization` present on **every** branch
  of **every** path. `code` is the switchable enum; `credential` names the failed credential; a
  lifecycle refusal (`revoked`) is a `code`, never a credential.
- **FR-004 — Two resources, symmetric.** `orders.create()/retrieve(id)` and `grants.create()/
  retrieve(id)` — both awaited, both return an `id` from the mint, both retrievable by it. Orders are
  one-shot verifications (retrieve → verdict); grants are durable (retrieve → handle with `status` +
  `spend()`/`revoke()`). **`credentagent.gate(handler, opts)`** is the top-level, **action-agnostic**
  page-less wrapper — it gates ANY consequential tool (a purchase, a records release, a deploy), so it
  lives on the client, not under a commerce resource (thesis: identity leads, payment is one application).
- **FR-005 — Money is a type.** `usd.dollars(n)`; opaque (no public scalar); compared via
  `.lt()/.gte()/.eq()`, combined via `.plus()/.minus()`, emitted via `.serialize()`.
- **FR-006 — MandateBundle on `ok`.** `{ intentMandate?, cartMandate, paymentMandate }`, each with
  its own `trustLevel` and `.serialize()`. `authorization: "direct" | "delegated"` rides on the result
  AND is stamped into the serialized `paymentMandate` (so a PSP can't mistake an off-session,
  human-away mandate for a live presentation).
- **FR-007 — Delegated lifecycle.** `grants.create()` returns `grant.id` immediately (before the human
  proves), so it persists across the authorize-now / spend-later process boundary; `grants.retrieve(id)`
  rehydrates; `grant.status` gates spending; `idempotencyKey` is a durable per-purchase key
  (`s.replayed` on a safe retry).
- **FR-008 — Additive.** Layers over today's `requirements()`/`mount()`, the retained Mode-B envelope,
  `DelegatedGate`, and the existing `ap2.CartMandate`/`ap2.PaymentMandate`/`IntentBounds`. Ships without
  breaking their current callers; `delegate()` may remain a thin alias of `grants.create()` during
  migration.
- **FR-009 — Completion signal, never a poll loop.** The async "human finished proving" transition is
  delivered by a **webhook/callback** — `credentagent.on("order.settled", …)` plus a return-URL redirect
  for the human — mirroring Stripe's `success_url` + `checkout.session.completed`. `orders.retrieve(id)`
  is a **single current-state read** (for the callback handler, or a fallback), and an optional
  `orders.awaitProof(id, { timeout })` resolves when settled. A hand-written poll loop MUST NOT be the
  documented path. The page-less `credentagent.gate()` path needs **no** signal — the agent's re-call is the trigger.
- **FR-010 — Intent Mandate production (grants only).** The AP2 **Intent Mandate** is produced in the
  `grants` flow, at the one-time authorize ceremony (`grant.approveUrl`) — **not** in `orders` (a
  human-present order signs the **Cart** Mandate directly, so `mandateBundle.intentMandate` is absent).
  At authorize, the human's wallet **seals the bounded intent** — merchant, `perSpend`, `budget`, `policy`,
  expiry, and the delegate key permitted to sign later spends — into the Intent Mandate; it then rides on
  `grant.intentMandate`, and every subsequent spend's Payment Mandate references it. Today it is
  **dev-sealed** (content-addressed integrity hash, `sealIntent`), `trustLevel: "presence-only-demo"`; the
  roadmap swaps the internals so the wallet **key-signs** it during the live ceremony (KB-JWT/SD-JWT —
  #14/#39/#71) with no change to this surface.

### Honesty (Constitution VII — load-bearing)

- **HR-001** — `trustLevel` is `"presence-only-demo"` everywhere today (dev-signed integrity hash, NOT
  issuer/key-signed). No prose, comment, or field may imply issuer-verified trust or real settlement.
  The example says "seals/binds (dev-signed)", never "signed".
- **HR-002** — On a delegated spend the human is absent; `authorization:"delegated"` + the fact that
  `trustLevel` describes the *authorize* ceremony (not the spend) must be visible on the result and in
  the serialized mandate. "presence-only" must never assert a presentation that didn't happen.

## Success Criteria

- **SC-001** — A cold reader picks the right path for each of the three canonical tasks (page checkout,
  page-less tool gate, human-away budget) without re-reading, and writes the call in ~one declarative line.
- **SC-002** — `if (res.ok) … else if (res.pending) … else switch (res.code)` compiles and is correct on
  **every** path (byte-identical door).
- **SC-003** — No amount is ever passed by the caller; a hand-edited price cannot change what settles
  (bypass test).
- **SC-004** — Every mandate and every result carries its `trustLevel`; a bypass test asserts nothing reads
  as issuer-verified, and that a delegated mandate is marked as such through serialization.

## Design journey (why these choices — the 9-round DX review)

Scored 1–5 for Stripe-ease by four independent cold-reader personas each round; a four-lens council
audited against `architecture-principles.md` + the constitution.

| v | Score | What the round forced |
| --- | --- | --- |
| 1 | 3.67 | "three libraries stapled together"; honesty fence missing from the types |
| 2 | 3.25 | one client + shared policy + `trustLevel`; over-corrected (purchase-in-tool went homeless) |
| 3 | 3.50 | named present-pair; delegate consent ceremony surfaced; money/trust contracts |
| 4 | 3.75 | one `{ok,reason}` door; catalog prices every path (kills agent-supplied-total) |
| 5 | 3.70 | uniform input; the `ok`-on-success bug; `usd()` money helper; idempotent replay |
| 6 | 3.67 | contract-first framing (learn once, then thin triggers); honesty-prose fix |
| 7 | 3.75 | `proveUrl` on every result; **grant.id + rehydrate**; `requireInTool` third door; Stripe-analogue map |
| 8 | 3.75 | **Stripe resource idiom** (`grants.create/retrieve`); specific refusal tokens; `spend().remaining` |
| 9 | 3.75 | council froze the spine; final renames (below) |

**Why it asymptotes at ~3.75, and why that is "nailed":** the score plateaued for six rounds because
(a) a Stripe-veteran reader structurally anchors a *novel* consent API at 3–4 versus Stripe's decade of
refinement, and (b) adversarial cold-readers always surface ~3 fresh consistency nits on any snippet. The
council's own round-9 verdict — *"the spine is genuinely Stripe-grade and should be FROZEN; none require
new surface — all are renames"* — is the true exit signal. The architecture is validated; the remainder was
a naming pass, now applied.

**Final naming pass applied (round-9 fixes):** `reason`+`detail` → `credential`+`code` (matches no-collision
with the shipped `envelope.ts`); `reason:'revoked'` → a `code` / `grant.status`; `orders.require` →
`orders.create` (awaited, symmetric with `grants.create`); mint returns `id`; `Money` made opaque;
`proveUrl` → `approveUrl` (aligns with the shipped `approve_url`); `authorization` stamped into the
serialized paymentMandate.

**Post-lock reconciliation (2026-07-21):** the page-less wrapper — designed here as `orders.gate` /
earlier `requireInTool` — is **`credentagent.gate(handler, opts)`**, top-level and **action-agnostic**.
The `#17` session shipped it as `credentagent.gate()`, and that name wins over `orders.gate`: gating a
*non-commerce* tool (a records release, a deploy) shouldn't live under a commerce resource — "identity
leads; payment is one application." So `orders` and `grants` stay resources (the checkout and delegated
*lifecycles*), while `gate()` is the general page-less primitive on the client. The design journey above
predates this call; the surface + FR-004 reflect it.

## Out of Scope

- Wire-format / SD-JWT serialization (#39) and Python-SDK conformance (#40) — this owns the surface, not the wire.
- Real key-bound / issuer-verified signing (#14).
- Reworking `DelegatedGate`/intent-rail internals (#12, #69–71) — this is their surface, additive.
- Implementation — this spec is design only; `plan.md` sequences the build over the existing primitives.

**On the prototypes:** `examples/orders-proto/` and `examples/grants-proto/` are **validation demos** — facades
that *stand in for* the API to prove the design runs; they are not the shipping library code. They graduate
into the real `credentagent.orders.*` / `credentagent.grants.*` API in **#97** (the demos get rewired to the
real API rather than deleted, so nothing is thrown away).

## Dependencies

- #17 (`credentagent.gate()` — the top-level, action-agnostic page-less wrapper; SHIPPED on `feat/17`).
- #12 / #69–71 (`grants` = the delegated surface over the intent rail).
- Constitution I (Stripe-grade, no grab-bags) and VII (honesty in types); Security invariants #1–#6.
