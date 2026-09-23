// REAL device-signed presentation tests for the intent-sign rail. These drive the
// actual crypto end-to-end: a real signed OpenID4VP request whose nonce is bound to
// the grant bounds → a SIMULATED wallet that mints a device key, self-signs an MSO,
// and produces a REAL ES256 DeviceAuth signature over the bounds-bound session
// transcript → verifyIntentPresentation (decrypt + bounds re-derivation + DEVICE
// signature check + required-claim + single-use).
//
// What these PROVE is real: the ECDH-ES JWE decryption, the boundsHash equality
// control, and — unlike the presence-only rails — the mdoc DeviceAuth COSE signature.
// What stays fenced (trust_level "device-signed", not "issuer-verified") is the issuer
// trust anchor: the device key rides in a self-minted MSO (no VICAL check — #14).
import { describe, it, expect } from "vitest";
import { buildIntentSignRequest } from "./request.js";
import { verifyIntentPresentation, memoryNonceGuard, inGateBackend, type IntentVerifyBackend } from "./verify.js";
import { devSimulateWalletSignature } from "./simulate.js";
import { boundsHash, type IntentBoundsInput } from "./bounds.js";
import type { Origin } from "../origin.js";

const SECRET = "stable-test-secret";
const ORIGIN: Origin = { rpID: "shop.example", origin: "https://shop.example" };

function bounds(over: Partial<IntentBoundsInput> = {}): IntentBoundsInput {
  return {
    grantId: "grant_abc123",
    merchant: "utopia",
    budget: 200,
    perSpend: 130,
    allow: { categories: ["Beverages", "Electronics"], skus: [] },
    createdAt: "2026-07-28T00:00:00.000Z",
    nonce: "salt-fixed-01",
    ...over,
  };
}

async function signFor(b: IntentBoundsInput, simOver: Parameters<typeof devSimulateWalletSignature>[0] extends infer T ? Partial<T> : never = {}) {
  const req = await buildIntentSignRequest({ bounds: b, origin: ORIGIN, secret: SECRET });
  const result = await devSimulateWalletSignature({ request: req, origin: ORIGIN.origin, ...simOver });
  return { req, result };
}

describe("intent-sign REAL device-signed presentation", () => {
  it("verifies a real DeviceAuth signature over the bounds-bound nonce → device-signed", async () => {
    const b = bounds();
    const { req, result } = await signFor(b);
    const out = await verifyIntentPresentation({
      result,
      readerContextToken: req.readerContextToken,
      secret: SECRET,
      bounds: b,
      origin: ORIGIN,
      nonceGuard: memoryNonceGuard(),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.trustLevel).toBe("device-signed");
      expect(out.verifiedBy).toBe("gate");
      expect(out.boundsHash).toBe(boundsHash(b));
      expect(out.credentialDoctype).toBe("org.multipaz.payment.sca.1");
      expect(typeof out.signedAt).toBe("string");
    }
  });

  it("BYPASS (a): bounds tampered after render (budget 200→2000) → refused", async () => {
    const b = bounds({ budget: 200 });
    const { req, result } = await signFor(b);
    // The grant RECORD the gate re-derives from now shows 2000 — the sealed request
    // was for 200. The boundsHash equality check must refuse.
    const tampered = bounds({ budget: 2000 });
    const out = await verifyIntentPresentation({
      result,
      readerContextToken: req.readerContextToken,
      secret: SECRET,
      bounds: tampered,
      origin: ORIGIN,
      nonceGuard: memoryNonceGuard(),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/bounds mismatch/);
  });

  it("BYPASS (b): a presentation from a DIFFERENT grant's ceremony → refused", async () => {
    const a = bounds({ grantId: "grant_A" });
    const { req, result } = await signFor(a);
    // POST grant A's sealed context + response against grant B's record.
    const bRec = bounds({ grantId: "grant_B" });
    const out = await verifyIntentPresentation({
      result,
      readerContextToken: req.readerContextToken,
      secret: SECRET,
      bounds: bRec,
      origin: ORIGIN,
      nonceGuard: memoryNonceGuard(),
    });
    // Assert the REFUSAL outcome, not the exact reason text (a copy tweak must not break this).
    expect(out.ok).toBe(false);
  });

  it("BYPASS (b'): replaying the SAME succeeded presentation → refused (single-use nonce)", async () => {
    const b = bounds();
    const { req, result } = await signFor(b);
    const guard = memoryNonceGuard();
    const first = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: guard });
    const second = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: guard });
    // First succeeds; the replay is REFUSED — assert the outcome, not the reason string.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("refuses a signature made over a DIFFERENT nonce (not this request)", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { overrideNonce: "a-different-nonce" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard() });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/signature/);
  });

  it("refuses a wrong credential doctype", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { overrideDocType: "org.iso.18013.5.1.mDL" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard() });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/wrong credential/);
  });

  it("refuses when the payment credential discloses no instrument id", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { omitInstrumentId: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard() });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/payment_instrument_id/);
  });
});

