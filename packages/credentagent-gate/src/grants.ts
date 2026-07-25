// credentagent.grants — the human-NOT-present resource (spec 009, #104): authorize once, spend later.
//
//   const grant = await credentagent.grants.create({ merchant, budget: 100, perSpend: 30, allow: { skus: [...] } });
//   sendToUser(grant.approveUrl);                    // the human approves ONCE (today: a demo page; roadmap: the wallet)
//   // later, human away — rehydrate and spend within the sealed bounds:
//   const g = await credentagent.grants.retrieve(id);
//   const s = await g.spend({ idempotencyKey, items: [{ sku: "coffee" }] });   // typed door: ok | code
//   await g.revoke();                                // the very next spend is refused, fail-closed
//
// It wraps the REAL DelegatedGate engine (per-spend cap, cumulative budget, single-use ledger,
// revocation, age-non-delegable) — this file adds the lifecycle (pending → authorized/denied →
// revoked), the `allow` item bounds, and the spec-009 door vocabulary over the engine's refusals.
//
// HONESTY: the authorize ceremony today is a DEMO step (the intent is sealed server-side when the
// human clicks approve — presence "delegated-demo", trust "server-issued-demo"). The wallet
// key-signing ceremony is the roadmap (#71/#14); it will call the SAME _authorize seam.

import { DelegatedGate, DelegatedGrant, type CatalogEntry } from "./delegated.js";

/** Why a grant operation refused — a TYPED union (never `string`; #95 review). */
export type GrantDoorCode =
  | "not-authorized" // the grant is pending / denied — the human never approved it
  | "not-allowed" // the item is outside the grant's `allow` bounds (what, not how much)
  | "per-spend-exceeded" // this one purchase is over the per-spend cap (engine: over-cap)
  | "budget-exceeded" // the cumulative budget is spent out (engine: over-total)
  | "wrong-merchant" // outside the granted merchant scope (engine: out-of-scope)
  | "step-up" // needs a live human — e.g. age-restricted goods are NON-delegable
  | "revoked" // the grant was revoked; nothing spends against it again
  | "expired"; // the grant's validity window passed

/** Engine RefusalCode → the door's vocabulary (the proto's validated mapping, now shipped). */
const CODE_MAP: Record<string, GrantDoorCode> = {
  "over-cap": "per-spend-exceeded",
  "over-total": "budget-exceeded",
  "out-of-scope": "wrong-merchant",
  "step-up": "step-up",
  "revoked": "revoked",
  "consumed": "revoked",
  "expired": "expired",
};

/** Bound WHAT the agent may buy (not just how much): explicit SKUs and/or catalog categories. */
export interface GrantAllow {
  skus?: string[];
  categories?: string[];
}

export interface CreateGrantOptions {
  /** The granted merchant scope. */
  merchant: string;
  /** Cumulative budget in dollars — once drawn down, further spends refuse `budget-exceeded`. */
  budget: number;
  /** Per-purchase cap in dollars — one spend over it refuses `per-spend-exceeded`. */
  perSpend: number;
  /** Optional item bounds — a spend outside them refuses `not-allowed`, fail-closed. */
  allow?: GrantAllow;
  /** The human sentence shown at approve time. */
  description?: string;
}

export type GrantStatus = "pending" | "authorized" | "denied" | "revoked";

/** The one spend door (spec 009 FR-003 shape). */
export type SpendDoor =
  | { ok: true; amount: number; remaining: number; replayed: boolean; authorization: "delegated"; delegationId?: string }
  | { ok: false; code: GrantDoorCode; remaining?: number; retryable?: string };

export interface SpendItems {
  /** Durable per-purchase key — a safe retry replays the SAME outcome (`replayed: true`). */
  idempotencyKey: string;
  items: Array<{ sku: string; qty?: number }>;
}

/** A grant record — one per `create()`, keyed by id (never process-global per grant). */
interface GrantRecord {
  id: string;
  status: GrantStatus;
  opts: CreateGrantOptions;
  /** Minted at AUTHORIZE time (the intent is sealed when the human approves, not before). */
  engine?: DelegatedGrant;
  /** Idempotent spend cache: key → the door already returned (a retry replays it). */
  cache: Map<string, SpendDoor>;
}

export interface GrantsDeps {
  walletOrigin: string;
  /** The priced catalog (dollars) — the ONE price source; also read by the `allow` bounds. */
  catalog?: Record<string, CatalogEntry>;
}

