// REAL OpenID4VP presentation tests for the credential gate. These drive the actual
// crypto end-to-end: a real signed request (buildCredentialRequest) → a simulated
// wallet that JWE-encrypts (jose ECDH-ES) an ISO 18013-5 mdoc DeviceResponse to the
// request's response-encryption key, with the nonce echoed in `apu` → the real
// verifyCredentialPresentation (decrypt + nonce binding + mdoc parse + policy).
//
// What these PROVE is real: JWE/ECDH-ES decryption, nonce binding, ISO-mdoc CBOR
// parsing, and the explicit-positive-claim policy on the disclosed value. What stays
// fenced (trust_level presence-only-demo) is the issuer/device COSE signature — these
// DeviceResponses are unsigned synthetic mdocs (no trust anchor). The tampering tests
// confirm a response NOT bound to this request (wrong nonce) and a value-bypass
// (age_over_21=false) are REFUSED.
import { describe, it, expect } from "vitest";
import * as jose from "jose";
import { Encoder, Tag } from "cbor-x";
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256, Aes128Gcm } from "@hpke/core";
import { buildCredentialRequest } from "./request.js";
import { verifyCredentialPresentation } from "./verify.js";
import { verifyMdocPresentation } from "./mdoc-verify.js";
import { mdocDocSpec } from "./doc-spec.js";
import { buildMdocRequestParts, sealMdocContext, buildSessionTranscript } from "../mdoc/mdoc-iso.js";
import type { Origin } from "../origin.js";

const suite = () => new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
const toAB = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const enc = new Encoder({ useRecords: false, variableMapSize: true, useTag259ForMaps: false });
const cbor = (v: unknown): Buffer => enc.encode(v);

const SECRET = "stable-test-secret";
const ORIGIN: Origin = { rpID: "shop.example", origin: "https://shop.example" };

// A synthetic ISO 18013-5 DeviceResponse disclosing one element (issuer-signed,
// UNSIGNED — the wire structure is real; the issuer trust anchor is the future work).
function deviceResponseB64(namespace: string, elementId: string, value: unknown): string {
  const isi = cbor({ digestID: 0, random: Buffer.alloc(16), elementIdentifier: elementId, elementValue: value });
  const dr = cbor({
    version: "1.0",
    documents: [{ docType: "org.iso.18013.5.1.mDL", issuerSigned: { nameSpaces: { [namespace]: [new Tag(isi, 24)] } } }],
    status: 0,
  });
  return Buffer.from(dr).toString("base64url");
}

// Pull the public response-encryption JWK + nonce out of the signed request JWT.
function requestParams(requestJwt: string): { encJwk: jose.JWK; nonce: string } {
  const payload = jose.decodeJwt(requestJwt) as {
    nonce: string;
    client_metadata: { jwks: { keys: jose.JWK[] } };
  };
  return { encJwk: payload.client_metadata.jwks.keys[0], nonce: payload.nonce };
}

// Simulate the wallet: JWE-encrypt {vp_token} to the reader's public key.
//
// On the bound-OK path we encrypt WITHOUT apu/apv. OpenID4VP 1.0 makes those
// key-agreement params optional (real wallets — Multipaz/Chrome — send them empty
// cross-device), and verify.ts explicitly "accepts on absence"; binding is enforced
// by the fresh per-request ephemeral key + short TTL, so a response only ever
// decrypts under the request that produced it. On the MISMATCH path we DO set a
// (wrong) apu — verify.ts rejects it at the nonce check, BEFORE decryption, which is
// exactly the contradiction-refusal we want to pin. (We deliberately avoid the
// jose-encrypt→jose-decrypt apu round-trip, which jose does not support: the apu it
// writes is not fed back into its own ECDH-ES Concat-KDF on decrypt.)
async function walletEncrypt(encJwk: jose.JWK, wrongNonce: string | null, vpToken: unknown): Promise<string> {
  const pub = await jose.importJWK(encJwk, "ECDH-ES");
  const builder = new jose.CompactEncrypt(new TextEncoder().encode(JSON.stringify({ vp_token: vpToken })));
  const header: jose.CompactJWEHeaderParameters = { alg: "ECDH-ES", enc: "A128GCM" };
  if (wrongNonce) header.apu = jose.base64url.encode(wrongNonce);
  return await builder.setProtectedHeader(header).encrypt(pub);
}

