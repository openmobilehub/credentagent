// Agent-signed purchases over HTTP — the store's half of a grant whose key the AGENT holds.
//
// OPT-IN: these routes exist only when the host sets `agents: { trust: "presence-only-demo" }` on
// `new CredentAgent(...)`. A store that keeps its own ledger (README, "Two things stay yours") must
// not get a second one by upgrading. Routes live under /credentagent/grants/:id because that is where
// the grant's id and approve page already are; ticket #263 sketched /credentagent/agents/* and the
// open decision on it is #285 — moving them is a rename, not a redesign.
//
// A verified purchase finishes through the SAME path as every other order: the shared `completeOrder`
// (age and custom-gate checks re-derived from the catalog) and then `orders._complete`, so
// `order.settled`, webhooks and `orders.retrieve()` behave as for a person's checkout.
//
//   GET  /credentagent/grants/:id/delegation             the signed permission the agent spends
//   POST /credentagent/grants/:id/purchases              quote a cart from the CATALOG + issue a nonce
//   POST /credentagent/grants/:id/purchases/:nonce/proof verify the agent's Checkout + Payment mandates
//
// Everything that decides is server-side and comes from the store, never from the caller: the
// audience, the nonce (single-use, bound to one grant and one cart, short-lived), the spend ledger
// (on the grant record, so `usage()` and the card read it) and the catalog price. The agent's private
// key is never an input or an output of any route here.
//
// HONESTY: a verified purchase proves the holder key the credential names signed the permission and
// the agent's key signed this cart. A self-minted credential passes, so it proves nothing about who
// issued it (#14): `trust_level` says so.
import { randomUUID } from "node:crypto";
import { DelegatedIntent, verifyDelegatedPurchase, type DelegatedPurchaseProof, type PurchaseRefusal, type PurchaseRefusalCode } from "./ap2/chain/purchase.js";
import { toMinorUnits } from "./ap2/money.js";
import type { UcpCheckout } from "./ap2/types.js";
import { minAgeOf, type CatalogEntry } from "./delegated.js";
import { ageProofCovers } from "./ceremony/mandate.js";
import { completeOrder, type CompletedOrderStore } from "./ceremony/completion.js";
import type { CeremonyCatalog, CeremonyOrder } from "./ceremony/types.js";
import type { CompletedOrder } from "./orders.js";
import type { Credential, VerificationStore } from "./types.js";
import { skuAllowed } from "./grants-age.js";
import type { Grants } from "./grants.js";
import type { GrantsApp } from "./grants-serve.js";

/** How long a quote's nonce stays valid. Short: the agent quotes and signs in one breath. */
export const QUOTE_TTL_MS = 120_000;
/** Outstanding (unused, unexpired) quotes one grant may hold — against nonce flooding. */
export const MAX_OPEN_QUOTES_PER_GRANT = 5;
/** How long a used quote (and the receipt it holds) is kept after it expires, so an agent whose
 *  connection dropped can post the same proof again and get its receipt instead of buying twice. */
export const RECEIPT_RETENTION_MS = 10 * 60_000;
/** Most quotes (open or used, with their receipts) held at once per registration; the oldest go first. */
export const MAX_RETAINED_QUOTES = 10_000;

/** What the host wires in when it opts in: the shared completion path, and the state it reads. */
export interface AgentPurchaseDeps {
  /** Record a finished order and fire `order.settled` + webhooks — `orders._complete`. */
  complete(order: CompletedOrder): Promise<void>;
  /** Per-order verification state `completeOrder` reads (age). */
  verificationStore: VerificationStore;
  /** The custom `gate()` credentials `completeOrder` enforces on every completion path. */
  credentialRegistry: ReadonlyMap<string, Credential>;
}

export type PurchaseCode =
  | PurchaseRefusalCode
  | "unknown-grant"
  | "not-authorized"
  | "revoked"
  | "not-recorded"
  | "not-allowed"
  | "step-up"
  | "invalid-request"
  | "nonce-used"
  | "nonce-expired"
  | "too-many-quotes";

export type PurchaseDoor<T> = ({ ok: true } & T) | { ok: false; code: PurchaseCode; detail: string; violations?: PurchaseRefusal["violations"] };

export interface PurchaseQuote {
  nonce: string;
  checkoutJwt: string;
  audience: string;
  amount: number;
  currency: string;
  expiresAt: string;
}

