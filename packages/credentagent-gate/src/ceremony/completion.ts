// The shared completion seam (every rail records through this one path):
//   gates → catalog re-derivation → idempotency → settlement (when configured) →
//   completed record + cart clear + per-order verification clear.
// Extracted from the demo's payment-gate/completion.ts, but injected-seam based
// (no hardcoded demo imports) so dc-payment and passkey reconcile against the same
// amount-binding logic. Settlement GATES completion: a configured-but-failed
// settle means authorized-but-not-completed (no record, cart intact — FR-013).
import type { Credential, GateOrder, TrustLevel, VerificationStore } from "../types.js";
import type { CartItemRef, CeremonyCatalog, CeremonyOrder, CompletionInput, CompletionResult, GateOutcome } from "./types.js";
import { verifyCartMandate, type CartMandate } from "./cartMandate.js";
import { reconcileCartPayment } from "./reconciliation.js";
import { checkDraw, type DrawVerifier } from "./mandate.js";
import type { RevocationStore } from "./revocation.js";
import { refusal } from "./refusals.js";
import { RESERVED_CREDENTIAL_IDS } from "../credentials.js";

// One on-chain (demo-mode) settlement backing a completed order. Kept structural
// so the demo's richer SettlementRecord is assignable without the package taking
// a settlement dependency.
export interface SettlementRecordLike {
  network: string;
  txId: string;
  status: string;
  [k: string]: unknown;
}

// A completed-purchase record. On a successful ceremony the gate writes one of
// these so the agent can later poll it (MCP has no server→client push) and
// confirm the purchase. Keyed by order id — never process-global (invariant 4).
export interface CompletedRecord {
  orderId: string;
  mandateId: string;
  amount: number;
  currency: string;
  method: string;
  instrument?: unknown;
  gates: GateOutcome[];
  completedAt: string;
  settlement?: SettlementRecordLike;
  /** The authorizing Intent Mandate id, when this order completed via a delegated draw
   *  (005) — the audit link from an unattended completion back to its grant. */
  delegationId?: string;
  /** How strongly this completion was trusted, RELAYED from an external verifier's verdict
   *  (008). `"issuer-verified"` only when a real trust anchor produced it; the built-in rails
   *  omit this (their honesty level is the manifest's `presence-only-demo`). Never synthesized
   *  here — the gate only records a level it received. */
  trustLevel?: TrustLevel;
}

export interface CompletedOrderStore {
  read(orderId: string): CompletedRecord | undefined | Promise<CompletedRecord | undefined>;
  write(record: CompletedRecord): void | Promise<void>;
}

export interface ClearableCart {
  clear(): void | Promise<void>;
}

export interface CompletionContext {
  catalog: CeremonyCatalog;
  verificationStore: VerificationStore;
  /** Idempotent completed-order store, keyed by order id. */
  records: CompletedOrderStore;
  /** Cart to empty on completion (optional). */
  cart?: ClearableCart;
  /** Optional demo-mode settlement; throwing GATES completion (no record). */
  settle?: (order: CompletionInput["order"]) => Promise<SettlementRecordLike>;
  /** Optional HMAC key for Cart Mandate verification. When set AND the input carries a
   *  `cartMandate`, completion verifies it (signature + order-id binding + expiry)
   *  before re-pricing. Absent ⇒ the cart-mandate check is skipped (additive). */
  signingKey?: string;
  /** Optional revocation + committed-draw store (005). REQUIRED when the input carries a
   *  `draw`: its absence is fail-closed (a draw without a store to check it is refused).
   *  Consulted fail-closed (a throwing read refuses) and holds the atomic single-use consume. */
  revocation?: RevocationStore;
  /** Optional signer-agnostic draw verifier (defaults to ES256/P-256). */
  verifyDraw?: DrawVerifier;
  /** Injectable clock for the draw window check (testability). */
  now?: () => number;
  /**
   * The gate's in-process credential registry (id → Credential), populated by
   * `requirements()` and injected by `mount()` (007). When present, completion
   * enforces EVERY applicable custom `gate()` credential — re-deriving applicability
   * from the RE-PRICED order (invariant 2) and refusing any not in the order's
   * `verifiedGates` (invariant 1). Reserved built-ins are excluded (they keep their
   * own enforcement). Absent ⇒ the custom-gate sweep is skipped (additive).
   */
  credentialRegistry?: ReadonlyMap<string, Credential>;
}

