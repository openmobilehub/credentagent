// Shared ceremony entities + the data shapes the injected seams exchange. The
// package stays dependency-free (no `express` import): every shape is STRUCTURAL
// so the demo injects its catalog/stores with zero glue — a demo `Order` is
// assignable to `CeremonyOrder`, `createOrder` to `CeremonyCatalog`, and so on.
//
// The seam CONTRACT (CeremonySeams / CeremonyContext) lives in mount.ts; this
// file holds the entities those seams pass around.

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
}

export interface CompletionResult {
  completed: boolean;
  settlement?: SettlementRecordLike;
  settlementError?: string;
  /** Why a non-completion happened — a failed ceremony ("gates"), a tampered token
   *  re-priced against the catalog ("reprice"), or an age-restricted order with no
   *  proven per-order age claim ("age"). */
  reason?: "gates" | "reprice" | "age";
}

/**
 * The host-bound completion seam mount() hands to each rail. The host pre-binds
 * it to its completed-order + cart stores; the package ships `completeOrder`
 * (completion.ts) as one ready implementation over the injected ceremony context.
 */
export type CompletionSeam = (input: CompletionInput) => MaybePromise<CompletionResult>;

// ── Settlement seam (optional, demo-mode) ───────────────────────────────────

export type SettlementSeam = (order: CeremonyOrder) => Promise<SettlementRecordLike>;
