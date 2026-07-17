// A Stripe-grade, configure-once facade for delegated grants (HNP, 005).
//
// The seams (sealIntent / signDraw / completeOrder / RevocationStore) are the
// security-critical primitives; this bundles them so a caller writes
// preApprove() / spend() / revoke() instead of wiring a catalog, stores, key
// generation and a 7-field completeOrder call by hand (Principle I — the bar is
// `new Stripe(key)` → `stripe.charges.create({...})`).
//
// The API is the stable surface; the implementation is demo-fenced. TODAY the
// delegate key is generated HERE (the server, not the user's phone), so grants
// carry presence "delegated-demo" + trust_level "server-issued-demo" (readable via
// grant.presence / grant.trustLevel) and no real value settles (constitution VII).
// The wallet-server increment swaps the internals (the key is minted in the user's
// wallet during a live ceremony) WITHOUT changing this surface.

import type { CeremonyCatalog, CeremonyOrder } from "./ceremony/types.js";
import { MemoryVerificationStore } from "./store.js";
import { MemoryRevocationStore, type RevocationStore } from "./ceremony/revocation.js";
import { sealIntent, generateDelegate, signDraw, type IntentBounds } from "./ceremony/mandate.js";
import { completeOrder, type CompletedRecord, type CompletionContext } from "./ceremony/completion.js";
import type { RefusalCode, RefusalRetryable } from "./ceremony/refusals.js";

/** The delegate private key type, without naming the DOM `CryptoKey` global. */
type DelegateKey = Awaited<ReturnType<typeof generateDelegate>>["privateKey"];

/** A catalog entry: a bare price, or a price plus an age restriction. */
export type CatalogEntry = number | { price: number; minAge?: number };

export interface DelegatedGateOptions {
  /** Your priced catalog: item id → price, or → { price, minAge }. */
  catalog: Record<string, CatalogEntry>;
  /** Shared revocation + single-use ledger (defaults to in-memory, single-process). */
  revocation?: RevocationStore;
}

export interface PreApproveOptions {
  /** The one merchant this grant may spend at. */
  merchant: string;
  /** Per-purchase ceiling (an absolute cap). */
  perOrder: number;
  /** Cumulative LIFETIME cap across every draw — it does NOT reset (there is no time
   *  window in v0.1). Once total spend reaches it, the grant is spent out. */
  total: number;
  /** A human sentence describing the grant (shown in your UI). */
  description?: string;
  /** Who delegated — informational in v0.1 (an audit key; not yet an enforced identity). */
  subject?: string;
}

export interface Purchase {
  /** A stable idempotency key for THIS purchase (Stripe's model). REUSE it to retry safely —
   *  a timed-out retry with the same key returns the ORIGINAL result, charged once, never a
   *  double-charge. Use a UNIQUE key per distinct purchase; a distinct key is a new draw.
   *  The caller owns retry-safety: it must reuse the key, not mint a fresh one, on retry. */
  idempotencyKey: string;
  item: string;
  quantity?: number;
  /** Spend at a merchant other than the approved one (to exercise scope). */
  merchant?: string;
}

export interface SpendResult {
  /** Did the gate complete the purchase? */
  ok: boolean;
  /** The amount the gate priced from the catalog (never trusted from the caller). */
  amount: number;
  /** Headroom left on the grant's cumulative cap AFTER this spend (a completed spend
   *  draws it down; a refused one leaves it unchanged). Reaches 0 when spent out. */
  remaining: number;
  /** Why it was refused — present when `!ok` (e.g. "over-cap", "replay", "revoked"). */
  reason?: RefusalCode;
  /** How to recover from a refusal — the bit an unattended loop branches on:
   *  "needs-human" (surface an approve link), "retry" (transient), "terminal". */
  retryable?: RefusalRetryable;
  /** The authorizing grant id — present when `ok` (the audit link on the record). */
  delegationId?: string;
}

const priceOf = (e: CatalogEntry) => (typeof e === "number" ? e : e.price);
const minAgeOf = (e: CatalogEntry) => (typeof e === "number" ? undefined : e.minAge);

function buildCatalog(items: Record<string, CatalogEntry>): CeremonyCatalog {
  return {
    // Must honor the passed orderId — completeOrder re-prices under the SAME id, and its
    // idempotency is keyed by it, so a duplicate id would echo a prior completion instead
    // of running the per-draw checks. An unknown item is a programming error, not a gate
    // decision, so it throws (fail fast) rather than silently refusing.
    createOrder(refs, orderId): CeremonyOrder {
      const lines = refs.map(({ productId, quantity }) => {
        const entry = items[productId];
        if (entry === undefined) {
          throw new Error(`[credentagent] unknown catalog item "${productId}". Known items: ${Object.keys(items).join(", ")}.`);
        }
        const unitPrice = priceOf(entry);
        const minimumAge = minAgeOf(entry);
        return { id: productId, unitPrice, quantity, lineTotal: unitPrice * quantity, currency: "USD", ...(minimumAge ? { minimumAge } : {}) };
      });
      const total = lines.reduce((sum, l) => sum + l.lineTotal, 0);
      return { id: orderId, lines, itemCount: refs.length, subtotal: total, discount: 0, total, currency: "USD" };
    },
  };
}

