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
export { Grants, grantLifecycle } from "./grants.js";
export type { Grant, GrantStatus, GrantLifecycle, GrantUsage, GrantDoorCode, GrantAllow, CreateGrantOptions, GrantSigning, GrantMandateEvidence, SpendDoor, SpendItems } from "./grants.js";
// `grant.ageScope` — the age-restricted products a grant's bounds NAME, so the page can say so
// before the human authorizes (#172). Read straight from the catalog; disclosure, not enforcement.
export { ageScopeFor } from "./grants-age.js";
export type { GrantAgeScope, AgeRestrictedItem } from "./grants-age.js";

// ── Device-signed grants (spec 012, #144) — the wallet SIGNS the Intent Mandate first ──
// Opt a grant into wallet signing with `grants.create({ …, signing: "device" })`: its
// approveUrl serves the signing ceremony, and it only authorizes on a REAL mdoc DeviceAuth
// signature over its exact bounds (trust_level "device-signed" — the signature is real; the
// trust anchor is still a demo credential, #14). These exports are the building blocks + a
// SIMULATED wallet for testing the flow in-process (no phone), the way Stripe ships test cards.
export { canonicalIntentBounds, boundsHash, deriveNonce } from "./ceremony/intent-sign/bounds.js";
export type { IntentBoundsInput } from "./ceremony/intent-sign/bounds.js";
export { buildIntentSignRequest } from "./ceremony/intent-sign/request.js";
export type { SignedIntentRequest } from "./ceremony/intent-sign/request.js";
export { verifyIntentPresentation, inGateBackend, memoryNonceGuard } from "./ceremony/intent-sign/verify.js";
export type { IntentVerifyResult, IntentVerifyBackend, IntentTrustVerdict, NonceGuard } from "./ceremony/intent-sign/verify.js";
export { devSimulateWalletSignature } from "./ceremony/intent-sign/simulate.js";
export type { SimulateOptions } from "./ceremony/intent-sign/simulate.js";

// ── MRTR (spec: Multi Round-Trip Requests) — "I need more from the human before I can do this" ──
// The MCP pattern for a tool that cannot complete yet: answer with `input_required` (the questions
// + an opaque `requestState`), the client asks the human, then calls the tool AGAIN echoing the
// blob. `MultiRoundTrip` seals that blob (HMAC + TTL + request/principal binding) so the server
// keeps NO session between rounds and a hand-edited blob is refused, never trusted.
//   const round = rounds.open({ request: "create-spending-grant", params, state, responses });
//   if (!round.answers.size) return round.ask({ size: { message: "Which size?", fields: { size: { type: "string" } } } });
// Implemented here because @modelcontextprotocol/sdk does not ship the MRTR types yet.
export { MultiRoundTrip, DEFAULT_MRTR_TTL_MS } from "./mrtr.js";
export type {
  Ask,
  AskField,
  AskOptions,
  InputRequests,
  InputRequiredResult,
  MultiRoundTripOptions,
  MultiRoundTripRefusal,
  OpenRoundArgs,
  Round,
} from "./mrtr.js";


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

// ── AP2 mandates (spec 013) — the real wire format ──────────────────────────
// Replaces the three homemade schemes 0.4.0 shipped: the mock-signed `ap2.PaymentMandate`,
// the server-HMAC `ap2.CartMandate`, and `credentagent.IntentBounds/v0`. Everything below is
// SD-JWT (RFC 9901), ES256, discriminated by the AP2 `vct` claim. See MIGRATING.md.
//
// HONESTY: a verified chain proves this gate issued these records — and, on the grant path,
// that the wallet key signed them. It does NOT prove the credential behind them came from a
// real issuer (#14). `trust_level` still says so.
export { Ap2Issuer, presentWithKeyBinding, DEFAULT_MANDATE_TTL_MS } from "./ap2/issue.js";
export type { IssuedMandate, IssuedCheckout, IssueCheckoutArgs, IssuePaymentArgs, IssueOpenArgs, IssueOpenPaymentArgs } from "./ap2/issue.js";
export { verifyMandate, openCheckoutPayload, peekVct } from "./ap2/verify.js";
export type { VerifyOptions as VerifyMandateOptions, VerifyResult, MandateVerdict, MandateRefusal, MandateRefusalCode } from "./ap2/verify.js";
export { issueCeremonyChain, issueOrderChain, runCeremonyGates } from "./ap2/ceremony.js";
export type { CeremonyChain, CeremonyEvidence } from "./ap2/ceremony.js";
export { verifyChain } from "./ap2/chain.js";
export type { MandateChain, ChainResult, ChainVerdict, ChainRefusal, ChainRefusalCode, VerifyChainOptions } from "./ap2/chain.js";
export { encodeMandateChainParam, decodeMandateChainParam } from "./ap2/transport.js";
export { VCT, findConstraint } from "./ap2/types.js";
export type {
  Vct,
  Amount,
  Merchant,
  PaymentInstrument,
  UcpCheckout,
  UcpLineItem,
  UcpTotal,
  CheckoutMandate,
  PaymentMandate,
  OpenCheckoutMandate,
  OpenPaymentMandate,
  AnyMandate,
  Cnf,
  CheckoutConstraint,
  PaymentConstraint,
} from "./ap2/types.js";
export { amountFrom, amountOfMinor, amountsEqual, formatAmount, sumAmounts, toMajorUnits, toMinorUnits, exponentFor } from "./ap2/money.js";
export { checkoutFromOrder, merchantFor, rederiveTotal, totalOf, checkoutConstraintsFromGrant, paymentConstraintsFromGrant } from "./ap2/from-gate.js";
export type { GrantBoundsInput } from "./ap2/from-gate.js";
export { didWebFor, didDocument, resolveSigningKey, SIGNING_ALG } from "./ap2/keys.js";
export type { GateSigningKey, PrivateJwkP256, PublicJwkP256 } from "./ap2/keys.js";

// ── Ceremony presentation (the ONE shared three-gate checkout page) ─────────
// Both the committed demo and @openmobilehub/credentagent-storefront render their
// checkout page through `renderRequirements(order, manifest, verification)` — one
// polished, route-agnostic page driven by the `requires` manifest (each gate links
// to its OWN approveUrl) so the two surfaces never drift (T030).
export { renderRequirements } from "./ceremony/checkout-page.js";
// The design-system primitives every ceremony page is built from — the page shell + CSS, the
// brand row, and the step rail. Exported so a HOST page that sits inside the same flow (a grant
// index, a landing step, a confirmation) can match the rails instead of re-copying their CSS and
// drifting from it. `trustFooter` is deliberately NOT here: that honesty line belongs to the
// OpenID4VP rails and must not be pasted onto a page making a different claim.
export { pageHead, brandHeader, progressRail } from "./ceremony/theme.js";
export type { RailStep } from "./ceremony/theme.js";
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
export type { SealedAgeProof, SealedMembershipProof } from "./ceremony/mandate.js";
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
  Presence,
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
