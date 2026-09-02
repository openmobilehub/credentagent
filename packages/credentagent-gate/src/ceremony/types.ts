// Shared ceremony entities + the data shapes the injected seams exchange. The
// package stays dependency-free (no `express` import): every shape is STRUCTURAL
// so the demo injects its catalog/stores with zero glue — a demo `Order` is
// assignable to `CeremonyOrder`, `createOrder` to `CeremonyCatalog`, and so on.
//
// The seam CONTRACT (CeremonySeams / CeremonyContext) lives in mount.ts; this
// file holds the entities those seams pass around.
import type { MandateChain } from "../ap2/chain.js";

import type { SettlementRecordLike } from "./completion.js";
import type { BindingFields } from "./mandate.js";
import type { Origin } from "./origin.js";
import type { DcqlQuery, TrustLevel } from "../types.js";

export type MaybePromise<T> = T | Promise<T>;

// ── Order (input, ALWAYS re-priced server-side — never the token) ───────────

export interface CeremonyOrderLine {
  /** Product id. */
  id: string;
  /** Display name (optional; the catalog is the source of truth). */
  name?: string;
  /** Unit price (catalog-authoritative). */
  unitPrice: number;
  /** Quantity. */
  quantity: number;
  /** unitPrice × quantity. */
  lineTotal: number;
  /** ISO 4217 (optional; order-level currency is authoritative). */
  currency?: string;
  /** Per-product age threshold (e.g. 21), re-derived from the catalog. */
  minimumAge?: number;
  /** Product category — available to custom `.when()` predicates. */
  category?: string;
  /** Prescription flag — a catalog-derived product attribute a custom `appliesTo`
   *  may key on (e.g. the README's `prescription` gate). Preserved through re-pricing
   *  so the completion-time custom-gate sweep sees the SAME inputs as the manifest
   *  resolver (007 — a field the sweep can't see is a fail-OPEN bug). */
  requiresRx?: boolean;
  /** Any custom catalog attribute preserved through re-pricing (see `OrderLine`), so the
   *  completion sweep's `appliesTo` sees the SAME arbitrary fields the manifest resolver did. */
  [attribute: string]: unknown;
}

export interface CeremonyOrder {
  /** Stable per checkout. */
  id: string;
  lines: CeremonyOrderLine[];
  itemCount?: number;
  subtotal: number;
  /** Re-derived from the catalog + this order's verified loyalty state. */
  discount: number;
  /** subtotal − discount; re-derived, never trusted from the token. */
  total: number;
  currency: string;
  createdAt?: string;
}

// ── Catalog seam (server-side re-pricing — the source of truth) ─────────────

export interface CartItemRef {
  productId: string;
  quantity: number;
}

export interface RepriceOpts {
  ageVerified?: boolean;
  loyaltyApplied?: boolean;
  /** The exact discount rate to apply when `loyaltyApplied` — for a delegated draw this is the
   *  percentage SEALED into the grant at approval time (#172), so the amount the delegate key
   *  signed and the amount `completeOrder` re-derives are computed from one number and can never
   *  disagree (invariant 3). Absent ⇒ the catalog applies its own rate, as it always has. */
  loyaltyDiscountPct?: number;
}

export interface CeremonyCatalog {
  /**
   * Re-price an order's lines from the catalog — the SERVER-SIDE source of truth
   * (Security invariant 2: never trust the token's totals). The id is preserved;
   * the loyalty discount is applied only when THIS order's verification opts in.
   * Mirrors the demo's `createOrder(items, id, opts)` so it injects with no glue.
   */
  createOrder(items: CartItemRef[], orderId: string, opts?: RepriceOpts): CeremonyOrder;
}

// ── Order store seam (resolve a created order by id) ────────────────────────

export interface CeremonyOrderStore {
  /**
   * Resolve a created order by id. Totals are re-derived from the catalog
   * regardless (CT3) — this only recovers the line items + id, never the price.
   */
  read(orderId: string): MaybePromise<CeremonyOrder | null | undefined>;
}