/**
 * Invariant 1 (007, generalized): is there an applicable custom `gate()` credential with NO
 * proof for THIS order? Shared by the human-present path AND the delegated-draw path — a draw
 * is a completion path too, and an unattended agent can't present a prescription/license, so
 * an applicable custom gate must refuse (step up to a human). Applicability is re-derived from
 * the RE-PRICED order (invariant 2) against the full line (never a lossy projection). Absent
 * registry / no custom gates ⇒ false (additive — unchanged for hosts that don't wire it).
 */
function hasUnprovenCustomGate(ctx: CompletionContext, repriced: CeremonyOrder, verification: unknown): boolean {
  if (!ctx.credentialRegistry) return false;
  // Pre-filter to the custom `gate()` credentials ONCE (#64 item 2). The common case is a
  // registry of only reserved built-ins (age/membership/payment), which the loop below skips
  // anyway — so building `gateOrder` (which clones every re-priced line) and iterating would
  // be pure waste. Skip both entirely when the custom set is empty. Same predicate as the
  // loop's per-cred skips, so behavior is unchanged: an empty set could never return true.
  const customGates = [...ctx.credentialRegistry.values()].filter(
    (cred) => !RESERVED_CREDENTIAL_IDS.has(cred.id) && cred.effect.kind === "gate",
  );
  if (customGates.length === 0) return false;
  // Evaluate `appliesTo` against the FULL re-priced line — spread every field, never a
  // hand-picked allow-list. A dropped field could make an applicable gate look inapplicable
  // here (fail-OPEN), skipping enforcement the manifest promised (invariant 1). #64 item 1
  // — narrowing this projection — was declined for exactly that reason.
  const gateOrder: GateOrder = {
    id: repriced.id,
    total: repriced.total,
    currency: repriced.currency,
    lines: repriced.lines.map((l) => ({ ...l })),
  };
  const verifiedGates = (verification as { verifiedGates?: Record<string, true> } | undefined)?.verifiedGates ?? {};
  for (const cred of customGates) {
    const applies = cred.appliesTo ? cred.appliesTo(gateOrder) : true;
    if (applies && verifiedGates[cred.id] !== true) return true;
  }
  return false;
}

