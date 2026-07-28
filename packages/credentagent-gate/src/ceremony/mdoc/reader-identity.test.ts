// #51 — the gate presents a STABLE reader identity (so a wallet trusting it via a
// RICAL shows the verifier as trusted) instead of a per-request self-signed cert.
//
// These are BYPASS tests: each asserts the request carries the injected identity's
// cert AND is signed by its key. Delete the `readerIdentity` threading and they fail
// (the x5c reverts to a self-signed cert) — the definition of a load-bearing test.
// The fixture identity is generated here, so these depend on NO external PKI files;
// the tie to the real demo PKI + RICAL is a separate harness (verify-reader-trust).
import { describe, it, expect, vi } from "vitest";
import * as jose from "jose";
import * as x509 from "@peculiar/x509";
import { Encoder, decode as cborDecode, Tag } from "cbor-x";
import { makeReaderCert } from "./reader.js";
import { buildMdocRequestParts, buildSessionTranscript } from "./mdoc-iso.js";
import { buildDcPaymentRequest } from "../dc-payment/request.js";
import { buildCredentialRequest } from "../credential-gate/request.js";
import { mdocDocSpec } from "../credential-gate/doc-spec.js";
import { CredentAgent } from "../../client.js";
import type { ReaderIdentity } from "../../types.js";
import type { Origin } from "../origin.js";
import type { CeremonyOrder } from "../types.js";

const webcrypto = globalThis.crypto;
x509.cryptoProvider.set(webcrypto);
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

// Match the implementation's canonical (deterministic) CBOR so reconstructed
// reader-auth bytes are byte-identical to what the module signed (see mdoc-iso.ts).
const canonicalEncoder = new Encoder({ useRecords: false, variableMapSize: true, useTag259ForMaps: false });
const cborEncode = (value: unknown): Buffer => canonicalEncoder.encode(value);

const SECRET = "stable-test-secret";
const ORIGIN: Origin = { rpID: "127.0.0.1", origin: "http://127.0.0.1" };

const ORDER: CeremonyOrder = {
  id: "ORD-RI1",
  lines: [{ id: "aurora-headphones", name: "Aurora", unitPrice: 199, currency: "USD", quantity: 1, lineTotal: 199 }],
  itemCount: 1, subtotal: 199, discount: 0, total: 199, currency: "USD",
};

function pemPkcs8(der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** A self-contained reader identity fixture with a chosen SAN dNSName. */
async function makeFixtureIdentity(sanDns: string): Promise<{
  identity: ReaderIdentity; certBase64: string; publicKey: CryptoKey;
}> {
  const keys = await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "0a", name: "CN=Fixture Reader",
    notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: ALG, keys,
    extensions: [
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: sanDns }]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  return { identity: { key: pemPkcs8(pkcs8), cert: cert.toString("pem") }, certBase64: cert.toString("base64"), publicKey: keys.publicKey };
}

const x5cOf = (jwt: string): string[] => (jose.decodeProtectedHeader(jwt).x5c ?? []) as string[];

describe("#51 reader identity — makeReaderCert", () => {
  it("presents the injected cert and signs with its key when an identity is given", async () => {
    const { identity, certBase64, publicKey } = await makeFixtureIdentity("127.0.0.1");
    const { x5c, privateKey } = await makeReaderCert("127.0.0.1", identity);
    expect(x5c).toEqual([certBase64]); // the demo cert, not a self-signed one
    // the returned key is the identity's key: a JWT it signs verifies against the cert's public key
    const jwt = await new jose.SignJWT({ t: 1 }).setProtectedHeader({ alg: "ES256" }).sign(privateKey as unknown as jose.KeyLike);
    await expect(jose.jwtVerify(jwt, publicKey)).resolves.toBeDefined();
  });

  it("includes the optional issuer chain leaf-first", async () => {
    const leaf = await makeFixtureIdentity("127.0.0.1");
    const root = await makeFixtureIdentity("root.example");
    const { x5c } = await makeReaderCert("127.0.0.1", { ...leaf.identity, chain: [root.identity.cert] });
    expect(x5c).toEqual([leaf.certBase64, root.certBase64]);
  });

  it("self-signs a fresh, origin-bound cert when no identity is given (presence-only default)", async () => {
    const a = await makeReaderCert("127.0.0.1");
    const b = await makeReaderCert("127.0.0.1");
    expect(a.x5c).toHaveLength(1);
    expect(a.x5c[0]).not.toEqual(b.x5c[0]); // ephemeral — different every call
    const cert = new x509.X509Certificate(Buffer.from(a.x5c[0], "base64"));
    expect(cert.subject).toEqual(cert.issuer); // self-signed
    const san = cert.getExtension(x509.SubjectAlternativeNameExtension);
    expect(san?.names.items.some((n) => n.type === "dns" && n.value === "127.0.0.1")).toBe(true);
  });
});

