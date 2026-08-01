// The REAL signed OpenID4VP request for the intent-sign ceremony. Mirrors the
// credential rail's request builder (same reader cert, ephemeral ECDH response key,
// ES256-signed verifier-bound request object, sealed reader context) — the ONE
// difference is the nonce.
//
// The credential rail's nonce is random. Here the nonce is BOUNDS-BOUND:
//
//   boundsHash = sha256(canonicalIntentBounds(grant))     // bounds.ts
//   nonce      = sha256(challenge ‖ boundsHash)            // deriveNonce
//
// The wallet's mdoc DeviceAuth signature covers the session transcript carrying this
// nonce (deviceAuth.ts), so the device signature cryptographically covers the exact
// grant bounds — the same binding trick the dc-payment rail uses for the amount. The
// `challenge` + `boundsHash` + `grantId` are sealed in the reader context so /verify
// can re-derive the nonce and re-check the bounds against the SERVER's grant record
// (FR-2), never anything the client sent.
//
// The crypto is REAL (signed request, origin/RP binding, sealed context, and — unlike
// the credential rail — /verify checks the DEVICE signature). The issuer trust anchor
// is not (the payment credential is a self-minted demo credential): trust_level
// "device-signed", stated plainly on the page (FR-4).
import * as jose from "jose";
import type { Origin } from "../origin.js";
import { makeReaderCert, makeEncryptionKey } from "../mdoc/reader.js";
import { sealReaderContext } from "../mdoc/readerContext.js";
import { buildIntentSignDcql } from "./dcql.js";
import { boundsHash, deriveNonce, type IntentBoundsInput } from "./bounds.js";
import type { DcqlQuery, ReaderIdentity } from "../../types.js";

export interface SignedIntentRequest {
  protocol: "openid4vp-v1-signed";
  /** The ES256-signed OpenID4VP request JWT (real). */
  request: string;
  /** The DCQL embedded in the signed request (echoed for callers/tests). */
  dcql_query: DcqlQuery;
  /** Sealed reader context (ECDH key + challenge + boundsHash + grantId) for /verify. */
  readerContextToken: string;
  /** The bounds-bound nonce embedded in the request (echoed for the wallet/tests). */
  nonce: string;
  trust_level: "device-signed";
}

/**
 * Build the REAL signed OpenID4VP request for signing a grant's Intent Mandate. The
 * request asks for the payment credential (`org.openwallet.payment.1`) and binds its
 * nonce to the grant bounds. `secret` seals the reader context; `currency` shapes only
 * the reused payment DCQL.
 */
export async function buildIntentSignRequest(args: {
  bounds: IntentBoundsInput;
  origin: Origin;
  secret: string;
  currency?: string;
  readerIdentity?: ReaderIdentity;
}): Promise<SignedIntentRequest> {
  const { bounds, origin, secret } = args;
  const dcql = buildIntentSignDcql(args.currency);
  const { x5c, privateKey } = await makeReaderCert(origin.rpID, args.readerIdentity);
  const { encJwk, ecdhPrivateJwk } = await makeEncryptionKey();

  // A per-ceremony random challenge, then the bounds-bound nonce over (challenge, bounds).
  const challenge = jose.base64url.encode(crypto.getRandomValues(new Uint8Array(16)));
  const hash = boundsHash(bounds);
  const nonce = deriveNonce(challenge, hash);

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

  // Seal the challenge + boundsHash + grantId alongside the decryption key. /verify
  // re-derives the nonce from (challenge, boundsHash) and re-checks boundsHash against
  // the server's grant record — the client never supplies any of it.
  const readerContextToken = await sealReaderContext(
    { ecdhPrivateJwk, transactionDataB64: "", nonce, grantId: bounds.grantId, challenge, boundsHash: hash },
    secret,
  );
  return { protocol: "openid4vp-v1-signed", request, dcql_query: dcql, readerContextToken, nonce, trust_level: "device-signed" };
}
