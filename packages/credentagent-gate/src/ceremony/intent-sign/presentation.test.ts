// REAL delegated-presentation tests for the intent-sign rail. These drive the actual crypto
// end to end: a real signed OpenID4VP request carrying the grant's AP2 Mandate Content → a
// SIMULATED wallet that mints an SD-JWT VC with its own certificate and signs a REAL ES256 Key
// Binding JWT over those mandates → verifyIntentPresentation (decrypt + bounds re-derivation +
// holder signature + MANDATE equality + required claim + single-use).
//
// What these PROVE is real: the ECDH-ES JWE decryption, the boundsHash equality control, the
// holder's key-binding signature against the key the credential names in `cnf`, and that the
// terms signed are the terms the server recorded. What stays fenced (trust_level
// "device-signed", never "issuer-verified") is the issuer trust anchor: the credential is
// self-certified, exactly as the demo minter makes it (#14).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { peekJwtHeader } from "../../ap2/jwt.js";
import { appendAgentHop } from "../../ap2/chain/hop.js";
import { walletChain } from "../../ap2/chain/serialize.js";
import { verifyChain } from "../../ap2/chain/verify.js";
import { VCT } from "../../ap2/types.js";
import { p256 } from "./dev-wallet.js";
import { buildIntentSignRequest } from "./request.js";
import { verifyIntentPresentation, memoryNonceGuard, inGateBackend, type IntentVerifyBackend } from "./verify.js";
import { dcApiAudience, splitPresentation, verifyDelegatedPresentation } from "./presentation.js";
import { devSimulateWalletSignature } from "./simulate.js";
import { boundsHash, type IntentBoundsInput } from "./bounds.js";
import type { Origin } from "../origin.js";
import { generateDelegate } from "../mandate.js";
import { arrayDisclosure } from "./mandates.js";

