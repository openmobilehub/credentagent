// ap2.CartMandate — a signed integrity envelope over the cart the agent/buyer is acting
// on. The signed sibling of the ap2.PaymentMandate (mandate.ts): it makes the cart
// TAMPER-EVIDENT so the cart that travels with a request can be checked before it's
// trusted.
//
// ADDITIVE + FAIL-CLOSED, and it does NOT change the price authority: the catalog stays
// the source of truth (Security invariant 2). A cart mandate proves "THIS SERVER issued
// this cart"; re-pricing still decides the price. So verification is a fast, explicit
// pre-check (a tampered/replayed/expired cart is refused with a clear reason BEFORE the
// re-price step) and defense-in-depth — never a substitute for re-derivation.
//
// HONESTY (trust_level "presence-only-demo"): v0.1 signs with the SERVER's HMAC key
// (the same sealed-HMAC primitive challengeToken.ts uses). That proves the server issued
// the cart, NOT that the user authorized it. A user/agent-signed Cart Mandate (the true
// AP2 user-authorization semantic) + issuer trust is the v0.2 line — the `alg` field
// reserves room for an ES256 / key-bound variant without changing this contract.
import { createHmac, timingSafeEqual } from "node:crypto";

/** A priced cart line the mandate seals (the fields the gates re-derive from). */
export interface CartMandateLine {
  id: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  minimumAge?: number;
}

export interface CartMandate {
  type: "ap2.CartMandate";
  /** Stable id (defaults to `cart_<orderId>`); a PaymentMandate can reference it. */
  id: string;
  /** The order this cart is bound to — a mandate replayed against another order is refused. */
  orderId: string;
  lines: CartMandateLine[];
  currency: string;
  /** Cart total in major units — re-derived server-side, sealed here for integrity. */
  total: number;
  /** Epoch ms. */
  issuedAt: number;
  expiresAt: number;
  /** Signature suite. v0.1 = server HMAC-SHA256; reserved for a future key-bound variant. */
  alg: "HS256";
  trust_level: "presence-only-demo";
  /** base64url HMAC over the canonical payload. */
  signature: string;
}

/** Default validity window — mirrors the challenge-token TTL policy. */
export const DEFAULT_CART_MANDATE_TTL_MS = 15 * 60 * 1000;

// Deterministic canonical payload the signature covers. Fixed field + line order so the
// same cart re-signs stably and ANY edit (a line qty, a unit price, the total, the
// currency, the order id, the expiry) changes the bytes and so the signature.
function canonical(m: Omit<CartMandate, "signature">): string {
  const lines = m.lines
    .map((l) => `${l.id}:${l.quantity}:${l.unitPrice}:${l.lineTotal}:${l.minimumAge ?? ""}`)
    .join(",");
  return [m.type, m.id, m.orderId, m.currency, m.total, m.issuedAt, m.expiresAt, m.alg, m.trust_level, lines].join("|");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export interface IssueCartMandateArgs {
  orderId: string;
  lines: CartMandateLine[];
  currency: string;
  total: number;
  /** Defaults to `cart_<orderId>`. */
  id?: string;
  /** Injectable clock (tests); defaults to `Date.now()`. */
  now?: number;
  ttlMs?: number;
}

/** Issue (sign) a Cart Mandate for a server-priced cart. */
export function issueCartMandate(args: IssueCartMandateArgs, secret: string): CartMandate {
  const now = args.now ?? Date.now();
  const base: Omit<CartMandate, "signature"> = {
    type: "ap2.CartMandate",
    id: args.id ?? `cart_${args.orderId}`,
    orderId: args.orderId,
    lines: args.lines,
    currency: args.currency,
    total: args.total,
    issuedAt: now,
    expiresAt: now + (args.ttlMs ?? DEFAULT_CART_MANDATE_TTL_MS),
    alg: "HS256",
    trust_level: "presence-only-demo",
  };
  return { ...base, signature: sign(canonical(base), secret) };
}

/**
 * Decode a Cart Mandate carried on a GET request's `cart` query param as base64url
 * JSON — the `statelessOrders` transport (FR-007). Returns `undefined` for a
 * missing/garbage value; `verifyCartMandate` is the real gate, so decoding is
 * trust-free (a bad value just falls through to the store path / fails closed).
 */
export function decodeCartMandateParam(v: unknown): unknown {
  if (typeof v !== "string" || v.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.from(v, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export type CartMandateRefusal = "malformed" | "signature" | "order-id" | "expired";

export type CartMandateVerdict = { ok: true; mandate: CartMandate } | { ok: false; reason: CartMandateRefusal };

/**
 * Verify a Cart Mandate against the order it should be bound to. Checks, in order:
 *   1. shape (a malformed/non-mandate object is refused);
 *   2. SIGNATURE — recompute the HMAC over the canonical payload + constant-time compare,
 *      so a forged or edited cart fails here first (`signature`);
 *   3. order-id binding — a valid mandate replayed against a different order (`order-id`);
 *   4. expiry — a stale mandate, with a DISTINCT reason so a slow buyer sees "expired",
 *      not "tampered" (`expired`).
 * Returns the typed verdict; it never throws.
 */
export function verifyCartMandate(
  mandate: unknown,
  expectedOrderId: string,
  secret: string,
  now: number = Date.now(),
): CartMandateVerdict {
  if (!mandate || typeof mandate !== "object") return { ok: false, reason: "malformed" };
  const m = mandate as CartMandate;
  if (m.type !== "ap2.CartMandate" || typeof m.signature !== "string" || !Array.isArray(m.lines)) {
    return { ok: false, reason: "malformed" };
  }
  const expected = sign(canonical(m), secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(m.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature" };
  if (m.orderId !== expectedOrderId) return { ok: false, reason: "order-id" };
  if (now > m.expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, mandate: m };
}