describe("#51 reader identity — the rails present it in the signed request", () => {
  it("dc-payment: x5c is the identity cert AND the request verifies against the identity key", async () => {
    const { identity, certBase64, publicKey } = await makeFixtureIdentity("127.0.0.1");
    const withId = await buildDcPaymentRequest(ORDER, ORIGIN, SECRET, identity);
    expect(x5cOf(withId.request)).toEqual([certBase64]);
    await expect(jose.jwtVerify(withId.request, publicKey)).resolves.toBeDefined();
    // control: without an identity the x5c is a DIFFERENT (self-signed) cert — this is
    // what makes the assertion above load-bearing (it fails if the wiring is dropped).
    const noId = await buildDcPaymentRequest(ORDER, ORIGIN, SECRET);
    expect(x5cOf(noId.request)).not.toEqual([certBase64]);
  });

  it("credential-gate: x5c is the identity cert AND the request verifies against the identity key", async () => {
    const { identity, certBase64, publicKey } = await makeFixtureIdentity("127.0.0.1");
    const withId = await buildCredentialRequest("age", ORIGIN, SECRET, { minimumAge: 21 }, identity);
    expect(x5cOf(withId.request)).toEqual([certBase64]);
    await expect(jose.jwtVerify(withId.request, publicKey)).resolves.toBeDefined();
    const noId = await buildCredentialRequest("age", ORIGIN, SECRET, { minimumAge: 21 });
    expect(x5cOf(noId.request)).not.toEqual([certBase64]);
  });
});

