// @openmobilehub/credentagent-gate — the consent layer for AI agents (v0.1).
//
// Require a verifiable credential from the user's phone wallet before a
// consequential MCP tool completes. Identity leads; payments is one application.
//
// The v0.1 surface (consolidated Mode A):
//   • new CredentAgent({ walletOrigin })            — configure once
//   • credentagent.requirements(order, policy)      — Context 1: policy → serializable manifest
//   • credentagent.mount(app)                       — Context 2: ceremony seam
//   • required/optional over age/membership/payment builders, .when() conditional
//   • defineCredential + gate/discount/authorize + dcql — gate ANY credential
// The `verification_required` envelope + gated() are retained as the Mode-B /
// roadmap blocking primitive (page-less tools); see ROADMAP.

// ── Client ───────────────────────────────────────────────────────────────
export { CredentAgent } from "./client.js";
export type { ExpressApp } from "./client.js";

// ── Config preflight (#25) — `credentagent.doctor()` validates a deployment's config in
// one place and returns typed plain data `{ ok, findings: [{ level, code, message, fix }] }`.
export type { DoctorReport, DoctorFinding, DoctorLevel } from "./doctor.js";

// ── Policy builders + extensibility ────────────────────────────────────────
export { age, membership, payment, required, optional, defineCredential, dcql, gate, discount, authorize } from "./credentials.js";

// ── Store ────────────────────────────────────────────────────────────────
export { MemoryVerificationStore } from "./store.js";

// ── The orders resource (spec 009) ──────────────────────────────────────────
// `await credentagent.orders.create({ order, policy })` → { id, approveUrl, manifest };
// `credentagent.orders.retrieve(id)` → the door (ok | pending+approveUrl | reason).
export { Orders, MemoryOrderStore } from "./orders.js";
export type { OrderStore, CreatedOrder, CompletedOrder, OrderDoor, OrderDoorCode } from "./orders.js";

// ── Grants (spec 009, #104) — authorize once, spend later (human NOT present) ──
// `await credentagent.grants.create({ merchant, budget, perSpend, allow? })` → a pending grant;
// the human approves once (grant.approveUrl) → `grant.spend({ idempotencyKey, items })` runs the
// REAL engine (per-spend cap, budget, single-use, revocation, age-non-delegable) → typed door.
export { Grants } from "./grants.js";
export type { Grant, GrantStatus, GrantDoorCode, GrantAllow, CreateGrantOptions, SpendDoor, SpendItems } from "./grants.js";
// `grant.ageScope` — what the bounds cover age-wise, so the approve page can say so BEFORE the
// human taps Approve (#172). Derived server-side from the catalog; disclosure, not enforcement.
export { ageScopeFor, skuAllowed } from "./grants-age.js";
export type { GrantAgeScope, AgeRestrictedItem } from "./grants-age.js";

// ── Webhooks (spec 010) — the REAL HTTP completion signal ───────────────────
// SEND: `new CredentAgent({ webhooks: { endpoints: [{ url, secret }] } })` → every settled order
// POSTs a signed `order.settled` event. RECEIVE (a different service, secret only):
// `constructEvent(rawBody, sigHeader, secret)` → typed event, or throws on a forged/tampered/replayed
// body (the Stripe idiom). `verifyEvent(...)` is the never-throws verdict door.
export { constructEvent, verifyEvent, generateWebhookSecret, signPayload, Webhooks, WebhookSignatureError, SIGNATURE_HEADER, DEFAULT_TOLERANCE_SECONDS } from "./webhooks.js";
export type { WebhookEvent, WebhookEndpoint, WebhookOptions, WebhookVerdict, WebhookRefusalCode, WebhookTransport, VerifyOptions } from "./webhooks.js";

// ── Ceremony composition (host-side: bind completion over YOUR stores) ──────
// A composing host (e.g. @openmobilehub/credentagent-storefront) binds `completeOrder`
// to its completed-order / cart stores + catalog and exposes it as the `completion`
// seam on `app.locals.credentagent`, so a finished ceremony records + clears through the
// SAME shared path every rail uses (FR-008). The ceremony entity types let the host
// type those seam adapters without re-declaring them.
export { completeOrder } from "./ceremony/completion.js";

// ── defineHost — the typed "bring your own host" seam contract ──────────────
// The ergonomic facade over the above: give it your catalog + order store + completed-order
// store and it BUILDS the shared completion, owns the per-order verification store, and
// publishes every seam onto `app.locals.credentagent` — so a non-storefront host wires the
// gate in three lines, with no `completeOrder` by hand and no raw `app.locals` plumbing.
//   const host = defineHost({ catalog, orderStore, records, signingKey });
//   host.publish(app); new CredentAgent({ walletOrigin }).mount(app);
export { defineHost } from "./host.js";
export type { DefineHostSpec, Host, HostApp } from "./host.js";

// ── Cart Mandate (ap2.CartMandate) — signed, tamper-evident cart envelope ────
// Additive + fail-closed: `issueCartMandate` seals a server-priced cart with the host's
// HMAC key; `verifyCartMandate` (and `completeOrder`, when given a `cartMandate` +
// `signingKey`) refuses a tampered / replayed / expired cart BEFORE re-pricing. The
// catalog stays the price authority (invariant 2); trust_level is presence-only-demo.
export { issueCartMandate, verifyCartMandate, decodeCartMandateParam, DEFAULT_CART_MANDATE_TTL_MS } from "./ceremony/cartMandate.js";
export type { CartMandate, CartMandateLine, CartMandateRefusal, CartMandateVerdict, IssueCartMandateArgs } from "./ceremony/cartMandate.js";

