// `verifyMandate`'s refusal vocabulary, pinned token by token.
//
// Two things live here that the round-trip suite does not cover:
//
//   1. The REAL clock. `@sd-jwt/core` checks `iat` / `nbf` / `exp` itself, before our checks
//      run, so a clock or skew that never reaches it is a check that silently does not apply.
//      These tests pass no `nowMs` wherever the point is what the library sees.
//   2. One real token per library error message. The library reports every failure through one
//      exception type, so `verify.ts` names the failure from the message. A library upgrade
//      that rewords a message must turn a test red here, not quietly change the code a caller
//      switches on.
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { resolveSigningKey, type GateSigningKey } from "./keys.js";
import { Ap2Issuer, presentWithKeyBinding } from "./issue.js";
import { verifyMandate } from "./verify.js";
import { sdJwtInstance } from "./sdjwt.js";
import { amountFrom } from "./money.js";
import { VCT } from "./types.js";

const ORIGIN = "https://shop.example";
const nowSec = () => Math.floor(Date.now() / 1000);

/** Mint a payment-shaped mandate with exactly these claims, signed by the gate key. */
async function mint(key: GateSigningKey, claims: Record<string, unknown>, header: Record<string, unknown> = { kid: key.kid }) {
  return sdJwtInstance({ privateKey: key.privateKey }).issue(claims as never, undefined, { header });
}

const base = (key: GateSigningKey, over: Record<string, unknown> = {}) => ({
  iss: key.issuer,
  vct: VCT.payment,
  transaction_id: "tx",
  iat: nowSec(),
  exp: nowSec() + 900,
  ...over,
});

/** Replace the issuer JWT's header, keeping payload, signature and disclosures. */
function withHeader(token: string, header: Record<string, unknown>): string {
  const [jwt, ...rest] = token.split("~");
  const [, payload, sig] = jwt.split(".");
  const h = Buffer.from(JSON.stringify(header), "utf-8").toString("base64url");
  return [`${h}.${payload}.${sig}`, ...rest].join("~");
}

function holder() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  return { privateKey, cnf: { jwk: { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y } } };
}

describe("time claims, against the real clock", () => {
  it("labels a really-expired mandate `expired`, not `signature`", async () => {
    const key = resolveSigningKey(ORIGIN);
    const pay = await new Ap2Issuer(key).payment({
      transactionId: "tx",
      payee: { id: "shop.example", name: "Shop" },
      amount: amountFrom(1, "usd"),
      instrument: { id: "pi_1", type: "card" },
      ttlMs: -120_000, // expired two minutes ago — past the library's skew too
    });
    const v = await verifyMandate(pay.token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "expired" });
  });

  // The skew must reach the library. Without `skewSeconds` it refuses a mandate issued a few
  // seconds "in the future" — ordinary drift between two servers — before our own check runs.
  it("accepts a mandate issued 5 seconds in the future (clock drift)", async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = await mint(key, base(key, { iat: nowSec() + 5 }));
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v.ok).toBe(true);
  });

  it("refuses a mandate issued beyond the skew as `not-yet-valid` (bypass)", async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = await mint(key, base(key, { iat: nowSec() + 600 }));
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "not-yet-valid", detail: expect.stringMatching(/not yet valid/) });
  });

  it("refuses a future `nbf` as `not-yet-valid` (bypass)", async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = await mint(key, base(key, { nbf: nowSec() + 600 }));
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "not-yet-valid" });
  });

  // The injected clock must reach the library too: ten minutes after a one-second mandate, the
  // library itself refuses — and with `currentDate` dropped it would read the real clock and pass.
  it("an injected `nowMs` reaches the library's own expiry check", async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = await mint(key, base(key, { exp: nowSec() + 1 }));
    const v = await verifyMandate(token, { publicJwk: key.publicJwk, nowMs: Date.now() + 600_000 });
    expect(v).toMatchObject({ ok: false, code: "expired", detail: expect.stringMatching(/JWT is expired/) });
  });

  // Inside the library's skew window our own check still refuses: no tolerance on `exp`.
  it("allows no skew on `exp` (bypass)", async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = await mint(key, base(key, { exp: nowSec() - 10 }));
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "expired", detail: expect.stringMatching(/^exp=/) });
  });

  // A mandate with no `exp` would verify forever.
  it("refuses a mandate with no `exp` (bypass)", async () => {
    const key = resolveSigningKey(ORIGIN);
    const { exp: _omitted, ...claims } = base(key);
    const token = await mint(key, claims);
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "malformed", detail: expect.stringMatching(/no numeric `exp`/) });
  });

  it("refuses a non-numeric `exp` as `malformed`", async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = await mint(key, base(key, { exp: "tomorrow" }));
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "malformed", detail: expect.stringMatching(/must be a number/) });
  });
});