const SECRET = "stable-test-secret";
const ORIGIN: Origin = { rpID: "shop.example", origin: "https://shop.example" };
/** The agent key the mandates name in `cnf` — AP2 binds an open mandate to one agent. */
// A REAL P-256 agent key, not a stand-in. This is the key AP2 names in the mandates' `cnf` and
// the one the human's signature covers, so every test here signs over a JWK with real
// coordinates. A `{ x: "agent-x" }` placeholder passes the rail's own checks — nothing here
// verifies an agent signature — which is exactly why it hid whether real coordinates survive
// the disclosure round trip byte-for-byte.
const { delegate: DELEGATE } = await generateDelegate();
const MANDATE_EXP = 4102444800;
/** Resolved server-side in production (`grants._allowedSkusFor`); fixed here. */
const ALLOWED_SKUS = ["coffee", "espresso-machine"]; // 2100-01-01, so expiry never flakes a test

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
  const req = await buildIntentSignRequest({ bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, secret: SECRET, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
  const result = await devSimulateWalletSignature({ request: req, origin: ORIGIN.origin, ...simOver });
  return { req, result };
}

describe("intent-sign REAL device-signed presentation", () => {
  it("verifies a real key-binding signature over the requested mandates → device-signed", async () => {
    const b = bounds();
    const { req, result } = await signFor(b);
    const out = await verifyIntentPresentation({
      result,
      readerContextToken: req.readerContextToken,
      secret: SECRET,
      bounds: b,
      origin: ORIGIN, merchantUrl: ORIGIN.origin,
      nonceGuard: memoryNonceGuard(),
      delegate: DELEGATE,
      mandateExp: MANDATE_EXP,
      allowedSkus: ALLOWED_SKUS,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.trustLevel).toBe("device-signed");
      expect(out.verifiedBy).toBe("gate");
      expect(out.boundsHash).toBe(boundsHash(b));
      expect(out.credentialType).toBe("urn:emvco:dpc:card:1");
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
      origin: ORIGIN, merchantUrl: ORIGIN.origin,
      nonceGuard: memoryNonceGuard(),
      delegate: DELEGATE,
      mandateExp: MANDATE_EXP,
      allowedSkus: ALLOWED_SKUS,
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
      origin: ORIGIN, merchantUrl: ORIGIN.origin,
      nonceGuard: memoryNonceGuard(),
      delegate: DELEGATE,
      mandateExp: MANDATE_EXP,
      allowedSkus: ALLOWED_SKUS,
    });
    // Assert the REFUSAL outcome, not the exact reason text (a copy tweak must not break this).
    expect(out.ok).toBe(false);
  });

  // THE control this rail exists for since spec 014. Everything the human agreed to lives in
  // the Mandate Content, so a wallet that returns different content has authorized different
  // terms. Delete the equality check in verify.ts and this is the test that fails.
  it("BYPASS: the wallet signs DIFFERENT mandates than the gate asked for → refused", async () => {
    const b = bounds();
    const req = await buildIntentSignRequest({ bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, secret: SECRET, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    // A raised per-purchase cap, signed as if the human had agreed to it.
    const inflated = JSON.parse(JSON.stringify(req.mandates)) as Record<string, unknown>[];
    const constraints = inflated[1].constraints as { type: string; max?: number }[];
    const range = constraints.find((c) => c.type === "payment.amount_range")!;
    range.max = 9_999_00;
    const result = await devSimulateWalletSignature({ request: req, origin: ORIGIN.origin, overrideMandates: inflated });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/mandate mismatch/);
  });

  // The agent key is inside the mandates, so swapping it is a mandate change — which is the
  // point: a grant may only ever be spent by the key the human actually authorized.
  it("BYPASS: mandates naming a DIFFERENT agent key → refused", async () => {
    const b = bounds();
    const req = await buildIntentSignRequest({ bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, secret: SECRET, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    const swapped = JSON.parse(JSON.stringify(req.mandates)) as Record<string, unknown>[];
    for (const m of swapped) m.cnf = { jwk: { kty: "EC", crv: "P-256", x: "attacker-x", y: "attacker-y" } };
    const result = await devSimulateWalletSignature({ request: req, origin: ORIGIN.origin, overrideMandates: swapped });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
  });

  // Without this, "the holder signed it" means nothing: anyone could sign for anyone.
  it("BYPASS: a key binding signed by a key the credential does not name → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { forgeHolderKey: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/key-binding signature/);
  });

  // A revealed field is only the ISSUER'S claim if a digest of it is in the issuer-signed `_sd`.
  // `decodeSdJwt` only DECODES: reading claims off its disclosure list let a wallet mint a
  // credential WITHOUT the real instrument, staple an unsigned disclosure naming another card in
  // its place, and have `verifyIntentPresentation` return ok with trustLevel "device-signed".
  //
  // `sd_hash` cannot catch this one — the wallet holds the `cnf` key and recomputes it over its
  // own tampered bytes. Only the `getClaims` digest check can. Delete that call in
  // `presentation.ts` and this test goes green again.
  it("BYPASS: a revealed field the ISSUER never signed a digest for → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { forgeRevealedClaim: "attacker-card" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/Unreferenced disclosure/i);
  });

  // The other half, and a different attacker: `sd_hash` is what makes the holder's signature
  // cover WHICH disclosures were presented (RFC 9901 §4.3). Without it, someone between the
  // wallet and the gate can drop or swap a disclosure after the holder signed, and every
  // signature in the presentation still verifies. Delete the `sd_hash` comparison and this
  // test goes green again.
  it("BYPASS: a key binding whose sd_hash does not cover the disclosures presented → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { breakSdHash: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/sd_hash/);
  });

  // A presentation with no key binding authorizes nothing, and must not read as consent.
  it("BYPASS: a presentation with NO key binding → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { omitKeyBinding: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/key-binding/);
  });

  it("BYPASS (b'): replaying the SAME succeeded presentation → refused (single-use nonce)", async () => {
    const b = bounds();
    const { req, result } = await signFor(b);
    const guard = memoryNonceGuard();
    const first = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: guard, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    const second = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: guard, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    // First succeeds; the replay is REFUSED — assert the outcome, not the reason string.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("refuses a signature made over a DIFFERENT nonce (not this request)", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { overrideNonce: "a-different-nonce" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/nonce/);
  });

  it("refuses a wrong credential type", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { overrideVct: "org.iso.18013.5.1.mDL" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/wrong credential/);
  });

  it("refuses when the payment credential discloses no instrument id", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { omitInstrumentId: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/payment_instrument_id/);
  });

  // The official Multipaz Payment card (`payment_sca_sd_jwt`) carries `credential_id`, not
  // `payment_instrument_id`. These tests use `cardShape: "multipaz-dpc"`, which copies that card's
  // claim names; the simulator signs the card itself, so none of this says the card is genuine.
  // A phone run (2026-11-13) matched the real card on `credential_id`.
  it("verifies a card with the Multipaz card's layout: credential_id disclosed, no payment_instrument_id", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { cardShape: "multipaz-dpc" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.trustLevel).toBe("device-signed");
      expect(out.credentialType).toBe("urn:emvco:dpc:card:1");
      // Prove the Multipaz layout really ran: the card discloses credential_id and no payment_instrument_id.
      const disclosed = out.intent.presentation.split("~").slice(1, -1)
        .map((d) => JSON.parse(Buffer.from(d, "base64url").toString("utf8"))[1]);
      expect(disclosed).toContain("credential_id");
      expect(disclosed).not.toContain("payment_instrument_id");
    }
  });

  // A typo must not quietly mint the demo card: the multipaz-dpc refusal tests below would still pass on it, testing the wrong layout.
  it("the simulated wallet throws on an unknown cardShape instead of minting the demo card", async () => {
    await expect(signFor(bounds(), { cardShape: "multipaz" as never })).rejects.toThrow(/unknown cardShape "multipaz"; use "multipaz-dpc" or "demo-dpc"/);
  });

  // The error calls "demo-dpc" the default, so naming it must make the same card as leaving it out:
  // the test card, which carries payment_instrument_id. If either one changes, this fails.
  it("cardShape \"demo-dpc\" makes the default card: payment_instrument_id disclosed, no credential_id", async () => {
    for (const over of [{}, { cardShape: "demo-dpc" as const }]) {
      const b = bounds();
      const { req, result } = await signFor(b, over);
      const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
      expect(out.ok).toBe(true);
      if (out.ok) {
        const disclosed = out.intent.presentation.split("~").slice(1, -1)
          .map((d) => JSON.parse(Buffer.from(d, "base64url").toString("utf8"))[1]);
        expect(disclosed).toContain("payment_instrument_id");
        expect(disclosed).not.toContain("credential_id");
      }
    }
  });

  // Delete the `hasClaim` check in verify.ts and this FAILS: a card that proves nothing
  // about itself would authorize the grant.
  it("BYPASS: the multipaz-dpc card discloses none of the accepted claims → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { cardShape: "multipaz-dpc", omitInstrumentId: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/did not disclose any of: credential_id, payment_instrument_id/);
  });

  // A claim that is disclosed but EMPTY proves nothing about the card. Remove the empty-string
  // clause from the `hasClaim` check in verify.ts and this fails: only that clause refuses it.
  it("BYPASS: the multipaz-dpc card discloses an EMPTY credential_id → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { cardShape: "multipaz-dpc", instrumentId: "" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/did not disclose any of/);
  });

  // Same attack as the `payment_instrument_id` one above, on the new claim: a credential_id the
  // issuer never signed a digest for. Only the `_sd` digest check can refuse it.
  it("BYPASS: a credential_id the ISSUER never signed, on the multipaz-dpc card → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { cardShape: "multipaz-dpc", forgeRevealedClaim: "attacker-card" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/Unreferenced disclosure/i);
  });

  // Carrying an accepted claim is not enough: the card must also be the right TYPE.
  it("BYPASS: the multipaz-dpc card's claims under a DIFFERENT credential type → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { cardShape: "multipaz-dpc", overrideVct: "org.iso.18013.5.1.mDL" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/wrong credential/);
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
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
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
    // It must report the Mandate Content it saw signed. The gate compares that against its own
    // record — delegation moves the TRUST decision, never the gate's own authorization check —
    // so a backend that reports nothing here is refused rather than trusted.
    const delegated: IntentVerifyBackend = async () => ({
      ok: true,
      trustLevel: "issuer-verified",
      verifiedBy: "upay-verifier",
      credentialType: "urn:emvco:dpc:card:1",
      disclosed: { payment_instrument_id: "instrument_delegated" },
      delegatePayload: req.delegateDigests.map((d) => ({ "...": d })),
    });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), backend: delegated, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.trustLevel).toBe("issuer-verified"); // relayed verbatim — a stronger label
      expect(out.verifiedBy).toBe("upay-verifier"); // …always traceable to WHO attested it
    }
  });

  it("still enforces the gate's OWN checks even under a delegated backend (bounds equality holds)", async () => {
    const b = bounds({ budget: 200 });
    const { req, result } = await signFor(b);
    const delegated: IntentVerifyBackend = async () => ({ ok: true, trustLevel: "issuer-verified", verifiedBy: "upay-verifier", credentialType: "urn:emvco:dpc:card:1", disclosed: { payment_instrument_id: "x" }, delegatePayload: req.delegateDigests.map((d) => ({ "...": d })) });
    // A tampered record (2000 vs the sealed 200) is refused BEFORE the backend runs — delegation
    // moves TRUST, never BINDING (the gate still re-derives boundsHash and requires equality).
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds({ budget: 2000 }), origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), backend: delegated });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/bounds mismatch/);
  });
});

