// Agent-signed purchases over HTTP — the store's half of a grant whose key the AGENT holds
// (design: docs/superpowers/specs/2026-11-09-agent-signed-purchase-design.md).
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
// HONESTY: a verified purchase proves the wallet's key signed the permission and the agent's key
// signed this cart. It proves nothing about who issued the credential (#14): `trust_level` says so.
import { randomUUID } from "node:crypto";
import { DelegatedIntent, verifyDelegatedPurchase, type DelegatedPurchaseProof, type PurchaseRefusalCode } from "./ap2/chain/purchase.js";
import { toMinorUnits } from "./ap2/money.js";
import type { UcpCheckout } from "./ap2/types.js";
import { minAgeOf, type CatalogEntry } from "./delegated.js";
import { ageProofCovers } from "./ceremony/mandate.js";
import { skuAllowed } from "./grants-age.js";
import type { Grants } from "./grants.js";
import type { GrantsApp } from "./grants-serve.js";

/** How long a quote's nonce stays valid. Short: the agent quotes and signs in one breath. */
export const QUOTE_TTL_MS = 120_000;
/** Outstanding (unused, unexpired) quotes one grant may hold — against nonce flooding. */
export const MAX_OPEN_QUOTES_PER_GRANT = 5;

export type PurchaseCode =
  | PurchaseRefusalCode
  | "unknown-grant"
  | "not-authorized"
  | "not-allowed"
  | "step-up"
  | "invalid-request"
  | "nonce-used"
  | "nonce-expired"
  | "too-many-quotes";

export type PurchaseDoor<T> = ({ ok: true } & T) | { ok: false; code: PurchaseCode; detail: string };

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
interface OrderStoreLike {
  write(id: string, value: unknown): unknown | Promise<unknown>;
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
}

const STATUS: Record<string, number> = {
  "unknown-grant": 404,
  "invalid-request": 400,
  "too-many-quotes": 429,
  "not-authorized": 409,
  "nonce-used": 409,
  "nonce-expired": 409,
  "not-allowed": 403,
  "step-up": 403,
};
const refuse = (code: PurchaseCode, detail: string): { ok: false; code: PurchaseCode; detail: string } => ({ ok: false, code, detail });
const send = (res: Res, door: { ok: boolean; code?: string }) => res.status(door.ok ? 200 : STATUS[door.code ?? ""] ?? 422).json(door);

const priceOf = (e: CatalogEntry | undefined): number | undefined => (e === undefined ? undefined : typeof e === "number" ? e : e.price);
const titleOf = (e: CatalogEntry, sku: string): string => (typeof e === "number" ? sku : e.name ?? sku);

/** What the person is charged for `qty` of one item, in minor units, with the grant's loyalty discount
 *  applied once, here — the quote and the verifier's price check both call this, so they cannot drift. */
function chargedMinor(price: number, qty: number, discountPct: number): number {
  const listed = toMinorUnits(price, "USD") * qty;
  return discountPct > 0 ? listed - Math.round((listed * discountPct) / 100) : listed;
}