describe("who issued it", () => {
  it("refuses an `iss` that is not the key's DID (bypass)", async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = await mint(key, base(key, { iss: "did:web:evil.example" }));
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "issuer", detail: expect.stringMatching(/^iss=did:web:evil/) });
  });

  it("refuses a header `kid` that is not the key's (bypass)", async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = await mint(key, base(key), { kid: "did:web:evil.example#k" });
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "issuer", detail: expect.stringMatching(/^kid=/) });
  });

  it("refuses when there is no issuer to check against", async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = await mint(key, base(key));
    const { kid: _kid, ...anonymous } = key.publicJwk;
    const v = await verifyMandate(token, { publicJwk: anonymous });
    // Pin the detail: without the guard, the later `iss` comparison refuses with the same code.
    expect(v).toMatchObject({ ok: false, code: "issuer", detail: expect.stringMatching(/^no issuer to check/) });
  });

  it("accepts an explicit `issuer` for a key published without a `kid`", async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = await mint(key, base(key));
    const { kid: _kid, ...anonymous } = key.publicJwk;
    const v = await verifyMandate(token, { publicJwk: anonymous, issuer: key.issuer });
    expect(v.ok).toBe(true);
  });
});

describe("one real token per library message (a reworded message must turn this red)", () => {
  it('"Invalid JWT Signature" → signature', async () => {
    const key = resolveSigningKey(ORIGIN);
    const other = resolveSigningKey(ORIGIN);
    const token = await mint(key, base(key));
    const v = await verifyMandate(token, { publicJwk: other.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "signature", detail: expect.stringMatching(/Invalid JWT Signature/) });
  });

  // `allowedIssuerAlgorithms` refuses the header's `alg` before the signature is even tried.
  it('"Disallowed alg" → signature', async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = withHeader(await mint(key, base(key)), { alg: "ES384", typ: "dc+sd-jwt", kid: key.kid });
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "signature", detail: expect.stringMatching(/Disallowed alg ES384/) });
  });

  it('alg "none" → signature', async () => {
    const key = resolveSigningKey(ORIGIN);
    const token = withHeader(await mint(key, base(key)), { alg: "none", kid: key.kid });
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "signature", detail: expect.stringMatching(/"none" is not allowed/) });
  });

  it('"Missing required claim keys" → malformed', async () => {
    const key = resolveSigningKey(ORIGIN);
    const { vct: _vct, ...claims } = base(key);
    const token = await mint(key, claims);
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "malformed", detail: expect.stringMatching(/Missing required claim keys: vct/) });
  });

  it("garbage → malformed", async () => {
    const key = resolveSigningKey(ORIGIN);
    const v = await verifyMandate("not-a-token", { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "malformed" });
  });

  describe("on the key-binding hop", () => {
    async function openMandate(key: GateSigningKey, cnf: ReturnType<typeof holder>["cnf"]) {
      return new Ap2Issuer(key).openPayment({
        constraints: [{ type: "payment.reference", conditional_transaction_id: "oc" }],
        cnf,
        exp: nowSec() + 3600,
      });
    }

    it('"Invalid Nonce" → nonce', async () => {
      const key = resolveSigningKey(ORIGIN);
      const h = holder();
      const presented = await presentWithKeyBinding({ token: (await openMandate(key, h.cnf)).token, holderKey: h.privateKey, aud: ORIGIN, nonce: "n-1" });
      const v = await verifyMandate(presented, { publicJwk: key.publicJwk, audience: ORIGIN, nonce: "n-2" });
      expect(v).toMatchObject({ ok: false, code: "nonce", detail: expect.stringMatching(/Invalid Nonce/) });
    });

    it('"Invalid Key Binding audience" → audience', async () => {
      const key = resolveSigningKey(ORIGIN);
      const h = holder();
      const presented = await presentWithKeyBinding({ token: (await openMandate(key, h.cnf)).token, holderKey: h.privateKey, aud: ORIGIN, nonce: "n-1" });
      const v = await verifyMandate(presented, { publicJwk: key.publicJwk, audience: "https://evil.example", nonce: "n-1" });
      expect(v).toMatchObject({ ok: false, code: "audience", detail: expect.stringMatching(/Invalid Key Binding audience/) });
    });

    // The issuer signature is fine; the HOLDER's is not. Two-pass verification is what keeps
    // this from being reported as the issuer's `signature`.
    it("a hop signed by a key the `cnf` does not name → key-binding, not signature", async () => {
      const key = resolveSigningKey(ORIGIN);
      const owner = holder();
      const attacker = holder();
      const forged = await presentWithKeyBinding({ token: (await openMandate(key, owner.cnf)).token, holderKey: attacker.privateKey, aud: ORIGIN, nonce: "n-1" });
      const v = await verifyMandate(forged, { publicJwk: key.publicJwk, audience: ORIGIN, nonce: "n-1" });
      expect(v).toMatchObject({ ok: false, code: "key-binding", detail: expect.stringMatching(/Invalid JWT Signature/) });
    });

    // A KB-JWT lifted off one presentation and stapled to another mandate: its `sd_hash` no longer
    // covers the token it is attached to.
    it('"Invalid sd_hash" → key-binding (bypass)', async () => {
      const key = resolveSigningKey(ORIGIN);
      const h = holder();
      const a = await openMandate(key, h.cnf);
      const b = await openMandate(key, h.cnf);
      const presentedA = await presentWithKeyBinding({ token: a.token, holderKey: h.privateKey, aud: ORIGIN, nonce: "n-1" });
      const kbJwt = presentedA.slice(presentedA.lastIndexOf("~") + 1);
      const stapled = `${b.token}${kbJwt}`;
      const v = await verifyMandate(stapled, { publicJwk: key.publicJwk, audience: ORIGIN, nonce: "n-1" });
      expect(v).toMatchObject({ ok: false, code: "key-binding", detail: expect.stringMatching(/sd_hash/) });
    });
  });
});