// The audience form is not cosmetic, and it is the one thing the simulator got wrong for the
// whole of this rail's life: it sent the bare origin, every test passed, and the first real
// wallet was refused. These pin the rule so the two cannot drift apart again.
describe("the Key Binding audience (OpenID4VP §B.3.6)", () => {
  it("is the origin prefixed with `origin:`, not the bare origin", () => {
    // What a real Multipaz wallet sends over the DC API. Confirmed on-device 2026-09-14, and
    // in Multipaz's own OpenID4VP.kt, which cites §B.3.6 for the same rule.
    expect(dcApiAudience(ORIGIN.origin)).toBe(`origin:${ORIGIN.origin}`);
    expect(dcApiAudience(ORIGIN.origin)).not.toBe(ORIGIN.origin);
  });

  it("BYPASS: a key binding addressed to a DIFFERENT verifier → refused", async () => {
    const b = bounds();
    // The wallet signs for someone else's origin. Accepting it would let a presentation
    // captured at one verifier be replayed at another.
    const { req, result } = await signFor(b, { origin: "https://attacker.example" } as never);
    const out = await verifyIntentPresentation({
      result,
      readerContextToken: req.readerContextToken,
      secret: SECRET,
      bounds: b,
      origin: ORIGIN, merchantUrl: ORIGIN.origin,
      nonceGuard: memoryNonceGuard(),
      delegate: DELEGATE,
      mandateExp: MANDATE_EXP,
      allowedSkus: ALLOWED_SKUS,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/addressed to/);
  });
});

// THE WIRE SHAPE Delegate SD-JWT defines, pinned on this side (#192 Priority 2).
//
// These are interop tests with a specification, not internal consistency checks: every
// assertion below names something a verifier written against
// `draft-gco-oauth-delegate-sd-jwt-00` will look for. Change the shape and they go red, which is
// the only way this rail finds out it has drifted — a simulator and a gate that agree with each
// other and disagree with the world pass every other test in this file (that is exactly how the
// `aud` bug reached a real phone).
describe("Delegate SD-JWT conformance (draft-gco-oauth-delegate-sd-jwt-00)", () => {
  const b64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf-8")) as never;
  const entriesOf = (req: { request: string }) =>
    ((b64(req.request.split(".")[1]) as { transaction_data: string[] }).transaction_data ?? []).map(
      (t) => b64(t) as unknown as Record<string, unknown>,
    );

  async function build(over: Partial<Parameters<typeof buildIntentSignRequest>[0]> = {}) {
    return buildIntentSignRequest({ bounds: bounds(), origin: ORIGIN, merchantUrl: ORIGIN.origin, secret: SECRET, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS, ...over });
  }

  it("§7.1: the request carries delegate_payload_disclosure, not AP2's plain delegate_payload", async () => {
    const entries = entriesOf(await build());
    for (const entry of entries) {
      expect(entry.type).toBe("delegate");
      // The member the draft REQUIRES: one array disclosure, as a string.
      expect(typeof entry.delegate_payload_disclosure).toBe("string");
      // AP2's `agent_authorization.md` puts the mandate objects here in the clear. Following the
      // draft means this member is absent — if it comes back, we silently switched specs.
      expect(entry.delegate_payload).toBeUndefined();
      // "REQUIRED string containing either dSD-JWT or dSD-JWT+KB" — NOT the credential's
      // `dc+sd-jwt` VDC format, which is what AP2's example carries here.
      expect(entry.format).toBe("dSD-JWT");
      expect(entry.transaction_data_hashes_alg).toEqual(["sha-256"]);
    }
  });

  it("§7.1: one entry per mandate, each disclosing the Mandate Content verbatim", async () => {
    const req = await build();
    const entries = entriesOf(req);
    expect(entries).toHaveLength(req.mandates.length);
    expect(req.mandates.length).toBeGreaterThan(1); // checkout + payment: the multi-entry case
    entries.forEach((entry, i) => {
      // RFC 9901 §4.2.4.2 array disclosure: [salt, value].
      const [salt, value] = b64(entry.delegate_payload_disclosure as string) as unknown as [string, Record<string, unknown>];
      expect(typeof salt).toBe("string");
      expect(salt.length).toBeGreaterThanOrEqual(22); // ≥128 bits of base64url
      expect(value).toEqual(req.mandates[i]);
    });
  });

  it("the disclosures are deterministic, so /verify rebuilds them without remembering anything", async () => {
    // Two independent builds of the same grant must produce identical digests, or the second hop
    // could not recognise what the first one asked the wallet to sign.
    expect((await build()).delegateDigests).toEqual((await build()).delegateDigests);
    // …and a DIFFERENT grant must not reuse them.
    expect((await build({ bounds: bounds({ grantId: "grant_other" }) })).delegateDigests).not.toEqual((await build()).delegateDigests);
  });

  it("§5.1.4 + §7.1: the KB-JWT is typed kb+sd-jwt and carries digests under `delegate_payload`", async () => {
    const { req, result } = await signFor(bounds());
    // Read the KB-JWT the way the verifier does: decrypt is not needed — the simulator's
    // presentation is rebuilt here from the same inputs, so assert on a fresh signature.
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds(), origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(true);
    // The digests the gate computed are what the wallet had to sign over.
    expect(req.delegateDigests).toHaveLength(req.mandates.length);
    for (const digest of req.delegateDigests) expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url sha-256
  });

  // BYPASS: the claim name is the whole point of this increment. `_delegate_payload` came from
  // datatracker's rendering of the draft's Markdown italics; a verifier written against the draft
  // looks for `delegate_payload`. Rename the constant back and this goes red.
  it("BYPASS: the KB-JWT claim is `delegate_payload`, with no leading underscore", async () => {
    const { req, result } = await signFor(bounds(), { plainDelegatePayload: false });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds(), origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(true);
    const { DELEGATE_PAYLOAD_CLAIM } = await import("../../ap2/delegate.js");
    expect(DELEGATE_PAYLOAD_CLAIM).toBe("delegate_payload");
    expect(DELEGATE_PAYLOAD_CLAIM.startsWith("_")).toBe(false);
  });

  // BYPASS (the `typ` check in presentation.ts): a wallet that emits the ordinary `kb+jwt` has
  // not applied the delegation extension. That is the shape this rail shipped BEFORE #192, so
  // accepting it would let the non-conformant output keep passing.
  it("BYPASS: a plain `kb+jwt` key binding is refused", async () => {
    const { req, result } = await signFor(bounds(), { overrideKbTyp: "kb+jwt" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds(), origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.reason).toContain("kb+jwt");
  });

  // BYPASS (the digest comparison): the pre-#192 shape put the mandate objects in the KB-JWT in
  // the clear. §7.1 says the KB-JWT carries their DIGEST. A verifier that accepts both cannot
  // tell a conformant wallet from a legacy one.
  it("BYPASS: mandates sent as plain objects instead of digests are refused", async () => {
    const { req, result } = await signFor(bounds(), { plainDelegatePayload: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds(), origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("mandate mismatch") });
  });

  // BYPASS (the "every expected digest" rule in delegatePayloadMatches): Multipaz keeps only the
  // LAST delegate entry's payload while hashing all of them (#192). The human would be shown two
  // authorizations and sign one. An equality check on LENGTH alone would not catch this.
  it("BYPASS: signing only the last `delegate` entry is refused", async () => {
    const { req, result } = await signFor(bounds(), { signOnlyLastEntry: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds(), origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("mandate mismatch") });
  });

  // The requested algorithm is honoured on both sides (#192). A wallet that always answers in
  // sha-256 fails a sha-384 request with a digest mismatch that points nowhere near the cause.
  it("§7.1: a sha-384 request is answered in sha-384, end to end", async () => {
    const b = bounds();
    const req = await build({ hashAlg: "sha-384" });
    expect(entriesOf(req).every((e) => JSON.stringify(e.transaction_data_hashes_alg) === '["sha-384"]')).toBe(true);
    for (const digest of req.delegateDigests) expect(digest).toMatch(/^[A-Za-z0-9_-]{64}$/); // base64url sha-384

    const result = await devSimulateWalletSignature({ request: req, origin: ORIGIN.origin });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS, hashAlg: "sha-384" });
    expect(out.ok).toBe(true);
  });

  // …and the two sides must agree on WHICH algorithm. A verifier still checking sha-256 against
  // a sha-384 answer refuses, rather than comparing digests of different lengths and shrugging.
  it("BYPASS: a sha-384 answer does not satisfy a verifier expecting sha-256", async () => {
    const b = bounds();
    const req = await build({ hashAlg: "sha-384" });
    const result = await devSimulateWalletSignature({ request: req, origin: ORIGIN.origin });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("mandate mismatch") });
  });
});

