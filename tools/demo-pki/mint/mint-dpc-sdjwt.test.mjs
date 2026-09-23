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
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify, webcrypto, X509Certificate } from "node:crypto";
import { SDJwtInstance, decodeSdJwt } from "@sd-jwt/core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { decode } from "cbor-x";

const HERE_DIR = nodePath.dirname(fileURLToPath(import.meta.url));

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
/** `n` is a byte count; the full hex string keeps all 128 bits (RFC 9901 §9.3). */
const saltGenerator = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString("hex");
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

/** The six claims the gate's DCQL asks for — the script must mint exactly these. */
const EXPECTED_CLAIMS = [
  "expiry_date",
  "holder_name",
  "issue_date",
  "issuer_name",
  "masked_account_reference",
  "payment_instrument_id",
];

const pemOf = (b64der) => `-----BEGIN CERTIFICATE-----\n${b64der.replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----`;

/**
 * The credential under test is the one the CLI writes — not a re-implementation of it. An
 * earlier version of this file minted in-memory with a local copy of the issuing logic, which
 * meant every test below could pass while `mint-dpc-sdjwt.mjs` produced something else
 * entirely. The only thing that answers "is the minted credential fit for AP2 delegation?" is
 * the minted credential.
 *
 * The issuer key is taken from the token's OWN `x5c`, the same way Multipaz takes it, so the
 * verification here is the verification a wallet would do, not one handed the right answer.
 *
 * Lazy, so a fault names the file it could not read instead of emptying the whole suite.
 */
let realCache;
const real = () => (realCache ??= (() => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "dpc-real-"));
  const keys = mkdtempSync(nodePath.join(tmpdir(), "dpc-real-keys-"));
  execFileSync(
    process.execPath,
    [nodePath.join(HERE_DIR, "mint-dpc-sdjwt.mjs"), "--out", dir, "--keys", keys],
    { stdio: "pipe" },
  );
  const token = readFileSync(nodePath.join(dir, "dpc.sdjwt"), "utf-8").trim();
  const holderJwk = JSON.parse(readFileSync(nodePath.join(keys, "dpc-holder-key.jwk"), "utf-8"));
  const header = JSON.parse(Buffer.from(token.split("~")[0].split(".")[0], "base64url").toString("utf-8"));
  const issuerPublicJwk = new X509Certificate(pemOf(header.x5c[0])).publicKey.export({ format: "jwk" });
  const { kty, crv, x, y } = holderJwk;
  return {
    token,
    header,
    issuerPublicJwk,
    devicePublicJwk: { kty, crv, x, y },
    devicePrivateKey: createPrivateKey({ key: holderJwk, format: "jwk" }),
  };
})());

const sdjwt = (opts) => new SDJwtInstance({ hasher, hashAlg: "sha-256", saltGenerator, signAlg: "ES256", ...opts });
const kbPayload = (extra = {}) => ({ iat: Math.floor(Date.now() / 1000), aud: AUD, nonce: NONCE, ...extra });