export interface PurchaseReceipt {
  orderId: string;
  /** True when this is the receipt of an earlier identical proof, returned again — nothing was bought twice. */
  replayed?: boolean;
  amount: number;
  remaining: number;
  trustLevel: "presence-only-demo";
  checkout: string;
  payment: string;
}

interface Req {
  params: Record<string, string>;
  body?: unknown;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): unknown;
}
interface Quoted {
  grantId: string;
  /** The id of the cart this nonce quoted: a proof must be for THAT cart, not another the store signed. */
  cartId: string;
  sku: string;
  qty: number;
  amountMinor: number;
  expiresAtMs: number;
  used: boolean;
  /** The proof that used this nonce, and what came of it — so an identical retry gets the same answer. */
  proofKey?: string;
  outcome?: Promise<PurchaseDoor<{ receipt: PurchaseReceipt }>>;
}

const STATUS: Record<string, number> = {
  "unknown-grant": 404,
  "invalid-request": 400,
  "too-many-quotes": 429,
  "not-authorized": 409,
  revoked: 409,
  "not-recorded": 500,
  "nonce-used": 409,
  "nonce-expired": 409,
  "not-allowed": 403,
  "step-up": 403,
};
const refuse = (code: PurchaseCode, detail: string, violations?: PurchaseRefusal["violations"]) =>
  ({ ok: false, code, detail, ...(violations ? { violations } : {}) }) as { ok: false; code: PurchaseCode; detail: string; violations?: PurchaseRefusal["violations"] };
/** A grant that cannot sell right now, in the grant's own words: `revoked` is not "never approved". */
const notSelling = (status: string) => refuse(status === "revoked" ? "revoked" : "not-authorized", `the grant is ${status}`);
const send = (res: Res, door: { ok: boolean; code?: string; receipt?: unknown }) => res.status(door.ok ? 200 : STATUS[door.code ?? ""] ?? 422).json(door);

const priceOf = (e: CatalogEntry | undefined): number | undefined => (e === undefined ? undefined : typeof e === "number" ? e : e.price);
const titleOf = (e: CatalogEntry, sku: string): string => (typeof e === "number" ? sku : e.name ?? sku);

/** What the person is charged for `qty` of one item, in minor units, with the grant's loyalty discount
 *  applied once, here — the quote and the verifier's price check both call this, so they cannot drift. */
function chargedMinor(price: number, qty: number, discountPct: number): number {
  const listed = toMinorUnits(price, "USD") * qty;
  return discountPct > 0 ? listed - Math.round((listed * discountPct) / 100) : listed;
}

/** The catalog as `completeOrder` re-prices with it: the same cents-exact arithmetic as the quote, and
 *  the grant's own sealed loyalty rate (never the caller's). Amounts are dollars, as every order's are. */
function agentCatalog(items: Record<string, CatalogEntry>, discountPct: number): CeremonyCatalog {
  return {
    createOrder(refs, orderId): CeremonyOrder {
      let listedMinor = 0;
      let chargedTotal = 0;
      const lines = refs.map(({ productId, quantity }) => {
        const entry = Object.prototype.hasOwnProperty.call(items, productId) ? items[productId] : undefined;
        const price = priceOf(entry);
        if (entry === undefined || price === undefined) throw new Error(`[credentagent] unknown catalog item "${productId}"`);
        const lineMinor = toMinorUnits(price, "USD") * quantity;
        listedMinor += lineMinor;
        chargedTotal += chargedMinor(price, quantity, discountPct);
        const minimumAge = minAgeOf(entry);
        // Carry EVERY catalog attribute (category, requiresRx, …) onto the line, so a gate's `appliesTo` sees
        // what a person's checkout shows it. Without them a category-scoped gate would never apply here.
        const { price: _p, minAge: _m, ...details } = typeof entry === "number" ? ({} as Record<string, unknown>) : (entry as unknown as Record<string, unknown>);
        return { ...details, id: productId, unitPrice: price, quantity, lineTotal: lineMinor / 100, currency: "USD", ...(minimumAge ? { minimumAge } : {}) };
      });
      return { id: orderId, lines, itemCount: refs.length, subtotal: listedMinor / 100, discount: (listedMinor - chargedTotal) / 100, total: chargedTotal / 100, currency: "USD" };
    },
  };
}

