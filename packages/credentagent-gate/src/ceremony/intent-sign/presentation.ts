// Verifying what a wallet returns from an AP2 delegation ceremony.
//
// The wallet answers with an SD-JWT VC presentation: the issuer-signed credential, the
// disclosures it chose to reveal, and a Key Binding JWT signed by the holder. AP2 puts the
// Mandate Content inside that KB-JWT, so the holder's signature is what authorizes the grant.
//
// WHAT A PASS FROM THIS FILE MEANS, exactly:
//   • the credential was signed by the key in its own `x5c` certificate,
//   • the KB-JWT was signed by the key that credential commits to in `cnf`,
//   • that KB-JWT names THIS verifier (`aud`) and THIS ceremony (`nonce`),
//   • it is typed `kb+sd-jwt` and carries a `delegate_payload` (Delegate SD-JWT §5.1.4, §7.1).
//
// It does NOT mean the certificate chains to anyone we trust. The demo credential is
// self-signed by `tools/demo-pki/mint/`, and checking a chain we minted against a root we
// minted would be theatre. Issuer trust is #14; `trust_level` stays "device-signed" and says
// only what it can: a key the credential names signed this.
//
// It also does not decide whether the mandates are the RIGHT ones. That comparison is
// `mandates.ts`, against the server's own grant record, and the caller must do it.
import { createHash, createPublicKey, verify as nodeVerify, X509Certificate } from "node:crypto";
import { decodeSdJwt, getClaims, splitSdJwt } from "@sd-jwt/core";
import { DELEGATE_KB_TYP, DELEGATE_PAYLOAD_CLAIM, type MandateContent } from "./mandates.js";

const utf8 = new TextEncoder();

/** The SD-JWT hasher for this rail. `@sd-jwt` passes IANA names ("sha-256"); node wants
 *  "sha256". Exported so the in-process wallet hashes the way the verifier does — two copies
 *  is two places for this to drift, and a drift here reads as a bad signature. */
export const hasher = (data: string | ArrayBuffer, alg: string): Uint8Array => {
  const input = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
  return new Uint8Array(createHash(alg.replace(/-/g, "")).update(input).digest());
};