// A mandate that names its holder's key in `cnf` is only meaningful when the holder proves they
// have it. Verified WITHOUT that proof, it is a bearer token: anyone holding a copy passes. The
// caller who forgets to ask for binding must be refused, not quietly handed `ok: true`.
describe("a holder-bound mandate", () => {
  async function openMandate() {
    const key = resolveSigningKey(ORIGIN);
    const h = holder();
    const open = await new Ap2Issuer(key).openPayment({
      constraints: [{ type: "payment.reference", conditional_transaction_id: "oc" }],
      cnf: h.cnf,
      exp: nowSec() + 3600,
    });
    return { key, token: open.token };
  }

  it("is refused when presented with no key binding (bypass)", async () => {
    const { key, token } = await openMandate();
    const v = await verifyMandate(token, { publicJwk: key.publicJwk });
    expect(v).toMatchObject({ ok: false, code: "key-binding", detail: expect.stringMatching(/names a holder key/) });
  });

  // The explicit way to read one — say, the issuer inspecting what it minted — is to opt out by name.
  it("can be read unbound only by opting out explicitly", async () => {
    const { key, token } = await openMandate();
    const v = await verifyMandate(token, { publicJwk: key.publicJwk, allowUnbound: true });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.keyBound).toBeUndefined();
  });
});

