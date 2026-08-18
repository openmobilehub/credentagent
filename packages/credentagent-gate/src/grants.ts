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
// revocation, the age gate) — this file adds the lifecycle (pending → authorized/denied →
// revoked), the `allow` item bounds, and the spec-009 door vocabulary over the engine's refusals.
//
// AGE (#172): a grant discloses what its bounds cover age-wise (`ageScope`) so the approve page can
// say so BEFORE the human taps Approve, and carries an age claim the human proved on that page
// (`ageProof`) so their agent can buy those items later. No proof ⇒ an age-restricted item still
// refuses `step-up`, exactly as before.
//
// HONESTY: the authorize ceremony today is a DEMO step (the intent is sealed server-side when the
// human clicks approve — presence "delegated-demo", trust "server-issued-demo"). The wallet
// key-signing ceremony is the roadmap (#71/#14); it will call the SAME _authorize seam.

import { DelegatedGate, DelegatedGrant, type CatalogEntry } from "./delegated.js";
import { serveGrants, type GrantsApp } from "./grants-serve.js";
import { ageScopeFor, skuAllowed, type GrantAgeScope } from "./grants-age.js";
import type { SealedAgeProof } from "./ceremony/mandate.js";

/** Why a grant operation refused — a TYPED union (never `string`; #95 review). */
export type GrantDoorCode =
  | "not-authorized" // the grant is pending / denied — the human never approved it
  | "not-allowed" // the item is outside the grant's `allow` bounds (what, not how much)
  | "invalid-request" // malformed spend input (e.g. not exactly one item) — the key is NOT consumed
  | "invalid-amount" // the priced amount is not a finite positive number (e.g. qty 0 / negative)
  | "per-spend-exceeded" // this one purchase is over the per-spend cap (engine: over-cap)
  | "budget-exceeded" // the cumulative budget is spent out (engine: over-total)
  | "wrong-merchant" // outside the granted merchant scope (engine: out-of-scope)
  | "step-up" // needs a live human — e.g. age-restricted goods are NON-delegable
  | "revoked" // the grant was revoked; nothing spends against it again
  | "expired" // the grant's validity window passed (or hasn't started)
  | "refused"; // an internal engine refusal (integrity class) — terminal; never a specific lie

/** Engine RefusalCode → the door's vocabulary. EVERY engine code is mapped deliberately
 *  (refusals.ts documents that surfaces may coarsen); the integrity class — signature /
 *  bounds-tampered / intent-mismatch / currency-mismatch / replay / revocation-unavailable,
 *  unreachable by design through this facade — coarsens to the honest catch-all "refused"
 *  rather than misreporting a specific cause (a P2 on #112: unknown ≠ "revoked"). */
const CODE_MAP: Record<string, GrantDoorCode> = {
  "invalid-amount": "invalid-amount",
  "over-cap": "per-spend-exceeded",
  "over-total": "budget-exceeded",
  "out-of-scope": "wrong-merchant",
  "step-up": "step-up",
  "unpermitted-presentment": "step-up", // also "a live human must present it"
  "revoked": "revoked",
  "consumed": "revoked",
  "expired": "expired",
  "not-yet-valid": "expired",
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

/** The one spend door (spec 009 FR-003 shape). A retried idempotency key replays the ORIGINAL
 *  outcome — success OR refusal (`replayed: true` on both) — so a key can never be repurposed
 *  with a different item after a refusal (a P2 on #112). */
export type SpendDoor =
  | { ok: true; amount: number; remaining: number; replayed: boolean; authorization: "delegated"; delegationId?: string }
  | { ok: false; code: GrantDoorCode; remaining?: number; retryable?: string; replayed?: boolean };

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
  /** The age claim the human proved on the approve page, held until `_authorize` seals it into
   *  the intent (#172). Writable ONLY while the grant is pending — see `_recordAgeProof`. */
  ageProof?: SealedAgeProof;
  /** Idempotent spend cache: key → the door already returned (a retry replays it). */
  cache: Map<string, SpendDoor>;
}

export interface GrantsDeps {
  walletOrigin: string;
  /** The priced catalog (dollars) — the ONE price source; also read by the `allow` bounds. */
  catalog?: Record<string, CatalogEntry>;
}

