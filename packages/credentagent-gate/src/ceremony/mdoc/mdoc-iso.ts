// ISO 18013-7 Annex C "org-iso-mdoc" over the W3C Digital Credentials API — the
// protocol iOS Safari/WebKit supports (Android Chrome uses OpenID4VP instead).
// Extracted FAITHFULLY from the demo's payment-gate/credential-gate/mdoc-iso.ts
// (which reverse-engineered the wire format from verifier.multipaz.org). The only
// adaptation: the doctype/namespace/elements arrive as a `MdocDocSpec` argument
// (rail-agnostic) instead of a hardcoded credential-kind table, so both rails reuse
// this one module.
//
// What is REAL here: the full ISO/IEC 18013-5 wire format — deterministic
// (canonical) CBOR, COSE_Sign1 ReaderAuthAll (ES256 over the SessionTranscript),
// the @peculiar/x509 reader-cert chain (CA + leaf with mDL reader-auth EKUs),
// EncryptionInfo / DeviceRequest / SessionTranscript, and HPKE (P-256 / HKDF-SHA256
// / AES-128-GCM) decryption of the wallet's DeviceResponse bound to the web origin.
// What is NOT yet real: the issuer TRUST ANCHOR — the reader cert is self-signed
// (no real CA), so origin/reader binding is enforced but cross-issuer trust is not.
import { Encoder, decode as cborDecode, Tag } from "cbor-x";

// ISO/IEC 18013-5 §9.1.1 mandates *deterministic* (canonical) CBOR. cbor-x's
// default `encode` writes maps with a fixed 2-byte length header (0xb9 …) for
// speed, which is non-minimal — Apple re-encodes deviceRequestInfo canonically
// when it reconstructs ReaderAuthenticationAll, so a non-minimal header makes the
// reader-auth signature fail to validate (idcsInvalidReaderAuthSignature).
// `useRecords:false` + `variableMapSize:true` emits minimal map headers (0xa2 …)
// matching verifier.multipaz.org's output exactly. `useTag259ForMaps:false` is
// CRITICAL: by default cbor-x wraps every JS Map in its non-standard tag 259
// (0xd90103), so the COSE protected header `{1:-7}` becomes `d90103 a10126`
// instead of `a10126`. The protected header is part of the signed Sig_structure,
// so the tag makes Apple's COSE parser reject the reader-auth signature
// (idcsInvalidReaderAuthSignature). It also corrupts the x5chain (unprotected
// header) and the recipientPublicKey COSE_Key.
const canonicalEncoder = new Encoder({
  useRecords: false,
  variableMapSize: true,
  useTag259ForMaps: false,
} as ConstructorParameters<typeof Encoder>[0]);
function cborEncode(value: unknown): Buffer {
  return canonicalEncoder.encode(value);
}
import { createHash, webcrypto, randomBytes } from "node:crypto";
import type { webcrypto as NodeWebCrypto } from "node:crypto";
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256, Aes128Gcm } from "@hpke/core";
import * as jose from "jose";
import * as x509 from "@peculiar/x509";
import { decodeVpToken, type DisclosedEntry } from "./mdoc.js";

x509.cryptoProvider.set(globalThis.crypto);
const READER_SIGN_ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

// What the wallet is asked to disclose on the org-iso-mdoc path: an ISO doctype, a
// namespace, and the data elements. Each rail maps its credential to one of these.
export interface MdocDocSpec {
  docType: string;
  namespace: string;
  elements: string[];
}

