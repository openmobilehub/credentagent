// @openmobilehub/attesto-gate — the consent layer for AI agents (v0.1).
//
// Require a verifiable credential from the user's phone wallet before a
// consequential MCP tool completes. Identity leads; payments is one application.
//
// The v0.1 surface (consolidated Mode A):
//   • new Attesto({ walletOrigin })            — configure once
//   • attesto.requirements(order, policy)      — Context 1: policy → serializable manifest
//   • attesto.mount(app)                       — Context 2: ceremony seam
//   • required/optional over age/membership/payment builders, .when() conditional
//   • defineCredential + gate/discount/authorize + dcql — gate ANY credential
// The `verification_required` envelope + gated() are retained as the Mode-B /
// roadmap blocking primitive (page-less tools); see ROADMAP.

// ── Client ───────────────────────────────────────────────────────────────
export { Attesto } from "./client.js";
export type { ExpressApp } from "./client.js";

// ── Policy builders + extensibility ────────────────────────────────────────
export { age, membership, payment, required, optional, defineCredential, dcql, gate, discount, authorize } from "./credentials.js";

// ── Store ────────────────────────────────────────────────────────────────
export { MemoryVerificationStore } from "./store.js";

// ── Ceremony composition (host-side: bind completion over YOUR stores) ──────
// A composing host (e.g. @openmobilehub/attesto-storefront) binds `completeOrder`
// to its completed-order / cart stores + catalog and exposes it as the `completion`
// seam on `app.locals.attesto`, so a finished ceremony records + clears through the
// SAME shared path every rail uses (FR-008). The ceremony entity types let the host
// type those seam adapters without re-declaring them.
export { completeOrder } from "./ceremony/completion.js";

// ── Ceremony presentation (the ONE shared three-gate checkout page) ─────────
// Both the committed demo and @openmobilehub/attesto-storefront render their
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
  AttestoOptions,
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