// Diego's re-check tried a duplicated disclosure and the library refused it. Nothing in the
// suite would have noticed if a library upgrade stopped refusing, so this pins the behaviour
// we rely on rather than the implementation that provides it.
describe("a malformed disclosure set is refused, not unpacked", () => {
  it("BYPASS: the same disclosure presented twice, with the key binding re-signed → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { duplicateDisclosure: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/disclosure/i);
  });
});

// #331: merchantUrl names the merchant the person signs for. It is required, and checked at
// runtime too — these functions are exported, so a JavaScript caller that leaves it out (or
// passes something that is not an http(s) URL) gets a plain refusal, not an `Invalid URL` throw
// or a permission naming the wrong store.
describe("merchantUrl is required (#331)", () => {
  const base = { bounds: bounds(), origin: ORIGIN, secret: SECRET, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS };

  it("REFUSES to build a signing request without a merchantUrl (bypass)", async () => {
    await expect(buildIntentSignRequest({ ...base } as never)).rejects.toThrow(/merchantUrl is required/);
    await expect(buildIntentSignRequest({ ...base, merchantUrl: "/coffee" })).rejects.toThrow(/absolute http\(s\) URL/);
    // Parses as a URL with an empty host and path "shop.example/wine" — merchantFor would name
    // the WINE store. Only the http(s) check stops it.
    await expect(buildIntentSignRequest({ ...base, merchantUrl: "foo:shop.example/wine" })).rejects.toThrow(/absolute http\(s\) URL/);
  });

  it("REFUSES to verify without a merchantUrl — a refusal, never a throw (bypass)", async () => {
    const { req, result } = await signFor(bounds());
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds(), origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS } as never);
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/merchantUrl is required/) });
  });

  // A store served under a path: the wallet presentation stays bound to the bare origin, but the
  // mandates name the path. The host's root store must not accept what was signed for /coffee.
  it("binds the mandates to the path in merchantUrl — the host's root store REFUSES them (bypass)", async () => {
    const b = bounds();
    const coffee = "https://shop.example/coffee";
    const req = await buildIntentSignRequest({ bounds: b, origin: ORIGIN, merchantUrl: coffee, secret: SECRET, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    const result = await devSimulateWalletSignature({ request: req, origin: ORIGIN.origin });
    const verifyAs = (merchantUrl: string) => verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect((await verifyAs(coffee)).ok).toBe(true);
    expect((await verifyAs(ORIGIN.origin)).ok).toBe(false);
  });
});

