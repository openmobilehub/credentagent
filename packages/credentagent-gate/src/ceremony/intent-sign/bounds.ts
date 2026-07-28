// FR-1 — the canonical Intent-Mandate BOUNDS encoding + its hash.
//
// A spending grant (an AP2 "Intent Mandate" — the record of "here is what I
// authorize an agent to spend") is what the device signs. A wallet signs a
// *presentation*, not an arbitrary blob, so the rail folds the grant's bounds into
// the OpenID4VP ceremony NONCE (see request.ts). That only works if BOTH sides —
// the /request that seals the nonce and the /verify that re-derives it — agree on
// the exact bytes of the bounds, forever. This module is that single encoder.
//
//   boundsHash = sha256( canonicalIntentBounds(grant) )              // this file
//   nonce      = deriveNonce( challenge, boundsHash )                // request.ts
//
// STABILITY IS LOAD-BEARING: any drift in key order, array order, or number
// formatting changes boundsHash, which changes the nonce, which makes a legitimate
// device signature fail to verify (the grant would refuse itself). The encoding is
// pinned by bounds.test.ts — treat a change to it like a wire-format change.
import { createHash } from "node:crypto";
import { canonical } from "../mandate.js";

/** The subset of a grant that the human authorizes and the device signs over.
 *  Assembled from the grant record (grants.ts) — never from anything the client
 *  sends, so /verify can re-derive it from the server's own state (FR-2). */
export interface IntentBoundsInput {
  /** The grant id — already unique per grant, so two grants never share a hash. */
  grantId: string;
  merchant: string;
  /** Cumulative budget, in dollars (the value the human reads on the page). */
  budget: number;
  /** Per-purchase cap, in dollars. */
  perSpend: number;
  /** Item bounds — WHAT the agent may buy. Arrays are sorted before encoding. */
  allow?: { skus?: string[]; categories?: string[] };
  /** When the grant was opened (ISO 8601), so re-creating identical bounds later
   *  still hashes distinctly. */
  createdAt: string;
  /** Optional validity horizon (ISO 8601); omitted from the hash when absent. */
  expiresAt?: string;
  /** A per-grant random salt, so the hash cannot be precomputed from the public
   *  bounds alone (minted once at create, sealed in the record). */
  nonce: string;
}

/**
 * The stable, JSON-canonical encoding of a grant's bounds (FR-1). Reuses the
 * package's `canonical()` (recursive key sort) for key order and number
 * formatting, and sorts the `allow` arrays here so `["b","a"]` and `["a","b"]`
 * encode identically. The `allow` object is ALWAYS present with both arrays (empty
 * when unset), so a grant with no item bounds and a grant with empty item bounds
 * hash the same and the shape never varies.
 */
export function canonicalIntentBounds(input: IntentBoundsInput): string {
  return canonical({
    grantId: input.grantId,
    merchant: input.merchant,
    budget: input.budget,
    perSpend: input.perSpend,
    allow: {
      skus: [...(input.allow?.skus ?? [])].sort(),
      categories: [...(input.allow?.categories ?? [])].sort(),
    },
    createdAt: input.createdAt,
    // `canonical()` drops an undefined value, so an absent expiry simply isn't in
    // the bytes — no need to branch here, but we keep it explicit for the reader.
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    nonce: input.nonce,
  });
}

/** sha256(canonicalIntentBounds), base64url — the value the ceremony nonce binds
 *  to and that /verify re-derives from the server's grant record and requires to
 *  match (FR-2). */
export function boundsHash(input: IntentBoundsInput): string {
  return createHash("sha256").update(canonicalIntentBounds(input)).digest("base64url");
}

/**
 * The OpenID4VP nonce, bound to the bounds: sha256( challenge ‖ boundsHash ),
 * base64url. The wallet's mdoc DeviceAuth signature covers the session transcript
 * that carries this nonce (deviceAuth.ts), so the device signature cryptographically
 * covers the exact bounds — the same trick the dc-payment rail uses for amounts.
 * Deterministic in its two inputs, so /request (which knows the challenge) and
 * /verify (which re-opens it) derive the identical nonce.
 */
export function deriveNonce(challengeB64url: string, boundsHashB64url: string): string {
  const challenge = Buffer.from(challengeB64url, "base64url");
  const bounds = Buffer.from(boundsHashB64url, "base64url");
  return createHash("sha256").update(Buffer.concat([challenge, bounds])).digest("base64url");
}