// ── Completion seam I/O (the implementation lives in completion.ts) ──────────

export interface GateOutcome {
  gate: string;
  pass: boolean;
  detail: string;
}

export interface CompletionInput {
  order: CeremonyOrder;
  mandateId: string;
  amount: number;
  currency: string;
  method: string;
  instrument?: unknown;
  gates: GateOutcome[];
  /**
   * The optional AP2 mandate chain riding with this completion (spec 013): the Checkout
   * Mandate, the Payment Mandate bound to it, and — on a delegated spend — the grant's two
   * "open" mandates. When present AND the context holds the gate's public key, completion
   * verifies the WHOLE chain before re-pricing and refuses a tampered, replayed, expired or
   * out-of-bounds one. The catalog is still the price authority (invariant 2): a chain with a
   * perfect signature and the wrong price is refused at the re-price step either way.
   */
  mandateChain?: MandateChain;
  /** Required when the chain carries key-bound open mandates: who the KB-JWT is addressed to. */
  mandateAudience?: string;
  /** Required when the chain carries key-bound open mandates: the nonce this gate issued. */
  mandateNonce?: string;
  /** Optional HNP delegated draw (005): a user-sealed Intent Mandate + the delegate-signed
   *  draw redeeming it. When present, completion re-runs the full bounds + revocation +
   *  atomic single-use checks server-side (additive, fail-closed) — never trusting an
   *  upstream verify (invariant 1). Absent ⇒ the draw branch is skipped entirely (HP paths
   *  byte-unchanged). */
  draw?: { intent: import("./mandate.js").IntentBounds; draw: import("./mandate.js").Draw };
  /** Optional per-request settlement thunk (008: the delegated rail's gate-authorized
   *  `verifier.settle`). Runs at the shared settlement point — after every gate + the
   *  re-price + age/custom enforcement pass, before the record — and takes precedence over
   *  the mount-time `ctx.settle`. Throwing GATES completion (authorized-but-not-settled).
   *  Absent ⇒ `ctx.settle` (if any) is used, exactly as before (additive). */
  settle?: () => import("./types.js").MaybePromise<SettlementRecordLike>;
  /** Optional trust level to RELAY onto the completed record (008), sourced from an external
   *  verifier's verdict. The gate never synthesizes it — only records a level it received.
   *  Absent ⇒ the record omits it (the built-in rails' honesty level stays the manifest's). */
  trustLevel?: import("../types.js").TrustLevel;
  /**
   * The custom-credential ids in THIS order's resolved policy (007 / #59 finding 2). The
   * completion sweep enforces a custom `gate()` only when its id is in this set — so a gate
   * that belongs to a DIFFERENT order's policy but happens to sit in the shared, process-wide
   * credential registry (register-on-resolve accumulates across orders) cannot block an order
   * that never required it (the over-enforcement DEADLOCK — invariant 4, scope state per order).
   * Absent ⇒ the sweep falls back to the whole registry (unchanged, fail-closed default for a
   * raw `completeOrder` call that carries no per-order policy); `orders.serve` supplies it from
   * the created order's stored policy.
   */
  policyCredentialIds?: readonly string[];
}

export interface CompletionResult {
  completed: boolean;
  settlement?: SettlementRecordLike;
  settlementError?: string;
  /** Why a non-completion happened — a failed ceremony ("gates"), a tampered/replayed/
   *  expired Cart Mandate ("cart-mandate"), a tampered token re-priced against the
   *  catalog ("reprice"), a signed Cart Mandate and signed Payment Mandate that
   *  disagree on order/amount/currency ("reconcile"), an age-restricted order with
   *  no proven per-order age claim ("age"), an applicable custom gate() credential with no
   *  proven per-order verification ("gate" — 007), or a refused delegated draw ("draw"). */
  reason?: "gates" | "cart-mandate" | "reprice" | "reconcile" | "age" | "gate" | "draw";
  /** For a refused delegated draw, the typed refusals (why + who + recovery class). */
  refusals?: import("./refusals.js").Refusal[];
  /** For a completed delegated draw, the authorizing grant id (the audit link). */
  delegationId?: string;
}

