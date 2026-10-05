// The gate's mandate-signing key, and the DID document that lets anyone else check it.
//
// DECISION (spec 013 #1): a host MAY inject a stable key; when it does not, the gate
// generates an ephemeral P-256 key so a zero-config install still runs — and `doctor.ts`
// reports that as an ERROR ON A DEPLOYMENT, because an ephemeral key means every mandate the
// process signed becomes unverifiable the moment it restarts.
//
// DECISION (spec 013 #2): `mount()` serves `/.well-known/did.json`. Without a published
// key the signature is checkable only by us, which would make "real signatures" a hollow
// claim. (The older `MOCK-DEV-SIGNER` path in `ceremony/mandate.ts` is still live; it will be
// retired once checkouts move onto `Ap2Issuer`.)
//
// SYNCHRONOUS on purpose. `mount()` is synchronous; a key resolved on a promise would reach
// `app.locals` some ticks after the routes do — a race in the middle of a security check.
// node's `crypto.sign` with `dsaEncoding: "ieee-p1363"` emits the raw r‖s that JWS wants, so
// nothing is lost by not using WebCrypto's async subtle here.
import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";

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

/** The P-256 public point for private scalar `d`, COMPUTED (d·G) — not read back from a key
 *  object, which on some node builds simply echoes whatever `x` / `y` it was imported with. */
function publicPointFromD(d: string): { x: string; y: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(d, "base64url"));
  const point = ecdh.getPublicKey(); // uncompressed: 0x04 ‖ X(32) ‖ Y(32)
  return { x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") };
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
    const mismatch = "mandateSigningKey's public `x` / `y` do not belong to its private `d` — the JWK is corrupt or mismatched";
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: hostKey as unknown as Record<string, unknown>, format: "jwk" });
    } catch (err) {
      // Some node/OpenSSL builds catch a mismatched pair at import ("Invalid JWK EC key"); name it
      // the same way the explicit check below does, so the error does not depend on the runtime.
      throw new Error(`${mismatch} (${err instanceof Error ? err.message : String(err)})`);
    }
    // The public half is DERIVED from `d`, never copied from the host's `x` / `y`. Not every node
    // build refuses a JWK whose `x` / `y` do not belong to its `d` at import — and on those that
    // accept it, `createPublicKey(privateKey)` hands the imported `x` / `y` straight back rather
    // than recomputing them, so it is no check at all. Only a scalar multiplication of `d` is; copying them would publish a
    // key that matches nothing we sign, so every mandate would fail its own check while doctor()
    // stayed green. A mismatch is a broken secret, refused here rather than at the first verify.
    const derived = publicPointFromD(hostKey.d);
    if (derived.x !== hostKey.x || derived.y !== hostKey.y) {
      throw new Error(mismatch);
    }
    return {
      kid,
      issuer,
      privateKey,
      publicJwk: { kty: "EC", crv: "P-256", x: derived.x, y: derived.y, alg: SIGNING_ALG, kid },
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

/**
 * The other half of {@link didDocument}: turn a fetched `/.well-known/did.json` into the
 * `publicJwk` {@link verifyMandate} takes — so checking a mandate somebody else's gate signed
 * is a fetch and two calls, not hand-written plumbing.
 *
 * ```ts
 * const doc = await (await fetch("https://shop.example/.well-known/did.json")).json();
 * const verdict = await verifyMandate(token, { publicJwk: publicJwkFromDidDocument(doc) });
 * ```
 *
 * Returns the key with its `kid` set to the verification method's id, which is what makes
 * `verifyMandate` also check the mandate's `iss` / `kid`. Throws when the document does not
 * publish an EC P-256 assertion key it controls: a key that is not an assertion method was
 * never published for signing mandates, and must not be quietly used for it.
 */
export function publicJwkFromDidDocument(doc: unknown, kid?: string): PublicJwkP256 {
  const d = doc as {
    id?: unknown;
    verificationMethod?: Array<{ id?: unknown; controller?: unknown; publicKeyJwk?: Record<string, unknown> }>;
    assertionMethod?: unknown[];
  };
  if (typeof d?.id !== "string" || !d.id.startsWith("did:")) throw new Error("not a DID document: no `did:` id");
  const assertion = new Set((d.assertionMethod ?? []).filter((m): m is string => typeof m === "string"));
  const method = (d.verificationMethod ?? []).find(
    (m) => typeof m.id === "string" && (kid ? m.id === kid : assertion.has(m.id)),
  );
  if (!method || typeof method.id !== "string") throw new Error(`DID document ${d.id} publishes no ${kid ? `method ${kid}` : "assertion method"}`);
  if (!assertion.has(method.id)) throw new Error(`${method.id} is not an assertionMethod of ${d.id} — it was not published for signing`);
  if (method.controller !== d.id || !method.id.startsWith(`${d.id}#`)) throw new Error(`${method.id} is not controlled by ${d.id}`);
  const jwk = method.publicKeyJwk;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error(`${method.id} is not an EC P-256 key — AP2 mandates here are ES256`);
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, alg: SIGNING_ALG, kid: method.id };
}
