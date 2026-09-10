// The REAL signed OpenID4VP request for the intent-sign ceremony. Mirrors the credential
// rail's request builder (same reader cert, ephemeral ECDH response key, ES256-signed
// verifier-bound request object, sealed reader context) — what differs is WHAT the wallet is
// asked to sign.
//
// WHAT CHANGED (spec 014). The rail used to fold the grant's bounds into the ceremony nonce
// and rely on the wallet's mdoc DeviceAuth signature over a session transcript carrying it.
// It now uses the mechanism AP2 specifies: the Mandate Content rides in a `transaction_data`
// entry of type `delegate`, and the wallet returns it inside the Key Binding JWT. The user's
// key binding IS the authorization, and what they authorized is readable by anyone who knows
// AP2 rather than only by this project.
//
// The bounds-bound nonce is KEPT. It is no longer the binding that carries the grant — the
// signed `delegate_payload` is — but it costs nothing, it keeps the sealed context's
// tamper-evidence for the grant record, and a second independent binding on a security path
// is not something to remove for tidiness.
//
// The crypto is REAL (signed request, origin/RP binding, sealed context, encrypted response,
// and /verify checks the HOLDER's key-binding signature). The issuer trust anchor is not — the
// payment credential is a self-minted demo credential — so trust_level stays "device-signed"
// and the page says so (FR-4).
import * as jose from "jose";
import type { Origin } from "../origin.js";
import { makeReaderCert, makeEncryptionKey } from "../mdoc/reader.js";
import { sealReaderContext } from "../mdoc/readerContext.js";
import { buildIntentSignDcql, PAYMENT_CREDENTIAL_ID } from "./dcql.js";
import { boundsHash, deriveNonce, type IntentBoundsInput } from "./bounds.js";
import { delegateTransactionData, openMandatesForGrant, type DelegateJwk, type MandateContent } from "./mandates.js";
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
  /** The Mandate Content the wallet is asked to sign — echoed so a caller can show it. */
  mandates: MandateContent[];
  trust_level: "device-signed";
}

/**
 * Build the REAL signed OpenID4VP request for signing a grant's Intent Mandate.
 *
 * Asks for the payment credential as an SD-JWT VC (`dcql.ts`) and carries the grant's Mandate
 * Content in an AP2 `delegate` transaction-data entry, which is what the wallet's key binding
 * signs. `secret` seals the reader context so `/verify` can re-derive everything it needs from
 * the server's own state.
 */
export async function buildIntentSignRequest(args: {
  bounds: IntentBoundsInput;
  origin: Origin;
  secret: string;
  /** The agent's public key. AP2 binds an open mandate to the agent allowed to use it. */
  delegate: DelegateJwk;
  /** Absolute expiry for the mandates, epoch seconds. */
  mandateExp: number;
  readerIdentity?: ReaderIdentity;
}): Promise<SignedIntentRequest> {
  const { bounds, origin, secret } = args;
  const dcql = buildIntentSignDcql();
  const { x5c, privateKey } = await makeReaderCert(origin.rpID, args.readerIdentity);
  const { encJwk, ecdhPrivateJwk } = await makeEncryptionKey();

  // A per-ceremony random challenge, then the bounds-bound nonce over (challenge, bounds).
  const challenge = jose.base64url.encode(crypto.getRandomValues(new Uint8Array(16)));
  const hash = boundsHash(bounds);
  const nonce = deriveNonce(challenge, hash);

  // The Mandate Content — assembled from the SERVER's grant record and the agent key, never
  // from anything the client sent. `/verify` rebuilds these from the same record and requires
  // what came back to be identical.
  const mandates = openMandatesForGrant({
    bounds,
    origin: origin.origin,
    delegate: args.delegate,
    exp: args.mandateExp,
  });

  const requestObject = {
    response_type: "vp_token",
    response_mode: "dc_api.jwt",
    client_id: `x509_san_dns:${origin.rpID}`,
    expected_origins: [origin.origin],
    nonce,
    dcql_query: dcql,
    // ONE entry, on purpose. AP2's example pairs `delegate` with a human-readable payment
    // entry, but a wallet refuses the whole presentation when any entry does not apply to the
    // chosen credential — and Multipaz's payment type requires a different credential type
    // than the one delegation needs. Sending both fails with "Error retrieving a token", which
    // points nowhere near the cause. The approve page remains the reading surface (FR-4).
    transaction_data: [
      Buffer.from(
        JSON.stringify(delegateTransactionData({ mandates, credentialId: PAYMENT_CREDENTIAL_ID })),
        "utf-8",
      ).toString("base64url"),
    ],
    client_metadata: {
      vp_formats_supported: { "dc+sd-jwt": { "sd-jwt_alg_values": ["ES256"], "kb-jwt_alg_values": ["ES256"] } },
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
  return { protocol: "openid4vp-v1-signed", request, dcql_query: dcql, readerContextToken, nonce, mandates, trust_level: "device-signed" };
}