/** Decode a JWS segment without verifying. Only ever used to READ a key or a claim name. */
function segment<T>(token: string, index: 0 | 1): T | undefined {
  try {
    return JSON.parse(Buffer.from(token.split(".")[index], "base64url").toString("utf-8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * ES256 verify. `ieee-p1363` is the raw r‖s encoding JWS uses — node's EC default is DER,
 * which would reject every valid signature. Any malformed input verifies as FALSE rather than
 * throwing, so a caller cannot mistake "could not check" for "inconclusive, carry on".
 */
function es256(publicKey: ReturnType<typeof createPublicKey>, data: string, sig: string): boolean {
  try {
    return nodeVerify("sha256", utf8.encode(data), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}

/**
 * The audience a Key Binding JWT must name, for a presentation made over the Digital
 * Credentials API.
 *
 * OpenID4VP 1.0 §B.3.6: the `aud` claim MUST be the value of the Client Identifier, EXCEPT for
 * requests over the DC API, where it MUST be the Origin prefixed with `origin:` (Appendix A.4).
 * This rail responds over `dc_api.jwt`, so the prefixed form is the correct one — not the bare
 * origin, and not the `client_id`.
 *
 * It is a function so the gate and the simulated wallet cannot drift apart. They did: the
 * simulator sent the bare origin, every test passed, and the first real wallet was refused with
 * "key binding is addressed to origin:https://… , not this verifier".
 */
export function dcApiAudience(origin: string): string {
  return `origin:${origin}`;
}

export type PresentationResult =
  | {
      ok: true;
      /** The KB-JWT's `delegate_payload`, verbatim — array-element digests of the mandates the
       *  holder signed (Delegate SD-JWT §7.1). Compare against the server's own record. */
      delegatePayload: MandateContent[];
      /** Disclosed claims, for the explicit-positive-claim check (invariant 5). */
      disclosed: Record<string, unknown>;
      /** The credential type that signed — recorded on the grant. */
      vct: string;
    }
  | { ok: false; reason: string };

/**
 * Verify an SD-JWT VC presentation carrying an AP2 delegation.
 *
 * Fail-closed on every axis. `audience` and `nonce` are REQUIRED: a key-bound presentation
 * checked without them verifies a signature over bytes that could have been produced for any
 * other verifier, at any other time, which is exactly what replay is.
 */
export async function verifyDelegatedPresentation(args: {
  /** The compact SD-JWT presentation from `vp_token`. */
  sdjwt: string;
  /** Who the KB-JWT must be addressed to — this gate's origin. */
  audience: string;
  /** The nonce this ceremony issued. */
  nonce: string;
  nowMs?: number;
}): Promise<PresentationResult> {
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);

  let parts: ReturnType<typeof splitSdJwt>;
  try {
    parts = splitSdJwt(args.sdjwt);
  } catch {
    return { ok: false, reason: "not a compact SD-JWT presentation" };
  }
  // Read key binding off the TOKEN, never from what the caller remembered to ask for. A
  // presentation whose KB-JWT is simply absent must be refused, not treated as an ordinary
  // credential that happens to carry no delegation.
  if (!parts.kbJwt) return { ok: false, reason: "presentation carries no key-binding JWT" };

  // The issuer key comes from the credential's own certificate. Multipaz will not even export
  // a credential without one, so its absence here means the wallet returned something else.
  const header = segment<{ x5c?: string[] }>(parts.jwt, 0);
  const leaf = header?.x5c?.[0];
  if (!leaf) return { ok: false, reason: "credential has no x5c certificate chain" };

  let issuerKey: ReturnType<typeof createPublicKey>;
  try {
    issuerKey = new X509Certificate(
      `-----BEGIN CERTIFICATE-----\n${leaf.replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----`,
    ).publicKey;
  } catch (err) {
    return { ok: false, reason: `x5c: ${(err as Error).message}` };
  }

  const [issuerHeader, issuerBody, issuerSig] = parts.jwt.split(".");
  if (!es256(issuerKey, `${issuerHeader}.${issuerBody}`, issuerSig ?? "")) {
    return { ok: false, reason: "credential signature does not verify against its own certificate" };
  }

  // The holder's key, as the credential commits to it. Taken from the verified credential —
  // never from anything travelling beside the signature.
  const claims = segment<{
    cnf?: { jwk?: { kty?: string; crv?: string; x?: string; y?: string } };
    vct?: string;
    exp?: number;
    /** RFC 9901 §4.1.1. Absent means sha-256; `sd_hash` MUST be computed with the token's own. */
    _sd_alg?: string;
  }>(parts.jwt, 1);
  const cnfJwk = claims?.cnf?.jwk;
  if (!cnfJwk || cnfJwk.kty !== "EC" || cnfJwk.crv !== "P-256") {
    return { ok: false, reason: "credential has no P-256 cnf key to bind to" };
  }
  if (typeof claims?.exp === "number" && nowSec >= claims.exp) {
    return { ok: false, reason: "credential has expired" };
  }

  let holderKey: ReturnType<typeof createPublicKey>;
  try {
    holderKey = createPublicKey({ key: cnfJwk as unknown as Record<string, unknown>, format: "jwk" });
  } catch (err) {
    return { ok: false, reason: `cnf: ${(err as Error).message}` };
  }

  const [kbHeader, kbBody, kbSig] = parts.kbJwt.split(".");
  if (!es256(holderKey, `${kbHeader}.${kbBody}`, kbSig ?? "")) {
    return { ok: false, reason: "key-binding signature does not verify against the credential's cnf key" };
  }

  const kb = segment<{ aud?: string; nonce?: string; sd_hash?: string; [k: string]: unknown }>(parts.kbJwt, 1);
  if (!kb) return { ok: false, reason: "key-binding JWT is not readable" };
  if (kb.aud !== args.audience) return { ok: false, reason: `key binding is addressed to ${String(kb.aud)}, not this verifier` };
  if (kb.nonce !== args.nonce) return { ok: false, reason: "key-binding nonce is not the one this ceremony issued" };

  // Delegate SD-JWT §5.1.4: a Delegate KB-JWT is typed `kb+sd-jwt` (or `kb+sd-jwt+kb`), not the
  // plain `kb+jwt` of an ordinary key binding. A wallet that emits `kb+jwt` here has treated the
  // delegation as a normal presentation, which is the shape this rail shipped before #192 — so
  // accepting it would let the old, non-conformant output keep passing unnoticed.
  const kbTyp = segment<{ typ?: string }>(parts.kbJwt, 0)?.typ;
  if (!kbTyp || !(DELEGATE_KB_TYP as readonly string[]).includes(kbTyp)) {
    return { ok: false, reason: `key binding is typed ${kbTyp ?? "∅"}, not ${DELEGATE_KB_TYP.join(" or ")}` };
  }

  const delegatePayload = kb[DELEGATE_PAYLOAD_CLAIM];
  if (!Array.isArray(delegatePayload) || delegatePayload.length === 0) {
    return { ok: false, reason: "key binding carries no delegate_payload — the wallet signed no mandates" };
  }

  // ── A revealed field is only a CLAIM if the issuer signed a digest of it ────────────────
  //
  // `sd_hash` first (RFC 9901 §4.3): the digest of the presentation up to the KB-JWT, so the
  // holder's signature covers WHICH disclosures were presented and in what form. Everything
  // after the last `~` is the KB-JWT; everything up to and including it is what is hashed.
  const withoutKb = args.sdjwt.slice(0, args.sdjwt.lastIndexOf("~") + 1);
  let sdHash: string;
  try {
    sdHash = Buffer.from(hasher(withoutKb, claims?._sd_alg ?? "sha-256")).toString("base64url");
  } catch {
    return { ok: false, reason: `credential names an _sd_alg this verifier cannot compute: ${String(claims?._sd_alg)}` };
  }
  if (kb.sd_hash !== sdHash) {
    return { ok: false, reason: "key binding's sd_hash does not cover the disclosures presented" };
  }

  // Then the disclosures themselves. `decodeSdJwt` DECODES — it does not check that a revealed
  // field is one the issuer committed to. Reading claims straight off its `disclosures` list is
  // the bypass this closes: append an unsigned `["<salt>", "payment_instrument_id", "theirs"]` to
  // a presentation, leave the real one out, and the forged value came back as a verified claim.
  //
  // `getClaims` rebuilds the payload from the issuer-signed `_sd` digests instead, and REFUSES
  // ("Unreferenced disclosure(s) detected") any disclosure whose digest the issuer never signed.
  // That is invariant 5 — verify the actual claim, not that a token was present — and invariant
  // 6, since `sd_hash` is what binds the presented set to the holder's signature.
  //
  // Note what this is NOT: it does not make the credential trustworthy. The issuer here signs
  // with its own self-minted certificate (#14). It makes the claim genuinely the ISSUER's, which
  // is the property that has to hold before real issuer trust can mean anything.
  const disclosed: Record<string, unknown> = {};
  try {
    const decoded = await decodeSdJwt(args.sdjwt, hasher);
    await getClaims(decoded.jwt.payload, decoded.disclosures, hasher);
    // Past `getClaims`, every disclosure is one the issuer committed to, so its key/value is
    // the issuer's. Only the SELECTIVELY disclosed names are reported: the caller asks "did the
    // wallet reveal this?", which is a different question from "is this in the payload?".
    for (const d of decoded.disclosures) {
      if (d.key) disclosed[d.key] = d.value;
    }
  } catch (err) {
    return { ok: false, reason: `disclosures: ${(err as Error).message}` };
  }

  return {
    ok: true,
    delegatePayload: delegatePayload as MandateContent[],
    disclosed,
    vct: typeof claims?.vct === "string" ? claims.vct : "",
  };
}
