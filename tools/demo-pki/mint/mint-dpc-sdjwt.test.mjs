// Is the minted SD-JWT Digital Payment Credential actually fit for AP2 delegation?
//
// The minting tool can produce a well-formed file that is useless for the one job spec 014
// needs it to do. These tests pin that job: a wallet holding this credential must be able to
// present it with key binding, carrying AP2's `_delegate_payload` — the mechanism the Agent
// Payments Protocol specifies for a user to authorize open mandates — and a wrong holder key
// must be refused.
//
// The last test is the load-bearing one. Without it, "the holder can present it" proves
// nothing: a verifier that checks no holder signature would pass every other test here.
//
// This file lives at the repo root's reach, not inside a workspace — run it with the root
// `npm test` (see #184).
import { describe, expect, it } from "vitest";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, webcrypto } from "node:crypto";
import { SDJwtInstance, decodeSdJwt } from "@sd-jwt/core";

const AUD = "https://shop.example";
const NONCE = "n-once-123";

/** The open mandates a user authorizes — AP2 `transaction_data` type "delegate". */
const DELEGATE_PAYLOAD = [
  {
    vct: "mandate.checkout.open.1",
    constraints: [{ type: "checkout.line_items", allowed: ["oak-whiskey"] }],
    cnf: { jwk: { kty: "EC", crv: "P-256", x: "agent-x", y: "agent-y" } },
  },
  {
    vct: "mandate.payment.open.1",
    constraints: [{ type: "payment.amount_range", currency: "USD", max: 5000 }],
    cnf: { jwk: { kty: "EC", crv: "P-256", x: "agent-x", y: "agent-y" } },
  },
];

const utf8 = new TextEncoder();
const hasher = (data, alg) =>
  new Uint8Array(
    createHash(alg.replace(/-/g, ""))
      .update(typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data))
      .digest(),
  );
