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
import { makeReaderCert } from "./reader.js";
import { buildDcPaymentRequest } from "../dc-payment/request.js";
import { buildCredentialRequest } from "../credential-gate/request.js";
import { CredentAgent } from "../../client.js";
import type { ReaderIdentity } from "../../types.js";
import type { Origin } from "../origin.js";
import type { CeremonyOrder } from "../types.js";

const webcrypto = globalThis.crypto;
x509.cryptoProvider.set(webcrypto);
const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

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