// The updated Multipaz wallet (Multipaz #2178, `presentWithKbDisclosures`) answers in the Delegated
// SD-JWT layout of draft §5.1.1: `<SD-JWT>~~<KB-JWT>~<disclosure>~…~`. The key binding is in the
// MIDDLE and the string ends in `~`, so a verifier that reads the last part as the key binding
// refuses a real signature ("presentation carries no key-binding JWT", #473).
describe("the Delegated SD-JWT layout (#473)", () => {
  async function verifyLayout(simOver: Parameters<typeof signFor>[1] = {}) {
    const b = bounds();
    const { req, result } = await signFor(b, { delegatedLayout: true, ...simOver });
    return verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
  }

  it("accepts the layout, device-signed, and still accepts the earlier one", async () => {
    const out = await verifyLayout();
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.trustLevel).toBe("device-signed");
    const b = bounds();
    const { req, result } = await signFor(b);
    const earlier = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(earlier.ok).toBe(true);
  });

  it("stores the presentation in the earlier shape, so the chain code that spends it is unchanged", async () => {
    const out = await verifyLayout();
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.intent.presentation).not.toContain("~~");
      expect(out.intent.presentation.endsWith("~")).toBe(false);
    }
  });

  it("BYPASS: an sd_hash that does not cover the credential's chain → refused", async () => {
    const out = await verifyLayout({ breakSdHash: true });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/sd_hash/);
  });

  it("BYPASS: another nonce → refused", async () => {
    const out = await verifyLayout({ overrideNonce: "another-nonce" });
    expect(out.ok).toBe(false);
  });

  it("BYPASS: a different audience → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { delegatedLayout: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: { rpID: "evil.example", origin: "https://evil.example" }, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
  });

  it("BYPASS: a disclosure behind the key binding that delegate_payload does not commit to → refused", async () => {
    const forged = arrayDisclosure("forged-salt", { type: "payment.open", forged: true } as never);
    const out = await verifyLayout({ overrideKbDisclosure: forged });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/disclosure/);
  });

  it("the simulated wallet throws on overrideKbDisclosure without delegatedLayout instead of ignoring it", async () => {
    await expect(signFor(bounds(), { overrideKbDisclosure: "x" })).rejects.toThrow(/delegatedLayout/);
  });

  // The wallet's hop names the agent's key, so the draft types it delegable. This page still lets
  // the terminal `kb+sd-jwt` through for a grant whose key the gate holds, because the gate spends
  // that grant itself (`verify.ts` refuses it when the agent holds the key; see grants.agent-key.test.ts).
  it("lets a gate-held grant through with the wallet's hop typed `kb+sd-jwt`, as 0.6.0 did", async () => {
    expect((await verifyLayout({ overrideKbTyp: "kb+sd-jwt" })).ok).toBe(true);
  });

  // `kb-sd-jwt` is the other terminal spelling: accepted for the agent's LAST hop by the merchant's
  // verifier, never on this page.
  it("BYPASS: the wallet's hop typed `kb-sd-jwt`, the other terminal spelling → refused", async () => {
    const out = await verifyLayout({ overrideKbTyp: "kb-sd-jwt" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/typed kb-sd-jwt/);
  });

  // A key binding whose body a strict decoder cannot read must be refused here, as it was when the
  // whole answer was decoded, not authorized and then refused when the agent spends it.
  it.each([
    ["the Delegated layout", { delegatedLayout: true }],
    ["the earlier layout", {}],
  ])("BYPASS: a key binding with one extra base64url character in its body, in %s → refused", async (_name, layout) => {
    const out = await verifyLayout({ ...layout, breakKbEncoding: true });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/^disclosures: /);
  });

  it("BYPASS: mandates in delegate_payload that are not the grant's → refused", async () => {
    const out = await verifyLayout({ overrideMandates: [{ type: "payment.open", forged: true } as never] });
    expect(out.ok).toBe(false);
  });

  it("BYPASS: nothing behind the `~~` → refused as no key binding", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { delegatedLayout: true, omitKeyBinding: true });
    // The answer really is in the new layout: the credential's chain, then the gap, then nothing.
    let seen = "";
    const spy: IntentVerifyBackend = async (a) => {
      seen = a.sdjwt;
      return inGateBackend(a);
    };
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS, backend: spy });
    expect(seen).toMatch(/~~$/);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("presentation carries no key-binding JWT");
  });

  it("BYPASS: a backend that accepts an answer with nothing behind the `~~` → the gate still refuses", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { delegatedLayout: true, omitKeyBinding: true });
    // A custom backend that vouches for everything. The gate must not store `<chain>undefined` as a
    // presentation: with no key binding there is nothing signed to keep, whoever vouched for it.
    const accepting: IntentVerifyBackend = async () => ({
      ok: true,
      trustLevel: "issuer-verified",
      verifiedBy: "careless-verifier",
      credentialType: "urn:emvco:dpc:card:1",
      disclosed: { payment_instrument_id: "x" },
      delegatePayload: req.delegateDigests.map((d) => ({ "...": d })),
    });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, merchantUrl: ORIGIN.origin, nonceGuard: memoryNonceGuard(), backend: accepting, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("presentation carries no key-binding JWT");
  });

  it("BYPASS: a key binding signed by a key the credential does not name → refused", async () => {
    const out = await verifyLayout({ forgeHolderKey: true });
    expect(out.ok).toBe(false);
  });
});

