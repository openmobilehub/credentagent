// Shared ceremony entities + the data shapes the injected seams exchange. The
// package stays dependency-free (no `express` import): every shape is STRUCTURAL
// so the demo injects its catalog/stores with zero glue — a demo `Order` is
// assignable to `CeremonyOrder`, `createOrder` to `CeremonyCatalog`, and so on.
//
// The seam CONTRACT (CeremonySeams / CeremonyContext) lives in mount.ts; this
// file holds the entities those seams pass around.
import type { CartMandate } from "./cartMandate.js";

import type { SettlementRecordLike } from "./completion.js";

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
  /** Optional signed Cart Mandate (ap2.CartMandate). When present AND the context has a
   *  `signingKey`, completion verifies it (signature + order-id binding + expiry) BEFORE
   *  re-pricing and refuses a tampered/replayed/expired cart — additive, fail-closed
   *  defense-in-depth; the catalog stays the price authority either way. */
  cartMandate?: CartMandate;
  /** Optional HNP delegated draw (005): a user-sealed Intent Mandate + the delegate-signed
   *  draw redeeming it. When present, completion re-runs the full bounds + revocation +
   *  atomic single-use checks server-side (additive, fail-closed) — never trusting an
   *  upstream verify (invariant 1). Absent ⇒ the draw branch is skipped entirely (HP paths
   *  byte-unchanged). */
  draw?: { intent: import("./mandate.js").IntentBounds; draw: import("./mandate.js").Draw };
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
