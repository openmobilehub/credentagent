# Feature Specification: Order Webhooks — a real HTTP completion signal

Increment under **#97** (Graduate the orders/grants prototypes into the real library API).
Sibling of the human-present checkout (`orders.serve`, PR #98). Benchmark: **stripe-node webhooks**.

## Overview

`credentagent.on("order.settled", …)` is an **in-process** listener: it fires only in the Node
process that completed the order, doesn't survive a restart, and can't reach a *different*
service. That is fine for a single-process server and useless for a real deploy where the
instance that finishes an order is often not the one that fulfills it.

This feature adds the **real** signal: when an order settles, the gate sends a **signed HTTP
POST** to endpoint URL(s) the developer registered, and the developer verifies it with a
one-call `constructEvent(...)` — exactly the shape a Stripe user already knows. The in-process
`on(...)` listener stays (it's the zero-config local path); the webhook is the durable,
cross-service path.

## Decisions *(locked; recorded here rather than as `needs-decision`)*

- **Stripe is the idiom.** The receive side mirrors `stripe.webhooks.constructEvent(rawBody,
  sigHeader, secret)` — same mental model, same one error door (verify → typed event, or throw).
- **The in-process `on(...)` stays and is unchanged.** The webhook is additive; a developer opts
  in by registering an endpoint. Neither replaces the other; the docs state when to reach for each.
- **Real crypto, honestly delivered.** The HMAC signature is real (this is *not* `presence-only-demo`
  — that label is about mdoc issuer trust, which is orthogonal). Delivery is **at-least-once** with
  retry; receivers must be **idempotent**. We never claim exactly-once or guaranteed delivery.

*(The concrete API surface, signature scheme, and delivery/verify design are locked by the DX
council synthesis — see [§ Design](#design-locked-by-dx-council) below.)*

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A different service learns an order settled (Priority: P1)

Fulfillment runs on a worker separate from the instance that completed the checkout. It registers
a webhook endpoint and receives a signed `order.settled` event over HTTP when *any* instance
settles an order — the in-process listener could never reach it.

**Acceptance:** an order settled on instance A delivers a POST to the registered URL; the worker's
`constructEvent` returns a typed event carrying the order id (and completion data).

### User Story 2 — A forged event is rejected (Priority: P1, security)

An attacker POSTs a fake `order.settled` (or replays a captured one, or flips a byte of the body)
to the fulfillment endpoint. `constructEvent` **throws** — the fulfillment never runs.

**Acceptance (load-bearing bypass tests — each must FAIL when its control is removed):**
- a body whose signature doesn't match the secret is rejected;
- a body tampered after signing (signature no longer matches) is rejected;
- a signature with a timestamp outside the tolerance window is rejected (replay);
- the wrong endpoint secret is rejected.

### User Story 3 — Retries + idempotency (Priority: P2)

The receiver is briefly down / returns 500. The gate retries with backoff. When the receiver
recovers it may see the same event twice; deduping on the event id makes fulfillment safe.

**Acceptance:** a failed delivery is retried; the delivered event carries a stable `id` a receiver
can dedupe on; re-delivery of the same event is observable and safe.

### User Story 4 — Zero-config local dev still works (Priority: P2)

A single-process dev server needs no endpoint registration and no secret ceremony to see
completions — the in-process `on(...)` listener already covers it. Adding a webhook endpoint is a
strictly additive step for when you deploy.

## Requirements *(mandatory)*

- **R1 — Additive.** No existing signature changes. `on(...)`, `orders.create/retrieve/serve` are
  byte-unchanged. A server that registers no endpoint behaves exactly as today.
- **R2 — One-call verify.** Receiving is a single `constructEvent(rawBody, signatureHeader, secret)`
  returning a typed event or throwing — no callback grab-bag, one error door (DX rubric).
- **R3 — Signature is a security control.** HMAC over `<timestamp>.<rawBody>`; a mismatch, a tampered
  body, a stale timestamp (replay), or a wrong secret is rejected. The secret is never logged. Each
  is pinned by a bypass test that fails when the control is deleted (per `write-bypass-test`).
- **R4 — Honest delivery semantics.** At-least-once + retry/backoff; a stable event id for idempotency;
  documented behavior on receiver downtime. No overclaim of guaranteed/exactly-once delivery.
- **R5 — Consistent with `orders.*`.** Same client, configure-once, typed plain-data results, naming
  that states what it does. The example is written first and needs no plumbing block.
- **R6 — Safe endpoints.** Endpoint URLs are developer-supplied config (not attacker-influenced);
  the delivery path documents its SSRF stance and does not follow redirects to internal hosts.

### Key Entities

*(Finalized from the council synthesis — see § Design. Expected: a `WebhookEvent` `{ id, type,
created, data }`, a registered endpoint `{ url, secret, events }`, and the signature header.)*

## Success Criteria *(mandatory)*

- **SC1** — Sending + receiving a verified `order.settled` event over HTTP takes a couple of
  declarative lines each (the example is the test).
- **SC2** — Every User-Story-2 bypass test fails when its control is removed.
- **SC3** — Full gate + storefront suites stay green; the feature is additive.
- **SC4** — README + types state the honest delivery semantics (at-least-once, idempotency) and
  when to use the webhook vs. the in-process listener.

## Assumptions

- Node's `crypto` (HMAC-SHA256, `timingSafeEqual`) is available; the package stays dependency-free
  (no new runtime deps; delivery uses global `fetch`).
- The developer owns the endpoint URL and its secret storage.

## Out of Scope (v1)

- A `stripe listen --forward-to` style local tunnel/CLI.
- A dashboard / persistent endpoint registry (endpoints are configured in code; a shared store is a
  later increment if needed).
- Events beyond the order lifecycle (grants/HNP events ride the same bus in a later increment).

## Design *(locked by DX council)*

The `webhook-dx-council` ran 4 independent designs (library-fit, Stripe-purist, security-first,
DX-minimalist) → an 8-vote judge panel. All four scored **9/10 on Stripe-idiomaticity** and
converged on the same shape; this locks their consensus plus the security-first design's precise
signature scheme.

### The locked example (the DX test)

```ts
// ── SENDING — the server that settles orders (configure once) ─────────────────
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const credentagent = new CredentAgent({
  walletOrigin: "https://shop.example",
  webhooks: { endpoints: [
    { url: "https://fulfillment.example/hooks", secret: process.env.FULFILLMENT_WHSEC }, // whsec_…
  ] },
});
credentagent.orders.serve(app);
// When an order settles, a SIGNED order.settled event is POSTed to each endpoint — retried,
// non-blocking. No delivery call to write. (credentagent.on("order.settled",…) still fires in-process.)

// ── RECEIVING — a DIFFERENT service; needs only the shared secret ─────────────
import express from "express";
import { constructEvent } from "@openmobilehub/credentagent-gate";

app.post("/hooks", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = constructEvent(req.body, req.get("CredentAgent-Signature"), process.env.FULFILLMENT_WHSEC);
  } catch (err) {
    return res.status(400).send(`webhook signature failed: ${err.message}`); // forged / tampered / replayed
  }
  if (event.type === "order.settled") fulfill(event.data.object.orderId); // dedupe on event.id (at-least-once)
  res.json({ received: true });
});
```

### API surface

```ts
// Receiving — two symmetric doors over one core (the Zod parse/safeParse idiom the DX rubric praises).
// STANDALONE (a receiver has no CredentAgent) + ca.webhooks.* convenience that delegate to these:
function constructEvent<T>(rawBody, sigHeader, secret, opts?): WebhookEvent<T>          // Stripe door — THROWS
function verifyEvent<T>(rawBody, sigHeader, secret, opts?): WebhookVerdict<T>           // repo-native door — never throws
function generateWebhookSecret(): string                                               // "whsec_" + base64url(32B)

// Sending — configured at construction; additive runtime registration:
new CredentAgent({ webhooks: { endpoints: WebhookEndpoint[], retries?, toleranceSeconds?, transport? } })
credentagent.webhooks.register({ url, events? }): { id, secret }   // secret shown ONCE (process-local; config = multi-instance)
credentagent.webhooks.constructEvent / verifyEvent                // convenience, delegate to the standalone core

interface WebhookEvent<T> { id: string; type: "order.settled"; created: number; data: { object: T } }
interface WebhookEndpoint { url: string; secret: string; events?: string[] }
type WebhookVerdict<T> = { ok: true; event: WebhookEvent<T> } | { ok: false; code: WebhookRefusalCode; reason: string }
class WebhookSignatureError extends Error { code: WebhookRefusalCode }
```

### Security model (precise)

- **Header** `CredentAgent-Signature: t=<unix seconds>,v1=<lowercase hex HMAC-SHA256>`. The MAC is over
  `` `${t}.${rawBody}` `` with key = the endpoint secret. HMAC-SHA256, **hex** digest (Stripe interop
  beats the repo's internal base64url — called out in the doc comment). `t` is bound INTO the MAC, so it
  can't be backdated without breaking the signature.
- **Verify** (constant-time, fail-closed): parse `t` + one-or-more `v1=` (multiple = secret rotation);
  recompute; `timingSafeEqual` on equal-length buffers (length-checked first); pass if ANY `v1` matches;
  then reject a `t` outside `±toleranceSeconds` (default **300s** — the replay window, invariant-6 analogue).
- **Rejected** → `WebhookRefusalCode`: `no-signature`, `bad-format`, `no-match` (forged / tampered /
  wrong-secret), `timestamp` (replay). Secret is never logged, never in a delivery record.
- **Secret** `whsec_` + base64url(32 random bytes). **SSRF:** endpoint URLs are trusted developer config
  (not user input); https is **enforced where endpoints enter** — the constructor and `register()` refuse a
  non-https URL (http allowed for localhost dev only); the default transport sends `redirect: "manual"`, so
  a 3xx is a failed delivery, never followed.
- **Delivery** fire-and-forget from `_complete` (never blocks or rolls back a settled order); **at-least-once**
  with bounded exponential backoff; each attempt is bounded by a per-attempt timeout (`timeoutMs`, default
  10s) so a stalled receiver is retried + reported, never accumulated as a forever-pending request;
  `transport` injectable (default global `fetch`) for testability.

### Load-bearing bypass tests (each must FAIL when its control is removed)

1. wrong-secret signature → `constructEvent` throws / `verifyEvent` `no-match`.
2. body tampered after signing → rejected.
3. timestamp outside tolerance (replay) → rejected `timestamp`.
4. valid signature within tolerance → returns the event (the positive control).
5. delivery: a settled order POSTs a correctly-signed event whose signature the receiver verifies (round-trip);
   a first-attempt failure is retried.
6. an endpoint answering 3xx → the redirect is NOT followed (the redirect target never sees the delivery);
   the 3xx surfaces as a failed delivery.
7. a non-localhost http endpoint URL → refused at the constructor and at `register()`.
8. a receiver that accepts but never responds → the attempt times out, is retried, and is reported.

## Dependencies & increment map

- Parent epic increment: **#97**. Builds on the `orders.*` surface (PR #98) — reuses the completed-order
  store write as the fire point.
- Follows: grants/HNP events on the same webhook bus (later).