// `splitPresentation` is the one place the two layouts are told apart, so its odd shapes are pinned
// directly. Each of these must come back with no key binding to store, or not at all.
describe("splitPresentation", () => {
  const C = "J.P.S~D1~"; // a credential's chain
  const KB = "H.B.S";

  it("reads the earlier layout, key binding last", () => {
    expect(splitPresentation(`${C}${KB}`)).toMatchObject({ chain: C, kbJwt: KB, kbDisclosures: [], normalized: `${C}${KB}` });
  });

  it("reads the Delegated layout and stores it in the earlier shape", () => {
    expect(splitPresentation(`${C}~${KB}~M1~M2~`)).toMatchObject({ chain: C, kbJwt: KB, kbDisclosures: ["M1", "M2"], normalized: `${C}${KB}` });
  });

  it("the gap with nothing behind it has no key binding to store", () => {
    expect(splitPresentation(`${C}~`)?.normalized).toBeUndefined();
    expect(splitPresentation(`${C}~`)?.kbJwt).toBeUndefined();
  });

  it("an empty key binding with a disclosure behind it has none to store", () => {
    expect(splitPresentation(`${C}~~M1~`)?.normalized).toBeUndefined();
  });

  it("a Delegated answer not closed by `~` is refused", () => {
    expect(splitPresentation(`${C}~${KB}`)).toBeUndefined();
  });

  it("an empty disclosure behind the key binding is refused", () => {
    expect(splitPresentation(`${C}~${KB}~~M1~`)).toBeUndefined();
  });

  it("a key binding that is not three parts is refused, in both layouts", () => {
    expect(splitPresentation(`${C}${KB}.x`)).toBeUndefined();
    expect(splitPresentation(`${C}~${KB}.x~M1~`)).toBeUndefined();
    expect(splitPresentation(`${C}H.B`)).toBeUndefined();
  });

  // Three parts is not enough: the signature is decoded leniently, so `S==` would verify and be
  // stored, then be refused by `walletChain` when the agent spends it.
  it("a three-part key binding with characters outside base64url is refused, in both layouts", () => {
    expect(splitPresentation(`${C}${KB}==`)).toBeUndefined();
    expect(splitPresentation(`${C}~${KB}=~M1~`)).toBeUndefined();
    // Standard base64's `+` and `/` decode leniently too, and `walletChain` refuses them.
    expect(splitPresentation(`${C}H.B.S+/`)).toBeUndefined();
    expect(splitPresentation(`${C}~H.B.S+/~M1~`)).toBeUndefined();
  });

  it("a non-string is refused", () => {
    expect(splitPresentation(undefined as never)).toBeUndefined();
  });
});

