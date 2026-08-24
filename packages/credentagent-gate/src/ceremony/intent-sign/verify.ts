// Verify a wallet's device-signed Intent Mandate presentation.
//
// The transport-level work (decrypt the JWE, open the sealed reader context,
// re-derive the bounds, re-check them against the SERVER's grant record, enforce
// single-use) lives here; the TRUST decision runs through a seam (FR-4) so the
// backend can move without touching the rest:
//
//   • in-gate backend (v1 default): verify the wallet's DeviceAuth COSE signature
//     in-process → trust_level "device-signed", verifiedBy "gate". Real device
//     signature; demo trust anchor (the payment credential is self-minted — #14).
//   • delegated backend (the #103 DelegatedVerifier seam, fast-follow): an external
//     checker verifies an issuer-backed credential and reports its OWN trust_level;
//     the gate RELAYS it verbatim with verifiedBy = <verifier id>. A stronger label
//     is always traceable to who vouched for it, never the gate's own claim.
//
// The bounds re-derivation is the load-bearing integrity control: /verify recomputes
// boundsHash from the grant RECORD and requires it to equal the value sealed at
// /request time (never anything the client sent). Delete that equality check and a
// tampered grant is authorized against a signature made for the original bounds —
// which is exactly what the FR-6(a)/(c) bypass test pins.
import * as jose from "jose";
import { openReaderContext } from "../mdoc/readerContext.js";
import { PAYMENT_CREDENTIAL_DOCTYPE, PAYMENT_INSTRUMENT_CLAIM } from "./dcql.js";
import { boundsHash, deriveNonce, type IntentBoundsInput } from "./bounds.js";
import { buildIntentSessionTranscript, verifyDeviceAuth } from "./deviceAuth.js";
import type { TrustLevel } from "../../types.js";

/** Single-use nonce ledger: `consume` records a nonce and returns true only the FIRST
 *  time (false on replay). In-process (grants are process-local); a multi-instance
 *  deploy would back this with a shared store, like the grant records themselves. */
export interface NonceGuard {
  consume(nonce: string): boolean;
}

/** A trivial in-memory NonceGuard (a Set). */
export function memoryNonceGuard(): NonceGuard {
  const used = new Set<string>();
  return {
    consume(nonce: string): boolean {
      if (used.has(nonce)) return false;
      used.add(nonce);
      return true;
    },
  };
}

/** What a verify backend establishes about a parsed presentation: whether the holder
 *  binding is proven, at what trust level, and by whom. The gate re-checks bounds +
 *  the required claim itself either way. */
export interface IntentTrustVerdict {
  ok: boolean;
  reason?: string;
  /** How strongly bound, AS REPORTED BY THE BACKEND (relayed verbatim; never upgraded). */
  trustLevel: TrustLevel;
  /** Who verified — "gate" (in-gate) or an external verifier's id. */
  verifiedBy: string;
  /** Disclosed issuer-signed claims, for the gate's own required-claim check. */
  disclosed?: Record<string, unknown>;
  docType?: string;
}

/** The verify seam: given the wallet's DeviceResponse + the transcript the gate
 *  re-derived, decide trust. Swappable per FR-4 (in-gate default; delegated later).
 *
 *  CONTRACT — a backend MUST verify the holder's DeviceAuth signature over
 *  `sessionTranscript` itself (the in-gate default does). The gate always re-checks the
 *  bounds/binding regardless of backend, but the PROOF-OF-SIGNATURE travels WITH the backend:
 *  "delegation moves trust, not binding" must NOT be read to exclude the signature. A permissive
 *  stub that returns `{ ok: true }` without verifying the signature would accept a presentation
 *  whose DeviceAuth does not verify — so a real delegated verifier is responsible for that check. */
export type IntentVerifyBackend = (args: {
  deviceResponseB64url: string;
  sessionTranscript: Uint8Array;
}) => Promise<IntentTrustVerdict>;

/** The v1 in-gate backend: verify the DeviceAuth COSE signature in-process. */
export const inGateBackend: IntentVerifyBackend = async ({ deviceResponseB64url, sessionTranscript }) => {
  const da = await verifyDeviceAuth({ deviceResponseB64url, sessionTranscript });
  if (!da.ok) return { ok: false, reason: da.reason, trustLevel: "device-signed", verifiedBy: "gate" };
  return { ok: true, trustLevel: "device-signed", verifiedBy: "gate", disclosed: da.disclosed, docType: da.docType };
};

export type IntentVerifyResult =
  | {
      ok: true;
      boundsHash: string;
      signedAt: string;
      trustLevel: TrustLevel;
      verifiedBy: string;
      credentialDoctype: string;
    }
  | { ok: false; reason: string };

/** Pull the DeviceResponse (base64url) out of a decrypted OpenID4VP vp_token. The DC
 *  API shape is `{ "<dcql-id>": "<DeviceResponse>" }` (older: an array per id). */
function deviceResponseFromVpToken(vpToken: unknown): string | null {
  if (!vpToken || typeof vpToken !== "object") return null;
  const first = Object.values(vpToken as Record<string, unknown>)[0];
  const value = Array.isArray(first) ? first[0] : first;
  return typeof value === "string" ? value : null;
}

/**
 * Verify a device-signed Intent Mandate presentation and return typed plain data.
 *
 * `bounds` is the grant's CURRENT bounds, read from the server's own record — /verify
 * re-derives boundsHash from it and requires equality with the sealed value.
 */