describe("credential-gate REAL OpenID4VP presentation — age", () => {
  it("decrypts + nonce-binds + parses the mdoc and verifies age_over_21 (real crypto)", async () => {
    const req = await buildCredentialRequest("age", ORIGIN, SECRET, { minimumAge: 21 });
    const { encJwk } = requestParams(req.request);
    const response = await walletEncrypt(encJwk, null, { mdl: deviceResponseB64("org.iso.18013.5.1", "age_over_21", true) });

    const out = await verifyCredentialPresentation({
      kind: "age",
      result: { protocol: "openid4vp-v1-signed", data: { response } },
      readerContextToken: req.readerContextToken,
      secret: SECRET,
      minimumAge: 21,
    });
    expect(out.verified).toBe(true);
    expect(out.trust_level).toBe("presence-only-demo");
  });

  it("REFUSES a value-bypass: a decryptable token disclosing age_over_21=false does NOT pass", async () => {
    const req = await buildCredentialRequest("age", ORIGIN, SECRET, { minimumAge: 21 });
    const { encJwk } = requestParams(req.request);
    const response = await walletEncrypt(encJwk, null, { mdl: deviceResponseB64("org.iso.18013.5.1", "age_over_21", false) });

    const out = await verifyCredentialPresentation({
      kind: "age",
      result: { protocol: "openid4vp-v1-signed", data: { response } },
      readerContextToken: req.readerContextToken,
      secret: SECRET,
      minimumAge: 21,
    });
    expect(out.verified).toBe(false); // token-presence proves nothing about the value
  });

  it("REJECTS a response bound to a DIFFERENT nonce (apu echo mismatch — not this request)", async () => {
    const req = await buildCredentialRequest("age", ORIGIN, SECRET, { minimumAge: 21 });
    const { encJwk } = requestParams(req.request);
    // Wallet echoes a WRONG nonce — the response was produced for another request.
    const response = await walletEncrypt(encJwk, "a-different-nonce-entirely", { mdl: deviceResponseB64("org.iso.18013.5.1", "age_over_21", true) });

    await expect(
      verifyCredentialPresentation({
        kind: "age",
        result: { protocol: "openid4vp-v1-signed", data: { response } },
        readerContextToken: req.readerContextToken,
        secret: SECRET,
        minimumAge: 21,
      }),
    ).rejects.toThrow(/nonce mismatch/);
  });
});

describe("credential-gate REAL OpenID4VP presentation — membership", () => {
  it("decrypts + parses and verifies a disclosed membership_number (real crypto)", async () => {
    const req = await buildCredentialRequest("membership", ORIGIN, SECRET, {});
    const { encJwk } = requestParams(req.request);
    const response = await walletEncrypt(encJwk, null, { loyalty: deviceResponseB64("org.multipaz.loyalty.1", "membership_number", "M-9087") });

    const out = await verifyCredentialPresentation({
      kind: "membership",
      result: { protocol: "openid4vp-v1-signed", data: { response } },
      readerContextToken: req.readerContextToken,
      secret: SECRET,
    });
    expect(out.verified).toBe(true);
    expect(out.membershipNumber).toBe("M-9087");
  });
});

// The iOS org-iso-mdoc path through the actual rail function: a sealed mdoc reader
// context + an HPKE-sealed DeviceResponse bound to the SAME origin's session
// transcript → verifyMdocPresentation decrypts and evaluates. The HPKE binding is
// REAL; only the issuer trust anchor is fenced.
describe("credential-gate REAL org-iso-mdoc presentation (iOS WebKit path)", () => {
  it("HPKE-decrypts the origin-bound DeviceResponse and verifies age_over_21", async () => {
    const parts = await buildMdocRequestParts(mdocDocSpec("age", 21), ORIGIN.origin);
    const mdocContextToken = await sealMdocContext(
      { readerPrivateJwk: parts.readerPrivateJwk, base64EncryptionInfo: parts.base64EncryptionInfo },
      SECRET,
    );

    // Wallet side: HPKE-seal a DeviceResponse to the reader pubkey, info-bound to
    // this origin's session transcript (so a response for another origin won't open).
    const transcript = buildSessionTranscript(parts.base64EncryptionInfo, ORIGIN.origin);
    const dr = Buffer.from(deviceResponseB64("org.iso.18013.5.1", "age_over_21", true), "base64url");
    const s = suite();
    const pubJwk = { kty: parts.readerPrivateJwk.kty, crv: parts.readerPrivateJwk.crv, x: parts.readerPrivateJwk.x, y: parts.readerPrivateJwk.y };
    const recipientPublicKey = await s.kem.importKey("jwk", pubJwk as JsonWebKey, true);
    const sender = await s.createSenderContext({ recipientPublicKey, info: toAB(transcript) });
    const ct = new Uint8Array(await sender.seal(toAB(new Uint8Array(dr))));
    const response = Buffer.from(
      (new Encoder({ useRecords: false, variableMapSize: true, useTag259ForMaps: false })).encode([
        "dcapi",
        { enc: Buffer.from(new Uint8Array(sender.enc)), cipherText: Buffer.from(ct) },
      ]),
    ).toString("base64url");

    const out = await verifyMdocPresentation({
      kind: "age",
      result: { protocol: "org-iso-mdoc", data: { response } },
      mdocContextToken,
      origin: ORIGIN,
      secret: SECRET,
      minimumAge: 21,
    });
    expect(out.verified).toBe(true);
    expect(out.trust_level).toBe("presence-only-demo");
  });
});