const saltGenerator = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString("hex").slice(0, n);
const signer = (key) => (data) =>
  nodeSign("sha256", utf8.encode(data), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
const verifier = (jwk) => (data, sig) => {
  try {
    return nodeVerify(
      "sha256",
      utf8.encode(data),
      { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(sig, "base64url"),
    );
  } catch {
    return false;
  }
};

function p256() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { kty, crv, x, y } = publicKey.export({ format: "jwk" });
  return { privateKey, publicJwk: { kty, crv, x, y } };
}

const CLAIMS = {
  issuer_name: "Bank of Utopia",
  payment_instrument_id: "dpc-0123456789abcdef",
  masked_account_reference: "•••• 4444",
  holder_name: "Demo Buyer",
  issue_date: "2026-09-08",
  expiry_date: "2031-09-08",
};

/** Mint in-memory with the same shape `mint-dpc-sdjwt.mjs` writes to disk. */
async function mintDpc(issuerKey, deviceJwk) {
  const sdjwt = new SDJwtInstance({ hasher, hashAlg: "sha-256", saltGenerator, signAlg: "ES256", signer: signer(issuerKey) });
  const iat = Math.floor(Date.now() / 1000);
  return sdjwt.issue(
    { iss: "https://demo-pki.credentagent.local", vct: "com.emvco.dpc", iat, exp: iat + 86400, cnf: { jwk: deviceJwk }, ...CLAIMS },
    { _sd: Object.keys(CLAIMS) },
    { header: { typ: "dc+sd-jwt" } },
  );
}

describe("the SD-JWT Digital Payment Credential (spec 014, FR-1)", () => {
  it("verifies against the issuer key and names the device key in cnf", async () => {
    const issuer = p256();
    const device = p256();
    const token = await mintDpc(issuer.privateKey, device.publicJwk);

    const check = new SDJwtInstance({ hasher, hashAlg: "sha-256", saltGenerator, signAlg: "ES256", verifier: verifier(issuer.publicJwk) });
    const { payload } = await check.verify(token, { requiredClaimKeys: ["vct"] });

    expect(payload.vct).toBe("com.emvco.dpc");
    expect(payload.cnf.jwk).toEqual(device.publicJwk);
  });

  it("discloses only the claims asked for, and withholds the rest", async () => {
    const issuer = p256();
    const device = p256();
    const token = await mintDpc(issuer.privateKey, device.publicJwk);

    const holder = new SDJwtInstance({ hasher, hashAlg: "sha-256", saltGenerator, signAlg: "ES256", kbSignAlg: "ES256", kbSigner: signer(device.privateKey) });
    const presentation = await holder.present(
      token,
      { masked_account_reference: true, payment_instrument_id: true },
      { kb: { payload: { iat: Math.floor(Date.now() / 1000), aud: AUD, nonce: NONCE } } },
    );

    const disclosed = (await decodeSdJwt(presentation, hasher)).disclosures.map((d) => d.key).sort();
    expect(disclosed).toEqual(["masked_account_reference", "payment_instrument_id"]);
    // The other four stay hidden — the reason AP2 cites SD-JWT for this role at all.
    expect(disclosed).not.toContain("holder_name");
  });

  it("carries AP2's `_delegate_payload` inside the key-binding JWT", async () => {
    const issuer = p256();
    const device = p256();
    const token = await mintDpc(issuer.privateKey, device.publicJwk);

    const holder = new SDJwtInstance({ hasher, hashAlg: "sha-256", saltGenerator, signAlg: "ES256", kbSignAlg: "ES256", kbSigner: signer(device.privateKey) });
    const presentation = await holder.present(token, { masked_account_reference: true }, {
      kb: { payload: { iat: Math.floor(Date.now() / 1000), aud: AUD, nonce: NONCE, _delegate_payload: DELEGATE_PAYLOAD } },
    });

    const kb = (await decodeSdJwt(presentation, hasher)).kbJwt;
    expect(kb).toBeTruthy();
    // This is what makes the credential usable for delegation: the user's signature covers
    // the open mandates, because they are inside the payload that signature is over.
    expect(kb.payload._delegate_payload).toHaveLength(2);
    expect(kb.payload._delegate_payload[0].vct).toBe("mandate.checkout.open.1");
    expect(kb.payload._delegate_payload[1].vct).toBe("mandate.payment.open.1");
  });

  // BYPASS — delete the kbVerifier and this is the test that fails.
  it("BYPASS: a presentation signed by a key the credential does not name is refused", async () => {
    const issuer = p256();
    const device = p256();
    const attacker = p256();
    const token = await mintDpc(issuer.privateKey, device.publicJwk);

    // The verifier checks the key-binding signature against the key the CREDENTIAL commits
    // to in `cnf` — never against a key handed over alongside the signature.
    const kbVerifier = (data, sig, payload) => verifier(payload?.cnf?.jwk)(data, sig);
    const check = new SDJwtInstance({
      hasher, hashAlg: "sha-256", saltGenerator, signAlg: "ES256",
      verifier: verifier(issuer.publicJwk), kbSignAlg: "ES256", kbVerifier,
    });
    const verifyOpts = { requiredClaimKeys: ["vct"], keyBindingNonce: NONCE, expectedKeyBindingAudience: AUD };
    const kbPayload = { iat: Math.floor(Date.now() / 1000), aud: AUD, nonce: NONCE, _delegate_payload: DELEGATE_PAYLOAD };

    const genuine = new SDJwtInstance({ hasher, hashAlg: "sha-256", saltGenerator, signAlg: "ES256", kbSignAlg: "ES256", kbSigner: signer(device.privateKey) });
    await expect(check.verify(await genuine.present(token, { masked_account_reference: true }, { kb: { payload: kbPayload } }), verifyOpts)).resolves.toBeTruthy();

    const forger = new SDJwtInstance({ hasher, hashAlg: "sha-256", saltGenerator, signAlg: "ES256", kbSignAlg: "ES256", kbSigner: signer(attacker.privateKey) });
    await expect(check.verify(await forger.present(token, { masked_account_reference: true }, { kb: { payload: kbPayload } }), verifyOpts)).rejects.toThrow();
  });
});
