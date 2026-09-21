// The gate's mandate-signing key, and the DID document that lets anyone else check it.
//
// DECISION (spec 013 #1): a host MAY inject a stable key; when it does not, the gate
// generates an ephemeral P-256 key so a zero-config install still runs — and `doctor.ts`
// reports that as an ERROR, because an ephemeral key means every mandate this process
// signed becomes unverifiable the moment it restarts.
//
// DECISION (spec 013 #2): `mount()` serves `/.well-known/did.json`. Without a published
// key the signature is checkable only by us, which would make "real signatures" a hollow
// claim — the whole point of leaving `MOCK-DEV-SIGNER` behind.
//
// SYNCHRONOUS on purpose. `mount()` is synchronous, and resolving the key on a promise
// meant the public key reached `app.locals` some ticks after the routes did — a race in
// the middle of a security check, where the loser is "no key, refuse everything" or, one
// refactor later, "no key, verify nothing". node's `crypto.sign` with `dsaEncoding:
// "ieee-p1363"` also emits the raw r‖s that JWS wants, so nothing is lost by not using
// WebCrypto's async subtle here.
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";

/** The signing suite. AP2 mandates in this package are ES256 over P-256, always. */
export const SIGNING_ALG = "ES256" as const;

/** Fragment of the gate's verification method — also every mandate's `kid`. */
export const KEY_FRAGMENT = "gate-signing-key";

/** A P-256 PRIVATE JWK — what a host injects as `{ mandateSigningKey }`. `d` is the secret. */
export interface PrivateJwkP256 {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  d: string;
}

/** A P-256 public JWK, as it appears in a DID document and in a `cnf` claim. */
export interface PublicJwkP256 {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  alg?: string;
  kid?: string;
}

export interface GateSigningKey {
  /** `did:web:<host>#gate-signing-key` — the `kid` on every mandate this gate signs. */
  kid: string;
  /** `did:web:<host>` — the mandates' `iss`. */
  issuer: string;
  privateKey: KeyObject;
  publicJwk: PublicJwkP256;
  /** True when nobody supplied a key and we made one up at boot. Surfaced by doctor.ts. */
  ephemeral: boolean;
}

/**
 * `did:web` for an origin. Per the did:web method the authority is percent-encoded; we
 * only ever key on the authority, so no path segments are appended.
 */
export function didWebFor(origin: string): string {
  return `did:web:${encodeURIComponent(new URL(origin).host)}`;
}

/**
 * Resolve the gate's signing key.
 *
 * `hostKey` is a PRIVATE P-256 JWK the host controls (read it from a secret manager, not
 * from source). Absent ⇒ an ephemeral key, flagged as such rather than silently accepted.
 */
export function resolveSigningKey(origin: string, hostKey?: PrivateJwkP256): GateSigningKey {
  const issuer = didWebFor(origin);
  const kid = `${issuer}#${KEY_FRAGMENT}`;

  if (hostKey) {
    if (hostKey.kty !== "EC" || hostKey.crv !== "P-256") {
      throw new Error(
        `mandateSigningKey must be an EC P-256 JWK (got kty=${hostKey.kty} crv=${hostKey.crv}) — AP2 mandates here are ES256`,
      );
    }
    if (!hostKey.d) throw new Error("mandateSigningKey must be a PRIVATE JWK (no `d` component present)");
    const privateKey = createPrivateKey({ key: hostKey as unknown as Record<string, unknown>, format: "jwk" });
    return {
      kid,
      issuer,
      privateKey,
      publicJwk: { kty: "EC", crv: "P-256", x: hostKey.x, y: hostKey.y, alg: SIGNING_ALG, kid },
      ephemeral: false,
    };
  }

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return {
    kid,
    issuer,
    privateKey,
    publicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, alg: SIGNING_ALG, kid },
    ephemeral: true,
  };
}

/** Import a P-256 public JWK for verification (a `cnf` key, or our own from a DID doc). */
export function importVerifyKey(jwk: PublicJwkP256): KeyObject {
  return createPublicKey({
    key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as unknown as Record<string, unknown>,
    format: "jwk",
  });
}

/**
 * The DID document `mount()` serves at `/.well-known/did.json`.
 *
 * One verification method — this gate's mandate-signing key. `assertionMethod` is the
 * right relationship for issuing mandates; listing `authentication` too would over-state
 * what this key is for.
 */
export function didDocument(key: GateSigningKey): Record<string, unknown> {
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
    id: key.issuer,
    verificationMethod: [
      { id: key.kid, type: "JsonWebKey2020", controller: key.issuer, publicKeyJwk: key.publicJwk },
    ],
    assertionMethod: [key.kid],
  };
}