const genGrantId = (): string => `grant_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

/** Recursively freeze a plain-data object (the sealed grant bounds — arrays included). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** A tiny per-key async mutex: serializes a grant's lifecycle + spend transitions so a
 *  read-check-write can't interleave with another on the SAME grant (the TOCTOU class —
 *  REVIEW.md §1/§2). Ported from the closed PR #106 (issue #104): without it, two concurrent
 *  same-key spends both miss the idempotency cache and reach the engine, and the loser comes
 *  back `consumed` → misreported as `revoked`. In-process only — a multi-instance deploy needs
 *  a shared store + CAS (the known follow-up in the #104 comparison comment). */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain going but don't leak a rejection into the next waiter's scheduling.
    this.tails.set(key, next.then(() => undefined, () => undefined));
    return next;
  }
}

/** Convert plain dollars to integer cents (issue #104, fix 2). The public API stays plain
 *  dollars; internally the catalog + per-grant caps are cents, so every engine comparison is
 *  exact integers and an exact-budget spend on non-round prices ($4.90 × 3 == $14.70) is not
 *  lost to binary float drift (14.700000000000001 > 14.7). A genuinely sub-cent input (e.g.
 *  $0.006, $1.005) is REJECTED with a clear error rather than silently rounded to a different
 *  value (Codex P2): the smallest representable unit is one cent. The `1e-6` tolerance absorbs
 *  the float noise `× 100` introduces on representable amounts (4.9 → 490.00000000000006). */
function toCents(dollars: number, what = "amount"): number {
  const cents = dollars * 100;
  if (!Number.isFinite(cents) || Math.abs(cents - Math.round(cents)) > 1e-6) {
    throw new Error(
      `[credentagent] grants: ${what} $${dollars} has sub-cent precision; the smallest unit is one cent (round it, or use whole cents).`,
    );
  }
  return Math.round(cents);
}

/** A LIVE cents view over the plain-dollar catalog (issue #104 fix 2; Codex P1). The engine
 *  reads each item on demand, so WRAPPING the catalog (rather than snapshotting it) preserves
 *  the pre-#135 per-read behaviour: a host that re-prices an item in memory, or adds one, is
 *  honoured at the very next spend — and the sealed per-grant cap is enforced against the LIVE
 *  price, not a stale one. Category is preserved for the `allow` bounds (which read the dollar
 *  catalog directly). A sub-cent price throws when it is priced, the same class as an unknown item. */
function centsCatalogView(catalog: Record<string, CatalogEntry>): Record<string, CatalogEntry> {
  return new Proxy(catalog, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      const entry = target[prop];
      if (entry === undefined) return undefined;
      const priced = (p: number) => toCents(p, `price of "${prop}"`);
      return typeof entry === "number" ? priced(entry) : { ...entry, price: priced(entry.price) };
    },
  });
}

export class Grants {
  private readonly records = new Map<string, GrantRecord>();
  private readonly locks = new KeyedMutex();
  private gate?: DelegatedGate;
  private served = false;
  /** Set by the grant-age rail when `mount()` registers it (#172). The approve page offers the
   *  "prove your age" button ONLY when the ceremony is actually reachable — a host that calls
   *  `grants.serve(app)` without `mount(app)` gets the disclosure alone, never a link to a 404. */
  _ageRailMounted = false;

  constructor(private readonly deps: GrantsDeps) {}

  private engineGate(): DelegatedGate {
    if (!this.deps.catalog) {
      throw new Error(
        "[credentagent] grants needs a priced catalog: new CredentAgent({ catalog: { coffee: 18, wine: { price: 21, minAge: 21 } } })",
      );
    }
    // The engine runs in integer cents (fix 2) via a LIVE cents view — not a snapshot — so a host
    // that re-prices an item in memory is honoured at the next spend and the sealed cap is enforced
    // against the live price (Codex P1). Per-grant caps convert at authorize (the sealed bounds
    // don't move); each spend's amount converts back to dollars for the door.
    this.gate ??= new DelegatedGate({ catalog: centsCatalogView(this.deps.catalog) });
    return this.gate;
  }

  /**
   * Serve the approve/deny page at each grant's `approveUrl` (`/credentagent/grants/:id`) —
   * so the documented create-and-send-the-link flow actually works. Idempotent per instance.
   * The page is the demo stand-in for the wallet ceremony; it calls the same seams (#71).
   */
  serve(app: unknown): void {
    if (this.served) return;
    serveGrants(app as GrantsApp, this);
    this.served = true;
  }

  /** Open a grant awaiting the human's one-time approval. Returns immediately (status "pending"). */
  async create(opts: CreateGrantOptions): Promise<Grant> {
    this.engineGate(); // fail fast on a missing catalog at create, not first spend
    // Reject sub-cent caps at configuration — the earliest + clearest point (Codex P2); never
    // silently round the very amount the human is about to approve.
    toCents(opts.budget, "budget");
    toCents(opts.perSpend, "perSpend");
    const id = genGrantId();
    // SNAPSHOT + FREEZE the bounds at create (a P1 on #112): the record and the exposed handle
    // share this immutable copy, so neither a caller mutating `grant.allow` nor the original
    // options object can widen what the human approved after the fact.
    const sealed: CreateGrantOptions = deepFreeze(structuredClone(opts));
    const rec: GrantRecord = { id, status: "pending", opts: sealed, cache: new Map() };
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
    // Serialized per grant (fix 1): the pending→authorized transition can't interleave with a
    // concurrent revoke/deny or a second approve, so a stopped grant is never resurrected and a
    // double-approve seals exactly one intent. Caps go to the engine in cents (fix 2).
    return this.locks.run(id, async () => {
      const rec = this.records.get(id);
      if (!rec || rec.status !== "pending") return false;
      rec.engine = await this.engineGate().preApprove({
        merchant: rec.opts.merchant,
        perOrder: toCents(rec.opts.perSpend),
        total: toCents(rec.opts.budget),
        description:
          rec.opts.description ?? `Up to $${rec.opts.budget} at ${rec.opts.merchant}, $${rec.opts.perSpend}/purchase`,
        // Whatever age claim the human proved BEFORE tapping Approve is sealed with the bounds
        // (#172) — one atomic act of consent, covered by the content-addressed intentId.
        ...(rec.ageProof ? { ageProof: rec.ageProof } : {}),
      });
      rec.status = "authorized";
      return true;
    });
  }

  /**
   * The age seam (#172) — called by the grant-age rail when the human's wallet proves an over-age
   * claim on the approve page, BEFORE they tap Approve. The wallet ceremony and the instant-demo
   * path both land here; neither may pass a threshold of its own choosing (the rail re-derives it
   * from the catalog).
   *
   * PENDING ONLY, and serialized with the rest of the lifecycle: an already-authorized grant can
   * never gain a capability the human didn't approve, and a proof can't race the approve tap.
   * Returns false when the grant is unknown or past pending — the caller surfaces that, it is
   * never a silent no-op.
   */
  async _recordAgeProof(id: string, proof: { provenAge: number; expiresAt?: string }): Promise<boolean> {
    return this.locks.run(id, async () => {
      const rec = this.records.get(id);
      if (!rec || rec.status !== "pending") return false;
      if (typeof proof.provenAge !== "number" || !Number.isFinite(proof.provenAge) || proof.provenAge <= 0) return false;
      // Keep the STRICTEST proof if the human verifies twice — a second, weaker ceremony must
      // never lower what the first one established.
      if (rec.ageProof && rec.ageProof.provenAge >= proof.provenAge) return true;
      rec.ageProof = {
        provenAge: proof.provenAge,
        verifiedAt: new Date().toISOString(),
        ...(proof.expiresAt ? { expiresAt: proof.expiresAt } : {}),
        // HONESTY: the wire crypto is real, the issuer trust anchor is not (#14).
        trust_level: "presence-only-demo",
      };
      return true;
    });
  }

  /** The deny seam — the human rejected the approve screen. Terminal (spec FR-007). */
  async _deny(id: string): Promise<boolean> {
    return this.locks.run(id, async () => {
      const rec = this.records.get(id);
      if (!rec || rec.status !== "pending") return false;
      rec.status = "denied";
      return true;
    });
  }

  /** Is this sku inside the grant's `allow` bounds? Fail-closed: with bounds set, an unknown or
   *  uncategorized item does NOT pass. No bounds ⇒ everything in the catalog is allowed.
   *  Delegates to the SHARED predicate the approve page's age disclosure reads (grants-age.ts),
   *  so what the page says a grant covers is exactly what this enforces (#172). */
  private allowed(rec: GrantRecord, sku: string): boolean {
    return skuAllowed(rec.opts.allow, sku, this.deps.catalog ?? {});
  }

  private view(rec: GrantRecord): Grant {
    const spend = async ({ idempotencyKey, items }: SpendItems): Promise<SpendDoor> =>
      // Serialized per grant (fix 1): the idempotency-cache read and the engine draw commit run
      // as ONE unit, so two concurrent SAME-key spends collapse to one charge with a clean replay
      // for the loser — never a spurious `revoked` (which is what the engine's lost atomic
      // single-use looks like out of order). Distinct-key spends serialize too and each commits
      // atomically. (Issue #104, fix 1 — ported from the closed PR #106.)
      this.locks.run(rec.id, async (): Promise<SpendDoor> => {
        // Malformed input refuses BEFORE the key is consulted or consumed (P2 on #112): the engine
        // prices exactly one item, so a multi-item array must not silently drop items past the first.
        if (!Array.isArray(items) || items.length !== 1) return { ok: false, code: "invalid-request" };

        // Idempotent replay FIRST — a safe retry echoes the original outcome, SUCCESS OR REFUSAL
        // (P2 on #112: replaying only successes let a refused key be repurposed with a cheaper item).
        const cached = rec.cache.get(idempotencyKey);
        if (cached) return { ...cached, replayed: true };

        // Status gates the spend (FR-007): only an authorized grant spends. Fail-closed —
        // pending/denied never reach the engine; revoked is ALSO re-checked by the engine's
        // ledger at settle (revoke-wins, even for an in-flight spend). Deliberately UNCACHED:
        // status legitimately transitions (pending → authorized), so a retry after approval
        // must proceed — unlike engine/bounds refusals, which are final for that key.
        if (rec.status !== "authorized" || !rec.engine) {
          return { ok: false, code: rec.status === "revoked" ? "revoked" : "not-authorized" };
        }

        // The `allow` bounds — WHAT may be bought (invariant 1: enforced here, server-side,
        // before any engine work; the sealed caps then bound HOW MUCH). Refusal is cached like
        // any engine outcome — a refused key can't be re-tried with a different item.
        const { sku, qty = 1 } = items[0];
        if (!this.allowed(rec, sku)) {
          const refusal: SpendDoor = { ok: false, code: "not-allowed" };
          rec.cache.set(idempotencyKey, refusal);
          return refusal;
        }

        const r = await rec.engine.spend({ idempotencyKey, item: sku, quantity: qty });
        // The engine runs in cents (fix 2); convert its amount/remaining back to the plain-dollar
        // public surface. Division by 100 of an integer-cent value is exact for any cent amount.
        const door: SpendDoor = r.ok
          ? { ok: true, amount: r.amount / 100, remaining: r.remaining / 100, replayed: false, authorization: "delegated", ...(r.delegationId ? { delegationId: r.delegationId } : {}) }
          : { ok: false, code: CODE_MAP[r.reason ?? ""] ?? "refused", remaining: r.remaining / 100, ...(r.retryable ? { retryable: r.retryable } : {}) };
        rec.cache.set(idempotencyKey, door);
        return door;
      });

    return {
      id: rec.id,
      get status() {
        return rec.status;
      },
      approveUrl: `${this.deps.walletOrigin}/credentagent/grants/${rec.id}`,
      merchant: rec.opts.merchant,
      budget: rec.opts.budget,
      perSpend: rec.opts.perSpend,
      allow: rec.opts.allow,
      description: rec.opts.description,
      presence: rec.engine?.presence ?? "delegated-demo",
      trustLevel: rec.engine?.trustLevel ?? "server-issued-demo",
      // Derived HERE, from the sealed bounds against the live catalog — never reported by the
      // agent (#172). Re-derived per handle read, so a catalog change is reflected at the next
      // `retrieve()`; it is disclosure, not the control (grants-age.ts documents the limit).
      ageScope: ageScopeFor(rec.opts.allow, this.deps.catalog),
      // The sealed intent is the authority once authorized; before that, the pending record's
      // claim is what the approve page reflects back to the human.
      ageProof: rec.engine?.ageProof ?? rec.ageProof,
      spend,
      revoke: async () => {
        // Revoke the engine's ledger IMMEDIATELY — OUTSIDE the per-grant queue — so a spend
        // already in flight sees it at its atomic settle-time re-check and is refused: revoke
        // wins even mid-spend (spec 009 FR §136–140; Codex P1). Holding the mutex across the
        // in-flight spend and revoking inside it would queue the revoke behind that spend and let
        // it settle first. Ledger `revoke()` is idempotent, so the serialized re-revoke is safe.
        if (rec.engine) await rec.engine.revoke();
        // Flip status + catch an authorize that raced us (it may seal a NEW engine after the line
        // above) — serialized against _authorize so a revoked grant is never left spendable.
        await this.locks.run(rec.id, async () => {
          if (rec.engine) await rec.engine.revoke();
          rec.status = "revoked";
        });
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
  /** The one merchant this grant is cryptographically scoped to (the sealed authorization record). */
  readonly merchant: string;
  budget: number;
  perSpend: number;
  allow?: GrantAllow;
  description?: string;
  /** When/how consent happened — "delegated-demo" until the wallet ceremony lands (honesty axis). */
  presence: string;
  trustLevel: string;
  /** What these bounds cover, age-wise — the fact the approve page discloses BEFORE the human
   *  taps Approve (#172). `{ minimumAge: null, items: [] }` when nothing in scope is restricted.
   *  A forecast for a category grant, and DISCLOSURE only: the spend-time refusal is unchanged. */
  readonly ageScope: GrantAgeScope;
  /** The age claim the human proved at approval time, if they did (#172). Absent ⇒ an
   *  age-restricted purchase steps up. Read it to answer "may this grant buy that?" the way the
   *  gate does — pair it with `ageProofCovers(proof, requiredAge)`. */
  readonly ageProof?: SealedAgeProof;
  spend(input: SpendItems): Promise<SpendDoor>;
  revoke(): Promise<void>;
}
