// Pins the OpenID4VP DC API session-transcript handover shape (spec 012, adversarial-review
// finding 1). The handover MUST carry the response-encryption key's RFC 7638 JWK thumbprint as
// its third element — without it the gate and a real wallet build different transcripts and every
// device signature fails to verify. These tests fix the shape so a regression can't silently drop
// it back to a 2-element handover.
import { describe, it, expect } from "vitest";
import { decode as cborDecode } from "cbor-x";
import * as jose from "jose";
import { intentHandoverInfo, buildIntentSessionTranscript } from "./deviceAuth.js";

const ORIGIN = "https://shop.example";
const NONCE = "nonce-abc";

describe("intent-sign DC API handover shape (finding 1)", () => {
  it("HandoverInfo is a 3-element array with the JWK thumbprint in position 3", () => {
    // The thumbprint travels as the RAW digest (bstr), not the base64url text — the shape a real
    // Multipaz wallet signs, established on device (on-device-interop.md §5.1). Asserting the CBOR
    // TYPE is the point: a tstr carries the same digest, passes every simulated test in this rail
    // (both sides build it with this same function), and makes every real phone refuse.
    const THUMB = Buffer.alloc(32, 7).toString("base64url");
    const decoded = cborDecode(intentHandoverInfo(ORIGIN, NONCE, THUMB)) as unknown[];
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toHaveLength(3);
    expect(decoded[0]).toBe(ORIGIN);
    expect(decoded[1]).toBe(NONCE);
    expect(Buffer.from(decoded[2] as Uint8Array)).toEqual(Buffer.from(THUMB, "base64url"));
  });

  it("the transcript actually depends on the thumbprint (it is hashed in, not ignored)", () => {
    const a = Buffer.from(buildIntentSessionTranscript(ORIGIN, NONCE, "TP-A")).toString("hex");
    const b = Buffer.from(buildIntentSessionTranscript(ORIGIN, NONCE, "TP-B")).toString("hex");
    expect(a).not.toBe(b); // a different key ⇒ a different transcript
  });

  it("the thumbprint is RFC 7638 (jose), so a private JWK and its public form agree", async () => {
    const { privateKey, publicKey } = await jose.generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
    const privJwk = await jose.exportJWK(privateKey); // carries `d`
    const pubJwk = await jose.exportJWK(publicKey);
    // calculateJwkThumbprint hashes ONLY the required EC members, so the private JWK (with `d`)
    // and the public JWK produce the SAME thumbprint — which is why verify (sealed private key)
    // and the wallet (advertised public key) agree.
    expect(await jose.calculateJwkThumbprint(privJwk, "sha256")).toBe(await jose.calculateJwkThumbprint(pubJwk, "sha256"));
  });
});
