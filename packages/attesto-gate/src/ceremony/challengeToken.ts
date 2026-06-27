// Stateless WebAuthn challenge. The challenge rides in a signed token:
//   base64url(challenge) "." expiryMs "." base64url(HMAC-SHA256(challenge|expiry))
// so issue and verify need no shared server memory (serverless-correct on a
// multi-instance deployment where options→verify may hit different instances).
//
// The HMAC is keyed by the INJECTED `signingKey` seam (mount() requires a stable
// one — D6); a forged or tampered token fails the signature check, and a token
// replayed after its window fails the expiry check. Single-use WITHIN the window
// is provided by the rail: the challenge is bound into the WebAuthn assertion and
// the order's completion is idempotent, so a replayed assertion records nothing
// twice. The token itself is deliberately stateless (no server-side nonce store).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 120_000;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(challenge: string, expiry: number, secret: string): string {
  return createHmac("sha256", secret).update(`${challenge}|${expiry}`).digest("base64url");
}

export function issueChallenge(secret: string, ttlMs = DEFAULT_TTL_MS): { challenge: string; token: string } {
  const challenge = b64url(randomBytes(32));
  const expiry = Date.now() + ttlMs;
  const sig = sign(challenge, expiry, secret);
  return { challenge, token: `${challenge}.${expiry}.${sig}` };
}

export function verifyChallenge(token: string, secret: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed challenge token");
  const [challenge, expiryStr, sig] = parts;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry)) throw new Error("malformed challenge token");
  const expected = sign(challenge, expiry, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Constant-time compare — a length mismatch is also a rejection.
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("bad challenge signature");
  if (Date.now() > expiry) throw new Error("challenge expired");
  return challenge;
}
