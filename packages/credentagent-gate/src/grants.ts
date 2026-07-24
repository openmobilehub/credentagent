// credentagent.grants — durable spend authority (spec 009, the human-not-present half; #104).
//
//   const grant = await credentagent.grants.create({ merchant, budget: usd.dollars(100), perSpend: usd.dollars(30), policy });
//   sendToUser(grant.approveUrl);                                  // the human approves the LIMIT once
//   // later, from a worker — human away:
//   const grant = await credentagent.grants.retrieve(id);          // status: pending|authorized|denied|revoked|not-found
//   const s = await grant.spend({ idempotencyKey, items: [{ sku: "coffee", qty: 1 }] });
//
// A grant is the durable authority handle (status, remaining, spend, revoke); the AP2
// Intent Mandate is the sealed artifact it CARRIES (`grant.intentMandate`), produced at the
// authorize ceremony — two layers, two names (maintainer decision, 2026-07-23).
//
// Honesty (constitution VII): the delegate key is minted SERVER-side at authorize, so grants
// carry trust_level "server-issued-demo" — no real value settles, and the wallet-custody
// increment swaps the internals without changing this surface. Age and custom gate()
// credentials are NON-delegable: the shared completion seam steps them up to a live human.
//
// This is the ONE seam where Money converts to the repo's dollar-number amounts
// (GateOrder / IntentBounds / catalog prices): `dollarsOf()` below. Nowhere else.

import { webcrypto } from "node:crypto";
import type { Credential, GateOrder, Step, VerificationManifestEntry } from "./types.js";
import type { OrderStore, CompletedOrder } from "./orders.js";
import type { CeremonyCatalog } from "./ceremony/types.js";
import type { RevocationStore } from "./ceremony/revocation.js";
import { sealIntent, signDraw, type IntentBounds, type DelegateJwk } from "./ceremony/mandate.js";
import { completeOrder, type CompletedRecord } from "./ceremony/completion.js";
import { MemoryVerificationStore } from "./store.js";
import { usd, type Money } from "./money.js";

const { subtle } = webcrypto;

/** The delegate PRIVATE key as a JWK — server-held custody (trust_level "server-issued-demo").
 *  Unlike `DelegatedGate` (in-process, non-extractable key), a grant must rehydrate in a
 *  DIFFERENT process (`grants.retrieve` in a worker — spec 009 FR-007), so the key rides in
 *  the grant store. The wallet-custody increment moves it to the user's wallet. */
export interface DelegatePrivateJwk extends DelegateJwk {
  d: string;
}

/** The one Money → dollar-number conversion in the package (see header). */
const dollarsOf = (m: Money): number => m.serialize().amount / 100;

/** What the caller passes to `grants.create()`. Amounts are Money — never raw scalars. */
export interface CreateGrantOptions {
  /** The one merchant this grant may spend at. */
  merchant: string;
  /** Cumulative lifetime cap across every spend (does not reset). */
  budget: Money;
  /** Per-spend ceiling (an absolute cap). */
  perSpend: Money;
  /** Credential policy the human must satisfy at the authorize ceremony. `[]` ⇒ ungated. */
  policy: Step[];
  /** A human sentence describing the grant (shown on the approve page). */
  description?: string;
}

export type GrantStatus = "pending" | "authorized" | "denied" | "revoked" | "not-found";

/** The stored record — the server-side authority for terms + lifecycle (invariant 2/4). */
export interface GrantRecord {
  id: string;
  merchant: string;
  /** Dollars (converted from Money ONCE at create — see `dollarsOf`). */
  budgetDollars: number;
  perSpendDollars: number;
  currency: "USD";
  description?: string;
  policy: Step[];
  status: Exclude<GrantStatus, "not-found">;
  /** Sealed at authorize (dev-sealed, trust_level server-issued-demo). */
  intent?: IntentBounds;
  /** The delegate PRIVATE key, server-held (server-issued-demo; wallet-custody swaps this). */
  delegateJwk?: DelegatePrivateJwk;
}

export interface SpendItem {
  sku: string;
  qty?: number;
}