/**
 * The configure-once gate: give it a priced catalog, get `preApprove()`. It holds
 * the revocation ledger and per-order stores so callers never wire them. Mint as many
 * grants as you like from one gate — each is isolated.
 */
export class DelegatedGate {
  private readonly catalog: CeremonyCatalog;
  private readonly ctx: CompletionContext;

  constructor(opts: DelegatedGateOptions) {
    this.catalog = buildCatalog(opts.catalog);
    const records = new Map<string, CompletedRecord>();
    this.ctx = {
      catalog: this.catalog,
      revocation: opts.revocation ?? new MemoryRevocationStore(),
      // Delegated draws carry no live-verification state; the shared completion path
      // still reads/clears this seam, so a fresh per-order store satisfies it.
      verificationStore: new MemoryVerificationStore(),
      records: { read: (oid) => records.get(oid), write: (r) => void records.set(r.orderId, r) },
    };
  }

  /** Mint ONE grant and hand it back for your agent to hold. */
  async preApprove(opts: PreApproveOptions): Promise<DelegatedGrant> {
    const { privateKey, delegate } = await generateDelegate();
    const grant = await sealIntent({
      type: "credentagent.IntentBounds/v0",
      naturalLanguageDescription: opts.description,
      merchants: [opts.merchant],
      currency: "USD",
      maxAmount: opts.perOrder,
      totalAmount: opts.total,
      subject: opts.subject,
      delegate,
      presence: "delegated-demo",
      trust_level: "server-issued-demo",
    });
    return new DelegatedGrant(grant, privateKey, this.catalog, this.ctx);
  }
}

/**
 * A minted grant your agent holds. `spend()` signs one draw and runs it through the
 * gate; `revoke()` flips the ledger so the next spend dies.
 */
export class DelegatedGrant {
  constructor(
    private readonly grant: IntentBounds,
    private readonly key: DelegateKey,
    private readonly catalog: CeremonyCatalog,
    private readonly ctx: CompletionContext,
  ) {}

  /** The grant's content-addressed id (the delegationId written on each draw). */
  get id(): string {
    return this.grant.intentId;
  }

  /** When consent happened — "delegated-demo" in v0.1 (constitution VII honesty axis). */
  get presence(): string {
    return this.grant.presence;
  }

  /** How strongly the authorization is bound — "server-issued-demo" in v0.1 (demo-fenced). */
  get trustLevel(): string {
    return this.grant.trust_level;
  }

  /** The human sentence this grant was described with, if any. */
  get description(): string | undefined {
    return this.grant.naturalLanguageDescription;
  }

  /**
   * Spend against the grant. Returns `{ ok, amount, reason?, retryable?, delegationId? }`
   * for any GATE decision — it never throws to signal a refusal. (It does throw on a
   * programming error, e.g. an item id not in the catalog.)
   */
  async spend({ idempotencyKey, item, quantity = 1, merchant }: Purchase): Promise<SpendResult> {
    // The order id is DERIVED from the caller's idempotency key (not a per-call counter), and
    // namespaced by the grant. That is what makes a retry safe: a repeat with the same key
    // hits completeOrder's order-keyed idempotency and echoes the ORIGINAL completion — one
    // draw, charged once. The grant prefix keeps two grants on one gate from colliding
    // (grant B must never read grant A's completion — invariant 4).
    const orderId = `${this.grant.intentId}-${idempotencyKey}`;
    const order = this.catalog.createOrder([{ productId: item, quantity }], orderId);
    const draw = await signDraw(
      {
        type: "credentagent.Draw/v0",
        intentId: this.grant.intentId,
        paymentMandateId: idempotencyKey,
        merchant: merchant ?? this.grant.merchants![0],
        amount: order.total,
        currency: "USD",
        pspTransactionId: idempotencyKey,
      },
      this.key,
    );
    const res = await completeOrder(
      { order, mandateId: idempotencyKey, amount: order.total, currency: "USD", method: "delegated", gates: [], draw: { intent: this.grant, draw } },
      this.ctx,
    );
    // Headroom AFTER this spend: the store's committed draws now include this one iff it
    // completed, so `total − committed` reflects the draw-down (or is unchanged on refusal).
    const committed = await this.ctx.revocation!.priorDraws(this.grant.intentId);
    const remaining = this.grant.totalAmount - committed.reduce((sum, d) => sum + d.amount, 0);
    if (res.completed) return { ok: true, amount: order.total, remaining, delegationId: res.delegationId };
    const refusal = res.refusals?.[0];
    return { ok: false, amount: order.total, remaining, reason: refusal?.code, retryable: refusal?.retryable };
  }

  /** Revoke the grant — the very next spend is refused, fail-closed. Async so a remote
   *  revocation store (the wallet-custody increment) can be awaited before the next spend. */
  async revoke(): Promise<void> {
    await this.ctx.revocation!.revoke(this.grant.intentId);
  }
}