describe("the SD-JWT Digital Payment Credential (spec 014, FR-1)", () => {
  it("verifies against the issuer key it names, and binds cnf to the device key", async () => {
    const { token, issuerPublicJwk, devicePublicJwk } = real();

    const { payload } = await sdjwt({ verifier: verifier(issuerPublicJwk) })
      .verify(token, { requiredClaimKeys: ["vct"] });

    expect(payload.vct).toBe("com.emvco.dpc");
    expect(payload.cnf.jwk).toEqual(devicePublicJwk);
  });

  it("makes exactly the six DCQL claims separately disclosable", async () => {
    const { token } = real();
    const disclosures = (await decodeSdJwt(token, hasher)).disclosures.map((d) => d.key).sort();
    expect(disclosures).toEqual(EXPECTED_CLAIMS);
  });

  // RFC 9901 §9.3: a salt needs at least 128 bits of entropy. `saltGenerator` receives a BYTE
  // count and returns hex, so 16 bytes is 32 hex characters. Cutting that string to 16
  // characters — which this tool did — halves the entropy to 64 bits and changes nothing
  // visible about the output. This test is the only thing that would notice.
  it("salts every disclosure with at least 128 bits of entropy", async () => {
    const { token } = real();
    const salts = (await decodeSdJwt(token, hasher)).disclosures.map((d) => d.salt);
    expect(salts.length).toBe(EXPECTED_CLAIMS.length);
    for (const salt of salts) {
      expect(salt).toMatch(/^[0-9a-f]+$/);
      expect(salt.length).toBeGreaterThanOrEqual(32);
    }
    expect(new Set(salts).size).toBe(salts.length); // and a fresh one per claim
  });

  it("discloses only the claims asked for, and withholds the rest", async () => {
    const { token, devicePrivateKey } = real();

    const presentation = await sdjwt({ kbSignAlg: "ES256", kbSigner: signer(devicePrivateKey) })
      .present(token, { masked_account_reference: true, payment_instrument_id: true }, { kb: { payload: kbPayload() } });

    const disclosed = (await decodeSdJwt(presentation, hasher)).disclosures.map((d) => d.key).sort();
    expect(disclosed).toEqual(["masked_account_reference", "payment_instrument_id"]);
    // The other four stay hidden — the reason AP2 cites SD-JWT for this role at all.
    expect(disclosed).not.toContain("holder_name");
  });

  it("carries AP2's `_delegate_payload` inside the key-binding JWT", async () => {
    const { token, devicePrivateKey } = real();

    const presentation = await sdjwt({ kbSignAlg: "ES256", kbSigner: signer(devicePrivateKey) })
      .present(token, { masked_account_reference: true }, { kb: { payload: kbPayload({ _delegate_payload: DELEGATE_PAYLOAD }) } });

    const kb = (await decodeSdJwt(presentation, hasher)).kbJwt;
    expect(kb).toBeTruthy();
    // This is what makes the credential usable for delegation: the user's signature covers
    // the open mandates, because they are inside the payload that signature is over.
    expect(kb.payload._delegate_payload).toHaveLength(2);
    expect(kb.payload._delegate_payload[0].vct).toBe("mandate.checkout.open.1");
    expect(kb.payload._delegate_payload[1].vct).toBe("mandate.payment.open.1");
  });

  // BYPASS — the load-bearing one. Both presentations are of the SAME minted credential and
  // both go through `SDJwtInstance.verify`; the only difference is which key signed the key
  // binding. Delete the kbVerifier and the forged presentation is accepted.
  it("BYPASS: a presentation signed by a key the credential does not name is refused", async () => {
    const { token, issuerPublicJwk, devicePrivateKey } = real();
    const attacker = p256();

    // The verifier checks the key-binding signature against the key the CREDENTIAL commits
    // to in `cnf` — never against a key handed over alongside the signature.
    const check = sdjwt({
      verifier: verifier(issuerPublicJwk),
      kbSignAlg: "ES256",
      kbVerifier: (data, sig, payload) => verifier(payload?.cnf?.jwk)(data, sig),
    });
    const verifyOpts = { requiredClaimKeys: ["vct"], keyBindingNonce: NONCE, expectedKeyBindingAudience: AUD };
    const kb = { payload: kbPayload({ _delegate_payload: DELEGATE_PAYLOAD }) };
    const present = (key) => sdjwt({ kbSignAlg: "ES256", kbSigner: signer(key) })
      .present(token, { masked_account_reference: true }, { kb });

    await expect(check.verify(await present(devicePrivateKey), verifyOpts)).resolves.toBeTruthy();
    await expect(check.verify(await present(attacker.privateKey), verifyOpts)).rejects.toThrow();
  });
});