/** One result door for every spend (spec 009 FR-003). */
export type SpendDoor =
  | {
      ok: true;
      /** The catalog-priced amount of THIS spend (never trusted from the caller). */
      amount: Money;
      /** Headroom left on the budget AFTER this spend. */
      remaining: Money;
      /** True when this call safely replayed an already-completed spend (same idempotencyKey). */
      replayed?: true;
      authorization: "delegated";
      trustLevel: string;
      mandateBundle: { intentMandate: IntentBounds; draw: unknown };
    }
  | {
      ok: false;
      /** "budget-exceeded" | "per-spend-exceeded" | "revoked" | "not-authorized" | "step-up" | … */
      code: string;
      remaining: Money;
      retryable?: "retry" | "needs-human" | "terminal";
      trustLevel: string;
    };

export interface GrantsDeps {
  walletOrigin: string;
  store: OrderStore<GrantRecord>;
  revocation: RevocationStore;
  /** The client's priced catalog (spec FR-001) — required for `spend()`, not for create/retrieve. */
  catalog?: CeremonyCatalog;
  requirements: (order: GateOrder, policy: Step[]) => VerificationManifestEntry[];
  /** Route a completed spend through `orders._complete` — settled event + webhooks for free. */
  completeSpend: (record: CompletedOrder) => Promise<void>;
  /** Read a spend's completion (replay detection) — the orders completed store. */
  readSpend: (orderId: string) => Promise<CompletedOrder | undefined> | CompletedOrder | undefined;
  /** The client's credential registry, so the spend path enforces custom gate()s (007/inv. 1). */
  credentialRegistry?: ReadonlyMap<string, Credential>;
  /** Wire the approve page + rails onto an Express app — `grants.serve(app)` (set in client). */
  serve?: (app: unknown) => void;
}

