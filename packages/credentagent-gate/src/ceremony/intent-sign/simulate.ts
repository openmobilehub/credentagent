// A SIMULATED wallet, for tests and examples — never a phone.
//
// `devSimulateWalletSignature` fabricates exactly what a real Multipaz wallet would
// return from the intent-sign OpenID4VP request: an ISO 18013-5 DeviceResponse whose
// `deviceSignature` is a REAL ES256 COSE_Sign1 over the bounds-bound session
// transcript, JWE-encrypted to the request's ephemeral key. It lets you exercise the
// whole create → sign → authorize → spend chain end-to-end in-process, with no device
// (the credential rail's tests fabricate presentations the same way).
//
// It is honest about what it is: the device key it mints is a self-generated demo key
// with a self-minted MSO — no issuer/VICAL anchor (#14) — so the gate reports
// trust_level "device-signed", never "issuer-verified". This is the local test-double,
// the way Stripe's test cards are: real shape, no real trust behind it. The maintainer's
// on-device test (import `payment.mpzpass`, sign on a Pixel) is what proves the real
// wallet path — flagged open until then.
import { Encoder, Tag, decode as cborDecode } from "cbor-x";
import { webcrypto } from "node:crypto";
import * as jose from "jose";
import { coseKeyFromJwk } from "../mdoc/mdoc-iso.js";
import { buildIntentSessionTranscript } from "./deviceAuth.js";
import { PAYMENT_CREDENTIAL_DOCTYPE } from "./dcql.js";
import type { SignedIntentRequest } from "./request.js";

const enc = new Encoder({ useRecords: false, variableMapSize: true, useTag259ForMaps: false } as ConstructorParameters<typeof Encoder>[0]);
function cbor(value: unknown): Buffer {
  return enc.encode(value);
}
const subtle = webcrypto.subtle;
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

async function coseSign1Detached(payloadBytes: Buffer, key: webcrypto.CryptoKey): Promise<unknown[]> {
  const protectedHeader = cbor(new Map<number, number>([[1, -7]])); // { alg: ES256 }
  const sigStructure = cbor(["Signature1", Buffer.from(protectedHeader), Buffer.alloc(0), payloadBytes]);
  const signature = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, sigStructure));
  // [ protected, unprotected, payload(null = detached), signature ]
  return [Buffer.from(protectedHeader), new Map(), null, Buffer.from(signature)];
}

export interface SimulateOptions {
  /** The signed request the gate issued (the JWT carries the nonce + response-encryption
   *  key; the DCQL names the credential id the vp_token is keyed under). Accepts the full
   *  `SignedIntentRequest` OR just those two fields — so the same helper drives both the
   *  in-process flow and a request reconstructed from the rail's /sign/request response. */
  request: Pick<SignedIntentRequest, "request" | "dcql_query">;
  /** The web origin the wallet binds the transcript to (must match the gate's origin). */
  origin: string;
  /** The payment account the credential discloses (default a demo reference). */
  account?: string;
  /** TEST-ONLY: sign over a DIFFERENT nonce than the request asked for (drives the
   *  replay/tamper bypass tests — the device signature then won't verify). */
  overrideNonce?: string;
  /** TEST-ONLY: present a different doctype (drives the wrong-credential refusal). */
  overrideDocType?: string;
  /** TEST-ONLY: omit the account claim (drives the missing-claim refusal). */
  omitAccount?: boolean;
}

/**
 * Produce the `result` a browser would POST to /verify: `{ protocol, data:
 * { response: <JWE> } }`. Real device signature; demo trust anchor.
 */
