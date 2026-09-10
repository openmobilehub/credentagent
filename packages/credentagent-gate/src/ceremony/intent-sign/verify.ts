// Verify a wallet's device-signed Intent Mandate presentation.
//
// The transport-level work (decrypt the JWE, open the sealed reader context,
// re-derive the bounds, re-check them against the SERVER's grant record, enforce
// single-use) lives here; the TRUST decision runs through a seam (FR-4) so the
// backend can move without touching the rest:
//
//   • in-gate backend (v1 default): verify the holder's key-binding signature in-process
//     → trust_level "device-signed", verifiedBy "gate". Real holder signature; demo trust
//     anchor (the payment credential is self-minted — #14).
//   • delegated backend (the #103 DelegatedVerifier seam, fast-follow): an external
//     checker verifies an issuer-backed credential and reports its OWN trust_level;
//     the gate RELAYS it verbatim with verifiedBy = <verifier id>. A stronger label
//     is always traceable to who vouched for it, never the gate's own claim.
//
// TWO load-bearing integrity controls, and both compare against the SERVER's own record:
//
//   1. boundsHash, recomputed from the grant RECORD and required to equal the value sealed
//      at /request time. Tamper-evidence for the record between the two hops.
//   2. THE MANDATES the holder actually signed, rebuilt from that same record and required
//      to be identical to what came back (spec 014). This is the one that carries the
//      authorization now: the wallet signs AP2 Mandate Content inside its key-binding JWT,
//      so a changed merchant, a raised cap, an extra constraint or a swapped agent key all
//      show up here as a mismatch.
//
// Delete either and a tampered grant is authorized against a signature the human gave for
// different terms — which is what the bypass tests pin.
import * as jose from "jose";
import { openReaderContext } from "../mdoc/readerContext.js";
import { PAYMENT_CREDENTIAL_VCTS, PAYMENT_INSTRUMENT_CLAIM } from "./dcql.js";
import { boundsHash, deriveNonce, type IntentBoundsInput } from "./bounds.js";
import { verifyDelegatedPresentation } from "./presentation.js";
import { delegatePayloadMatches, openMandatesForGrant, type DelegateJwk, type MandateContent } from "./mandates.js";
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
  /** The credential type that signed (SD-JWT `vct`). */
  credentialType?: string;
  /** The Mandate Content the holder signed. The gate compares it to its own record. */
  delegatePayload?: MandateContent[];
}

/** The verify seam: given the wallet's SD-JWT presentation and the audience/nonce the gate
 *  issued, decide trust. Swappable per FR-4 (in-gate default; delegated later).
 *
 *  CONTRACT — a backend MUST verify the holder's key-binding signature itself, against the key
 *  the credential commits to in `cnf`, and MUST check the audience and nonce (the in-gate
 *  default does all three). The gate re-checks the bounds and the mandates regardless of
 *  backend, but the PROOF-OF-SIGNATURE travels WITH the backend: "delegation moves trust, not
 *  binding" must NOT be read to exclude the signature. A permissive stub returning
 *  `{ ok: true }` would accept a presentation nobody signed, so a real delegated verifier is
 *  responsible for that check. */
export type IntentVerifyBackend = (args: {
  /** The compact SD-JWT presentation from `vp_token`. */
  sdjwt: string;
  /** Who the key binding must be addressed to. */
  audience: string;
  /** The nonce this ceremony issued. */
  nonce: string;
}) => Promise<IntentTrustVerdict>;

/** The v1 in-gate backend: verify the holder's key-binding signature in-process. */
export const inGateBackend: IntentVerifyBackend = async ({ sdjwt, audience, nonce }) => {
  const p = await verifyDelegatedPresentation({ sdjwt, audience, nonce });
  if (!p.ok) return { ok: false, reason: p.reason, trustLevel: "device-signed", verifiedBy: "gate" };
  return {
    ok: true,
    trustLevel: "device-signed",
    verifiedBy: "gate",
    disclosed: p.disclosed,
    credentialType: p.vct,
    delegatePayload: p.delegatePayload,
  };
};