const genId = (): string => `gr_${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const TRUST_PENDING = "server-issued-demo";

export class Grants {
  constructor(private readonly deps: GrantsDeps) {}

  /** Open a grant awaiting the human's one-time approval. Persisted BEFORE the URL is handed out. */
  async create(opts: CreateGrantOptions): Promise<Grant> {
    const id = genId();
    const record: GrantRecord = {
      id,
      merchant: opts.merchant,
      budgetDollars: dollarsOf(opts.budget),
      perSpendDollars: dollarsOf(opts.perSpend),
      currency: "USD",
      ...(opts.description ? { description: opts.description } : {}),
      policy: opts.policy,
      status: "pending",
    };
    await this.deps.store.write(id, record);
    return new Grant(record, this.deps);
  }

  /** Rehydrate a grant by id. Unknown ids answer with a typed `not-found` handle — no throw. */
  async retrieve(id: string): Promise<Grant> {
    const record = await this.deps.store.read(id);
    if (!record) return Grant.notFound(id, this.deps);
    return new Grant(record, this.deps);
  }

  /** Wire the approve page (each grant's `approveUrl`) + ceremony rails onto your app. */
  serve(app: unknown): void {
    if (!this.deps.serve) throw new Error("[credentagent] grants.serve(app) is not wired on this client.");
    this.deps.serve(app);
  }

  /** Called by the approve ceremony when the human approves — seals the AP2 Intent Mandate
   *  (dev-sealed, trust_level "server-issued-demo"), mints the delegate key (server custody —
   *  extractable, because a worker process rehydrates and spends later; see DelegatePrivateJwk),
   *  and flips status to "authorized". Idempotent: only a PENDING grant seals; a re-POST or a
   *  denied/revoked grant is a no-op (fail-closed — never re-seal, never resurrect). */
  async _authorize(id: string): Promise<void> {
    const record = await this.deps.store.read(id);
    if (!record || record.status !== "pending") return;
    const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pub = await subtle.exportKey("jwk", pair.publicKey);
    const priv = (await subtle.exportKey("jwk", pair.privateKey)) as DelegatePrivateJwk;
    const delegate: DelegateJwk = { kty: "EC", crv: "P-256", x: pub.x!, y: pub.y! };
    const intent = await sealIntent({
      type: "credentagent.IntentBounds/v0",
      ...(record.description ? { naturalLanguageDescription: record.description } : {}),
      merchants: [record.merchant],
      currency: record.currency,
      maxAmount: record.perSpendDollars,
      totalAmount: record.budgetDollars,
      delegate,
      presence: "delegated-demo",
      trust_level: "server-issued-demo",
    });
    await this.deps.store.write(id, { ...record, status: "authorized", intent, delegateJwk: priv });
  }
}

/**
 * A grant handle. Status is a retrieve-time snapshot for display; `spend()`/`revoke()`
 * ALWAYS re-read the stored record, so a stale handle can never bypass a revocation.
 */
export class Grant {
  private constructorStatus: GrantStatus;

  constructor(
    private readonly record: GrantRecord | undefined,
    private readonly deps: GrantsDeps,
    private readonly missingId?: string,
  ) {
    this.constructorStatus = record ? record.status : "not-found";
  }

  static notFound(id: string, deps: GrantsDeps): Grant {
    return new Grant(undefined, deps, id);
  }

  get id(): string {
    return this.record?.id ?? this.missingId!;
  }

  get status(): GrantStatus {
    return this.constructorStatus;
  }

  get approveUrl(): string {
    return `${this.deps.walletOrigin}/credentagent/grants/${this.id}`;
  }

  /** The terms as Money — the raw dollar numbers stay server-side. */
  get terms(): { merchant: string; budget: Money; perSpend: Money; description?: string } {
    const r = this.requireRecord();
    return {
      merchant: r.merchant,
      budget: usd.dollars(r.budgetDollars),
      perSpend: usd.dollars(r.perSpendDollars),
      ...(r.description ? { description: r.description } : {}),
    };
  }

  /** The AP2 Intent Mandate this grant carries — sealed at authorize, absent while pending. */
  get intentMandate(): IntentBounds | undefined {
    return this.record?.intent;
  }

  get trustLevel(): string {
    return this.record?.intent?.trust_level ?? TRUST_PENDING;
  }

  private requireRecord(): GrantRecord {
    if (!this.record) throw new Error(`[credentagent] grant ${this.missingId} not found.`);
    return this.record;
  }

  /**
   * Revoke the grant — the kill switch. Writes BOTH authorities: the revocation store
   * (what the draw engine checks — a stale handle can never spend past it) AND the stored
   * status (what retrieve()/UIs read). A revoked grant is never resurrected: `_authorize`
   * only seals a PENDING record.
   */
  async revoke(): Promise<void> {
    const record = await this.deps.store.read(this.id);
    if (!record) return;
    // The intent may not exist yet (revoking a pending grant) — the status write alone
    // covers that case; the ledger write covers the authorized case.
    if (record.intent) await this.deps.revocation.revoke(record.intent.intentId);
    await this.deps.store.write(this.id, { ...record, status: "revoked" });
    this.constructorStatus = "revoked";
  }

  /** Budget headroom from the committed-draw ledger (the revocation store is the authority). */
  private async remainingOf(record: GrantRecord): Promise<Money> {
    if (!record.intent) return usd.dollars(record.budgetDollars);
    const committed = await this.deps.revocation.priorDraws(record.intent.intentId);
    return usd.dollars(record.budgetDollars - committed.reduce((sum, d) => sum + d.amount, 0));
  }

  /**
   * Spend against the grant while the human is away. Refusals are DATA (`{ ok:false, code }`),
   * never throws; a throw is a programming error (unknown sku, missing catalog config).
   *
   * Always re-reads the stored record — a stale handle can never bypass a revocation — and
   * routes the completion through the SAME choke point human-present orders use, so
   * `order.settled` and webhook fan-out fire for a delegated spend too.
   */
  async spend({ idempotencyKey, items }: { idempotencyKey: string; items: SpendItem[] }): Promise<SpendDoor> {
    const record = await this.deps.store.read(this.id);
    if (!record) return { ok: false, code: "not-found", remaining: usd.dollars(0), retryable: "terminal", trustLevel: TRUST_PENDING };
    const trust = record.intent?.trust_level ?? TRUST_PENDING;
    const remaining = await this.remainingOf(record);
    if (record.status === "revoked") return { ok: false, code: "revoked", remaining, retryable: "terminal", trustLevel: trust };
    if (record.status !== "authorized" || !record.intent || !record.delegateJwk) {
      // pending or denied — the human has not approved; surface the approve link path.
      return { ok: false, code: "not-authorized", remaining, retryable: "needs-human", trustLevel: trust };
    }
    if (!this.deps.catalog) {
      throw new Error(
        "[credentagent] grants: no catalog configured. Pass `new CredentAgent({ catalog: { sku: price, ... } })` — spends are re-priced server-side from it (a caller never passes an amount).",
      );
    }

    // The order id is DERIVED from the caller's idempotency key, namespaced by the grant
    // (invariant 4 — grant B must never read grant A's completion). A retry with the same key
    // is answered from the completed record — one draw, charged once, `replayed: true`.
    const orderId = `${this.id}-${idempotencyKey}`;
    const prior = await this.deps.readSpend(orderId);
    if (prior) {
      return {
        ok: true,
        amount: usd.dollars(prior.amount ?? 0),
        remaining,
        replayed: true,
        authorization: "delegated",
        trustLevel: trust,
        mandateBundle: (prior.mandateBundle as { intentMandate: IntentBounds; draw: unknown } | undefined) ?? { intentMandate: record.intent, draw: undefined },
      };
    }

    const order = this.deps.catalog.createOrder(
      items.map((i) => ({ productId: i.sku, quantity: i.qty ?? 1 })),
      orderId,
    );
    const key = await subtle.importKey("jwk", record.delegateJwk as webcrypto.JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const draw = await signDraw(
      {
        type: "credentagent.Draw/v0",
        intentId: record.intent.intentId,
        paymentMandateId: idempotencyKey,
        merchant: record.merchant,
        amount: order.total,
        currency: record.currency,
        pspTransactionId: idempotencyKey,
      },
      key,
    );
    const mandateBundle = { intentMandate: record.intent, draw };
    // The records seam forwards to `orders._complete` — the one completion choke point —
    // persisting the bundle so a later replay echoes it.
    const records = {
      read: async (oid: string): Promise<CompletedRecord | undefined> => {
        const done = await this.deps.readSpend(oid);
        if (!done) return undefined;
        return { orderId: oid, mandateId: done.txId ?? "", amount: done.amount ?? 0, currency: done.currency ?? "", method: done.method ?? "", gates: [], completedAt: done.completedAt ?? "" };
      },
      write: async (r: CompletedRecord): Promise<void> => {
        await this.deps.completeSpend({
          orderId: r.orderId,
          amount: r.amount,
          currency: r.currency,
          method: r.method,
          completedAt: r.completedAt,
          mandateBundle,
        });
      },
    };
    const res = await completeOrder(
      { order, mandateId: idempotencyKey, amount: order.total, currency: record.currency, method: "delegated", gates: [], draw: { intent: record.intent, draw } },
      {
        catalog: this.deps.catalog,
        revocation: this.deps.revocation,
        verificationStore: new MemoryVerificationStore(), // draws carry no live-verification state
        records,
        ...(this.deps.credentialRegistry ? { credentialRegistry: this.deps.credentialRegistry } : {}),
      },
    );
    const after = await this.remainingOf(record);
    if (res.completed) {
      return { ok: true, amount: usd.dollars(order.total), remaining: after, authorization: "delegated", trustLevel: trust, mandateBundle };
    }
    const refusal = res.refusals?.[0];
    // The spec-009 door names for the two budget codes; everything else passes through.
    const code = refusal?.code === "over-total" ? "budget-exceeded" : refusal?.code === "over-cap" ? "per-spend-exceeded" : (refusal?.code ?? "refused");
    return { ok: false, code, remaining: after, ...(refusal?.retryable ? { retryable: refusal.retryable } : {}), trustLevel: trust };
  }
}
