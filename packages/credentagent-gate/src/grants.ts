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
import { serveGrants, type GrantsApp } from "./grants-serve.js";
import type { IntentBoundsInput } from "./ceremony/intent-sign/bounds.js";
import type { Branding, ReaderIdentity, TrustLevel } from "./types.js";

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

/** How the human authorizes a grant (spec 012):
 *  • "page"   — today's default: click Approve on the server page (server-issued-demo).
 *  • "device" — the wallet SIGNS the Intent Mandate first; the grant reaches "authorized"
 *               ONLY through the verified device signature (trust_level "device-signed").
 */
export type GrantSigning = "device" | "page";

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
  /** How the human authorizes (spec 012). Default "page" — today's behavior, byte-for-byte.
   *  "device" opts into wallet signing: the grant's approveUrl serves the signing ceremony and
   *  the grant only authorizes on a verified device signature over its exact bounds. Additive. */
  signing?: GrantSigning;
}

export type GrantStatus = "pending" | "authorized" | "denied" | "revoked";

/** A grant's DISPLAY lifecycle — the projection/UI state, derived ONCE server-side from the
 *  raw {@link GrantStatus} plus the live money read so a view never re-derives "low"/"exhausted"
 *  independently (spec 011 FR-1 / UX A2). `low` = remaining has fallen to ≤ 20% of budget;
 *  `exhausted` = the budget is fully drawn down. */
export type GrantLifecycle = "pending" | "active" | "low" | "exhausted" | "revoked" | "denied";

/** A grant's live money read, in the grant's dollars — what a display shows and what the
 *  {@link grantLifecycle} derivation reads. `spent + remaining === budget`. */
export interface GrantUsage {
  budget: number;
  spent: number;
  remaining: number;
}

/** Fraction of the budget at/under which an active grant reads as "running low" (UX design §5). */
const LOW_BUDGET_FRACTION = 0.2;

/**
 * The ONE lifecycle derivation (spec 011 FR-1 / UX A2): map a grant's raw status + live money
 * to its display lifecycle. Terminal/pending states pass straight through; an authorized grant
 * is `exhausted` when spent out, `low` at ≤ 20% remaining, else `active`. Kept here (not in the
 * widget) so every surface — server projection, tests, custom views — reads the same rule.
 */
export function grantLifecycle(input: { status: GrantStatus; budget: number; remaining: number }): GrantLifecycle {
  const { status, budget, remaining } = input;
  if (status === "pending") return "pending";
  if (status === "denied") return "denied";
  if (status === "revoked") return "revoked";
  // authorized:
  if (remaining <= 0) return "exhausted";
  if (remaining <= LOW_BUDGET_FRACTION * budget) return "low";
  return "active";
}

/** The one spend door (spec 009 FR-003 shape). A retried idempotency key replays the ORIGINAL
 *  outcome — success OR refusal (`replayed: true` on both) — so a key can never be repurposed
 *  with a different item after a refusal (a P2 on #112). */
export type SpendDoor =
  | {
      ok: true;
      amount: number;
      remaining: number;
      replayed: boolean;
      authorization: "delegated";
      delegationId?: string;
      /** For a device-signed grant (spec 012, FR-5): the signed Intent Mandate this spend
       *  draws against — `id` (the content-addressed mandate id) + `boundsHash` (the exact
       *  bounds the device signed). Absent on page-mode grants. So a settled purchase traces
       *  to the signed authority. */
      mandate?: { id: string; boundsHash: string };
    }
  | { ok: false; code: GrantDoorCode; remaining?: number; retryable?: string; replayed?: boolean };

/** The device-signature evidence recorded when a device-mode grant authorizes (spec 012).
 *  `verifiedBy` + `trustLevel` are the FR-4 provenance: "gate"/"device-signed" for the in-gate
 *  backend, or an external verifier's id + its attested level (relayed verbatim). */