export type IntentVerifyResult =
  | {
      ok: true;
      boundsHash: string;
      signedAt: string;
      trustLevel: TrustLevel;
      verifiedBy: string;
      /** The credential type that signed. An SD-JWT `vct` since spec 014 (was an mdoc doctype). */
      credentialType: string;
      /** The AP2 Mandate Content the human authorized — the grant's record of what was signed. */
      mandates: MandateContent[];
    }
  | { ok: false; reason: string };

/** Pull the SD-JWT presentation out of a decrypted OpenID4VP vp_token. The DC API shape is
 *  `{ "<dcql-id>": "<presentation>" }`, or an array per id. */
function presentationFromVpToken(vpToken: unknown): string | null {
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
  /** The agent's public key, from the SERVER's grant record — the `cnf` the mandates name. */
  delegate: DelegateJwk;
  /** The absolute expiry used when the request was built, epoch seconds. */
  mandateExp: number;
  /** Trust backend (FR-4). Defaults to the in-gate key-binding check. */
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

  // Decrypt the wallet's JWE response and pull the SD-JWT presentation.
  let data: unknown = result?.data;
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { /* leave as string */ }
  }
  const jwe: string | undefined = (data as { response?: string } | undefined)?.response;
  if (!jwe) return { ok: false, reason: "no .response (JWE) in result.data" };

  let sdjwt: string | null;
  try {
    const encPrivKey = await jose.importJWK(ctx.ecdhPrivateJwk, "ECDH-ES");
    const { plaintext } = await jose.compactDecrypt(jwe, encPrivKey);
    const openid4vpResponse = JSON.parse(new TextDecoder().decode(plaintext)) as { vp_token?: unknown };
    sdjwt = presentationFromVpToken(openid4vpResponse.vp_token);
  } catch (err) {
    return { ok: false, reason: `decrypt: ${(err as Error).message}` };
  }
  if (!sdjwt) return { ok: false, reason: "no SD-JWT presentation in vp_token" };

  // On-device interop debug (off by default — set INTENT_DEBUG_PRESENTATION=<path>). Dumps the
  // wallet's presentation and the audience/nonce the gate expected, so a failed signature can
  // be inspected offline instead of guessing through redeploy-and-retry. Pure observability: it
  // changes neither the returned bytes nor the outcome.
  if (process.env.INTENT_DEBUG_PRESENTATION) {
    await (await import("node:fs/promises")).writeFile(
      process.env.INTENT_DEBUG_PRESENTATION,
      JSON.stringify({ sdjwt, audience: origin.origin, nonce }, null, 2),
    );
  }

  const verdict = await backend({ sdjwt, audience: origin.origin, nonce });
  if (!verdict.ok) return { ok: false, reason: verdict.reason ?? "presentation not verified" };

  // THE authorization check. Rebuild the Mandate Content from the SERVER's grant record and
  // require the holder to have signed exactly that. Everything the human agreed to — the
  // merchant, the caps, the allowed items, the expiry, and the agent key the grant delegates
  // to — lives in these bytes, so a mismatch here is a grant whose terms are not the ones that
  // were signed. Refuse rather than authorize against a signature given for something else.
  const expected = openMandatesForGrant({ bounds, origin: origin.origin, delegate: args.delegate, exp: args.mandateExp });
  if (!delegatePayloadMatches(verdict.delegatePayload, expected)) {
    return { ok: false, reason: "mandate mismatch: the wallet signed different terms than the grant records" };
  }

  // Require the payment credential — the right type AND its instrument claim disclosed
  // (invariant 5: an explicit positive claim, not merely "a token was present").
  const credentialType = verdict.credentialType ?? "";
  if (!(PAYMENT_CREDENTIAL_VCTS as readonly string[]).includes(credentialType)) {
    return { ok: false, reason: `wrong credential: expected one of ${PAYMENT_CREDENTIAL_VCTS.join(", ")}, got ${credentialType || "∅"}` };
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
    credentialType,
    mandates: expected,
  };
}
