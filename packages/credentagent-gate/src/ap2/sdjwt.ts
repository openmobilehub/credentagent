// The configured SD-JWT instance — hasher, salt source, signer and verifier wired to this
// package's crypto. Internal: callers use `issue.ts` / `verify.ts`, never this directly.
//
// RFC 9901 (SD-JWT) via @sd-jwt/core, the OpenWallet Foundation implementation — the same
// foundation as this repo, and not a wheel worth re-inventing (spec 013 decision #3).
import { createHash, sign as nodeSign, verify as nodeVerify, webcrypto, type KeyObject } from "node:crypto";
import { SDJwtInstance, type Signer, type Verifier, type KbVerifier, type SdJwtPayload } from "@sd-jwt/core";
import { importVerifyKey, type PublicJwkP256 } from "./keys.js";

const utf8 = new TextEncoder();

/** The hash algorithm we emit. `_sd_alg` records it; verification follows the token's. */
export const SD_HASH_ALG = "sha-256";

const hasher = (data: string | ArrayBuffer, alg: string): Uint8Array => {
  // @sd-jwt uses IANA names ("sha-256"); node wants "sha256".
  const nodeAlg = alg.replace(/-/g, "");
  const input = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
  return new Uint8Array(createHash(nodeAlg).update(input).digest());
};

const saltGenerator = (length: number): string =>
  Buffer.from(webcrypto.getRandomValues(new Uint8Array(length))).toString("hex").slice(0, length);

/** ES256 signer over a P-256 key. `ieee-p1363` is the raw r‖s encoding JWS requires — node's
 *  default for EC is DER, which would produce signatures no JWS verifier accepts. */
export function es256Signer(privateKey: KeyObject): Signer {
  return (data: string) =>
    nodeSign("sha256", utf8.encode(data), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

/** ES256 verifier against a known public JWK. Any malformed input verifies as FALSE, never
 *  as a thrown error a caller might catch and treat as "inconclusive". */
export function es256Verifier(publicJwk: PublicJwkP256): Verifier {
  return (data: string, sig: string) => {
    try {
      return nodeVerify(
        "sha256",
        utf8.encode(data),
        { key: importVerifyKey(publicJwk), dsaEncoding: "ieee-p1363" },
        Buffer.from(sig, "base64url"),
      );
    } catch {
      return false;
    }
  };
}

/**
 * Key-binding verifier: checks the KB-JWT against the key the mandate's OWN `cnf` names.
 *
 * This is the whole point of key binding — the holder's signature is checked against the
 * key the issuer committed to, not against a key supplied alongside the signature. A
 * mandate with no `cnf` cannot have a valid KB-JWT, and says so rather than passing.
 */
export const cnfKbVerifier: KbVerifier = (data, sig, payload) => {
  const jwk = payload?.cnf?.jwk as PublicJwkP256 | undefined;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256") return false;
  return es256Verifier(jwk)(data, sig);
};

export interface SdJwtOptions {
  /** Present ⇒ this instance can issue. */
  privateKey?: KeyObject;
  /** Present ⇒ this instance can verify an issuer signature. */
  publicJwk?: PublicJwkP256;
  /** Present ⇒ this instance can append a key-bound delegation hop. */
  holderKey?: KeyObject;
}

/** Build an SD-JWT instance wired to this package's crypto. */
export function sdJwtInstance(opts: SdJwtOptions): SDJwtInstance<SdJwtPayload> {
  return new SDJwtInstance<SdJwtPayload>({
    hasher,
    hashAlg: SD_HASH_ALG,
    saltGenerator,
    signAlg: "ES256",
    kbSignAlg: "ES256",
    ...(opts.privateKey ? { signer: es256Signer(opts.privateKey) } : {}),
    ...(opts.publicJwk ? { verifier: es256Verifier(opts.publicJwk) } : {}),
    ...(opts.holderKey ? { kbSigner: es256Signer(opts.holderKey) } : {}),
    kbVerifier: cnfKbVerifier,
  });
}

/**
 * `sd_hash` over a compact SD-JWT — the digest a Payment Mandate's `transaction_id` and a
 * Checkout Mandate's `checkout_hash` carry.
 *
 * AP2 requires the algorithm to match the token's own `_sd_alg` when present, else
 * sha-256 (the same agility #146 established on the dc-payment rail). `alg` is the IANA
 * name; callers read it off the decoded token rather than assuming.
 */
export function digestToken(token: string, alg: string = SD_HASH_ALG): string {
  return Buffer.from(hasher(token, alg)).toString("base64url");
}