export function registerPurchaseRoutes(app: GrantsApp, grants: Grants, deps: AgentPurchaseDeps): void {
  const get = app.get!.bind(app);
  const post = app.post!.bind(app);
  const cfg = grants.purchaseConfig;
  const quotes = new Map<string, Quoted>();

  const openQuotes = (grantId: string, now: number) => {
    let n = 0;
    for (const [nonce, q] of quotes) {
      if (now > q.expiresAtMs + RECEIPT_RETENTION_MS) quotes.delete(nonce); // nothing can use it, and no retry wants its receipt
      else if (!q.used && q.expiresAtMs >= now && q.grantId === grantId) n++;
    }
    return n;
  };

  get("/credentagent/grants/:id/delegation", async (req: Req, res: Res) => {
    const g = await grants.retrieve(req.params.id);
    if (!g) return send(res, refuse("unknown-grant", "no grant with this id"));
    if (!g.agentKey || g.status !== "authorized" || !g.mandate?.intent) {
      return send(res, refuse("not-authorized", "this grant has no signed permission an agent can spend"));
    }
    return send(res, { ok: true, intent: g.mandate.intent } as { ok: true; intent: unknown } & { ok: boolean });
  });

  post("/credentagent/grants/:id/purchases", async (req: Req, res: Res) => {
    const g = await grants.retrieve(req.params.id);
    if (!g) return send(res, refuse("unknown-grant", "no grant with this id"));
    if (!cfg.ap2 || !g.agentKey) return send(res, refuse("not-authorized", "this grant does not name an agent key, so an agent cannot sign purchases against it"));
    if (g.status !== "authorized") return send(res, notSelling(g.status));

    const body = (req.body ?? {}) as { sku?: unknown; qty?: unknown };
    const sku = typeof body.sku === "string" ? body.sku : "";
    const qty = body.qty === undefined ? 1 : body.qty;
    const entry = Object.prototype.hasOwnProperty.call(cfg.catalog, sku) ? cfg.catalog[sku] : undefined;
    const price = priceOf(entry);
    if (!sku || entry === undefined || price === undefined) return send(res, refuse("invalid-request", "unknown sku"));
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1) {
      return send(res, refuse("invalid-request", "qty must be a whole number, at least 1"));
    }
    // The signed open Checkout mandate holds ONE of each item per purchase, so a larger quantity would be
    // signed by the agent and then refused at verification, burning the nonce. Say so here instead.
    if (qty > 1) return send(res, refuse("invalid-request", "this grant's signed mandate allows one of each item per purchase"));
    // Age never delegates: an age-restricted item needs the proof the human sealed into THIS grant.
    const minAge = minAgeOf(entry);
    if (typeof minAge === "number" && minAge > 0 && !ageProofCovers(g.ageProof, minAge)) return send(res, refuse("step-up", `this item needs a proof of age ${minAge}+`));
    const signable = grants._allowedSkusFor(g.id);
    if (!skuAllowed(g.allow, sku, cfg.catalog) || (signable && !signable.includes(sku))) {
      return send(res, refuse("not-allowed", "this item is outside what the grant allows"));
    }

    const now = Date.now();
    if (openQuotes(g.id, now) >= MAX_OPEN_QUOTES_PER_GRANT) return send(res, refuse("too-many-quotes", "too many open quotes for this grant"));

    let amountMinor: number;
    try {
      amountMinor = chargedMinor(price, qty, g.membershipProof?.discountPct ?? 0);
    } catch {
      return send(res, refuse("invalid-request", "this item's catalog price is not a whole number of cents")); // typed, never a bare 500
    }
    const cart: UcpCheckout = {
      id: `ord_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      status: "ready_for_complete",
      currency: "USD",
      links: [],
      line_items: [{ id: "li_1", item: { id: sku, title: titleOf(entry, sku), price: Math.round(amountMinor / qty) }, quantity: qty, totals: [{ type: "total", amount: amountMinor }] }],
      totals: [{ type: "total", amount: amountMinor }],
    };
    let checkoutJwt: string;
    try {
      checkoutJwt = cfg.ap2.signCheckout(cart);
    } catch {
      return send(res, refuse("invalid-request", "the store could not quote this cart")); // a typed refusal, never a bare 500
    }
    const nonce = randomUUID();
    while (quotes.size >= MAX_RETAINED_QUOTES) quotes.delete(quotes.keys().next().value as string); // oldest first: bounded memory
    quotes.set(nonce, { grantId: g.id, cartId: cart.id, sku, qty, amountMinor, expiresAtMs: now + QUOTE_TTL_MS, used: false });
    const quote: PurchaseQuote = {
      nonce,
      checkoutJwt,
      audience: cfg.walletOrigin,
      amount: amountMinor / 100,
      currency: "USD",
      expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
    };
    return send(res, { ok: true, quote } as { ok: true; quote: PurchaseQuote } & { ok: boolean });
  });

  post("/credentagent/grants/:id/purchases/:nonce/proof", async (req: Req, res: Res) => {
    const grantId = req.params.id;
    const q = quotes.get(req.params.nonce);
    // An id that is not this grant's, or a nonce never issued, answers the same way and burns nothing.
    if (!q || q.grantId !== grantId) return send(res, refuse("nonce-used", "this nonce is unknown, used, or belongs to another grant"));
    const proof = (req.body as { proof?: DelegatedPurchaseProof } | undefined)?.proof as DelegatedPurchaseProof;
    const proofKey = typeof proof?.checkout === "string" && typeof proof?.payment === "string" ? `${proof.checkout}\n${proof.payment}` : undefined;

    if (q.used) {
      // The SAME proof posted again (the agent's connection dropped) gets the first answer back, marked as
      // a replay; anything else on a used nonce is refused. Either way nothing is bought a second time.
      if (q.outcome && proofKey !== undefined && q.proofKey === proofKey) {
        const first = await q.outcome;
        return send(res, first.ok ? { ...first, receipt: { ...first.receipt, replayed: true } } : first);
      }
      return send(res, refuse("nonce-used", "this nonce is unknown, used, or belongs to another grant"));
    }
    // Consume the nonce and park the attempt BEFORE any await: two concurrent submissions of one nonce
    // cannot both pass, and the second one can wait for the first one's answer.
    q.used = true;
    q.proofKey = proofKey;
    q.outcome = settle(grantId, req.params.nonce, q, proof).catch(() => refuse("not-recorded", "the purchase could not be completed; ask for a new quote"));
    return send(res, await q.outcome);
  });

  /** Verify, finish through the shared completion path, and take the budget — one unit per grant. */
  async function settle(grantId: string, nonce: string, q: Quoted, proof: DelegatedPurchaseProof): Promise<PurchaseDoor<{ receipt: PurchaseReceipt }>> {
    if (Date.now() > q.expiresAtMs) return refuse("nonce-expired", "the quote expired; ask for a new one");
    return grants._exclusive(grantId, async (): Promise<PurchaseDoor<{ receipt: PurchaseReceipt }>> => {
      // Read inside the unit: a revoke that landed since the quote must stop this purchase.
      const live = await grants.retrieve(grantId);
      if (!live) return refuse("unknown-grant", "no grant with this id");
      if (!cfg.ap2 || !live.agentKey || live.status !== "authorized") return notSelling(live.status);
      const pct = live.membershipProof?.discountPct ?? 0;
      let verdict;
      try {
        verdict = await verifyDelegatedPurchase(proof, {
          trust: "presence-only-demo",
          audience: cfg.walletOrigin,
          nonce,
          checkoutKey: cfg.ap2.checkoutPublicJwk,
          spent: () => grants._agentSpent(grantId),
          // The catalog prices the cart, never the proof (invariant 2). A price that is not whole cents is NaN: refused.
          price: (c) => c.line_items.reduce((sum, l) => {
            const p = priceOf(Object.prototype.hasOwnProperty.call(cfg.catalog, l.item.id) ? cfg.catalog[l.item.id] : undefined);
            try { return p === undefined ? Number.NaN : sum + chargedMinor(p, l.quantity, pct); } catch { return Number.NaN; }
          }, 0),
          nowMs: Date.now(),
        });
      } catch {
        return refuse("invalid-request", "the proof could not be read");
      }
      if (!verdict.ok) return refuse(verdict.code, verdict.detail, verdict.violations);
      // The mandates carry no grant id, and the store names ONE agent key on every grant, so the chain alone
      // cannot say which grant it spends. Require it to rest on THIS grant's own signed permission (else a
      // proof built from a larger grant would draw this grant's ledger past the budget its person approved),
      // and to be for the cart THIS nonce quoted.
      const own = live.mandate?.intent ? DelegatedIntent.fromWalletPresentation(live.mandate.intent).permissionId : undefined;
      if (!own || verdict.permissionId !== own) return refuse("not-authorized", "this proof rests on a different permission than this grant's");
      if (verdict.checkout.id !== q.cartId) return refuse("checkout-unbound", "this nonce was issued for another cart");

      // Finish the order through the shared `completeOrder`: it re-prices from the catalog, re-derives the age
      // restriction from the catalog's lines, and enforces every custom gate() — exactly as for a person's
      // checkout. The age proof is the one the person sealed into THIS grant; it counts only if it covers the
      // threshold the catalog demands NOW (an edit since the quote cannot slip an item past the gate).
      const orderId = verdict.checkout.id;
      const catalog = agentCatalog(cfg.catalog, pct);
      const order = catalog.createOrder([{ productId: q.sku, quantity: q.qty }], orderId);
      const requiredAge = Math.max(0, ...order.lines.map((l) => (typeof l.minimumAge === "number" ? l.minimumAge : 0)));
      const total = verdict.checkout.totals.find((t) => t.type === "total")?.amount ?? q.amountMinor;
      // One number on every side (invariant 3): what completion re-derived from the catalog must be what the
      // verifier priced and the agent signed. They share chargedMinor, so a drift here is a bug, never a price.
      if (Math.round(order.total * 100) !== total) return refuse("price", "the catalog prices this cart differently now");
      let drawn = false;
      let recorded = false;
      const records: CompletedOrderStore = {
        read: () => undefined, // every order id is minted per quote; replay is the nonce's concern, above
        write: async (rec) => {
          // The last step before the order exists: take the budget, record the order, tell the host. If the
          // record cannot be written, give the budget back — never a draw without an order.
          grants._commitAgentDraw(grantId, total);
          drawn = true;
          await deps.complete({
            orderId, amount: rec.amount, currency: rec.currency, method: rec.method, completedAt: rec.completedAt,
            authorization: "delegated", grantId, permissionId: verdict.permissionId,
            lines: order.lines.map((l) => ({ id: l.id, quantity: l.quantity, unitPrice: l.unitPrice })),
          });
          recorded = true; // from here the order exists and is announced: the draw must stay
        },
      };
      try {
        // The age proof is the one sealed into THIS grant and counts only if it covers the threshold the
        // catalog demands now. Awaited, and inside the try: a slow shared store must not lose the race with
        // the clear below, and a failing one must not leave the flag behind.
        if (requiredAge > 0 && ageProofCovers(live.ageProof, requiredAge)) await deps.verificationStore.write(orderId, { ageVerified: true });
        const done = await completeOrder(
          { order, mandateId: verdict.permissionId, amount: total / 100, currency: "USD", method: "delegated-agent", gates: [], trustLevel: verdict.trust_level },
          { catalog, verificationStore: deps.verificationStore, records, credentialRegistry: deps.credentialRegistry },
        );
        if (!done.completed) {
          const reason = (done as { reason?: string }).reason;
          // An age or custom gate the grant cannot answer needs a person, as on the draw path.
          if (reason === "age" || reason === "gate") return refuse("step-up", "completing this order needs a live person (an age or credential check the grant cannot answer)");
          return refuse("not-recorded", `the order could not be completed (${reason ?? "refused"})`);
        }
      } catch {
        // Something failed. If the order was already recorded and announced, it exists: keep the draw and
        // answer with its receipt. Only a failure BEFORE that gives the budget back.
        if (!recorded) {
          if (drawn) grants._releaseAgentDraw(grantId, total);
          return refuse("not-recorded", "the order could not be recorded, so nothing was drawn; ask for a new quote");
        }
      } finally {
        // Cleanup never replaces the result.
        try { await deps.verificationStore.clear(orderId); } catch { /* the flag is per order id and unreachable */ }
      }
      const usage = await live.usage();
      return { ok: true, receipt: { orderId, amount: total / 100, remaining: usage.remaining, trustLevel: verdict.trust_level, checkout: proof.checkout, payment: proof.payment } };
    });
  }
}
