// A wallet, in-process, for tests and the runnable example.
//
// It does what a real Multipaz wallet does on the intent-sign rail since spec 014: mint an
// SD-JWT VC payment credential, present it against the gate's signed request, and sign a Key
// Binding JWT carrying the AP2 Mandate Content the request asked for.
//
// THE SIGNATURES ARE REAL. The credential is signed by a demo issuer key with its own X.509
// certificate; the key binding is signed by the key the credential names in `cnf`; the
// response is encrypted to the gate's ephemeral key. Only the TRUST ANCHOR is fake — the
// issuer certificate is self-signed here, exactly as `tools/demo-pki/mint/` does for a real
// device. That is why a passing test here does not mean a passing run on a phone, and why the
// on-device procedure still exists.
//
// The `override*` options exist to drive the bypass tests. Each one produces a presentation
// that a correct verifier MUST refuse; if any of them starts passing, a control has gone.
import * as jose from "jose";
import { createHash, generateKeyPairSync, sign as nodeSign, webcrypto, type KeyObject } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { SDJwtInstance } from "@sd-jwt/core";
import { PAYMENT_CREDENTIAL_VCTS, PAYMENT_INSTRUMENT_CLAIM } from "./dcql.js";
import { DELEGATE_PAYLOAD_CLAIM, type MandateContent } from "./mandates.js";
import type { SignedIntentRequest } from "./request.js";

const utf8 = new TextEncoder();

const hasher = (data: string | ArrayBuffer, alg: string): Uint8Array => {
  const input = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
  return new Uint8Array(createHash(alg.replace(/-/g, "")).update(input).digest());
};

const saltGenerator = (n: number): string =>
  Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString("hex").slice(0, n);

/** ES256 over P-256. `ieee-p1363` is the raw r‖s JWS wants; node's EC default is DER. */
const signer = (key: KeyObject) => (data: string) =>
  nodeSign("sha256", utf8.encode(data), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");

function p256() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { kty, crv, x, y } = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
  return { privateKey, privateJwk: privateKey.export({ format: "jwk" }), publicJwk: { kty, crv, x, y } };
}

/**
 * A self-signed certificate for the issuer key, base64 DER for the JWS `x5c`.
 *
 * Not optional: a wallet will not read an SD-JWT VC without one, and neither does this rail's
 * verifier — the issuer key is taken FROM the certificate, so a credential without it has no
 * key to check against. Mirrors `tools/demo-pki/mint/mint-dpc-sdjwt.mjs`.
 */
async function selfSignedCert(privateJwk: unknown, publicJwk: { kty: string; crv: string; x: string; y: string }): Promise<string> {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
  const priv = await webcrypto.subtle.importKey("jwk", privateJwk as webcrypto.JsonWebKey, alg, false, ["sign"]);
  const pub = await webcrypto.subtle.importKey("jwk", { ...publicJwk, ext: true } as webcrypto.JsonWebKey, alg, true, ["verify"]);
  const notBefore = new Date(Date.now() - 60_000);
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(8))).toString("hex"),
      name: "CN=CredentAgent Simulated Wallet Issuer",
      notBefore,
      notAfter: new Date(notBefore.getTime() + 365 * 24 * 60 * 60 * 1000),
      signingAlgorithm: alg,
      keys: { privateKey: priv, publicKey: pub },
    },
    webcrypto as unknown as Parameters<typeof x509.X509CertificateGenerator.createSelfSigned>[1],
  );
  return Buffer.from(cert.rawData).toString("base64");
}

export interface SimulateOptions {
  /** The signed request the gate issued (nonce, response-encryption key, transaction data,
   *  and the DCQL id the vp_token is keyed under). Accepts the full `SignedIntentRequest` or
   *  just those two fields, so the same helper drives the in-process flow and a request
   *  reconstructed from the rail's /sign/request response. */
  request: Pick<SignedIntentRequest, "request" | "dcql_query">;
  /** The web origin the wallet addresses the key binding to (must match the gate's). */
  origin: string;
  /** The payment instrument id the credential discloses (default the demo fixture's). */
  instrumentId?: string;
  /** TEST-ONLY: bind to a different nonce than the request asked for (replay/tamper). */
  overrideNonce?: string;
  /** TEST-ONLY: present a different credential type (wrong-credential refusal). */
  overrideVct?: string;
  /** TEST-ONLY: omit the instrument claim (missing-claim refusal). */
  omitInstrumentId?: boolean;
  /** TEST-ONLY: sign DIFFERENT mandates than the gate asked for. The single most important
   *  bypass: a wallet that returns terms other than the ones requested must be refused. */
  overrideMandates?: MandateContent[];
  /** TEST-ONLY: sign the key binding with a key the credential does not name in `cnf`. */
  forgeHolderKey?: boolean;
  /** TEST-ONLY: return no key binding at all. */
  omitKeyBinding?: boolean;
}

