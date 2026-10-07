// The pieces of a wallet that a phone would otherwise supply — shared by the simulated wallet the
// package ships (`devSimulateWalletSignature`) and the chain tests' in-process wallet, so both sign
// exactly the way the gate verifies. Demo and test use only: every key here is made up on the spot,
// and the certificate anchors nothing (#14).
import { generateKeyPairSync, webcrypto, type KeyObject } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { es256Signer } from "../../ap2/sdjwt.js";
import { DELEGATE_KB_TYP, DELEGATE_PAYLOAD_CLAIM } from "../../ap2/delegate.js";
import { hasher } from "./presentation.js";

/** A P-256 key pair, with its public half as the JWK a `cnf` carries. */
export interface DevKeyPair {
  privateKey: KeyObject;
  publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
}

export function p256(): DevKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { x, y } = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return { privateKey, publicJwk: { kty: "EC", crv: "P-256", x, y } };
}

/** SD-JWT disclosure salts. */
export const saltGenerator = (n: number): string => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString("hex").slice(0, n);

/** ES256 over P-256 — the package's own signer, so a dev wallet signs exactly as the gate verifies. */
export const sign = (key: KeyObject) => es256Signer(key);

/**
 * A self-signed certificate for an issuer key, base64 DER for the JWS `x5c`.
 *
 * Not optional: a wallet will not read an SD-JWT VC without one, and neither does this package —
 * the issuer key is taken FROM the certificate. Mirrors `tools/demo-pki/mint/mint-dpc-sdjwt.mjs`.
 */
export async function selfSignedCert(key: DevKeyPair, name: string): Promise<string> {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
  const priv = await webcrypto.subtle.importKey("jwk", key.privateKey.export({ format: "jwk" }) as webcrypto.JsonWebKey, alg, false, ["sign"]);
  const pub = await webcrypto.subtle.importKey("jwk", { ...key.publicJwk, ext: true } as webcrypto.JsonWebKey, alg, true, ["verify"]);
  const notBefore = new Date(Date.now() - 60_000);
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(8))).toString("hex"),
      name: `CN=${name}`,
      notBefore,
      notAfter: new Date(notBefore.getTime() + 365 * 24 * 60 * 60 * 1000),
      signingAlgorithm: alg,
      keys: { privateKey: priv, publicKey: pub },
    },
    webcrypto as unknown as Parameters<typeof x509.X509CertificateGenerator.createSelfSigned>[1],
  );
  return Buffer.from(cert.rawData).toString("base64");
}

/**
 * Append a Delegate key binding to a presented credential (`<jwt>~<disclosures>~`): the wallet's
 * signature over `sd_hash` and the delegate payload's digests.
 *
 * Built by hand rather than through `SDJwtInstance.present({ kb })`, because that path hardcodes
 * `typ: "kb+jwt"` and a Delegate key binding must be typed `kb+sd-jwt+kb` (§5.1.4) when its
 * mandates name the agent's key. Everything else is the JWS the library would have produced.
 */
export function delegateKeyBinding(args: {
  presented: string;
  holderKey: KeyObject;
  aud: string;
  nonce: string;
  /** What `delegate_payload` carries — normally `{ "...": digest }` per disclosure (§7.1). */
  delegatePayload: unknown[];
  typ?: string;
  /** The bytes `sd_hash` covers. Defaults to `presented`; a test passes others to break it. */
  sdHashOver?: string;
  iat?: number;
}): string {
  const b64uJson = (v: unknown) => Buffer.from(JSON.stringify(v), "utf-8").toString("base64url");
  const header = { alg: "ES256", typ: args.typ ?? DELEGATE_KB_TYP.delegable };
  const payload = {
    iat: args.iat ?? Math.floor(Date.now() / 1000),
    aud: args.aud,
    nonce: args.nonce,
    // The SHARED hasher, so the wallet hashes exactly the way the verifier does.
    sd_hash: Buffer.from(hasher(args.sdHashOver ?? args.presented, "sha-256")).toString("base64url"),
    [DELEGATE_PAYLOAD_CLAIM]: args.delegatePayload,
  };
  const signingInput = `${b64uJson(header)}.${b64uJson(payload)}`;
  return `${args.presented}${signingInput}.${sign(args.holderKey)(signingInput)}`;
}
