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
import { buildIntentSignRequest } from "./request.js";
import { verifyIntentPresentation, memoryNonceGuard, inGateBackend, type IntentVerifyBackend } from "./verify.js";
import { dcApiAudience } from "./presentation.js";
import { devSimulateWalletSignature } from "./simulate.js";
import { boundsHash, type IntentBoundsInput } from "./bounds.js";
import type { Origin } from "../origin.js";

const SECRET = "stable-test-secret";
const ORIGIN: Origin = { rpID: "shop.example", origin: "https://shop.example" };
/** The agent key the mandates name in `cnf` — AP2 binds an open mandate to one agent. */
const DELEGATE = { kty: "EC", crv: "P-256", x: "agent-x", y: "agent-y" } as const;
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
  const req = await buildIntentSignRequest({ bounds: b, origin: ORIGIN, secret: SECRET, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
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
      origin: ORIGIN,
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
      origin: ORIGIN,
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
      origin: ORIGIN,
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
    const req = await buildIntentSignRequest({ bounds: b, origin: ORIGIN, secret: SECRET, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    // A raised per-purchase cap, signed as if the human had agreed to it.
    const inflated = JSON.parse(JSON.stringify(req.mandates)) as Record<string, unknown>[];
    const constraints = inflated[1].constraints as { type: string; max?: number }[];
    const range = constraints.find((c) => c.type === "payment.amount_range")!;
    range.max = 9_999_00;
    const result = await devSimulateWalletSignature({ request: req, origin: ORIGIN.origin, overrideMandates: inflated });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/mandate mismatch/);
  });

  // The agent key is inside the mandates, so swapping it is a mandate change — which is the
  // point: a grant may only ever be spent by the key the human actually authorized.
  it("BYPASS: mandates naming a DIFFERENT agent key → refused", async () => {
    const b = bounds();
    const req = await buildIntentSignRequest({ bounds: b, origin: ORIGIN, secret: SECRET, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    const swapped = JSON.parse(JSON.stringify(req.mandates)) as Record<string, unknown>[];
    for (const m of swapped) m.cnf = { jwk: { kty: "EC", crv: "P-256", x: "attacker-x", y: "attacker-y" } };
    const result = await devSimulateWalletSignature({ request: req, origin: ORIGIN.origin, overrideMandates: swapped });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
  });

  // Without this, "the holder signed it" means nothing: anyone could sign for anyone.
  it("BYPASS: a key binding signed by a key the credential does not name → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { forgeHolderKey: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/key-binding signature/);
  });

  // A presentation with no key binding authorizes nothing, and must not read as consent.
  it("BYPASS: a presentation with NO key binding → refused", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { omitKeyBinding: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/key-binding/);
  });

  it("BYPASS (b'): replaying the SAME succeeded presentation → refused (single-use nonce)", async () => {
    const b = bounds();
    const { req, result } = await signFor(b);
    const guard = memoryNonceGuard();
    const first = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: guard, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    const second = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: guard, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    // First succeeds; the replay is REFUSED — assert the outcome, not the reason string.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it("refuses a signature made over a DIFFERENT nonce (not this request)", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { overrideNonce: "a-different-nonce" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/nonce/);
  });

  it("refuses a wrong credential type", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { overrideVct: "org.iso.18013.5.1.mDL" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/wrong credential/);
  });

  it("refuses when the payment credential discloses no instrument id", async () => {
    const b = bounds();
    const { req, result } = await signFor(b, { omitInstrumentId: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
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
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
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
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), backend: delegated, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
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
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds({ budget: 2000 }), origin: ORIGIN, nonceGuard: memoryNonceGuard(), backend: delegated });
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
      origin: ORIGIN,
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
    return buildIntentSignRequest({ bounds: bounds(), origin: ORIGIN, secret: SECRET, delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS, ...over });
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
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds(), origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
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
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds(), origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out.ok).toBe(true);
    const { DELEGATE_PAYLOAD_CLAIM } = await import("./mandates.js");
    expect(DELEGATE_PAYLOAD_CLAIM).toBe("delegate_payload");
    expect(DELEGATE_PAYLOAD_CLAIM.startsWith("_")).toBe(false);
  });

  // BYPASS (the `typ` check in presentation.ts): a wallet that emits the ordinary `kb+jwt` has
  // not applied the delegation extension. That is the shape this rail shipped BEFORE #192, so
  // accepting it would let the non-conformant output keep passing.
  it("BYPASS: a plain `kb+jwt` key binding is refused", async () => {
    const { req, result } = await signFor(bounds(), { overrideKbTyp: "kb+jwt" });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds(), origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.reason).toContain("kb+jwt");
  });

  // BYPASS (the digest comparison): the pre-#192 shape put the mandate objects in the KB-JWT in
  // the clear. §7.1 says the KB-JWT carries their DIGEST. A verifier that accepts both cannot
  // tell a conformant wallet from a legacy one.
  it("BYPASS: mandates sent as plain objects instead of digests are refused", async () => {
    const { req, result } = await signFor(bounds(), { plainDelegatePayload: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds(), origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("mandate mismatch") });
  });

  // BYPASS (the "every expected digest" rule in delegatePayloadMatches): Multipaz keeps only the
  // LAST delegate entry's payload while hashing all of them (#192). The human would be shown two
  // authorizations and sign one. An equality check on LENGTH alone would not catch this.
  it("BYPASS: signing only the last `delegate` entry is refused", async () => {
    const { req, result } = await signFor(bounds(), { signOnlyLastEntry: true });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: bounds(), origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
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
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS, hashAlg: "sha-384" });
    expect(out.ok).toBe(true);
  });

  // …and the two sides must agree on WHICH algorithm. A verifier still checking sha-256 against
  // a sha-384 answer refuses, rather than comparing digests of different lengths and shrugging.
  it("BYPASS: a sha-384 answer does not satisfy a verifier expecting sha-256", async () => {
    const b = bounds();
    const req = await build({ hashAlg: "sha-384" });
    const result = await devSimulateWalletSignature({ request: req, origin: ORIGIN.origin });
    const out = await verifyIntentPresentation({ result, readerContextToken: req.readerContextToken, secret: SECRET, bounds: b, origin: ORIGIN, nonceGuard: memoryNonceGuard(), delegate: DELEGATE, mandateExp: MANDATE_EXP, allowedSkus: ALLOWED_SKUS });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("mandate mismatch") });
  });
});