// Reader-authentication certificate chain following the ISO/IEC 18013-5 reader
// profile. Apple validates the *whole chain* on a signed request, so a single
// self-signed cert is rejected (idcsInvalidReaderAuthSignature). We mint the
// exact structure verifier.multipaz.org uses: a self-signed Reader CA root
// (basicConstraints CA:true) and a leaf signed by it carrying the reader-auth
// EKUs and a DNS SAN matching the request origin. The reader auth is signed with
// the leaf key; x5chain = [leaf, ca].
//
// NOTE: this iOS ReaderAuthAll path always self-mints. The stable `readerIdentity`
// (CredentAgentOptions) is applied on the OpenID4VP (Android/Chrome) path only —
// presenting it here (so an iOS wallet's RICAL matches) is a follow-up (#51).
async function makeMdocReaderCert(
  origin: string,
  host: string,
): Promise<{ chainDer: Uint8Array[]; leafKey: NodeWebCrypto.CryptoKey }> {
  const now = Date.now();
  // ── Reader CA (self-signed root) ──
  const caKeys = await webcrypto.subtle.generateKey(READER_SIGN_ALG, true, ["sign", "verify"]);
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${host} Reader CA`,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 5 * 365 * 86_400_000),
    signingAlgorithm: READER_SIGN_ALG,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true), // CA:true, critical
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
  // ── Leaf (signed by the Reader CA) ──
  const leafKeys = await webcrypto.subtle.generateKey(READER_SIGN_ALG, true, ["sign", "verify"]);
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: `CN=Verifier at ${origin}`,
    issuer: ca.subject,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 365 * 86_400_000),
    signingAlgorithm: READER_SIGN_ALG,
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      // id-mdlReaderAuth + ISO 23220-4 reader-auth — both, as multipaz does.
      new x509.ExtendedKeyUsageExtension(["1.0.18013.5.1.6", "1.0.23220.4.1.6"], true),
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: host }]),
      await x509.AuthorityKeyIdentifierExtension.create(ca),
      await x509.SubjectKeyIdentifierExtension.create(leafKeys.publicKey),
    ],
  });
  return {
    chainDer: [new Uint8Array(leaf.rawData), new Uint8Array(ca.rawData)],
    leafKey: leafKeys.privateKey as unknown as NodeWebCrypto.CryptoKey,
  };
}

function suite(): CipherSuite {
  return new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
}

function b64urlToBytes(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
function bytesToB64url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}
// @hpke/core wants ArrayBuffer for enc/info/ciphertext.
function toAB(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

// ── COSE_Key (EC2 / P-256), CBOR map with integer keys ────────────────────────
export function coseKeyFromJwk(jwk: { x: string; y: string }): Map<number, unknown> {
  return new Map<number, unknown>([
    [1, 2],                       // kty: EC2
    [-1, 1],                      // crv: P-256
    [-2, b64urlToBytes(jwk.x)],   // x
    [-3, b64urlToBytes(jwk.y)],   // y
  ]);
}

// ── Reader ephemeral P-256 key the wallet encrypts its response to ────────────
export interface ReaderKey {
  coseKey: Map<number, unknown>;
  privateJwk: jose.JWK;
}

export async function generateReaderKey(): Promise<ReaderKey> {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pubJwk = (await webcrypto.subtle.exportKey("jwk", kp.publicKey)) as { x: string; y: string };
  const privateJwk = (await webcrypto.subtle.exportKey("jwk", kp.privateKey)) as jose.JWK;
  return { coseKey: coseKeyFromJwk(pubJwk), privateJwk };
}

// ── EncryptionInfo = ["dcapi", { nonce, recipientPublicKey: COSE_Key }] ────────
export function buildEncryptionInfo(coseKey: Map<number, unknown>, nonce: Uint8Array): {
  bytes: Uint8Array;
  base64: string;
} {
  const info = ["dcapi", { nonce: Buffer.from(nonce), recipientPublicKey: coseKey }];
  const bytes = cborEncode(info);
  return { bytes, base64: bytesToB64url(bytes) };
}

// CBOR canonical map-key order (RFC 8949 §4.2.1 / ISO 18013-5): shorter key
// first, then bytewise. The reader-auth signature is over the canonically-encoded
// ItemsRequest, so its element-map keys MUST be in this order or Apple's
// reconstruction won't match (idcsInvalidReaderAuthSignature).
function canonicalKeyOrder(a: string, b: string): number {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length !== bb.length ? ab.length - bb.length : Buffer.compare(ab, bb);
}

export function buildItemsRequest(spec: MdocDocSpec): Uint8Array {
  const { docType, namespace, elements } = spec;
  const sorted = [...elements].sort(canonicalKeyOrder);
  return cborEncode({ docType, nameSpaces: { [namespace]: Object.fromEntries(sorted.map((e) => [e, false])) } });
}

// A request may carry one credential or several; the iOS DeviceRequest is one docRequest
// per credential (item 6 — no truncation to the first). Callers pass a single spec or an array.
const asSpecList = (specs: MdocDocSpec | MdocDocSpec[]): MdocDocSpec[] => (Array.isArray(specs) ? specs : [specs]);

// Unsigned DeviceRequest (used by the structure tests). The real request sent to
// iOS is reader-authenticated — see buildSignedDeviceRequest.
export function buildDeviceRequest(specs: MdocDocSpec | MdocDocSpec[]): Uint8Array {
  const list = asSpecList(specs);
  return cborEncode({
    version: "1.0",
    docRequests: list.map((spec) => ({ itemsRequest: new Tag(Buffer.from(buildItemsRequest(spec)), 24) })),
  });
}

// ISO 18013-5 (mdoc v1.1) ReaderAuthAll — a single COSE_Sign1 (detached) at the
// DeviceRequest level covering ALL doc requests, signed over:
//   #6.24(bstr .cbor ["ReaderAuthenticationAll", SessionTranscript,
//                      [ #6.24(bstr ItemsRequest), … ], deviceRequestInfo|null])
// This is exactly what verifier.multipaz.org sends and what Apple's WebKit
// validator authenticates ("ReaderAuthAll"). The reader cert rides in x5chain
// (label 33). NOTE: the DeviceRequest version MUST be "1.1" or readerAuthAll is
// ignored by conformant parsers.
// DeviceRequestInfo (mdoc v1.1): one mandatory use case covering our single doc
// request (documentSets indices). Matches what verifier.multipaz.org sends; it is
// part of the ReaderAuthAll signed payload, so it must be present AND identical.
function buildDeviceRequestInfo(docCount = 1): Uint8Array {
  // One mandatory use case whose document set references every doc index [0 … docCount-1].
  // The single-doc shape ([[0]]) matches verifier.multipaz.org and is the on-device-tested path.
  // The multi-doc shape ([[0,1,…]]) is the ISO-canonical extension (all docs required together),
  // structure- and signature-verified here, but NOT yet confirmed against Apple's WebKit validator
  // with a multi-credential wallet — verify on a real iOS 18 device before relying on it (item 6).
  return cborEncode({ useCases: [{ mandatory: true, documentSets: [Array.from({ length: docCount }, (_, i) => i)] }] });
}

async function buildReaderAuthAll(args: {
  sessionTranscript: Uint8Array;
  itemsRequestTags: Tag[];
  deviceRequestInfoTag: Tag;
  signingKey: NodeWebCrypto.CryptoKey;
  chainDer: Uint8Array[];
}): Promise<unknown[]> {
  const transcriptItem = cborDecode(args.sessionTranscript);
  // [ "ReaderAuthenticationAll", SessionTranscript, [ItemsRequestBytes…], deviceRequestInfoBytes ]
  const readerAuthenticationAll = ["ReaderAuthenticationAll", transcriptItem, args.itemsRequestTags, args.deviceRequestInfoTag];
  const raaBytes = cborEncode(new Tag(Buffer.from(cborEncode(readerAuthenticationAll)), 24));
  const protectedHeader = cborEncode(new Map<number, number>([[1, -7]])); // {alg: ES256}
  const sigStructure = cborEncode(["Signature1", Buffer.from(protectedHeader), Buffer.alloc(0), Buffer.from(raaBytes)]);
  const signature = new Uint8Array(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, args.signingKey, sigStructure));
  // x5chain (label 33): array of DER certs, leaf first — [leaf, ca].
  const unprotected = new Map<number, unknown>([[33, args.chainDer.map((d) => Buffer.from(d))]]);
  // COSE_Sign1 = [protected, unprotected, payload(null = detached), signature]
  return [Buffer.from(protectedHeader), unprotected, null, Buffer.from(signature)];
}

async function buildSignedDeviceRequest(
  specs: MdocDocSpec | MdocDocSpec[],
  sessionTranscript: Uint8Array,
  signingKey: NodeWebCrypto.CryptoKey,
  chainDer: Uint8Array[],
): Promise<Uint8Array> {
  const list = asSpecList(specs);
  const itemsRequestTags = list.map((spec) => new Tag(Buffer.from(buildItemsRequest(spec)), 24));
  const deviceRequestInfoTag = new Tag(Buffer.from(buildDeviceRequestInfo(itemsRequestTags.length)), 24);
  // One ReaderAuthAll COSE_Sign1 covers ALL docRequests (it signs over every itemsRequest tag).
  const readerAuthAll = await buildReaderAuthAll({ sessionTranscript, itemsRequestTags, deviceRequestInfoTag, signingKey, chainDer });
  // Key order matches verifier.multipaz.org: version, docRequests, deviceRequestInfo, readerAuthAll.
  // readerAuthAll is an *array* of COSE_Sign1s (one per signing key); we always send exactly one,
  // so the value is [[protectedHdr, unprotected, null, sig]] — the outer array is not a mistake.
  return cborEncode({ version: "1.1", docRequests: itemsRequestTags.map((t) => ({ itemsRequest: t })), deviceRequestInfo: deviceRequestInfoTag, readerAuthAll: [readerAuthAll] });
}

// ── SessionTranscript = [null, null, ["dcapi", SHA256(CBOR([b64EncInfo, origin]))]] ──
export function buildSessionTranscript(base64EncryptionInfo: string, origin: string): Uint8Array {
  const dcapiInfo = [base64EncryptionInfo, origin];
  const digest = createHash("sha256").update(cborEncode(dcapiInfo)).digest();
  const transcript = [null, null, ["dcapi", digest]];
  return cborEncode(transcript);
}

// ── Assemble the request `data` for navigator.credentials.get ─────────────────
export interface MdocRequestParts {
  data: { deviceRequest: string; encryptionInfo: string }; // base64url
  readerPrivateJwk: jose.JWK;
  base64EncryptionInfo: string;
}

export async function buildMdocRequestParts(
  specs: MdocDocSpec | MdocDocSpec[],
  origin: string,
  signed = true,
): Promise<MdocRequestParts> {
  const { coseKey, privateJwk } = await generateReaderKey();
  const nonce = randomBytes(16);
  const { base64: base64EncryptionInfo } = buildEncryptionInfo(coseKey, nonce);
  let deviceRequest: Uint8Array;
  if (signed) {
    // The reader auth signs over the session transcript, which binds the request
    // to this exact origin — so the device request must be built with it.
    const sessionTranscript = buildSessionTranscript(base64EncryptionInfo, origin);
    const host = new URL(origin).host.split(":")[0];
    const { chainDer, leafKey } = await makeMdocReaderCert(origin, host);
    deviceRequest = await buildSignedDeviceRequest(specs, sessionTranscript, leafKey, chainDer);
  } else {
    deviceRequest = buildDeviceRequest(specs); // unsigned (diagnostic A/B)
  }
  return {
    data: { deviceRequest: bytesToB64url(deviceRequest), encryptionInfo: base64EncryptionInfo },
    readerPrivateJwk: privateJwk,
    base64EncryptionInfo,
  };
}

// ── HPKE-decrypt the wallet's response → DeviceResponse CBOR bytes ─────────────
function field(map: unknown, key: string): Uint8Array | undefined {
  if (map instanceof Map) return map.get(key) as Uint8Array | undefined;
  if (map && typeof map === "object") return (map as Record<string, Uint8Array>)[key];
  return undefined;
}

export async function decryptDeviceResponse(args: {
  responseB64Url: string;
  readerPrivateJwk: jose.JWK;
  sessionTranscript: Uint8Array;
}): Promise<Uint8Array> {
  const { responseB64Url, readerPrivateJwk, sessionTranscript } = args;
  const decoded = cborDecode(b64urlToBytes(responseB64Url)) as unknown;
  // Accept either ["dcapi", {enc, cipherText}] or a bare {enc, cipherText} map.
  const params = Array.isArray(decoded) && decoded[0] === "dcapi" ? decoded[1] : decoded;
  const enc = field(params, "enc");
  const cipherText = field(params, "cipherText");
  if (!enc || !cipherText) throw new Error("missing enc/cipherText in response");

  const s = suite();
  const recipientKey = await s.kem.importKey("jwk", readerPrivateJwk as unknown as Parameters<typeof s.kem.importKey>[1], false);
  const recipient = await s.createRecipientContext({
    recipientKey,
    enc: toAB(enc),
    info: toAB(sessionTranscript),
  });
  const pt = await recipient.open(toAB(cipherText));
  return new Uint8Array(pt);
}

// ── Decrypted DeviceResponse → disclosed claims (reuses ./mdoc.ts) ────────────
export function disclosedFromDeviceResponse(deviceResponse: Uint8Array): DisclosedEntry[] {
  return decodeVpToken({ mdoc: bytesToB64url(deviceResponse) });
}

// ── Stateless reader context (carries the reader key + encryptionInfo from
//    /request to /verify). Sealed as a JWE under the host signingKey, like the
//    OpenID4VP readerContext. The reader PRIVATE key is confidential, so we
//    encrypt. ──────────────────────────────────────────────────────────────────
export interface MdocReaderContext {
  readerPrivateJwk: jose.JWK;
  base64EncryptionInfo: string;
}

function keyFromSecret(secret: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(secret).digest());
}

export async function sealMdocContext(ctx: MdocReaderContext, secret: string, ttlMs = 180_000): Promise<string> {
  const payload = { ...ctx, exp: Date.now() + ttlMs };
  return await new jose.CompactEncrypt(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .encrypt(keyFromSecret(secret));
}

export async function openMdocContext(token: string, secret: string): Promise<MdocReaderContext> {
  const { plaintext } = await jose.compactDecrypt(token, keyFromSecret(secret));
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as MdocReaderContext & { exp: number };
  if (Date.now() > payload.exp) throw new Error("mdoc reader context expired");
  return { readerPrivateJwk: payload.readerPrivateJwk, base64EncryptionInfo: payload.base64EncryptionInfo };
}
