// REAL signed OpenID4VP request for the dc-payment rail. Faithfully ported from the
// demo's payment-gate/dc-payment/request.ts. It mints a reader cert
// (@peculiar/x509), an ephemeral ECDH response-encryption key, a fresh nonce, embeds
// the amount-bound `transaction_data` (txData.ts), and ES256-signs the verifier-bound
// request object (jose.SignJWT). The transaction_data — and the ECDH key — are sealed
// into a reader context (a JWE) so /verify re-checks the wallet's device-signed
// transaction_data_hash against SHA-256 of exactly what we sent.
//
// The crypto here is REAL (signed request, amount binding, origin/RP binding, sealed
// key); the issuer TRUST ANCHOR is not (the reader cert is self-signed) — trust_level
// stays presence-only-demo.
import * as jose from "jose";
import { buildDcPaymentDcql } from "./dcql.js";
import { buildTransactionData, encodeTransactionData } from "./txData.js";
import { makeReaderCert, makeEncryptionKey } from "../mdoc/reader.js";
import { sealReaderContext } from "../mdoc/readerContext.js";
import type { CeremonyOrder } from "../types.js";
import type { Origin } from "../origin.js";
import type { DcqlQuery, ReaderIdentity } from "../../types.js";

export interface SignedDcPaymentRequest {
  protocol: "openid4vp-v1-signed";
  /** The ES256-signed OpenID4VP request JWT (real). */
  request: string;
  /** The DCQL embedded in the signed request (echoed for callers/tests). */
  dcql_query: DcqlQuery;
  /** The amount-bound transaction_data entries (base64url) — REAL binding. */
  transaction_data: string[];
  /** Sealed reader context (ECDH key + bound transaction_data) carried to /verify. */
  readerContextToken: string;
  trust_level: "presence-only-demo";
}

/** Build the REAL signed OpenID4VP request for the payment credential. When a
 *  `readerIdentity` is supplied, the request presents that stable reader (so a
 *  wallet trusting it via a RICAL shows the verifier as trusted); otherwise a
 *  self-signed ephemeral reader is used (presence-only default). */
export async function buildDcPaymentRequest(order: CeremonyOrder, origin: Origin, secret: string, readerIdentity?: ReaderIdentity): Promise<SignedDcPaymentRequest> {
  const { x5c, privateKey } = await makeReaderCert(origin.rpID, readerIdentity);
  const { encJwk, ecdhPrivateJwk } = await makeEncryptionKey();
  const dcql = buildDcPaymentDcql();
  const txDataB64 = encodeTransactionData(buildTransactionData(order, origin));
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
    transaction_data: [txDataB64],
  };

  const request = await new jose.SignJWT(requestObject)
    .setProtectedHeader({ alg: "ES256", typ: "oauth-authz-req+jwt", x5c })
    .setIssuedAt()
    .sign(privateKey as unknown as Parameters<InstanceType<typeof jose.SignJWT>["sign"]>[0]);

  const readerContextToken = await sealReaderContext({ ecdhPrivateJwk, transactionDataB64: txDataB64, nonce }, secret);
  return {
    protocol: "openid4vp-v1-signed",
    request,
    dcql_query: dcql,
    transaction_data: [txDataB64],
    readerContextToken,
    trust_level: "presence-only-demo",
  };
}