// FR-4 — the verify SEAM: honesty is whatever the BACKEND attests, recorded with provenance.
// The gate never judges trust itself — the in-gate backend can only ever say "device-signed",
// and a stronger level must come from (and be traceable to) an external verifier.
describe("intent-sign verify seam (FR-4) — no self-upgrade, verbatim relay", () => {
  it("BYPASS: the in-gate backend can ONLY ever emit trustLevel device-signed / verifiedBy gate — success AND failure", async () => {
    // Direct unit pin on the backend (finding 4): whatever the presentation, the in-gate backend
    // attests exactly one level — it has no code path to "issuer-verified". Even a garbage
    // DeviceResponse (verification fails) is fenced at "device-signed", never upgraded.
    const bad = await inGateBackend({ deviceResponseB64url: "not-a-real-device-response", sessionTranscript: new Uint8Array([1, 2, 3]) });
    expect(bad.ok).toBe(false);
    expect(bad.trustLevel).toBe("device-signed");
    expect(bad.trustLevel).not.toBe("issuer-verified");
    expect(bad.verifiedBy).toBe("gate");
  });

  it("BYPASS: the in-gate backend NEVER emits a trustLevel above device-signed on a VALID presentation", async () => {
    const b = bounds();
    const { req, result } = await signFor(b); // default backend = in-gate
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard() });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.trustLevel).toBe("device-signed");
      expect(out.trustLevel).not.toBe("issuer-verified"); // the gate cannot vouch for an anchor it never checked
      expect(out.verifiedBy).toBe("gate");
    }
  });

  it("relays a delegated backend's attested trustLevel + verifiedBy VERBATIM (never upgrades or rewrites)", async () => {
    const b = bounds();
    const { req, result } = await signFor(b);
    // A stub for the #103-style external checker: it attests an issuer-backed level. It runs only
    // AFTER the transport checks (decrypt, bounds equality, nonce) pass — so the presentation is real;
    // only the TRUST decision is delegated.
    const delegated: IntentVerifyBackend = async () => ({
      ok: true,
      trustLevel: "issuer-verified",
      verifiedBy: "upay-verifier",
      docType: "org.multipaz.payment.sca.1",
      disclosed: { payment_instrument_id: "instrument_delegated" },
    });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), backend: delegated });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.trustLevel).toBe("issuer-verified"); // relayed verbatim — a stronger label
      expect(out.verifiedBy).toBe("upay-verifier"); // …always traceable to WHO attested it
    }
  });

  it("still enforces the gate's OWN checks even under a delegated backend (bounds equality holds)", async () => {
    const b = bounds({ budget: 200 });
    const { req, result } = await signFor(b);
    const delegated: IntentVerifyBackend = async () => ({ ok: true, trustLevel: "issuer-verified", verifiedBy: "upay-verifier", docType: "org.multipaz.payment.sca.1", disclosed: { payment_instrument_id: "x" } });
    // A tampered record (2000 vs the sealed 200) is refused BEFORE the backend runs — delegation
    // moves TRUST, never BINDING (the gate still re-derives boundsHash and requires equality).
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds({ budget: 2000 }), origin: ORIGIN, nonceGuard: memoryNonceGuard(), backend: delegated });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/bounds mismatch/);
  });
});
