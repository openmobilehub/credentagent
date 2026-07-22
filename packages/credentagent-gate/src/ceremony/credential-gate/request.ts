// REAL signed OpenID4VP request for a credential (age / membership) gate. Faithfully
// ported from the demo's payment-gate/credential-gate/request.ts — like the
// dc-payment request but with NO transaction_data (age/membership is not a payment,
// so there is no amount to bind). It mints a reader cert (@peculiar/x509), an
// ephemeral ECDH response-encryption key, a fresh nonce, and ES256-signs the
// verifier-bound request object (jose.SignJWT). The nonce is sealed alongside the
// decryption key (sealReaderContext, a JWE) so /verify can require the wallet's
// response to be bound to THIS request — not merely decryptable.
//
// The crypto here is REAL (signed request, origin/RP binding, sealed nonce + key);
// the issuer TRUST ANCHOR is not (the reader cert is self-signed) — trust_level
// stays presence-only-demo.
import * as jose from "jose";
import type { Origin } from "../origin.js";
import { makeReaderCert, makeEncryptionKey } from "../mdoc/reader.js";
import { sealReaderContext } from "../mdoc/readerContext.js";
import { buildCredentialDcql, type CredentialDcqlOpts, type CredentialKind } from "./dcql.js";
import type { DcqlQuery, ReaderIdentity } from "../../types.js";

export interface SignedCredentialRequest {
  protocol: "openid4vp-v1-signed";
  /** The ES256-signed OpenID4VP request JWT (real). */
  request: string;
  /** The DCQL embedded in the signed request (echoed for callers/tests). */
  dcql_query: DcqlQuery;
  /** Sealed reader context (ECDH key + nonce) carried to /verify. */
  readerContextToken: string;
  trust_level: "presence-only-demo";
}

/** Build the REAL signed OpenID4VP request descriptor for one built-in credential kind. */
export async function buildCredentialRequest(
  kind: CredentialKind,
  origin: Origin,
  secret: string,
  opts: CredentialDcqlOpts = {},
  readerIdentity?: ReaderIdentity,
): Promise<SignedCredentialRequest> {
  return buildSignedRequestForDcql(buildCredentialDcql(kind, opts), origin, secret, readerIdentity);
}

/**
 * The credential-agnostic core (007): sign a REAL OpenID4VP request embedding an
 * ARBITRARY DcqlQuery. The built-in `buildCredentialRequest` is a thin wrapper that
 * supplies the age/membership DCQL; the generalized rail passes a custom credential's
 * OWN `request` here. The crypto — reader cert, ephemeral ECDH key, sealed nonce,
 * ES256 signature, origin/RP binding — is identical to the built-in path (invariant 6);
 * only the source of the DCQL differs. trust_level stays presence-only-demo. A stable
 * `readerIdentity` (#51), when supplied, is presented instead of a self-signed cert.
 */
export async function buildSignedRequestForDcql(
  dcql: DcqlQuery,
  origin: Origin,
  secret: string,
  readerIdentity?: ReaderIdentity,
): Promise<SignedCredentialRequest> {
  const { x5c, privateKey } = await makeReaderCert(origin.rpID, readerIdentity);
  const { encJwk, ecdhPrivateJwk } = await makeEncryptionKey();
  const nonce = jose.base64url.encode(crypto.getRandomValues(new Uint8Array(16)));

  const requestObject = {
    response_type: "vp_token",
    response_mode: "dc_api.jwt",
    client_id: `x509_san_dns:${origin.rpID}`,
    expected_origins: [origin.origin],
    nonce,
    dcql_query: dcql,
    client_metadata: {
      vp_formats_supported: { mso_mdoc: { issuerauth_alg_values: [-7], deviceauth_alg_values: [-7] } },
      jwks: { keys: [encJwk] },
    },
  };

  const request = await new jose.SignJWT(requestObject)
    .setProtectedHeader({ alg: "ES256", typ: "oauth-authz-req+jwt", x5c })
    .setIssuedAt()
    .sign(privateKey as unknown as Parameters<InstanceType<typeof jose.SignJWT>["sign"]>[0]);

  // Seal the nonce alongside the decryption key so /verify can require the wallet's
  // response to be bound to THIS request (apu/apv check), not just decrypt.
  const readerContextToken = await sealReaderContext({ ecdhPrivateJwk, transactionDataB64: "", nonce }, secret);
  return { protocol: "openid4vp-v1-signed", request, dcql_query: dcql, readerContextToken, trust_level: "presence-only-demo" };
}
