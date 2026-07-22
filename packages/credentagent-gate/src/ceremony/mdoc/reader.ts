// Reader-side key + cert material for the Android-Chrome OpenID4VP path, shared by
// both rails' REAL signed-request builders. Extracted FAITHFULLY from the demo's
// payment-gate/dc-payment/request.ts (makeReaderCert + makeEncryptionKey).
//
// REAL crypto: the request is ES256-signed (jose.SignJWT) over the verifier-bound
// request object, with the reader cert chain in the `x5c` header and an ephemeral
// P-256 ECDH key the wallet encrypts its response to.
//
// Two reader identities:
//   • WITH a { key, cert, chain? } (opts.readerIdentity) — present that STABLE
//     identity, so a wallet trusting it via a RICAL shows the verifier as trusted.
//   • WITHOUT — self-sign an ephemeral P-256 reader cert per request (SAN-DNS =
//     RP-ID, SubjectKeyIdentifier required or the wallet's TrustManagerUtil NPEs).
//     Origin/RP binding is enforced either way; only cross-verifier TRUST differs.
import * as jose from "jose";
import * as x509 from "@peculiar/x509";
import type { webcrypto as NodeWebCrypto } from "node:crypto";
import type { ReaderIdentity } from "../../types.js";

const webcrypto = globalThis.crypto;
x509.cryptoProvider.set(webcrypto);

const SIGN_ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

/** Reader cert chain (base64 DER, leaf-first) + the ES256 signing key. When
 *  `identity` is supplied the STABLE reader is presented; otherwise a fresh
 *  self-signed cert bound to `rpID` is minted (the presence-only default). */
export async function makeReaderCert(
  rpID: string,
  identity?: ReaderIdentity,
): Promise<{ x5c: string[]; privateKey: NodeWebCrypto.CryptoKey }> {
  if (identity) {
    // Stable identity: sign with the provided key; present [leaf, ...chain].
    const privateKey = (await jose.importPKCS8(identity.key, "ES256")) as unknown as NodeWebCrypto.CryptoKey;
    const chainPem = [identity.cert, ...(identity.chain ?? [])];
    const x5c = chainPem.map((pem) => new x509.X509Certificate(pem).toString("base64"));
    return { x5c, privateKey };
  }
  const keys = await webcrypto.subtle.generateKey(SIGN_ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${rpID}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: SIGN_ALG,
    keys,
    extensions: [
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: rpID }]),
      // The Subject Key Identifier extension is REQUIRED — without it the wallet's
      // TrustManagerUtil does subjectKeyIdentifier!! → NPE.
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { x5c: [cert.toString("base64")], privateKey: keys.privateKey as unknown as NodeWebCrypto.CryptoKey };
}

// Ephemeral P-256 key the wallet encrypts its response to. Shared by the payment
// and credential gates so both build the response-encryption JWK identically.
export async function makeEncryptionKey(): Promise<{ encJwk: jose.JWK; ecdhPrivateJwk: jose.JWK }> {
  const encKP = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const encPubJwk = await webcrypto.subtle.exportKey("jwk", encKP.publicKey);
  const ecdhPrivateJwk = (await webcrypto.subtle.exportKey("jwk", encKP.privateKey)) as jose.JWK;
  const encJwk = { kty: "EC", crv: "P-256", x: encPubJwk.x, y: encPubJwk.y, use: "enc", alg: "ECDH-ES", kid: "response-encryption-key" } as jose.JWK;
  return { encJwk, ecdhPrivateJwk };
}