// Everything above builds its answers with this repo's own simulated wallet, which hashes the same
// bytes the page does — so those tests alone cannot tell whether the page and a real wallet agree
// on what `sd_hash` covers. This one answer came off a phone: the updated Multipaz Wallet signing a
// spending grant on 2026-11-19 (#473). Replayed, it pins the range, the layout and the type.
describe("a real Multipaz Wallet answer, replayed (#473)", () => {
  const real = JSON.parse(readFileSync(new URL("./fixtures/multipaz-delegated-presentation.json", import.meta.url), "utf8")) as { sdjwt: string; audience: string; nonce: string };
  const nowMs = Date.parse("2026-11-19T19:31:00Z"); // the credential expires later; fixed so the test never ages out
  const chainNow = nowMs + 60_000; // the wallet signed 32 seconds after nowMs; do not lean on clock leeway
  const replay = (over: Partial<Parameters<typeof verifyDelegatedPresentation>[0]> = {}) =>
    verifyDelegatedPresentation({ sdjwt: real.sdjwt, audience: real.audience, nonce: real.nonce, nowMs, ...over });

  it("is in the Delegated layout, typed `kb-sd-jwt+kb`", () => {
    const parts = splitPresentation(real.sdjwt)!;
    expect(parts.kbDisclosures).toHaveLength(2);
    expect(peekJwtHeader(parts.kbJwt!)?.typ).toBe("kb-sd-jwt+kb");
  });

  it("verifies: the wallet's sd_hash covers the credential's chain, as the page computes it", async () => {
    const out = await replay();
    expect(out).toMatchObject({ ok: true, vct: "urn:emvco:dpc:card:1" });
    if (out.ok) {
      expect(out.delegatePayload).toHaveLength(2);
      expect(Object.keys(out.disclosed)).toEqual(["credential_id"]);
    }
  });

  // The agent spends this answer and the merchant checks it with `verifyChain`. With an agent key that is not the one the
  // mandate names, it must get as far as the agent's own hop (link 2) and fail only there, so the real
  // wallet's `sd_hash` range and `kb-sd-jwt+kb` type are accepted by the merchant's checks too.
  it("reaches the agent's hop (link 2) when the merchant verifies it", async () => {
    const parts = splitPresentation(real.sdjwt)!;
    for (const d of parts.kbDisclosures) {
      const prefix = walletChain(parts.normalized!, d)!;
      const chain = await appendAgentHop({
        chain: prefix,
        agentKey: p256().privateKey,
        content: { vct: VCT.checkout, checkout_jwt: "h.p.s", checkout_hash: "hash" },
        audience: "https://merchant.example",
        nonce: "n-1",
      });
      const out = await verifyChain(chain, { audience: "https://merchant.example", nonce: "n-1", nowMs: chainNow });
      expect(out).toMatchObject({ ok: false, code: "signature" });
      if (!out.ok) expect(out.detail).toMatch(/^link 2: .*Invalid JWT Signature/);
    }
  });

  it("BYPASS: the same answer with the credential's disclosure dropped → refused (sd_hash)", async () => {
    const [jwt, , ...behind] = real.sdjwt.split("~"); // drops the credential_id disclosure
    const out = await replay({ sdjwt: [jwt, ...behind].join("~") });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/sd_hash/);
  });

  // The signature is checked on the key binding's first three parts, so a fourth leaves it valid.
  // Such an answer used to be authorized and then refused when the agent spent it (#474 review).
  it("BYPASS: the key binding with a fourth part → refused at signing, not at the purchase", async () => {
    const parts = real.sdjwt.split("~");
    parts[3] = `${parts[3]}.extra`;
    const out = await replay({ sdjwt: parts.join("~") });
    expect(out).toEqual({ ok: false, reason: "not a compact SD-JWT presentation" });
  });

  it("BYPASS: the same answer for another nonce or another audience → refused", async () => {
    expect((await replay({ nonce: "another-nonce" })).ok).toBe(false);
    expect((await replay({ audience: "origin:https://evil.example" })).ok).toBe(false);
  });
});