// The `.mpzpass` container is what the wallet actually imports — a bare SD-JWT is not
// importable. These pin its structure, because a container that is subtly wrong produces a
// wallet that silently refuses a perfectly good credential, and that failure costs a trip to
// the phone to discover.
//
// Format verified 2026-09-08 against openwallet-foundation/multipaz @ main,
// multipaz/src/commonMain/kotlin/org/multipaz/mpzpass/{MpzPass,MpzPassSdJwtVc}.kt.
describe("the .mpzpass container (spec 014, FR-1)", () => {
  const read = readFileSync;
  const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
  const get = (m, k) => (m instanceof Map ? m.get(k) : m[k]);

  /**
   * Mint into temp dirs through the real CLI — the tool as a caller runs it. Two dirs,
   * because the tool splits them: publishable artifacts to --out, private material to
   * --keys. Both are passed explicitly so a test run never writes into the repository.
   */
  // Built on first use, not at collection: a fixture that throws while the file is being
  // collected takes every test in it down with a "no tests" line that says nothing about
  // what broke. Inside a test, the same fault names the file it could not read.
  let cached;
  const packed = () => (cached ??= (() => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "dpc-"));
    const keys = mkdtempSync(nodePath.join(tmpdir(), "dpc-keys-"));
    execFileSync(
      process.execPath,
      [nodePath.join(HERE, "mint-dpc-sdjwt.mjs"), "--mpzpass", "--out", dir, "--keys", keys],
      { stdio: "pipe" },
    );
    const top = decode(read(nodePath.join(keys, "dpc.mpzpass")));
    return {
      dir,
      keys,
      top,
      root: decode(inflateRawSync(top[1])),
      token: read(nodePath.join(dir, "dpc.sdjwt"), "utf-8").trim(),
      holderJwk: JSON.parse(read(nodePath.join(keys, "dpc-holder-key.jwk"), "utf-8")),
    };
  })());

  it('is wrapped as ["MpzPass", raw-deflate(CBOR)]', () => {
    expect(Array.isArray(packed().top)).toBe(true);
    expect(packed().top[0]).toBe("MpzPass");
    expect(Buffer.isBuffer(packed().top[1]) || packed().top[1] instanceof Uint8Array).toBe(true);
  });

  it("carries the credential under credential.sdJwtVc, byte-identical to the minted token", () => {
    const entry = get(get(packed().root, "credential"), "sdJwtVc")[0];
    expect(get(entry, "vct")).toBe("com.emvco.dpc");
    // If this drifts, the wallet holds a credential that is not the one we verified.
    expect(get(entry, "compactSerialization")).toBe(packed().token);
  });

  it("encodes deviceKeyPrivate as a COSE_Key with INTEGER labels", () => {
    const entry = get(get(packed().root, "credential"), "sdJwtVc")[0];
    const cose = get(entry, "deviceKeyPrivate");
    const at = (label) => (cose instanceof Map ? cose.get(label) : cose[String(label)]);
    // kty EC2, crv P-256. String labels here would encode a map Multipaz cannot read.
    expect(at(1)).toBe(2);
    expect(at(-1)).toBe(1);
    const matches = (bytes, b64u) => Buffer.compare(Buffer.from(bytes), Buffer.from(b64u, "base64url")) === 0;
    expect(matches(at(-2), packed().holderJwk.x)).toBe(true);
    expect(matches(at(-3), packed().holderJwk.y)).toBe(true);
    // The private scalar travels IN the file. That is the format's documented trade-off, and
    // asserting it here keeps it from being a surprise to whoever reads this next.
    expect(matches(at(-4), packed().holderJwk.d)).toBe(true);
  });

  it("has the identifiers the format requires", () => {
    expect(String(get(packed().root, "uniqueId"))).toMatch(/^[A-Za-z0-9_-]{16,}$/); // ≥128 bits of entropy
    expect(get(packed().root, "version")).toBe(0);
    expect(get(get(packed().root, "display"), "typeName")).toBeTruthy();
  });
});