/**
 * Produce the `result` a browser would POST to /verify: `{ protocol, data: { response: <JWE> } }`.
 */
export async function devSimulateWalletSignature(
  opts: SimulateOptions,
): Promise<{ protocol: "openid4vp-v1-signed"; data: { response: string } }> {
  const { request, origin } = opts;
  const vct = opts.overrideVct ?? PAYMENT_CREDENTIAL_VCTS[0];
  const instrumentId = opts.instrumentId ?? "demo-instrument-0001";

  const payload = jose.decodeJwt(request.request) as {
    nonce: string;
    transaction_data?: string[];
    client_metadata: { jwks: { keys: jose.JWK[] } };
  };
  const encJwk = payload.client_metadata.jwks.keys[0];
  const nonce = opts.overrideNonce ?? payload.nonce;

  // The Mandate Content the gate asked for, read back out of the request the way a wallet does.
  const delegateEntry = (payload.transaction_data ?? [])
    .map((b64) => {
      try {
        return JSON.parse(Buffer.from(b64, "base64url").toString("utf-8")) as { type?: string; delegate_payload?: MandateContent[] };
      } catch {
        return undefined;
      }
    })
    .find((entry) => entry?.type === "delegate");
  const mandates = opts.overrideMandates ?? delegateEntry?.delegate_payload ?? [];

  // Mint the credential: issuer key + certificate, holder key in `cnf`.
  const issuer = p256();
  const holder = p256();
  const x5c = await selfSignedCert(issuer.privateJwk, issuer.publicJwk);

  const claims: Record<string, unknown> = { issuer_name: "Bank of Utopia", masked_account_reference: "•••• 4444" };
  if (!opts.omitInstrumentId) claims[PAYMENT_INSTRUMENT_CLAIM] = instrumentId;

  const iat = Math.floor(Date.now() / 1000);
  const issuerInstance = new SDJwtInstance<Record<string, unknown>>({
    hasher,
    hashAlg: "sha-256",
    saltGenerator,
    signAlg: "ES256",
    signer: signer(issuer.privateKey),
  });
  const credential = await issuerInstance.issue(
    {
      iss: "https://simulated-wallet.credentagent.local",
      vct,
      iat,
      exp: iat + 3600,
      cnf: { jwk: holder.publicJwk },
      ...claims,
    } as never,
    { _sd: Object.keys(claims) } as never,
    { header: { typ: "dc+sd-jwt", x5c: [x5c] } },
  );

  let presentation: string;
  if (opts.omitKeyBinding) {
    // Disclose everything, sign nothing. A verifier that accepts this has stopped checking
    // that anybody authorized anything.
    presentation = await new SDJwtInstance<Record<string, unknown>>({ hasher, hashAlg: "sha-256", saltGenerator }).present(
      credential,
      Object.fromEntries(Object.keys(claims).map((k) => [k, true])) as never,
    );
  } else {
    const kbKey = opts.forgeHolderKey ? p256().privateKey : holder.privateKey;
    presentation = await new SDJwtInstance<Record<string, unknown>>({
      hasher,
      hashAlg: "sha-256",
      saltGenerator,
      signAlg: "ES256",
      kbSignAlg: "ES256",
      kbSigner: signer(kbKey),
    }).present(credential, Object.fromEntries(Object.keys(claims).map((k) => [k, true])) as never, {
      kb: {
        payload: {
          iat: Math.floor(Date.now() / 1000),
          aud: origin,
          nonce,
          // AP2: the Mandate Content MUST be included as part of the Key Binding.
          [DELEGATE_PAYLOAD_CLAIM]: mandates,
        } as never,
      },
    });
  }

  const credentialId = (request.dcql_query as unknown as { credentials: { id: string }[] }).credentials[0].id;
  const openid4vpResponse = JSON.stringify({ vp_token: { [credentialId]: [presentation] } });

  const encKey = await jose.importJWK(encJwk, "ECDH-ES");
  const response = await new jose.CompactEncrypt(utf8.encode(openid4vpResponse))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A128GCM" })
    .encrypt(encKey);

  return { protocol: "openid4vp-v1-signed", data: { response } };
}