export async function completeOrder(input: CompletionInput, ctx: CompletionContext): Promise<CompletionResult> {
  // Every deterministic gate must have passed; one failure refuses, recording
  // nothing.
  if (!input.gates.every((g) => g.pass)) return { completed: false, reason: "gates" };

  // Idempotency: a replayed verify for an already-recorded order echoes the
  // recorded outcome — it settles/records nothing twice. Keyed by order id so it
  // can't collide across orders, and it runs BEFORE re-pricing because completion
  // clears the order's verification (a replayed discounted order would otherwise
  // reprice high and refuse).
  const existing = await ctx.records.read(input.order.id);
  if (existing) {
    // Echo the SAME shape the live completion returned — including the delegationId audit link
    // for a draw (a polling agent must see the grant link on a replay, not just completed:true).
    return {
      completed: true,
      ...(existing.settlement ? { settlement: existing.settlement } : {}),
      ...(existing.delegationId ? { delegationId: existing.delegationId } : {}),
    };
  }

  // Cart Mandate integrity (additive, fail-closed): if a signed cart mandate rode along
  // AND we hold the key, verify it BEFORE re-pricing — a tampered, replayed (wrong-order)
  // or expired cart is refused here with an explicit reason. The catalog STILL re-derives
  // the price below; the signature proves the server issued the cart, not the price
  // (invariant 2). A valid-signature-but-wrong-price mandate therefore still fails the
  // re-price check — the mandate is defense-in-depth, never a substitute for it. The
  // verified mandate is reconciled against the Payment Mandate's binding AFTER re-pricing.
  let cartMandate: CartMandate | undefined;
  if (input.cartMandate && ctx.signingKey) {
    const verdict = verifyCartMandate(input.cartMandate, input.order.id, ctx.signingKey);
    if (!verdict.ok) return { completed: false, reason: "cart-mandate" };
    cartMandate = verdict.mandate;
  }

  // Invariant 2: never trust the order token — re-price the lines against the
  // catalog and refuse if the inbound total doesn't match what those items cost.
  // Invariant 3: a loyalty discount only counts when THIS order's verification
  // says it was applied; a token merely claiming the discounted total reprices
  // higher and is refused.
  const verification = await ctx.verificationStore.read(input.order.id);
  const loyaltyApplied = !!(verification as { loyalty?: { applied?: boolean } } | undefined)?.loyalty?.applied;
  const items: CartItemRef[] = input.order.lines.map((l) => ({ productId: l.id, quantity: l.quantity }));
  const repriced = ctx.catalog.createOrder(items, input.order.id, { loyaltyApplied });
  if (repriced.total !== input.order.total) return { completed: false, reason: "reprice" };

  // Invariant 3: when a signed Cart Mandate AND a signed Payment Mandate are both
  // present, the two envelopes must tell ONE story before completing — same order,
  // consistent currency, and the cart's sealed total == the catalog-RE-DERIVED total
  // == the Payment Mandate's bound amount (`input.amount`, projected from
  // `mandate.payment` by every rail). This binds the cart's seal to the payment's
  // signature across ALL paths: a cart sealed for X paired with a payment for Y≠X, a
  // currency or order mismatch, or a discount one path blesses and another refuses is
  // refused here, never silently under-charged. Re-priced (not the token) per invariant 2.
  if (cartMandate) {
    const agree = reconcileCartPayment(
      cartMandate,
      { amount: input.amount, currency: input.currency, orderId: input.order.id },
      repriced.total,
    );
    if (!agree.ok) return { completed: false, reason: "reconcile" };
  }

  // Invariant 1: enforce the age gate on EVERY completion path. The age restriction
  // is re-derived from the catalog-priced lines (never the token); an age-restricted
  // order must carry a positive per-order age claim — written by the credential
  // gate's verify handler (credential-gate/routes.ts) — before it can complete. This
  // is the shared-completion-seam half of CT9; the demo's place-order + MCP
  // order-completion-tool halves are wired in T014.
  const ageRestricted = repriced.lines.some((l) => typeof l.minimumAge === "number" && l.minimumAge > 0);

  // ── HNP delegated-draw branch (005 FR-006): additive + fail-closed. Only taken when a
  // draw is present; every HP path above/below is byte-unchanged. The gate re-runs the FULL
  // bounds check here at the seam — never trusting an upstream rail verify (invariant 1) — so
  // a producer reaching completeOrder DIRECTLY with a draw is still fully checked. On success
  // it writes a delegationId (the audit link) and SUPPRESSES real settlement.
  if (input.draw) {
    const { intent, draw } = input.draw;
    const store = ctx.revocation;
    // Fail-closed: a draw with no store to check it against cannot complete.
    if (!store) return { completed: false, reason: "draw", refusals: [refusal("revocation-unavailable")] };

    // Age is NON-DELEGABLE: an age-restricted cart ALWAYS steps up to a live ceremony and
    // never completes from a grant, regardless of any snapshot (invariant 5, spec FR-013).
    if (ageRestricted) return { completed: false, reason: "draw", refusals: [refusal("step-up", { cause: "age-restricted" })] };

    // Custom gate() credentials are non-delegable too (invariant 1, generalized — 007): a draw
    // is a completion path, so an applicable custom gate (prescription, license, …) with no
    // proof for THIS order must step up to a live human — the draw path must NOT skip the sweep
    // the HP path runs by returning early below.
    if (hasUnprovenCustomGate(ctx, repriced, verification))
      return { completed: false, reason: "draw", refusals: [refusal("step-up", { cause: "custom-gate" })] };

    // Revocation + prior draws — fail-closed if the store errors (never fail-open).
    let revoked: boolean;
    let priorDraws;
    try {
      revoked = await store.isRevoked(intent.intentId, intent.subject);
      priorDraws = await store.priorDraws(intent.intentId);
    } catch {
      return { completed: false, reason: "draw", refusals: [refusal("revocation-unavailable")] };
    }
    if (revoked) return { completed: false, reason: "draw", refusals: [refusal("revoked", { intentId: intent.intentId })] };

    // The deterministic bounds gates (signature/cap/window/scope/replay/step-up/…).
    const verdict = await checkDraw(intent, draw, {
      now: ctx.now ? ctx.now() : undefined,
      priorDraws,
      verify: ctx.verifyDraw,
    });
    if (!verdict.ok) return { completed: false, reason: "draw", refusals: verdict.refusals };

    // Invariants 2+3: the draw's amount must equal the catalog-RE-DERIVED total — the grant
    // never carries an authoritative price, and the bound payment can't drift from ground truth.
    if (draw.amount !== repriced.total) {
      return { completed: false, reason: "draw", refusals: [refusal("over-cap", { pricedAt: repriced.total, amount: draw.amount })] };
    }
    // ...and in the SAME currency: checkDraw only proves draw.currency == intent.currency (the
    // grant's self-consistency), never agreement with the ORDER. Bind it to the re-priced
    // order's currency so a USD grant cannot settle a EUR-priced cart (invariant 3).
    if (draw.currency !== repriced.currency) {
      return { completed: false, reason: "draw", refusals: [refusal("currency-mismatch", { expected: repriced.currency, got: draw.currency })] };
    }

    // Atomic consume — keyed per intent (NOT per order: completeOrder's own idempotency is
    // order-keyed, so two concurrent redemptions minting two order ids would both pass without
    // this). The store makes BOTH the single-use AND the cumulative-cap decision atomically, so
    // concurrent draws with distinct pspTransactionIds cannot both slip past checkDraw's
    // (non-atomic) over-total pre-check and breach the cap. `consumed` = replayed txid;
    // `over-total` = would breach the cumulative cap at commit time.
    let commit: import("./revocation.js").CommitResult;
    try {
      commit = await store.commitDraw(intent.intentId, { amount: draw.amount, pspTransactionId: draw.pspTransactionId }, { totalAmount: intent.totalAmount, subject: intent.subject });
    } catch {
      return { completed: false, reason: "draw", refusals: [refusal("revocation-unavailable")] };
    }
    if (!commit.ok) {
      // commitDraw is the atomic authority — a revoke that landed after the pre-check above
      // is caught here (`revoked`), closing the check-then-act TOCTOU on the kill-switch.
      const detail =
        commit.reason === "consumed" ? { pspTransactionId: draw.pspTransactionId }
        : commit.reason === "revoked" ? { intentId: intent.intentId }
        : { total: intent.totalAmount };
      return { completed: false, reason: "draw", refusals: [refusal(commit.reason, detail)] };
    }

    // The draw is authorized. Record it with the delegationId audit link and SUPPRESS real
    // settlement (the honesty control — a demo-fenced draw never moves real value, spec FR-014).
    await ctx.records.write({
      orderId: input.order.id,
      mandateId: input.mandateId,
      amount: draw.amount,
      currency: input.currency,
      method: input.method,
      instrument: input.instrument,
      gates: input.gates,
      completedAt: new Date().toISOString(),
      delegationId: intent.intentId,
    } as Parameters<typeof ctx.records.write>[0]);
    if (ctx.cart) await ctx.cart.clear();
    await ctx.verificationStore.clear(input.order.id);
    return { completed: true, delegationId: intent.intentId };
  }

  if (ageRestricted && (verification as { ageVerified?: boolean } | undefined)?.ageVerified !== true) {
    return { completed: false, reason: "age" };
  }

  // Invariant 1 (generalized — 007): enforce EVERY applicable custom `gate()` credential, not
  // only age — the SAME check the delegated-draw branch above runs (`hasUnprovenCustomGate`),
  // so the two completion paths cannot drift. `gate()` is the hard-block effect, enforced
  // whenever it applies (required/optional flag ignored); applicability is re-derived from the
  // RE-PRICED order (invariant 2) against the full line. Absent registry ⇒ no-op (additive).
  if (hasUnprovenCustomGate(ctx, repriced, verification)) {
    return { completed: false, reason: "gate" };
  }

  // Settlement runs HERE — after every gate, the re-price, and the age/custom-gate
  // enforcement above have passed, and just before the record is written — so a refused
  // order never settles. A per-input `settle` thunk (008: the delegated rail's
  // gate-authorized `verifier.settle`, bound to the amount THIS path re-derived) takes
  // precedence over the mount-time `ctx.settle(order)`; both gate completion identically
  // (a throw ⇒ authorized-but-not-settled, no record — FR-013).
  let settlement: SettlementRecordLike | undefined;
  const settleFn = input.settle ?? (ctx.settle ? () => ctx.settle!(input.order) : undefined);
  if (settleFn) {
    try {
      settlement = await settleFn();
    } catch (err) {
      return { completed: false, settlementError: (err as Error).message };
    }
  }

  await ctx.records.write({
    orderId: input.order.id,
    mandateId: input.mandateId,
    amount: input.amount,
    currency: input.currency,
    method: input.method,
    instrument: input.instrument,
    gates: input.gates,
    completedAt: new Date().toISOString(),
    ...(settlement ? { settlement } : {}),
    ...(input.trustLevel ? { trustLevel: input.trustLevel } : {}),
  });
  if (ctx.cart) await ctx.cart.clear();
  // Completed purchase: clear this order's age/loyalty verification.
  await ctx.verificationStore.clear(input.order.id);
  return { completed: true, ...(settlement ? { settlement } : {}) };
}