/**
 * The host-bound completion seam mount() hands to each rail. The host pre-binds
 * it to its completed-order + cart stores; the package ships `completeOrder`
 * (completion.ts) as one ready implementation over the injected ceremony context.
 */
export type CompletionSeam = (input: CompletionInput) => MaybePromise<CompletionResult>;

// ── Settlement seam (optional, demo-mode) ───────────────────────────────────

export type SettlementSeam = (order: CeremonyOrder) => Promise<SettlementRecordLike>;

// ── Delegated verification seam (external verifier / processor — 008, #60) ──
//
// The gate's own rails verify in-process and are honestly fenced at
// `trust_level: "presence-only-demo"` — the wire crypto is real, but there is no
// issuer/device TRUST ANCHOR. This seam lets a host delegate verification (and, for
// payment, settlement) to a real external verifier/processor WITHOUT leaving the
// mounted ceremony, so the policy (`payment.in()`, `defineCredential`, `gate()`) is
// byte-identical and only the backend moves in.
//
// The load-bearing split, and the reason delegation stays safe:
//
//   TRUST is delegable — issuer/device signature against a real anchor is exactly
//   what the gate lacks; the verifier reports it via `trust_level`.
//   BINDING is NOT — the amount/payee/currency are re-derived from the catalog by
//   the gate (invariant 2/3/6) and RE-CHECKED against the verdict before anything
//   completes. An adapter that "approves" the wrong amount is still refused.
//
// Nothing here names a specific verifier or processor: the seam is the interface;
// a concrete adapter is a HOST-side implementation, and the gate depends on none.

/**
 * A verified presentment as it reaches the gate — STRUCTURAL and JSON-safe on
 * purpose, so the gate never depends on any verifier's object model (a foreign
 * `PresentmentRecord` must not leak into this package).
 */
export interface DelegatedVerdict {
  /** Did the external verifier approve (issuer/device trust + disclosure)? NECESSARY,
   *  never SUFFICIENT — the gate still re-checks `binding` and re-runs its OWN policy
   *  before authorizing settlement. `consume` performs NO settlement; approving here
   *  does not move money (that is the separate, gate-authorized `settle`). */
  approved: boolean;
  /** How strongly the presentment is trusted, as reported BY THE VERIFIER. Only a real
   *  issuer/device trust anchor may report `"issuer-verified"`; the gate RELAYS this
   *  value and never upgrades it (Principle VII — honesty carried in the type). */
  trust_level: TrustLevel;
  /** Disclosed claims keyed by the credential id from the request's DCQL (e.g.
   *  `{ payment: {...}, age_mdl: {...} }`), so the gate can run its OWN `verify` over
   *  them (invariants 1/5): the verifier's business rules may be laxer than this
   *  merchant's policy (an 18+ check does not satisfy an `age.over(21)` gate). */
  claims: Record<string, Record<string, unknown>>;
  /** What the verifier reports the holder actually signed over (the amount-bound
   *  transaction_data). Re-checked against the catalog-re-priced order + this RP's
   *  payee; any disagreement refuses BEFORE settlement (invariants 2/3/6). */
  binding: {
    amount: number;
    currency: string;
    /** The payee the wallet authorized — re-checked === this RP's re-derived payee. */
    payee: { id: string };
    /** The processor-side transaction id minted in `buildRequest` (carried to `settle`). */
    transactionId?: string;
  };
  /** Why the verifier refused — surfaced when `!approved`. */
  reason?: string;
}

/** What `buildRequest` hands back: the opaque reference the gate seals, plus the
 *  payload the browser passes to the external verifier. */
