// The cart a CLIENT carries — for MCP 2026-07-28, which has no session to key a server-side cart by.
//
// On the 2025-era protocol the host sends `Mcp-Session-Id` on every request, so the store keeps
// each shopper's cart under it. 2026-07-28 has no such header: every request stands alone. So on
// that revision the cart travels with the client instead — a signed token that each cart tool
// returns and the client passes back on its next cart call:
//
//   const carts = cartTokens(secret);          // configure once
//   const token = carts.mint(cart);            // → "cart1.<payload>.<mac>", returned to the client
//   const cart = carts.open(token);            // → the cart, or null if it was edited/forged
//
// WHAT IT CARRIES: product ids and quantities only — never prices. Every read re-prices from the
// catalog (Security invariant 2), so a token can say WHAT is in the cart but never what it costs.
//
// SECURITY: the token round-trips through the client, so it is attacker-controlled input. It is
// signed (HMAC-SHA256, a key derived only for cart tokens) and anything that fails the check is
// refused, never trusted. It is not bound to a user: whoever holds a token holds that cart, the
// same as whoever holds a session id — and nothing is shared, so one shopper's token never shows
// another shopper's items (Security invariant 4). It does not expire: an old token is an old cart,
// re-priced on use.
import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "cart1";
/** More lines than any real cart holds — refuses a token blown up to exhaust the server. */
const MAX_LINES = 100;

export interface CartTokens {
  /** Seal a cart into a token for the client to carry. */
  mint(cart: Map<string, number>): string;
  /** The cart inside a token, or null when it was edited, forged, or isn't a cart token at all. */
  open(token: string): Map<string, number> | null;
}

export function cartTokens(secret: string): CartTokens {
  // A key used for nothing else, so a cart token can never be passed off as another signed blob.
  const key = createHmac("sha256", secret).update("credentagent/cart-token/v1").digest();
  const mac = (payload: string) => createHmac("sha256", key).update(`${PREFIX}.${payload}`).digest();

  return {
    mint(cart) {
      const payload = Buffer.from(JSON.stringify([...cart.entries()])).toString("base64url");
      return `${PREFIX}.${payload}.${mac(payload).toString("base64url")}`;
    },
    open(token) {
      const [prefix, payload, sig, extra] = typeof token === "string" ? token.split(".") : [];
      if (prefix !== PREFIX || !payload || !sig || extra !== undefined) return null;
      const expected = mac(payload);
      const given = Buffer.from(sig, "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      let lines: unknown;
      try {
        lines = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (!Array.isArray(lines) || lines.length > MAX_LINES) return null;
      const cart = new Map<string, number>();
      for (const line of lines) {
        if (!Array.isArray(line) || typeof line[0] !== "string" || !Number.isInteger(line[1]) || line[1] <= 0) return null;
        cart.set(line[0], line[1]);
      }
      return cart;
    },
  };
}
