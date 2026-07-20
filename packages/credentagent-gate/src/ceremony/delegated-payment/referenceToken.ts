// Stateless carrier binding an external verifier's opaque reference to THIS order,
// between the delegated rail's /request and /verify. Same construction as the
// WebAuthn challenge token (challengeToken.ts): HMAC-SHA256 under the injected
// `signingKey`, constant-time compare, explicit expiry — so issue and redeem need no
// shared server memory (serverless-correct when the two hops land on different
// instances).
//
// This is what stops a browser redeeming someone else's verification. The browser
// carries the token, but the ORDER ID is sealed INSIDE it: a token minted for order A
// and submitted against order B fails the binding check (invariant 4), and a tampered
// payload fails the signature.
//
// Note what is deliberately NOT here: the verdict. The browser never carries the
// verification result — only this handle. The gate re-fetches the verified presentment
// server-to-server using the `reference` sealed here, because anything routed through
// the client is something the client can rewrite.
import { createHmac, timingSafeEqual } from "node:crypto";

// A wallet ceremony (open app, pick credential, biometric) is far slower than a
// WebAuthn tap, so this window is wider than the challenge token's 2 minutes.
const DEFAULT_TTL_MS = 600_000;

export interface ReferenceClaims {
  /** The external verifier's opaque handle for this presentation session. */
  reference: string;
  /** The order this reference was minted for — re-checked at redeem (invariant 4). */
  orderId: string;
}

interface SealedReference extends ReferenceClaims {
  exp: number;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Seal `{ reference, orderId }` with an expiry. The result is safe to hand to the
 *  browser: it is tamper-evident and only redeemable for `orderId`. */
export function sealReference(claims: ReferenceClaims, secret: string, ttlMs = DEFAULT_TTL_MS): string {
  const sealed: SealedReference = { ...claims, exp: Date.now() + ttlMs };
  const payload = Buffer.from(JSON.stringify(sealed), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Open a sealed reference and REQUIRE it to be the one minted for `orderId`.
 *
 * Throws on a malformed token, a bad signature, an expired window, or an order-id
 * mismatch. Every failure is a refusal — there is no partial trust, and the payload
 * is only parsed AFTER the signature verifies (never interpret unverified input).
 */
export function openReference(token: string, orderId: string, secret: string): ReferenceClaims {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("malformed reference token");
  const [payload, sig] = parts;

  // Signature first — constant-time, length mismatch is also a rejection.
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("bad reference signature");

  let claims: SealedReference;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SealedReference;
  } catch {
    throw new Error("malformed reference token");
  }
  if (!Number.isFinite(claims.exp) || Date.now() > claims.exp) throw new Error("reference expired");
  // Order binding (invariant 4): a reference minted for another order must not redeem
  // here, or one buyer's verification would unlock another's checkout.
  if (claims.orderId !== orderId) throw new Error("reference is not bound to this order");
  return { reference: claims.reference, orderId: claims.orderId };
}
