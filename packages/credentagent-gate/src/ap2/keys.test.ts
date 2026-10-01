// The gate's mandate-signing key: where it comes from, what it refuses, and what it publishes.
//
// Two of these are bypass tests. A key the gate cannot sign ES256 with must be refused at
// construction rather than at the first mandate — by then a caller has shipped — and the DID
// document must never carry the private half, because publishing it hands anyone the ability
// to forge every mandate this gate ever issues.
import { describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync, verify as nodeVerify } from "node:crypto";
import { didDocument, didWebFor, importVerifyKey, KEY_FRAGMENT, publicJwkFromDidDocument, resolveSigningKey, type PrivateJwkP256 } from "./keys.js";
import { Ap2Issuer } from "./issue.js";
import { verifyMandate } from "./verify.js";
import { amountFrom } from "./money.js";

function p256PrivateJwk(): PrivateJwkP256 {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ format: "jwk" }) as unknown as PrivateJwkP256;
}

describe("did:web identity", () => {
  it("keys on the authority, percent-encoded, with no path segments", () => {
    expect(didWebFor("https://shop.example")).toBe("did:web:shop.example");
    expect(didWebFor("https://shop.example/checkout?x=1")).toBe("did:web:shop.example");
    expect(didWebFor("http://localhost:3000")).toBe("did:web:localhost%3A3000");
  });
});

describe("resolving the mandate signing key", () => {
  it("uses a host-supplied key and reports it as stable", () => {
    const jwk = p256PrivateJwk();
    const key = resolveSigningKey("https://shop.example", jwk);

    expect(key.ephemeral).toBe(false);
    expect(key.issuer).toBe("did:web:shop.example");
    expect(key.kid).toBe(`did:web:shop.example#${KEY_FRAGMENT}`);
    expect(key.publicJwk).toMatchObject({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, alg: "ES256" });
    expect(key.publicJwk).not.toHaveProperty("d");
  });

  it("generates an ephemeral key when the host supplies none, and SAYS so", () => {
    const key = resolveSigningKey("https://shop.example");
    expect(key.ephemeral).toBe(true);
    expect(key.publicJwk.x).toBeTruthy();
    expect(key.kid).toBe(`did:web:shop.example#${KEY_FRAGMENT}`);
  });

  it("refuses a key that is not EC P-256", () => {
    expect(() =>
      resolveSigningKey("https://shop.example", { kty: "RSA", crv: "P-256", x: "a", y: "b", d: "c" } as unknown as PrivateJwkP256),
    ).toThrow(/EC P-256/);
    expect(() =>
      resolveSigningKey("https://shop.example", { kty: "EC", crv: "P-384", x: "a", y: "b", d: "c" } as unknown as PrivateJwkP256),
    ).toThrow(/EC P-256/);
  });

  // BYPASS: handing the gate a PUBLIC jwk must not yield a key object that cannot sign. The
  // failure would otherwise surface at the first mandate, in production, as a crypto error.
  it("refuses a public-only JWK (bypass)", () => {
    const { d: _omitted, ...publicOnly } = p256PrivateJwk();
    expect(() => resolveSigningKey("https://shop.example", publicOnly as PrivateJwkP256)).toThrow(/PRIVATE/);
  });

  // BYPASS: node imports a JWK whose `x` / `y` belong to a DIFFERENT key than its `d` without
  // complaint. Copying them into the DID document would publish a key that matches nothing the
  // gate signs — every mandate fails its own check, while doctor() stays green.
  it("refuses a JWK whose public half does not belong to its private half (bypass)", () => {
    const mine = p256PrivateJwk();
    const theirs = p256PrivateJwk();
    expect(() => resolveSigningKey("https://shop.example", { ...mine, x: theirs.x, y: theirs.y })).toThrow(/do not belong/);
  });

  it("round-trips: what resolveSigningKey signs, importVerifyKey verifies", () => {
    const key = resolveSigningKey("https://shop.example");
    const data = Buffer.from("mandate bytes", "utf-8");
    const sig = createSign("sha256").update(data).sign({ key: key.privateKey, dsaEncoding: "ieee-p1363" });
    expect(nodeVerify("sha256", data, { key: importVerifyKey(key.publicJwk), dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });
});

describe("the DID document mount() serves", () => {
  // BYPASS: the document is published to the world. One spread of the private JWK into it
  // hands anyone the key that signs every mandate.
  it("publishes exactly one assertion key and never the private half (bypass)", () => {
    const doc = didDocument(resolveSigningKey("https://shop.example", p256PrivateJwk()));

    expect(doc.id).toBe("did:web:shop.example");
    expect(doc.assertionMethod).toEqual([`did:web:shop.example#${KEY_FRAGMENT}`]);
    const methods = doc.verificationMethod as Array<{ id: string; type: string; publicKeyJwk: Record<string, unknown> }>;
    expect(methods).toHaveLength(1);
    expect(methods[0].type).toBe("JsonWebKey2020");
    expect(methods[0].publicKeyJwk).not.toHaveProperty("d");
    // `authentication` would over-state what this key is for — it issues mandates.
    expect(doc).not.toHaveProperty("authentication");
    expect(JSON.stringify(doc)).not.toContain('"d"');
  });
});

describe("checking a mandate from the published DID document alone", () => {
  // The DX claim: someone holding only the gate's public URL can check its mandates — a fetch
  // and two calls, no plumbing.
  it("turns did.json into the publicJwk verifyMandate takes", async () => {
    const key = resolveSigningKey("https://shop.example", p256PrivateJwk());
    const doc = JSON.parse(JSON.stringify(didDocument(key))); // what a stranger fetches
    const pay = await new Ap2Issuer(key).payment({
      transactionId: "tx",
      payee: { id: "shop.example", name: "Shop" },
      amount: amountFrom(1, "usd"),
      instrument: { id: "pi_1", type: "card" },
    });

    const publicJwk = publicJwkFromDidDocument(doc);
    expect(publicJwk.kid).toBe(key.kid);
    expect((await verifyMandate(pay.token, { publicJwk })).ok).toBe(true);
  });

  it("refuses a key that is not an assertion method, or not the document's own", () => {
    const doc = didDocument(resolveSigningKey("https://shop.example")) as Record<string, unknown>;
    expect(() => publicJwkFromDidDocument({ ...doc, assertionMethod: [] })).toThrow(/no assertion method/);
    const methods = doc.verificationMethod as Array<Record<string, unknown>>;
    expect(() =>
      publicJwkFromDidDocument({ ...doc, verificationMethod: [{ ...methods[0], controller: "did:web:evil.example" }] }),
    ).toThrow(/not controlled by/);
    expect(() => publicJwkFromDidDocument({ id: "nope" })).toThrow(/not a DID document/);
  });
});
