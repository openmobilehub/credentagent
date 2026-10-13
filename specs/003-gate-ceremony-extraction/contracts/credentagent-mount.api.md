# Contract — `attesto.mount(app)` + ceremony routes

The public contract this feature adds to `@openmobilehub/attesto-gate`. Behavior is preserved from the demo's
`payment-gate/`; only the location + the injected-seam boundary are new. Each contract item (CT#) is a testable
acceptance.

## Public API

```ts
const attesto = new Attesto(/* opts */);
attesto.mount(app);   // registers the ceremony routes onto a host Express app
```

- **CT1 — mount registers all three rails.** After `mount(app)`, the app serves the passkey, dc-payment, and
  credential-gate routes (below). `requirements(order, policy)` is unchanged (the code→data manifest).
- **CT2 — fail fast on missing seams.** If a required seam (verificationStore, orderStore, origin, catalog,
  completion) is absent, `mount()` throws a clear error at wire-up — never silently degrades. The `signingKey` is
  required unless the host passes `allowEphemeralKey: true` (dev-only); `mount()` never infers "serverless". (FR-009)
- **CT3 — injected store seam.** `mount()` resolves the order by id from the injected `orderStore`; amounts are
  re-derived from the injected `catalog` regardless. A tampered order/total is refused. (FR-004, FR-010)

## Ceremony routes (served by mount)

### Credential gate — age + membership (the GDC hero rail)
- `GET  /attesto/credential?order=<id>&cred=<age|membership>` → renders the OpenID4VP request page.
- `POST /attesto/credential/verify` → verifies the presentation; writes the per-order claim.
- **CT4 — explicit positive claim.** Verify succeeds only on `age_over_21 === true` (threshold == order's
  `minimumAge`); an `age_over_18` proof is **refused** for a 21+ gate. (FR-002, Sec Req)
- **CT5 — membership applies the discount once.** A verified membership marks the order; the total is re-derived
  with the discount applied exactly once; line sum == total. (FR-005)

### Passkey payment — same-device + cross-device (caBLE)
- `GET  /attesto/passkey?order=<id>[&xdev=1]` → renders the page (toggle for cross-device).
- `GET  /attesto/passkey/options[?xdev=1]` → WebAuthn options + signed challenge token.
- `POST /attesto/passkey/verify` → verifies assertion, runs the four gates, completes via `completeOrder`.
- `GET  /attesto/lib/sw/*` → serves `@simplewebauthn/browser` ESM same-origin.
- **CT6 — four gates + nonce/origin.** All four deterministic gates run; a replayed/expired challenge or a
  mismatched origin/RP-ID is rejected. (FR-007, Sec Req)
- **CT7 — amount integrity.** A tampered amount is refused by the amount-integrity gate (re-priced from catalog).

### Digital-Credentials payment
- `GET  /attesto/dc-payment?order=<id>` → renders the DC API / OpenID4VP request.
- `POST /attesto/dc-payment/verify` → verifies the amount-bound presentation; completes via the **shared**
  `completeOrder`.
- **CT8 — shared completion.** dc-payment records through the same `completeOrder` seam as passkey (idempotent,
  re-priced, cart+verification cleared). (FR-008)

## Cross-cutting contracts

- **CT9 — enforce on every completion path.** Refusal of an unverified age-restricted order holds in the verify
  handlers, in `place-order`, **and** in the MCP checkout/completion tool — not only the rendered page. A bypass
  test for each path fails if the control is removed. (FR-003, FR-014)
- **CT10 — per-order isolation.** Verifying order A does not unlock order B (state keyed by order id). (FR-006)
- **CT11 — presence-only honesty.** The page and any receipt state `trust_level: "presence-only-demo"`; no surface
  presents the gate as a real safety control. (FR-011, SC-006)
- **CT12 — brownfield parity.** With the demo consuming `mount()`, `npm run build` + the live deploy stay green;
  the pre-existing suite stays green (253/1-skip baseline as a floor, no new skips) and the new bypass tests pass;
  the **user-visible** result is identical (discount mechanism intentionally unified, FR-005). (FR-012)
- **CT13 — shared three-gate checkout renderer.** `attesto-gate` provides a reusable renderer for the
  `requirements()` manifest (numbered gates with live status, payment last, discount reflected in the total),
  route-agnostic (renders each entry's `approveUrl`). The storefront checkout page AND the demo's checkout page
  render the **same** component; the demo's swap is behavior-preserving (its pinned HTML tests stay green). (T030)

## Out of scope (v0.2+)
Real KB-JWT / key-bound mandate signing; cryptographic mdoc issuer-trust verification; any *new* ceremony behavior.
