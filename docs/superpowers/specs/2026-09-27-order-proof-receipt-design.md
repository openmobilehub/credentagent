# Order proof receipt — design

**Date:** 2026-09-27 · **Status:** approved in brainstorming, awaiting spec review
**Builds on:** `inspectPresentations` (PR #223 — the consent page's "Inspect this presentation" link)

## Problem

After a buyer proves something with their wallet (for example "I'm over 21") and the order completes,
nothing remembers the proof. Today:

- The inspect link exists only in the one `/verify` response the consent page receives.
- `completeOrder` writes the completed-order record and then **clears** the per-order verification
  record, so the age proof is gone.
- The storefront widget (shown in Claude / ChatGPT / Goose and in the website's Ask AI) and the
  website demo's "Order complete" receipt both read the completed-order record, so neither can show
  what was proven or link to it.

## Goals

1. Keep each successful proof **with its order**, so it survives completion.
2. A read endpoint, `GET /credentagent/orders/:id/proof`, that reports what the gate checked.
3. The storefront widget's confirmed-order card and the website demo's receipt show each proof, with an
   **Inspect ›** link when the credential bytes are available.

## Non-goals

- Verifying anything new. No issuer-signature check here; each proof keeps its own `trust_level`.
- A "verify any credential" endpoint (POST a DeviceResponse, check it against trust anchors). A separate,
  later project.
- Access control beyond today's: the receipt is readable by anyone with the order id, like
  `get-order-status`.

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| What does "check the proof" mean? | A per-order proof receipt — what the gate checked for that order. |
| Where does the link show? | Both the storefront MCP App widget and the website demo receipt. |
| Who can read the stored credential? | Anyone with the order id. Raw bytes only when the store sets `inspectPresentations`, documented as a demo/dev setting — never with real IDs. |
| Storage | Proofs travel with the order (no new store). |

## Design

### Data

`CompletedRecord` gains an optional `proofs: ProofEntry[]` (absent on records written before this
change — readers treat absent as `[]`).

```ts
interface ProofEntry {
  gate: string;                 // buyer-facing label, e.g. "Age 21+", "Membership", "Pay (USD)"
  rail: "credential" | "dc-payment" | "passkey" | "instant-demo";
  trust_level: TrustLevel;      // the level THIS proof had — never upgraded here
  checks: { gate: string; pass: boolean; detail: string }[]; // what the gate checked
  presentedAt: string;          // ISO time of the proof
  presentation?: InspectablePresentation; // only when inspectPresentations is on AND a wallet answered
}
```

- Only **successful** proofs are kept (a refused proof never completes an order).
- Instant-demo proofs are recorded as `rail: "instant-demo"` with no `presentation` — the receipt must
  never make a demo tap look like a wallet proof.

### Flow

1. **Credential rail** (age / membership / `defineCredential`): on a successful verify, append a
   `ProofEntry` to the order's verification record (`verificationStore`, keyed by order id —
   invariant 4). Re-proving the same gate replaces that gate's entry rather than piling up.
2. **Payment rails** (dc-payment, passkey): pass the payment's `ProofEntry` into `completeOrder` through
   the completion input.
3. **`completeOrder`**: write `proofs = [...verification.proofs, paymentProof]` into the completed record,
   then clear the verification record exactly as today.

The DeviceResponse makes an entry a few KB; that is fine for the in-memory and Redis stores.

### Endpoint

`GET /credentagent/orders/:id/proof`, registered by `mountCeremony`:

- Completed order → `200 { orderId, status: "completed", proofs }`.
- Order with proofs so far but not completed → `200 { orderId, status: "pending", proofs }`.
- Unknown order → `404 { error: "order not found" }`.

It needs to read completed orders, which the ceremony context can't do today. Add an optional read seam
`completedOrders?: { read(orderId) }` to `CeremonySeams` / `CeremonyContext`. The storefront (via
`app.locals.credentagent`) and `orders.serve` already hold that store and pass it in. Without the seam
the route still answers from the verification record (pending proofs only).

### Storefront widget

The confirmed-order card (`packages/credentagent-storefront/src/ui/app.tsx`, fed by
`/checkout/order-status`) lists each proof: `✓ Age 21+ · presence-only-demo · Inspect ›`.

- The link renders only when `presentation.inspectUrl` starts with the Multipaz inspector URL.
- It opens through the MCP Apps host's open-link call, like the checkout link.
- `instant-demo` proofs read "✓ Age 21+ · instant demo", with no link.

### Website demo receipt (credentagent-website)

`doneSummary` replaces the "Age 21+ ✓ proven" row with one row per proof from `order.proofs`, and adds an
`href` for the inspect link. It falls back to today's row when `proofs` is absent. The existing
`isHttpsUrl` guard applies to the link.

### Turning it on for the demo

- `examples/quickstart/server.mjs` passes
  `inspectPresentations: process.env.CREDENTAGENT_INSPECT_PRESENTATIONS === "1"`.
- `.github/workflows/deploy-dev.yml` adds `--env CREDENTAGENT_INSPECT_PRESENTATIONS=1`. That enables it
  on `/marketplace-dev`, which is what the website demo uses. It deploys on every merge to `main`.
- Prod (`/marketplace`, published packages) stays off until a release. Enabling it there is a separate
  one-line change to `deploy-prod.yml`.

## Honesty

- Each proof carries its own `trust_level`. Presence-only proofs stay `presence-only-demo`; no aggregate
  level is invented.
- The wording is "decoded" and "inspect", never "verified by" Multipaz.
- Instant-demo proofs are labelled as instant demo everywhere.

## Testing

Gate:
- The age proof survives completion: after the age verify and the payment, `CompletedRecord.proofs`
  has both entries.
- No cross-order bleed: a proof on order A never appears on order B (invariant 4).
- The flag gates the bytes: without `inspectPresentations`, no entry has `presentation`, including in
  `get-order-status` and `/checkout/order-status`.
- Instant demo records `rail: "instant-demo"` with no presentation.
- The endpoint returns a completed order's proofs, a pending order's proofs, and `404` for an unknown id.
- Re-proving a gate replaces its entry.

Storefront:
- The widget renders the proof rows, renders the link only for a Multipaz URL, and never renders it for
  an instant-demo proof.

Website:
- `doneSummary` tests cover: proofs with and without `presentation`, instant demo, and absent `proofs`
  (today's fallback).

## Sequencing

1. Library PR on `feat/order-proof-receipt`, stacked on PR #223 (inspectPresentations). It covers the
   gate, the storefront widget, the quickstart env switch and `deploy-dev.yml`.
2. When it merges, deploy-dev puts it on `/marketplace-dev`.
3. Website PR: the `doneSummary` proof rows. They go live on credentagent.ai right away, because the demo
   uses `/marketplace-dev`.