export function registerPurchaseRoutes(app: GrantsApp, grants: Grants): void {
  const get = app.get!.bind(app);
  const post = app.post!.bind(app);
  const cfg = grants.purchaseConfig;
  const quotes = new Map<string, Quoted>();
  const fallbackOrders = new Map<string, unknown>();
  const orderStore = (): OrderStoreLike => {
    const shared = (app as { locals?: { credentagent?: { orderStore?: OrderStoreLike } } }).locals?.credentagent?.orderStore;
    return shared ?? { write: (id, v) => void fallbackOrders.set(id, v) };
  };

  const openQuotes = (grantId: string, now: number) => {
    let n = 0;
    for (const [nonce, q] of quotes) {
      if (q.used || q.expiresAtMs < now) quotes.delete(nonce); // forget what can no longer be used
      else if (q.grantId === grantId) n++;
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
    if (!cfg.ap2 || !g.agentKey) return send(res, refuse("not-authorized", "this grant does not name an agent key; spend it with spend-from-grant"));
    if (g.status !== "authorized") return send(res, refuse("not-authorized", `the grant is ${g.status}`));

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
    if (minAge != null && !ageProofCovers(g.ageProof, minAge)) return send(res, refuse("step-up", `this item needs a proof of age ${minAge}+`));
    const signable = grants._allowedSkusFor(g.id);
    if (!skuAllowed(g.allow, sku, cfg.catalog) || (signable && !signable.includes(sku))) {
      return send(res, refuse("not-allowed", "this item is outside what the grant allows"));
    }

    const now = Date.now();
    if (openQuotes(g.id, now) >= MAX_OPEN_QUOTES_PER_GRANT) return send(res, refuse("too-many-quotes", "too many open quotes for this grant"));

    const amountMinor = chargedMinor(price, qty, g.membershipProof?.discountPct ?? 0);
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
    // Consume the nonce BEFORE any await: two concurrent submissions of one nonce cannot both pass.
    // An id that is not this grant's, or a nonce never issued, answers the same way and burns nothing.
    if (!q || q.grantId !== grantId || q.used) return send(res, refuse("nonce-used", "this nonce is unknown, used, or belongs to another grant"));
    q.used = true;
    if (Date.now() > q.expiresAtMs) return send(res, refuse("nonce-expired", "the quote expired; ask for a new one"));

    const g = await grants.retrieve(grantId);
    if (!g) return send(res, refuse("unknown-grant", "no grant with this id"));
    const proof = (req.body as { proof?: DelegatedPurchaseProof } | undefined)?.proof as DelegatedPurchaseProof;

    return send(res, await grants._exclusive(grantId, async (): Promise<PurchaseDoor<{ receipt: PurchaseReceipt }>> => {
      // Re-read inside the unit: a revoke that landed since the quote must stop this purchase.
      const live = await grants.retrieve(grantId);
      if (!live || !cfg.ap2 || !live.agentKey || live.status !== "authorized") return refuse("not-authorized", `the grant is ${live?.status ?? "gone"}`);
      const pct = live.membershipProof?.discountPct ?? 0;
      const verdict = await verifyDelegatedPurchase(proof, {
        trust: "presence-only-demo",
        audience: cfg.walletOrigin,
        nonce: req.params.nonce,
        checkoutKey: cfg.ap2.checkoutPublicJwk,
        spent: () => grants._agentSpent(grantId),
        // The catalog prices the cart, never the proof (invariant 2).
        price: (c) => c.line_items.reduce((sum, l) => {
          const p = priceOf(Object.prototype.hasOwnProperty.call(cfg.catalog, l.item.id) ? cfg.catalog[l.item.id] : undefined);
          return p === undefined ? Number.NaN : sum + chargedMinor(p, l.quantity, pct);
        }, 0),
        nowMs: Date.now(),
      });
      if (!verdict.ok) return refuse(verdict.code, verdict.detail);
      // The mandates carry no grant id, and the store names ONE agent key on every grant, so the chain alone
      // cannot say which grant it spends. Require it to rest on THIS grant's own signed permission (else a
      // proof built from a larger grant would draw this grant's ledger past the budget its person approved),
      // and to be for the cart THIS nonce quoted.
      const own = live.mandate?.intent ? DelegatedIntent.fromWalletPresentation(live.mandate.intent).permissionId : undefined;
      if (!own || verdict.permissionId !== own) return refuse("not-authorized", "this proof rests on a different permission than this grant's");
      if (verdict.checkout.id !== q.cartId) return refuse("checkout-unbound", "this nonce was issued for another cart");

      const total = verdict.checkout.totals.find((t) => t.type === "total")?.amount ?? q.amountMinor;
      grants._commitAgentDraw(grantId, total);
      const usage = await live.usage();
      const orderId = verdict.checkout.id;
      await orderStore().write(orderId, {
        orderId,
        amount: total / 100,
        currency: "USD",
        method: "delegated-agent",
        completedAt: new Date().toISOString(),
        mandateId: verdict.permissionId,
        ap2: { proof, intentMandates: live.mandate?.mandates ?? [], trustLevel: verdict.trust_level },
      });
      return { ok: true, receipt: { orderId, amount: total / 100, remaining: usage.remaining, trustLevel: verdict.trust_level, checkout: proof.checkout, payment: proof.payment } };
    }));
  });
}