export interface DelegatedHandoff {
  /** Opaque handle the verdict is later fetched BY (server-to-server). The gate seals
   *  it with the order id, so it cannot be redeemed against another order. */
  reference: string;
  /** Verifier-specific payload for the browser (e.g. `{ dcql, transaction_data, nonce,
   *  verifierUrl }`). Opaque to the gate — it is forwarded, never interpreted. */
  handoff: unknown;
  /**
   * OPTIONAL browser step. URL of a script THIS verifier serves which defines the function
   * that opens the wallet. The approve page loads it and calls {@link clientEntry}, passing
   * the opaque `handoff` — so the ADAPTER names its verifier and the gate names none.
   *
   * Omit both fields when the presentment is captured server-side (a local stand-in, or a
   * verifier with no browser step): the page then skips straight to the verify POST.
   */
  clientScript?: string;
  /** Global function name `clientScript` defines (e.g. `"acmeVerifyCredentials"`). Required
   *  whenever `clientScript` is set; the page calls `window[clientEntry](handoff)`. */
  clientEntry?: string;
}

/**
 * The external verifier/processor seam. THREE methods, mirroring the split a real
 * verifier/processor already has (a real verifier + a processor's `createTransaction` /
 * `commitTransaction`): mint the request, verify the presentment, then — only when
 * the gate authorizes it — settle.
 *
 * Everything is fetch-BY-REFERENCE rather than "receive the result": the browser sits
 * between the verifier and this server, so anything it carries is forgeable. The
 * browser carries only the sealed reference; the host re-fetches server-to-server.
 *
 * Why settlement is a SEPARATE, third step and not folded into `consume`:
 * the gate's policy can be STRICTER than the verifier's. The reference verifier's age
 * rule passes at 18+, but `age.over(21)` demands 21+ — so the verifier can legitimately
 * `approve` a purchase the gate must refuse. If `consume` settled, the gate would refuse
 * a 20-year-old's alcohol order AFTER the money moved. So `consume` performs NO
 * settlement; the gate re-checks binding + re-runs its own policy, and ONLY then calls
 * `settle`. Settlement is gate-authorized, never verifier-authorized.
 */
export interface DelegatedVerifier {
  /**
   * Mint the external verifier's request for THIS order. `binding` carries the gate's
   * catalog-re-derived amount/currency/payee (the SAME `buildBindingFields` the
   * dc-payment rail binds on, so the two rails cannot drift): the adapter binds TO it
   * and never supplies it.
   */
  buildRequest(input: {
    order: CeremonyOrder;
    dcql: DcqlQuery;
    binding: BindingFields;
    origin: Origin;
  }): MaybePromise<DelegatedHandoff>;

  /**
   * Fetch the verified presentment by reference, server-to-server, and run issuer-trust
   * verification. Returns a structural verdict (trust + disclosed claims + the amount
   * binding the wallet signed over). MUST NOT move money — settlement is the gate's call
   * (`settle`). The gate re-checks binding + re-runs its own policy over `claims` next.
   */
  consume(input: { reference: string; order: CeremonyOrder }): MaybePromise<DelegatedVerdict>;

  /**
   * Settle — commit the transaction the reference identifies (e.g. the processor's
   * `commitTransaction` consuming the verifier's presentment record). Called by the gate
   * ONLY after `consume` approved AND the gate's own binding + policy re-checks passed,
   * and ONLY for a policy that authorizes payment. `amount`/`currency` are the gate's
   * re-derived, re-checked figures (never the adapter's). Returns the settlement receipt
   * recorded on completion; throwing GATES completion (authorized-but-not-settled).
   *
   * SHOULD be idempotent by `reference` (#103): the gate passes the SAME sealed, order-bound
   * `reference` on every call for an order, and it serializes completion per order in-process to
   * collapse concurrent verifies to one call — but an in-process lock says nothing across a
   * multi-instance / serverless split, so two instances handling overlapping retries could each
   * call `settle`. An implementation that de-duplicates on `reference` (e.g. an idempotency key on
   * the processor's commit) makes the money path safe regardless of where the requests land.
   *
   * Optional: a delegated ceremony that only gates identity (age / a custom credential)
   * with no payment never calls it.
   */
  settle?(input: { reference: string; order: CeremonyOrder; amount: number; currency: string }): MaybePromise<SettlementRecordLike>;
}
