// @openmobilehub/attestomcp-gate — the consent layer for AI agents (v0.1).
//
// Require a verifiable credential from the user's phone wallet before a
// consequential MCP tool completes. Identity leads; payments is one application.
//
// The v0.1 surface (consolidated Mode A):
//   • new AttestoMCP({ walletOrigin })            — configure once
//   • attestomcp.requirements(order, policy)      — Context 1: policy → serializable manifest
//   • attestomcp.mount(app)                       — Context 2: ceremony seam
//   • required/optional over age/membership/payment builders, .when() conditional
//   • defineCredential + gate/discount/authorize + dcql — gate ANY credential
// The `verification_required` envelope + gated() are retained as the Mode-B /
// roadmap blocking primitive (page-less tools); see ROADMAP.

// ── Client ───────────────────────────────────────────────────────────────
export { AttestoMCP } from "./client.js";
export type { ExpressApp } from "./client.js";

// ── Policy builders + extensibility ────────────────────────────────────────
export { age, membership, payment, required, optional, defineCredential, dcql, gate, discount, authorize } from "./credentials.js";

// ── Store ────────────────────────────────────────────────────────────────
export { MemoryVerificationStore } from "./store.js";

// ── Ceremony composition (host-side: bind completion over YOUR stores) ──────
// A composing host (e.g. @openmobilehub/attestomcp-storefront) binds `completeOrder`
// to its completed-order / cart stores + catalog and exposes it as the `completion`
// seam on `app.locals.attestomcp`, so a finished ceremony records + clears through the
// SAME shared path every rail uses (FR-008). The ceremony entity types let the host
// type those seam adapters without re-declaring them.
export { completeOrder } from "./ceremony/completion.js";

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
// Both the committed demo and @openmobilehub/attestomcp-storefront render their
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

// ── Public types ───────────────────────────────────────────────────────────
export type {
  AttestoMCPOptions,
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