export async function devSimulateWalletSignature(
  opts: SimulateOptions,
): Promise<{ protocol: "openid4vp-v1-signed"; data: { response: string } }> {
  const { request, origin } = opts;
  const docType = opts.overrideDocType ?? PAYMENT_CREDENTIAL_DOCTYPE;
  const account = opts.account ?? "acct_demo_01";

  // Read the response-encryption key + nonce out of the signed request.
  const payload = jose.decodeJwt(request.request) as {
    nonce: string;
    client_metadata: { jwks: { keys: jose.JWK[] } };
  };
  const encJwk = payload.client_metadata.jwks.keys[0];
  const nonce = opts.overrideNonce ?? payload.nonce;
  const dcqlId = request.dcql_query.credentials[0].id;

  // ── Device key + a self-minted MSO carrying its public key (no issuer anchor). ──
  const deviceKp = await subtle.generateKey(ALG, true, ["sign", "verify"]);
  const devicePub = (await subtle.exportKey("jwk", deviceKp.publicKey)) as { x: string; y: string };

  const issuerKp = await subtle.generateKey(ALG, true, ["sign", "verify"]);
  const isi = cbor({ digestID: 0, random: webcrypto.getRandomValues(new Uint8Array(16)), elementIdentifier: "account", elementValue: account });
  const now = new Date();
  const mso = {
    version: "1.0",
    digestAlgorithm: "SHA-256",
    valueDigests: { [docType]: new Map<number, Buffer>([[0, Buffer.from(await subtle.digest("SHA-256", isi))]]) },
    deviceKeyInfo: { deviceKey: coseKeyFromJwk(devicePub) },
    docType,
    validityInfo: {
      signed: now.toISOString(),
      validFrom: now.toISOString(),
      validUntil: new Date(now.getTime() + 365 * 86_400_000).toISOString(),
    },
  };
  // MobileSecurityObjectBytes = #6.24(bstr .cbor MSO); it is the issuerAuth COSE payload.
  const msoBytes = cbor(new Tag(cbor(mso), 24));
  const issuerAuth = await coseSign1WithPayload(msoBytes, issuerKp.privateKey);

  // ── deviceSigned: empty device namespaces + the REAL device signature over the
  //    bounds-bound session transcript. ──
  const deviceNameSpaces = new Tag(cbor({}), 24);
  // The transcript binds to the response-encryption key's RFC 7638 JWK thumbprint (DC API
  // HandoverInfo); a real wallet computes it from the verifier's encryption key advertised in
  // client_metadata.jwks. Use jose's calculateJwkThumbprint (the SAME function the verifier uses).
  const thumbprint = await jose.calculateJwkThumbprint(encJwk, "sha256");
  const transcript = buildIntentSessionTranscript(origin, nonce, thumbprint);
  const deviceAuthentication = ["DeviceAuthentication", cborDecode(transcript), docType, deviceNameSpaces];
  const deviceAuthenticationBytes = cbor(new Tag(cbor(deviceAuthentication), 24));
  const deviceSignature = await coseSign1Detached(deviceAuthenticationBytes, deviceKp.privateKey);

  const deviceResponse = cbor({
    version: "1.0",
    documents: [
      {
        docType,
        issuerSigned: {
          nameSpaces: opts.omitAccount ? {} : { [docType]: [new Tag(isi, 24)] },
          issuerAuth,
        },
        deviceSigned: { nameSpaces: deviceNameSpaces, deviceAuth: { deviceSignature } },
      },
    ],
    status: 0,
  });
  const deviceResponseB64 = Buffer.from(deviceResponse).toString("base64url");

  // ── JWE-encrypt { vp_token } to the request's response-encryption key. ──
  const pub = await jose.importJWK(encJwk, "ECDH-ES");
  const jwe = await new jose.CompactEncrypt(
    new TextEncoder().encode(JSON.stringify({ vp_token: { [dcqlId]: deviceResponseB64 } })),
  )
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A128GCM" })
    .encrypt(pub);

  return { protocol: "openid4vp-v1-signed", data: { response: jwe } };
}

// issuerAuth ATTACHES the payload (non-detached) so a parser can read the MSO from it.
async function coseSign1WithPayload(payloadBytes: Buffer, key: webcrypto.CryptoKey): Promise<unknown[]> {
  const protectedHeader = cbor(new Map<number, number>([[1, -7]]));
  const sigStructure = cbor(["Signature1", Buffer.from(protectedHeader), Buffer.alloc(0), payloadBytes]);
  const signature = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, sigStructure));
  return [Buffer.from(protectedHeader), new Map(), Buffer.from(payloadBytes), Buffer.from(signature)];
}