// ── Cart ↔ Payment reconciliation — signed cart + signed payment agree on amount ──
// When BOTH a Cart Mandate and a Payment Mandate ride along, `completeOrder`
// reconciles them at the shared seam: same order, consistent currency, and the
// cart's sealed total == the catalog-re-derived total == the Payment Mandate's bound
// amount. One amount binding across every payment path (invariant 3); refuses on any
// mismatch. Exposed for hosts that reconcile outside the bundled completion seam.
export { reconcileCartPayment } from "./ceremony/reconciliation.js";
export type { PaymentBinding, ReconcileRefusal, ReconcileVerdict } from "./ceremony/reconciliation.js";

// ── Ceremony presentation (the ONE shared three-gate checkout page) ─────────
// Both the committed demo and @openmobilehub/credentagent-storefront render their
// checkout page through `renderRequirements(order, manifest, verification)` — one
// polished, route-agnostic page driven by the `requires` manifest (each gate links
// to its OWN approveUrl) so the two surfaces never drift (T030).
export { renderRequirements } from "./ceremony/checkout-page.js";
export type {
  RenderOrder,
  RenderOrderLine,
  RenderVerification,
  RenderPaid,
  PaymentMethod,
  PaymentOptions,
  RenderRequirementsOptions,
} from "./ceremony/checkout-page.js";
export type {
  CompletionContext,
  CompletedRecord,
  CompletedOrderStore,
  ClearableCart,
  SettlementRecordLike,
} from "./ceremony/completion.js";
// ── HNP delegated-draw seams (005, Option B) — the Intent Mandate bounds model, the
// deterministic draw gates, the typed refusals, and the revocation/single-use store. The
// completeOrder draw branch re-runs checkDraw + revocation + atomic consume server-side.
export {
  canonical,
  contentAddressId,
  sealIntent,
  generateDelegate,
  signDraw,
  checkDraw,
  verifyDrawEs256,
} from "./ceremony/mandate.js";
export type {
  IntentBounds,
  Draw,
  DelegateJwk,
  CommittedDraw,
  DrawVerifier,
  DrawVerdict,
  CheckDrawContext,
} from "./ceremony/mandate.js";
export { MemoryRevocationStore } from "./ceremony/revocation.js";
export type { RevocationStore } from "./ceremony/revocation.js";
export { refusal } from "./ceremony/refusals.js";
export type { Refusal, RefusalCode, RefusalEnforcer, RefusalRetryable } from "./ceremony/refusals.js";
// The Stripe-grade facade over the delegated-draw seams: configure a gate with a priced
// catalog, preApprove() once, spend()/revoke() — the ceremony (keys, signing, stores,
// completeOrder) is bundled. Demo-fenced today; stable surface for the wallet-server increment.
export { DelegatedGate, DelegatedGrant } from "./delegated.js";
export type { DelegatedGateOptions, PreApproveOptions, Purchase, SpendResult, CatalogEntry } from "./delegated.js";
// The age claim a human seals into a grant at approval time (#172) + the ONE predicate that
// answers "does it cover an order demanding N?" — so a host pre-check can ask the same question
// the gate's completion path asks, rather than inventing a second, drifting rule.
export { ageProofCovers } from "./ceremony/mandate.js";
export type { SealedAgeProof } from "./ceremony/mandate.js";
export type {
  CeremonyOrder,
  CeremonyOrderLine,
  CeremonyOrderStore,
  CeremonyCatalog,
  CartItemRef,
  RepriceOpts,
  CompletionInput,
  CompletionResult,
  CompletionSeam,
  SettlementSeam,
  GateOutcome,
} from "./ceremony/types.js";

// ── Delegated verification seam (008, #60) — run a REAL external verifier/processor
// INSIDE the mounted ceremony. Pass `{ verifier }` to `mount()` and the policy stays
// byte-identical; only the verification/settlement backend moves in.
//
// The gate delegates TRUST (issuer/device signature against a real anchor, reported as
// `trust_level`) and SETTLEMENT — never BINDING: it re-derives the amount/payee from the
// catalog and re-checks the verdict against it, then re-runs its OWN policy over the
// disclosed claims. An adapter that approves the wrong amount is still refused.
//
// This is the INTERFACE — processor-agnostic by design; ANY external verifier + settlement
// processor is a host-side adapter, and no processor-specific symbol lives in this package.
export type { DelegatedVerifier, DelegatedVerdict, DelegatedHandoff } from "./ceremony/types.js";
// The parameter types a host needs to implement `DelegatedVerifier`: `BindingFields` is the
// SAME catalog-derived amount binding the dc-payment rail binds on (one definition, no drift).
export type { BindingFields } from "./ceremony/mandate.js";
export type { Origin, RequestLike } from "./ceremony/origin.js";

// ── Public types ───────────────────────────────────────────────────────────
export type {
  CredentAgentOptions,
  Branding,
  ReaderIdentity,
  GateOrder,
  OrderLine,
  Credential,
  Step,
  Effect,
  VerificationManifestEntry,
  VerificationStore,
  VerificationRecord,
  TrustLevel,
  DcqlQuery,
  DcqlClaim,
  DcqlCredentialOption,
} from "./types.js";

// ── Retained: Mode-B / roadmap blocking primitive (do NOT break the wire shape) ──
export {
  ageDcql,
  buildVerificationRequired,
  isVerificationRequired,
  envelopeInstruction,
  ENVELOPE_VERSION,
  ENVELOPE_SENTINEL,
} from "./envelope.js";
export type { VerificationRequired, BuildEnvelopeArgs, BuiltinKind } from "./envelope.js";

// gated() — deprecated Mode-B shim (use requirements() for checkout).
export { gated } from "./gated.js";
export type { EasyGatePolicy, GateDeps, MinimalToolResult } from "./gated.js";