export async function verifyIntentPresentation(args: {
  result: { protocol?: string; data?: unknown };
  readerContextToken: string;
  secret: string;
  /** The grant's bounds from the SERVER's record (never the client). */
  bounds: IntentBoundsInput;
  origin: { origin: string };
  nonceGuard: NonceGuard;
  /** Trust backend (FR-4). Defaults to the in-gate DeviceAuth check. */
  backend?: IntentVerifyBackend;
}): Promise<IntentVerifyResult> {
  const { result, readerContextToken, secret, bounds, origin, nonceGuard } = args;
  const backend = args.backend ?? inGateBackend;

  let ctx;
  try {
    ctx = await openReaderContext(readerContextToken, secret);
  } catch (err) {
    return { ok: false, reason: `reader context: ${(err as Error).message}` };
  }
  if (!ctx.challenge || !ctx.boundsHash || !ctx.grantId || !ctx.nonce) {
    return { ok: false, reason: "reader context is not an intent-sign context" };
  }

  // Cross-grant scoping (invariant 4): the sealed context must belong to THIS grant.
  if (ctx.grantId !== bounds.grantId) return { ok: false, reason: "grant mismatch: context is for a different grant" };

  // FR-2 equality check — re-derive boundsHash from the SERVER's grant record and
  // require it to equal the value sealed at request time. This is the sole control
  // that ties the (sealed-bounds) signature to the CURRENT grant; the FR-6(a)/(c)
  // bypass test deletes it and asserts a tampered grant then authorizes.
  const recordHash = boundsHash(bounds);
  if (recordHash !== ctx.boundsHash) {
    return { ok: false, reason: "bounds mismatch: the grant's bounds changed since the request was issued" };
  }

  // The nonce the device signed over — derived from (challenge, sealed boundsHash).
  const nonce = deriveNonce(ctx.challenge, ctx.boundsHash);
  if (nonce !== ctx.nonce) return { ok: false, reason: "nonce derivation mismatch" };

  // Decrypt the wallet's JWE response and pull the DeviceResponse.
  let data: unknown = result?.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { /* leave as string */ }
  }
  const jwe: string | undefined = (data as { response?: string } | undefined)?.response;
  if (!jwe) return { ok: false, reason: "no .response (JWE) in result.data" };

  let deviceResponseB64url: string | null;
  try {
    const encPrivKey = await jose.importJWK(ctx.ecdhPrivateJwk, "ECDH-ES");
    const { plaintext } = await jose.compactDecrypt(jwe, encPrivKey);
    const openid4vpResponse = JSON.parse(new TextDecoder().decode(plaintext)) as { vp_token?: unknown };
    deviceResponseB64url = deviceResponseFromVpToken(openid4vpResponse.vp_token);
  } catch (err) {
    return { ok: false, reason: `decrypt: ${(err as Error).message}` };
  }
  if (!deviceResponseB64url) return { ok: false, reason: "no DeviceResponse in vp_token" };

  // On-device interop debug (off by default — set INTENT_DEBUG_DEVICE_RESPONSE=<path>).
  // Dumps the wallet's DeviceResponse + the handover inputs the gate used, so a failed
  // on-device signature can be solved OFFLINE (which transcript shape does the wallet's
  // real signature verify against?) instead of guessing through redeploy-and-retry.
  // Pure observability, same fence as INTENT_DEBUG_TRANSCRIPT: it does not change the
  // returned bytes or the verification outcome. See on-device-interop.md §5.
  if (process.env.INTENT_DEBUG_DEVICE_RESPONSE) {
    const thumb = await jose.calculateJwkThumbprint(ctx.ecdhPrivateJwk, "sha256");
    await (await import("node:fs/promises")).writeFile(
      process.env.INTENT_DEBUG_DEVICE_RESPONSE,
      JSON.stringify({ deviceResponseB64url, origin: origin.origin, rpID: new URL(origin.origin).hostname, nonce, thumbprint: thumb }, null, 2),
    );
  }

  // Build the transcript from the bounds-bound nonce + the response-encryption key's JWK
  // thumbprint (the DC API HandoverInfo's third element — deviceAuth.ts). RFC 7638 via jose's
  // calculateJwkThumbprint (NOT hand-rolled) so the member canonicalization matches the wallet;
  // it hashes only the required EC members, so passing the sealed private JWK is fine.
  const thumbprint = await jose.calculateJwkThumbprint(ctx.ecdhPrivateJwk, "sha256");
  const sessionTranscript = buildIntentSessionTranscript(origin.origin, nonce, thumbprint);
  const verdict = await backend({ deviceResponseB64url, sessionTranscript });
  if (!verdict.ok) return { ok: false, reason: verdict.reason ?? "presentation not verified" };

  // Require the payment credential — the right doctype AND its instrument claim disclosed
  // (invariant 5: an explicit positive claim, not merely "a token was present").
  const docType = verdict.docType ?? "";
  if (docType !== PAYMENT_CREDENTIAL_DOCTYPE) {
    return { ok: false, reason: `wrong credential: expected ${PAYMENT_CREDENTIAL_DOCTYPE}, got ${docType || "∅"}` };
  }
  const instrumentId = verdict.disclosed?.[PAYMENT_INSTRUMENT_CLAIM];
  if (instrumentId == null || (typeof instrumentId === "string" && instrumentId.length === 0)) {
    return { ok: false, reason: `payment credential did not disclose ${PAYMENT_INSTRUMENT_CLAIM}` };
  }

  // Single-use: consume the nonce LAST, so a failed verify does not burn it (a genuine
  // retry can still succeed), but a replay of a SUCCEEDED presentation is refused (FR-6b).
  if (!nonceGuard.consume(nonce)) return { ok: false, reason: "nonce already used (replay)" };

  return {
    ok: true,
    boundsHash: ctx.boundsHash,
    signedAt: new Date().toISOString(),
    trustLevel: verdict.trustLevel,
    verifiedBy: verdict.verifiedBy,
    credentialDoctype: docType,
  };
}