export interface GrantMandateEvidence {
  boundsHash: string;
  signedAt: string;
  credentialDoctype: string;
  verifiedBy: string;
  trustLevel: TrustLevel;
}

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
  /** When the grant was opened (ISO 8601) — part of the signed bounds (spec 012). */
  createdAt: string;
  /** A per-grant random salt folded into the signed bounds (spec 012, bounds.ts). */
  boundsNonce: string;
  /** Minted at AUTHORIZE time (the intent is sealed when the human approves, not before). */
  engine?: DelegatedGrant;
  /** Device-signature evidence (spec 012) — present once a device-mode grant authorizes. */
  mandate?: GrantMandateEvidence;
  /** The content-addressed Intent Mandate id (the engine's id) a device spend references. */
  mandateId?: string;
  /** Idempotent spend cache: key → the door already returned (a retry replays it). */
  cache: Map<string, SpendDoor>;
}

export interface GrantsDeps {
  walletOrigin: string;
  /** The priced catalog (dollars) — the ONE price source; also read by the `allow` bounds. */
  catalog?: Record<string, CatalogEntry>;
  /** Stable secret sealing the intent-sign reader context (spec 012). Defaults to a
   *  per-instance random key — fine because grant records are in-memory / process-local. */
  signingKey?: string;
  /** Stable reader identity the intent-sign request presents (absent ⇒ per-request self-signed). */
  readerIdentity?: ReaderIdentity;
  /** Host brand for the signing page (absent ⇒ the built-in look; never brands the trust line). */
  branding?: Branding;
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
  /** Stable secret that seals the intent-sign reader context (spec 012). */
  readonly signingSecret: string;

  constructor(private readonly deps: GrantsDeps) {
    this.signingSecret = deps.signingKey ?? globalThis.crypto.randomUUID();
  }

  /** Config the intent-sign rail (spec 012) reads via `grants.serve(app)`. */
  get railConfig(): { walletOrigin: string; secret: string; readerIdentity?: ReaderIdentity; branding?: Branding } {
    return {
      walletOrigin: this.deps.walletOrigin,
      secret: this.signingSecret,
      ...(this.deps.readerIdentity ? { readerIdentity: this.deps.readerIdentity } : {}),
      ...(this.deps.branding ? { branding: this.deps.branding } : {}),
    };
  }