describe("#51 reader identity — CredentAgent SAN guardrail", () => {
  it("warns when the cert SAN does not cover the walletOrigin host", async () => {
    const { identity } = await makeFixtureIdentity("127.0.0.1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new CredentAgent({ walletOrigin: "https://evil.example", readerIdentity: identity });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not include walletOrigin host"));
    warn.mockRestore();
  });

  it("is silent when the SAN covers the walletOrigin host", async () => {
    const { identity } = await makeFixtureIdentity("127.0.0.1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new CredentAgent({ walletOrigin: "http://127.0.0.1:3000", readerIdentity: identity });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("does not include walletOrigin host"));
    warn.mockRestore();
  });
});

// #99 — the iOS / ISO-mdoc (ReaderAuthAll) path presents the stable reader identity
// too, mirroring the Android/Chrome path #84 wired above. The identity's cert must
// ride in x5chain (COSE label 33) AND the ReaderAuthAll COSE_Sign1 must be signed by
// the identity's key. These are BYPASS tests: revert `makeMdocReaderCert` to always
// self-mint and the identity assertions fail (the presented leaf is a fresh self-mint,
// not the demo cert). On-device iOS trust (a wallet holding the RICAL shows the verifier
// as trusted) is NOT checked here — that is the issue's on-device done-when.
const MDOC_ORIGIN = "https://shop.example"; // host "shop.example" — the fixture SAN below matches
const AGE_SPEC = mdocDocSpec("age", 21);

// Pull the ReaderAuthAll COSE_Sign1 + its x5chain out of a built signed DeviceRequest.
// `x5raw` is label 33 EXACTLY as encoded (a bare bstr for a lone cert, an array for a
// chain — RFC 9360); `chain` normalizes both to a cert list for content assertions.
function readerAuthFromParts(parts: { data: { deviceRequest: string } }): {
  dr: { docRequests: { itemsRequest: Tag }[]; deviceRequestInfo: Tag };
  ra: unknown[];
  x5raw: unknown;
  chain: Uint8Array[];
} {
  const dr = cborDecode(Buffer.from(parts.data.deviceRequest, "base64url")) as {
    docRequests: { itemsRequest: Tag }[]; deviceRequestInfo: Tag; readerAuthAll: unknown[][];
  };
  const ra = dr.readerAuthAll[0];
  const unprotected = ra[1];
  const x5raw = unprotected instanceof Map ? unprotected.get(33) : (unprotected as Record<number, unknown>)[33];
  const chain = (Array.isArray(x5raw) ? x5raw : [x5raw]) as Uint8Array[];
  return { dr, ra, x5raw, chain };
}

// Rebuild the signed ReaderAuthenticationAll bytes and check the COSE_Sign1 signature
// against `pub` — the same reconstruction mdoc-iso.test.ts uses.
async function readerAuthVerifies(
  parts: { base64EncryptionInfo: string },
  dr: { docRequests: { itemsRequest: Tag }[]; deviceRequestInfo: Tag },
  ra: unknown[],
  origin: string,
  pub: CryptoKey,
): Promise<boolean> {
  const transcript = buildSessionTranscript(parts.base64EncryptionInfo, origin);
  const itemsTags = dr.docRequests.map((d) => d.itemsRequest);
  const raaBytes = cborEncode(
    new Tag(Buffer.from(cborEncode(["ReaderAuthenticationAll", cborDecode(transcript), itemsTags, dr.deviceRequestInfo])), 24),
  );
  const sigStructure = cborEncode(["Signature1", Buffer.from(ra[0] as Uint8Array), Buffer.alloc(0), Buffer.from(raaBytes)]);
  return webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, ra[3] as Uint8Array, sigStructure);
}

describe("#99 reader identity — the iOS / ISO-mdoc (ReaderAuthAll) path presents it", () => {
  it("presents the identity cert in x5chain AND signs ReaderAuthAll with the identity key", async () => {
    const { identity, certBase64, publicKey } = await makeFixtureIdentity("shop.example");
    const parts = await buildMdocRequestParts(AGE_SPEC, MDOC_ORIGIN, true, identity);
    const { dr, ra, x5raw, chain } = readerAuthFromParts(parts);
    // a lone identity cert (no chain) is a bare COSE bstr, NOT a one-element array (RFC 9360)
    expect(Array.isArray(x5raw)).toBe(false);
    // the leaf presented to the wallet is the demo identity cert, not a self-mint
    expect(Buffer.from(chain[0]).toString("base64")).toBe(certBase64);
    // and the reader authentication is signed by the identity's key
    expect(await readerAuthVerifies(parts, dr, ra, MDOC_ORIGIN, publicKey)).toBe(true);

    // control (makes the two assertions load-bearing): with NO identity the leaf is a
    // DIFFERENT self-minted cert and the signature does NOT verify against the identity key.
    const noId = await buildMdocRequestParts(AGE_SPEC, MDOC_ORIGIN, true);
    const bare = readerAuthFromParts(noId);
    expect(Buffer.from(bare.chain[0]).toString("base64")).not.toBe(certBase64);
    expect(await readerAuthVerifies(noId, bare.dr, bare.ra, MDOC_ORIGIN, publicKey)).toBe(false);
  });

  it("includes the optional issuer chain leaf-first in x5chain", async () => {
    const leaf = await makeFixtureIdentity("shop.example");
    const root = await makeFixtureIdentity("root.example");
    const parts = await buildMdocRequestParts(AGE_SPEC, MDOC_ORIGIN, true, { ...leaf.identity, chain: [root.identity.cert] });
    const { x5raw, chain } = readerAuthFromParts(parts);
    expect(Array.isArray(x5raw)).toBe(true); // 2+ certs → an array (RFC 9360)
    expect(chain.map((d) => Buffer.from(d).toString("base64"))).toEqual([leaf.certBase64, root.certBase64]);
  });

  it("self-mints an origin-bound chain when no identity is given (safe default) — SAN = origin host", async () => {
    const parts = await buildMdocRequestParts(AGE_SPEC, MDOC_ORIGIN, true);
    const { dr, ra, x5raw, chain } = readerAuthFromParts(parts);
    expect(Array.isArray(x5raw)).toBe(true); // [leaf, ca] → an array (2 certs)
    expect(chain).toHaveLength(2); // [leaf, ca] self-mint structure, unchanged
    // origin/SAN binding still applies in self-mint mode: the leaf carries DNS SAN = origin host
    const leaf = new x509.X509Certificate(chain[0]);
    const san = leaf.getExtension(x509.SubjectAlternativeNameExtension);
    expect(san?.names.items.some((n) => n.type === "dns" && n.value === "shop.example")).toBe(true);
    // and the self-minted request is itself valid (signed by its own leaf key)
    const leafPub = await webcrypto.subtle.importKey("spki", leaf.publicKey.rawData, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await readerAuthVerifies(parts, dr, ra, MDOC_ORIGIN, leafPub)).toBe(true);
  });
});