// The `x5c` header is not decoration — it is what makes the credential visible at all.
//
// Multipaz refuses to read an SD-JWT VC without it: `SdJwtVcCredential.getClaimsImpl` throws
// "Only X509-certified keys are supported in SD-JWT", the credential exports to the Android
// Digital Credentials matcher with NO claims, and every request answers "Your info wasn't
// found" — with nothing the holder can see to explain why. Found on a real device.
describe("the issuer certificate (spec 014, FR-1)", () => {
  let mintedCache;
  const minted = () => (mintedCache ??= (() => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "dpc-x5c-"));
    const keys = mkdtempSync(nodePath.join(tmpdir(), "dpc-x5c-keys-"));
    execFileSync(
      process.execPath,
      [nodePath.join(HERE_DIR, "mint-dpc-sdjwt.mjs"), "--out", dir, "--keys", keys],
      { stdio: "pipe" },
    );
    return readFileSync(nodePath.join(dir, "dpc.sdjwt"), "utf-8").trim();
  })());

  const header = () => JSON.parse(Buffer.from(minted().split("~")[0].split(".")[0], "base64url").toString("utf-8"));

  it("carries an x5c chain in the issuer JWT header", () => {
    expect(Array.isArray(header().x5c)).toBe(true);
    expect(header().x5c.length).toBeGreaterThan(0);
    // Standard JWS x5c is base64 DER — not base64url, and not PEM.
    expect(header().x5c[0]).not.toContain("-----BEGIN");
    expect(header().x5c[0]).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  // The load-bearing one. Multipaz takes the issuer key from the FIRST certificate and
  // verifies the SD-JWT against it. A certificate for a different key would be accepted as
  // present and then fail verification — the credential would still be unreadable.
  it("the certificate's key is the key that signed the credential", () => {
    const pem = `-----BEGIN CERTIFICATE-----\n${header().x5c[0].replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----`;
    const cert = new X509Certificate(pem);
    const [h, p, sig] = minted().split("~")[0].split(".");
    const ok = nodeVerify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key: cert.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(sig, "base64url"),
    );
    expect(ok).toBe(true);
  });
});

// `--out` is a TRACKED directory (`tools/demo-pki/out`); `--keys` is not (`../.gitignore`
// covers it under "Private keys never leave this machine"). If generated keys ever default
// back into --out, one `git add tools/demo-pki/out` publishes the issuer key, the holder key
// and a container carrying the holder's private scalar in the clear — and a pushed key cannot
// be un-pushed by deleting the file.
//
// This mints on its own rather than sharing the fixture above, so reverting the split fails
// HERE, on the assertion, instead of crashing the whole file at collection.
describe("key custody: nothing private reaches the tracked output directory", () => {
  const minted = (() => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "dpc-custody-"));
    const keys = mkdtempSync(nodePath.join(tmpdir(), "dpc-custody-keys-"));
    execFileSync(
      process.execPath,
      [nodePath.join(HERE_DIR, "mint-dpc-sdjwt.mjs"), "--mpzpass", "--out", dir, "--keys", keys],
      { stdio: "pipe" },
    );
    return { dir, keys };
  })();

  it("BYPASS: --out holds the credential and nothing that carries a private key", () => {
    const published = readdirSync(minted.dir).sort();

    // It really minted — otherwise "no private files" would pass by producing nothing.
    expect(published).toContain("dpc.sdjwt");

    expect(published.filter((f) => /\.(jwk|pem|mpzpass)$/.test(f))).toEqual([]);

    // Belt and braces: no published file carries key material under any name. `"d"` is the
    // JWK private scalar; the PEM banner covers an exported key.
    for (const f of published) {
      const body = readFileSync(nodePath.join(minted.dir, f), "utf-8");
      expect(body).not.toContain('"d":');
      expect(body).not.toContain("PRIVATE KEY");
    }
  });

  it("the private material exists — it went to --keys, mode 0600", () => {
    expect(readdirSync(minted.keys).sort()).toEqual([
      "dpc-holder-key.jwk",
      "dpc-issuer-key.jwk",
      "dpc.mpzpass",
    ]);
    for (const f of readdirSync(minted.keys)) {
      const mode = statSync(nodePath.join(minted.keys, f)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