  /** The grant's signed BOUNDS (spec 012) — assembled from the SERVER's record, never the
   *  client. `null` when the grant is unknown. The intent-sign rail re-derives boundsHash
   *  from this at /verify and requires equality with the value sealed at /request. */
  _boundsInputFor(id: string): IntentBoundsInput | null {
    const rec = this.records.get(id);
    if (!rec) return null;
    return {
      grantId: rec.id,
      merchant: rec.opts.merchant,
      budget: rec.opts.budget,
      perSpend: rec.opts.perSpend,
      ...(rec.opts.allow ? { allow: rec.opts.allow } : {}),
      createdAt: rec.createdAt,
      nonce: rec.boundsNonce,
    };
  }

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
    const rec: GrantRecord = {
      id,
      status: "pending",
      opts: sealed,
      // The bounds a device signs over (spec 012): a creation timestamp + a random salt, so
      // re-creating identical bounds still hashes distinctly. Minted for every grant (inert
      // for page mode — it never computes boundsHash).
      createdAt: new Date().toISOString(),
      boundsNonce: globalThis.crypto.randomUUID(),
      cache: new Map(),
    };
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
      // A device-mode grant NEVER authorizes through the page-approve seam (spec 012, FR-3):
      // only a verified device signature (_authorizeDevice) can seal it. Refuse here — the
      // grant stays pending — so "signed by the device first" cannot be side-stepped by
      // clicking the old approve button. (Bypass test (d) deletes this guard.)
      if (rec.opts.signing === "device") return false;
      rec.engine = await this.engineGate().preApprove({
        merchant: rec.opts.merchant,
        perOrder: toCents(rec.opts.perSpend),
        total: toCents(rec.opts.budget),
        description:
          rec.opts.description ?? `Up to $${rec.opts.budget} at ${rec.opts.merchant}, $${rec.opts.perSpend}/purchase`,
      });
      rec.status = "authorized";
      return true;
    });
  }

  /**
   * The DEVICE authorize seam (spec 012) — called by the intent-sign rail's /verify ONLY
   * after it verified the wallet's device signature over this grant's exact bounds. Seals the
   * engine with the evidence's trust level (relayed verbatim — the gate never upgrades it) and
   * records the mandate. A page-mode grant, or a grant not pending, is refused — so a
   * device-signed authorization can never be forged around the verified-evidence path.
   */
  async _authorizeDevice(id: string, evidence: GrantMandateEvidence): Promise<boolean> {
    return this.locks.run(id, async () => {
      const rec = this.records.get(id);
      if (!rec || rec.status !== "pending" || rec.opts.signing !== "device") return false;
      rec.engine = await this.engineGate().preApprove({
        merchant: rec.opts.merchant,
        perOrder: toCents(rec.opts.perSpend),
        total: toCents(rec.opts.budget),
        description:
          rec.opts.description ?? `Up to $${rec.opts.budget} at ${rec.opts.merchant}, $${rec.opts.perSpend}/purchase`,
        // Honesty carried in the SEALED record: real consent + the attested trust level.
        presence: "delegated",
        trustLevel: evidence.trustLevel,
      });
      rec.status = "authorized";
      rec.mandate = evidence;
      rec.mandateId = rec.engine.id;
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
          ? {
              ok: true,
              amount: r.amount / 100,
              remaining: r.remaining / 100,
              replayed: false,
              authorization: "delegated",
              ...(r.delegationId ? { delegationId: r.delegationId } : {}),
              // Trace the spend to the signed Intent Mandate (spec 012, FR-5) — device grants only.
              ...(rec.mandate && rec.mandateId ? { mandate: { id: rec.mandateId, boundsHash: rec.mandate.boundsHash } } : {}),
            }
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
      signing: rec.opts.signing ?? "page",
      presence: rec.engine?.presence ?? "delegated-demo",
      // The trust axis carries the honesty (spec 012): a device-signed grant relays the
      // evidence's level ("device-signed", or a verifier's attested level); page mode stays
      // "server-issued-demo". The TYPE, not copy, tells the two apart (FR-3).
      trustLevel: rec.mandate?.trustLevel ?? rec.engine?.trustLevel ?? "server-issued-demo",
      // The device-signature evidence (spec 012) — present only once a device grant is signed.
      ...(rec.mandate ? { mandate: { boundsHash: rec.mandate.boundsHash, signedAt: rec.mandate.signedAt, credentialDoctype: rec.mandate.credentialDoctype, verifiedBy: rec.mandate.verifiedBy } } : {}),
      usage: async (): Promise<GrantUsage> => {
        const budget = rec.opts.budget;
        // Before authorize there is no engine ledger yet: nothing has been drawn, so the
        // full budget is available. After authorize (incl. once revoked) the engine's
        // committed-draws ledger is the authority — convert its cents back to dollars.
        if (!rec.engine) return { budget, spent: 0, remaining: budget };
        const { spent, remaining } = await rec.engine.usage();
        return { budget, spent: spent / 100, remaining: remaining / 100 };
      },
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
  /** How the human authorizes this grant (spec 012) — "page" (default) or "device". */
  readonly signing: GrantSigning;
  /** When/how consent happened — "delegated-demo" until the wallet ceremony lands (honesty axis). */
  presence: string;
  /** How strongly the authorization is bound (honesty axis): "server-issued-demo" for page mode,
   *  "device-signed" once a device grant is wallet-signed (or a verifier's relayed level). */
  trustLevel: string;
  /** The device-signature evidence (spec 012) — present ONLY once a device-mode grant is signed:
   *  the exact bounds the device signed (`boundsHash`), when, which credential doctype, and who
   *  verified. Absent on page-mode grants and unsigned device grants. */
  readonly mandate?: { boundsHash: string; signedAt: string; credentialDoctype: string; verifiedBy: string };
  /** Live money read (dollars) for a display/projection — `{ budget, spent, remaining }`. Async
   *  because the engine's committed-draws ledger is the authority (it may be remote later); a
   *  pending grant reads `{ spent: 0, remaining: budget }`. Feeds {@link grantLifecycle}. */
  usage(): Promise<GrantUsage>;
  spend(input: SpendItems): Promise<SpendDoor>;
  revoke(): Promise<void>;
}