const genGrantId = (): string => `grant_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

export class Grants {
  private readonly records = new Map<string, GrantRecord>();
  private gate?: DelegatedGate;

  constructor(private readonly deps: GrantsDeps) {}

  private engineGate(): DelegatedGate {
    if (!this.deps.catalog) {
      throw new Error(
        "[credentagent] grants needs a priced catalog: new CredentAgent({ catalog: { coffee: 18, wine: { price: 21, minAge: 21 } } })",
      );
    }
    this.gate ??= new DelegatedGate({ catalog: this.deps.catalog });
    return this.gate;
  }

  /** Open a grant awaiting the human's one-time approval. Returns immediately (status "pending"). */
  async create(opts: CreateGrantOptions): Promise<Grant> {
    this.engineGate(); // fail fast on a missing catalog at create, not first spend
    const id = genGrantId();
    const rec: GrantRecord = { id, status: "pending", opts, cache: new Map() };
    this.records.set(id, rec);
    return this.view(rec);
  }

  /** Rehydrate a grant handle by id (the authorize-now / spend-later process boundary). */
  async retrieve(id: string): Promise<Grant | null> {
    const rec = this.records.get(id);
    return rec ? this.view(rec) : null;
  }

  /**
   * The authorize seam — TODAY called by the demo approve page; the wallet key-signing ceremony
   * (roadmap #71) calls the SAME seam. Seals the intent (mints the engine grant) on approval.
   * A denied/revoked grant can never be authorized after the fact (terminal states).
   */
  async _authorize(id: string): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec || rec.status !== "pending") return false;
    rec.engine = await this.engineGate().preApprove({
      merchant: rec.opts.merchant,
      perOrder: rec.opts.perSpend,
      total: rec.opts.budget,
      description:
        rec.opts.description ?? `Up to $${rec.opts.budget} at ${rec.opts.merchant}, $${rec.opts.perSpend}/purchase`,
    });
    rec.status = "authorized";
    return true;
  }

  /** The deny seam — the human rejected the approve screen. Terminal (spec FR-007). */
  async _deny(id: string): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec || rec.status !== "pending") return false;
    rec.status = "denied";
    return true;
  }

  /** Is this sku inside the grant's `allow` bounds? Fail-closed: with bounds set, an unknown or
   *  uncategorized item does NOT pass. No bounds ⇒ everything in the catalog is allowed. */
  private allowed(rec: GrantRecord, sku: string): boolean {
    const allow = rec.opts.allow;
    if (!allow || (!allow.skus && !allow.categories)) return true;
    if (allow.skus?.includes(sku)) return true;
    if (allow.categories) {
      const entry = this.deps.catalog?.[sku];
      const category = typeof entry === "object" ? (entry as { category?: string }).category : undefined;
      if (category && allow.categories.includes(category)) return true;
    }
    return false;
  }

  private view(rec: GrantRecord): Grant {
    const spend = async ({ idempotencyKey, items }: SpendItems): Promise<SpendDoor> => {
      // Idempotent replay FIRST — a safe retry echoes the original outcome, charging nothing twice.
      const cached = rec.cache.get(idempotencyKey);
      if (cached?.ok) return { ...cached, replayed: true };

      // Status gates the spend (FR-007): only an authorized grant spends. Fail-closed —
      // pending/denied never reach the engine; revoked is ALSO re-checked by the engine's
      // ledger at settle (revoke-wins, even for an in-flight spend).
      if (rec.status !== "authorized" || !rec.engine) {
        return { ok: false, code: rec.status === "revoked" ? "revoked" : "not-authorized" };
      }

      // The `allow` bounds — WHAT may be bought (invariant 1: enforced here, server-side,
      // before any engine work; the sealed caps then bound HOW MUCH).
      const { sku, qty = 1 } = items[0];
      if (!this.allowed(rec, sku)) return { ok: false, code: "not-allowed" };

      const r = await rec.engine.spend({ idempotencyKey, item: sku, quantity: qty });
      const door: SpendDoor = r.ok
        ? { ok: true, amount: r.amount, remaining: r.remaining, replayed: false, authorization: "delegated", ...(r.delegationId ? { delegationId: r.delegationId } : {}) }
        : { ok: false, code: CODE_MAP[r.reason ?? ""] ?? "revoked", remaining: r.remaining, ...(r.retryable ? { retryable: r.retryable } : {}) };
      rec.cache.set(idempotencyKey, door);
      return door;
    };

    return {
      id: rec.id,
      get status() {
        return rec.status;
      },
      approveUrl: `${this.deps.walletOrigin}/credentagent/grants/${rec.id}`,
      budget: rec.opts.budget,
      perSpend: rec.opts.perSpend,
      allow: rec.opts.allow,
      description: rec.opts.description,
      presence: rec.engine?.presence ?? "delegated-demo",
      trustLevel: rec.engine?.trustLevel ?? "server-issued-demo",
      spend,
      revoke: async () => {
        if (rec.engine) await rec.engine.revoke();
        rec.status = "revoked";
      },
    };
  }
}

/** The grant handle `create()`/`retrieve()` return — status + the two verbs. */
export interface Grant {
  id: string;
  readonly status: GrantStatus;
  /** Where the human approves ONCE. Today a demo page the host serves; the wallet ceremony later. */
  approveUrl: string;
  budget: number;
  perSpend: number;
  allow?: GrantAllow;
  description?: string;
  /** When/how consent happened — "delegated-demo" until the wallet ceremony lands (honesty axis). */
  presence: string;
  trustLevel: string;
  spend(input: SpendItems): Promise<SpendDoor>;
  revoke(): Promise<void>;
}
