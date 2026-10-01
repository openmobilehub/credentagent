// Stateless carrier for the reader's ephemeral ECDH private key + the bound
// transaction_data (and the request nonce) between /request and /verify. Extracted
// FAITHFULLY from the demo's payment-gate/dc-payment/readerContext.ts.
//
// REAL crypto: sealed as a JWE (dir / A256GCM) under a key derived from the host's
// signingKey, with a short expiry. Confidentiality matters (it wraps a PRIVATE
// key), so we encrypt rather than just HMAC — `jose.CompactEncrypt` /
// `jose.compactDecrypt`. The nonce sealed here is what /verify requires the
// wallet's response to be bound to (apu/apv echo) — not merely "a token decrypted".
import { createHash } from "node:crypto";
import * as jose from "jose";

const DEFAULT_TTL_MS = 180_000;

export interface ReaderContext {
  ecdhPrivateJwk: jose.JWK;
  transactionDataB64: string;
  // Request nonce, sealed so /verify can check the wallet's response is bound
  // to THIS request (credential gate; the payment gate also binds via transaction_data).
  nonce?: string;
  // Intent-sign rail (spec 012): the grant this ceremony signs + the bounds it was
  // sealed for. /verify re-derives boundsHash from the SERVER's grant record and
  // requires it to equal `boundsHash` (FR-2 equality check), and re-derives the nonce
  // from `challenge` + `boundsHash`. Sealed (not client-supplied) so neither can be
  // swapped after the request is issued. Absent on the credential / payment rails.
  grantId?: string;
  challenge?: string;
  boundsHash?: string;
}

interface SealedPayload extends ReaderContext {
  exp: number;
}

function keyFromSecret(secret: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(secret).digest());
}

export async function sealReaderContext(ctx: ReaderContext, secret: string, ttlMs = DEFAULT_TTL_MS): Promise<string> {
  const payload: SealedPayload = { ...ctx, exp: Date.now() + ttlMs };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  return await new jose.CompactEncrypt(plaintext)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .encrypt(keyFromSecret(secret));
}

export async function openReaderContext(token: string, secret: string): Promise<ReaderContext> {
  const { plaintext } = await jose.compactDecrypt(token, keyFromSecret(secret));
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as SealedPayload;
  if (Date.now() > payload.exp) throw new Error("reader context expired");
  return {
    ecdhPrivateJwk: payload.ecdhPrivateJwk,
    transactionDataB64: payload.transactionDataB64,
    nonce: payload.nonce,
    grantId: payload.grantId,
    challenge: payload.challenge,
    boundsHash: payload.boundsHash,
  };
}
