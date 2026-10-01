// The cart id a session-less (MCP 2026-07-28) conversation keeps — the ticket for a server-side cart.
//
// On the 2025-era protocol the host sends `Mcp-Session-Id` on every request, so the store keeps
// each shopper's cart under it. 2026-07-28 has no such header: every request stands alone, and
// nothing ties the widget's clicks to the agent's calls. So the store issues a cart id on the first
// cart-related call and returns it in the result — which BOTH the agent and the widget see — and
// every later call passes it back. The id never changes, so a click in the widget and the agent's
// next call land on the same cart, like the old session:
//
//   const ids = cartIds(secret);   // configure once
//   const id = ids.mint();         // → "cart_<random>_<tag>", returned to the client
//   ids.verify(id);                // → true only for an id THIS store issued
//
// SECURITY: the id is the key to a cart, so it must be unguessable (128 random bits) and the store
// must accept only ids it issued — an agent that invents "cart_1" must not land on anyone's cart,
// or two conversations that invent the same id would share one (Security invariant 4). Each id
// carries an HMAC tag (a key derived only for cart ids); an invented or edited id fails the check.
// Whoever holds an id holds that cart, the same as whoever held a session id.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const FORMAT = /^cart_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{22})$/;

export interface CartIds {
  /** A new, unguessable cart id this store will recognize. */
  mint(): string;
  /** Whether this store issued `id` — false for an invented, edited or foreign id. */
  verify(id: string): boolean;
}

export function cartIds(secret: string): CartIds {
  // A key used for nothing else, so a cart id can never be passed off as another signed value.
  const key = createHmac("sha256", secret).update("credentagent/cart-id/v1").digest();
  const tag = (random: string) => createHmac("sha256", key).update(random).digest().subarray(0, 16);

  return {
    mint() {
      const random = randomBytes(16).toString("base64url");
      return `cart_${random}_${tag(random).toString("base64url")}`;
    },
    verify(id) {
      const m = typeof id === "string" ? FORMAT.exec(id) : null;
      if (!m) return false;
      const given = Buffer.from(m[2], "base64url");
      const expected = tag(m[1]);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}
