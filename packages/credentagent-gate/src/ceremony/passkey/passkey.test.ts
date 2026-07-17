// Bypass/contract tests for the passkey payment rail (US2) — the most-real rail
// (genuine WebAuthn attestation + nonce/replay + origin binding). Every assertion
// pins a security control and FAILS if that control is removed:
//   CT6 — the four deterministic gates run (amount integrity, authorization
//         present, user verification asserted, subject/credential binding); a
//         REPLAYED/forged or EXPIRED challenge is rejected (sealed, time-limited
//         nonce — invariant 6); a mismatched origin/RP-ID is rejected (WebAuthn
//         bound to this server's origin — invariant 6).
//   CT7 — a tampered amount is refused by the amount-integrity gate, the order
//         re-priced from the injected catalog (never the token — invariant 2).
//   CT11 — the page + verify receipt state trust_level "presence-only-demo"
//         (Principle VII / FR-011); the gate is never a real safety control.
//
// The WebAuthn ceremony exercised here is a real registration assertion produced by
// a SOFTWARE AUTHENTICATOR fixture (built in-process below) — a self-contained,
// deterministic stand-in for a recorded browser ceremony (adapted from the demo's
// payment-gate/passkey/verify.fixture.test.ts, which loads a recorded JSON). It is
// a genuine "none"-attestation registration so @simplewebauthn/server verifies it
// for real (challenge, origin, rpID, UV) — the crypto path is NOT mocked.
//
// Load-bearing verification (mutate → test fails → revert) was confirmed for each
// control: removing the amount-integrity re-sum (gate 1) fails CT7; dropping the
// expectedOrigin/expectedRPID binding fails the origin/RP-ID test; removing the
// challenge-token signature/expiry check fails the replay/expiry tests.

import { describe, it, expect, vi } from "vitest";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import express, { type Express } from "express";
import request from "supertest";
import { mountCeremony, resolveOrder, type CeremonyContext, type CeremonySeams } from "../mount.js";
import { completeOrder, type CompletedRecord, type CompletionContext } from "../completion.js";
import { MemoryVerificationStore } from "../../store.js";
import { buildPasskeyMandate, runGates, type VerifiedAuthenticator } from "../mandate.js";
import { buildRegistrationOptions, verifyPasskeyAssertion } from "./verify.js";
import { renderPasskeyPage } from "./page.js";
import { issueChallenge } from "../challengeToken.js";
import type { CeremonyCatalog, CeremonyOrder, CompletionInput } from "../types.js";

// ── Catalog (source of truth for price + age restriction) ─────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const PRODUCTS: Record<string, { price: number; minimumAge?: number }> = {
  "oak-whiskey": { price: 124, minimumAge: 21 },
  "aurora-headphones": { price: 199 },
};

const catalog: CeremonyCatalog = {
  createOrder(items, orderId, opts) {
    const lines = items.map((it) => {
      const p = PRODUCTS[it.productId] ?? { price: 0 };
      return {
        id: it.productId,
        name: it.productId,
        unitPrice: p.price,
        currency: "USD",
        quantity: it.quantity,
        lineTotal: p.price * it.quantity,
        ...(p.minimumAge ? { minimumAge: p.minimumAge } : {}),
      };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const discount = opts?.loyaltyApplied ? round2(subtotal * 0.1) : 0;
    const total = round2(subtotal - discount);
    return { id: orderId, lines, itemCount: lines.reduce((s, l) => s + l.quantity, 0), subtotal, discount, total, currency: "USD", createdAt: new Date().toISOString() };
  },
};

// ── Software-authenticator fixture (a real "none"-attestation registration) ───
// Builds the minimal valid WebAuthn registration @simplewebauthn/server accepts:
// a P-256/ES256 COSE key in attested-credential authenticator data with UP|UV|AT
// flags, an empty "none" attestation statement, and clientDataJSON bound to the
// given challenge + origin. Deterministic and self-contained — no browser needed.

function cborHead(major: number, len: number): Buffer {
  const mt = major << 5;
  if (len < 24) return Buffer.from([mt | len]);
  if (len < 256) return Buffer.from([mt | 24, len]);
  if (len < 65536) {
    const b = Buffer.from([mt | 25, 0, 0]);
    b.writeUInt16BE(len, 1);
    return b;
  }
  const b = Buffer.from([mt | 26, 0, 0, 0, 0]);
  b.writeUInt32BE(len, 1);
  return b;
}
const cborInt = (n: number): Buffer => (n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n));
const cborBytes = (buf: Buffer): Buffer => Buffer.concat([cborHead(2, buf.length), buf]);
const cborText = (s: string): Buffer => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([cborHead(3, b.length), b]);
};
const cborMap = (pairs: [Buffer, Buffer][]): Buffer =>
  Buffer.concat([cborHead(5, pairs.length), ...pairs.flatMap(([k, v]) => [k, v])]);

interface RegistrationFixture {
  response: Record<string, unknown>;
  credId: Buffer;
}

function makeRegistration(args: { challenge: string; origin: string; rpID: string }): RegistrationFixture {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  // COSE_Key for EC2 / ES256 (kty=2, alg=-7, crv=1=P-256, x, y).
  const cose = cborMap([
    [cborInt(1), cborInt(2)],
    [cborInt(3), cborInt(-7)],
    [cborInt(-1), cborInt(1)],
    [cborInt(-2), cborBytes(x)],
    [cborInt(-3), cborBytes(y)],
  ]);

  const rpIdHash = createHash("sha256").update(args.rpID).digest();
  const flags = Buffer.from([0x45]); // UP (0x01) | UV (0x04) | AT (0x40)
  const signCount = Buffer.from([0, 0, 0, 0]);
  const aaguid = Buffer.alloc(16, 0);
  const credId = randomBytes(16);
  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(credId.length, 0);
  const authData = Buffer.concat([rpIdHash, flags, signCount, aaguid, credIdLen, credId, cose]);

  const attestationObject = cborMap([
    [cborText("fmt"), cborText("none")],
    [cborText("attStmt"), cborHead(5, 0)], // empty map
    [cborText("authData"), cborBytes(authData)],
  ]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.create", challenge: args.challenge, origin: args.origin, crossOrigin: false }),
    "utf8",
  );

  return {
    credId,
    response: {
      id: credId.toString("base64url"),
      rawId: credId.toString("base64url"),
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: attestationObject.toString("base64url"),
        transports: ["internal"],
      },
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    },
  };
}

// ── Harness ───────────────────────────────────────────────────────────────────

const SIGNING_KEY = "stable-test-secret";
const HOST = "shop.example";
const ORIGIN = `https://${HOST}`;

interface Harness {
  app: Express;
  ctx: CeremonyContext;
  verificationStore: MemoryVerificationStore;
  records: Map<string, CompletedRecord>;
  seed: (id: string, items: { id: string; quantity: number }[], tamperedTotal?: number) => void;
}

function harness(): Harness {
  const verificationStore = new MemoryVerificationStore();
  const orders = new Map<string, CeremonyOrder>();
  const records = new Map<string, CompletedRecord>();
  // The injected completion seam IS the shared completeOrder (re-price + age gate +
  // idempotent record), so the rail never owns a second completion path.
  const completionCtx: CompletionContext = {
    catalog,
    verificationStore,
    records: { read: async (id) => records.get(id), write: async (rec) => void records.set(rec.orderId, rec) },
    cart: { clear: async () => {} },
  };
  const seams: CeremonySeams = {
    verificationStore,
    orderStore: { read: async (id) => orders.get(id) ?? null },
    catalog,
    completion: (input) => completeOrder(input, completionCtx),
    signingKey: SIGNING_KEY,
  };
  const app = express();
  const ctx = mountCeremony(app as never, seams);
  function seed(id: string, items: { id: string; quantity: number }[], tamperedTotal?: number): void {
    const priced = catalog.createOrder(items.map((i) => ({ productId: i.id, quantity: i.quantity })), id);
    orders.set(id, tamperedTotal != null ? { ...priced, total: tamperedTotal, subtotal: tamperedTotal } : priced);
  }
  return { app, ctx, verificationStore, records, seed };
}

// Drive the real ceremony end-to-end through the mount()-served routes for one order.
async function authorize(h: Harness, orderId: string, opts: { host?: string; proto?: string } = {}) {
  const host = opts.host ?? HOST;
  const proto = opts.proto ?? "https";
  const optRes = await request(h.app)
    .get("/credentagent/passkey/options")
    .set("X-Forwarded-Host", host)
    .set("X-Forwarded-Proto", proto);
  const { options, challengeToken } = optRes.body as { options: { challenge: string }; challengeToken: string };
  // Build the assertion bound to the SAME origin/rpID the options were issued for.
  const fixture = makeRegistration({ challenge: options.challenge, origin: `${proto}://${host}`, rpID: host });
  return request(h.app)
    .post("/credentagent/passkey/verify")
    .set("X-Forwarded-Host", host)
    .set("X-Forwarded-Proto", proto)
    .send({ response: fixture.response, challengeToken, order: orderId });
}

// ── CT6 — four gates run; nonce + origin/RP-ID binding ────────────────────────

describe("CT6 — the four deterministic gates run on a real passkey ceremony", () => {
  it("authorizes an order: four gates pass, mandate produced, recorded idempotently", async () => {
    const h = harness();
    h.seed("ORD-P", [{ id: "aurora-headphones", quantity: 1 }]);
    const res = await authorize(h, "ORD-P");
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
    expect(res.body.gates.map((g: { gate: string }) => g.gate)).toEqual([
      "Amount integrity",
      "Authorization present",
      "User verification",
      "Subject binding",
    ]);
    expect(res.body.gates.every((g: { pass: boolean }) => g.pass)).toBe(true);
    expect(res.body.mandate.trust_level).toBe("presence-only-demo");
    expect(h.records.get("ORD-P")?.amount).toBe(199);
  });

  it("a replayed verify is idempotent — it records/settles nothing twice", async () => {
    const h = harness();
    h.seed("ORD-P", [{ id: "aurora-headphones", quantity: 1 }]);
    await authorize(h, "ORD-P");
    // A second ceremony for the same order completes (echoes) but does not re-record.
    const again = await authorize(h, "ORD-P");
    expect(again.body.completed).toBe(true);
    expect(h.records.size).toBe(1);
  });

  it("REJECTS a forged/tampered challenge token (sealed HMAC nonce — invariant 6)", async () => {
    const h = harness();
    h.seed("ORD-P", [{ id: "aurora-headphones", quantity: 1 }]);
    const optRes = await request(h.app).get("/credentagent/passkey/options").set("X-Forwarded-Host", HOST).set("X-Forwarded-Proto", "https");
    const { options, challengeToken } = optRes.body as { options: { challenge: string }; challengeToken: string };
    const fixture = makeRegistration({ challenge: options.challenge, origin: ORIGIN, rpID: HOST });
    // Flip the signature segment of the token — the HMAC seal must reject it.
    const forged = challengeToken.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    const res = await request(h.app)
      .post("/credentagent/passkey/verify")
      .set("X-Forwarded-Host", HOST)
      .set("X-Forwarded-Proto", "https")
      .send({ response: fixture.response, challengeToken: forged, order: "ORD-P" });
    expect(res.status).toBe(400);
    expect(res.body.completed).toBeFalsy();
    expect(h.records.size).toBe(0);
  });

  it("REJECTS an EXPIRED challenge (time-limited nonce — invariant 6)", async () => {
    vi.useFakeTimers();
    try {
      const { token } = issueChallenge(SIGNING_KEY);
      const fixture = makeRegistration({ challenge: "x", origin: ORIGIN, rpID: HOST });
      // Advance past the token TTL (120s) — verifyChallenge must throw before any
      // attestation parsing.
      vi.advanceTimersByTime(130_000);
      await expect(
        verifyPasskeyAssertion({ response: fixture.response as never, challengeToken: token, origin: { rpID: HOST, origin: ORIGIN }, secret: SIGNING_KEY }),
      ).rejects.toThrow(/expired/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("REJECTS a mismatched origin/RP-ID (WebAuthn bound to this server — invariant 6)", async () => {
    const h = harness();
    h.seed("ORD-P", [{ id: "aurora-headphones", quantity: 1 }]);
    // Issue options for shop.example, build the assertion bound to shop.example…
    const optRes = await request(h.app).get("/credentagent/passkey/options").set("X-Forwarded-Host", HOST).set("X-Forwarded-Proto", "https");
    const { options, challengeToken } = optRes.body as { options: { challenge: string }; challengeToken: string };
    const fixture = makeRegistration({ challenge: options.challenge, origin: ORIGIN, rpID: HOST });
    // …but POST verify under a DIFFERENT host, so the route derives evil.example.
    const res = await request(h.app)
      .post("/credentagent/passkey/verify")
      .set("X-Forwarded-Host", "evil.example")
      .set("X-Forwarded-Proto", "https")
      .send({ response: fixture.response, challengeToken, order: "ORD-P" });
    expect(res.status).toBe(400); // FAILS if origin/RP-ID binding is dropped
    expect(h.records.size).toBe(0);
  });

  it("the recorded fixture verifies for real through verifyPasskeyAssertion (crypto path is not mocked)", () => {
    const { challenge, token } = issueChallenge(SIGNING_KEY);
    const fixture = makeRegistration({ challenge, origin: ORIGIN, rpID: HOST });
    return expect(
      verifyPasskeyAssertion({ response: fixture.response as never, challengeToken: token, origin: { rpID: HOST, origin: ORIGIN }, secret: SIGNING_KEY }),
    ).resolves.toMatchObject({ userVerified: true });
  });
});

// ── CT7 — amount integrity; re-priced from the catalog, never the token ───────

describe("CT7 — a tampered amount is refused by the amount-integrity gate", () => {
  const AUTH: VerifiedAuthenticator = { credentialID: "cred-abc", userVerified: true, credentialDeviceType: "singleDevice", credentialBackedUp: false };

  it("the amount-integrity gate FAILS when the bound payment amount is tampered", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-T");
    const mandate = buildPasskeyMandate({ order, authenticator: AUTH, origin: { rpID: HOST, origin: ORIGIN } });
    // Tamper the authorized amount away from the re-summed line total.
    mandate.payment.amount = 1;
    const gates = runGates(mandate);
    const amountGate = gates.find((g) => g.gate === "Amount integrity")!;
    expect(amountGate.pass).toBe(false); // FAILS if gate 1 stopped re-summing the lines
    // The other three gates still pass — only amount integrity catches the tamper.
    expect(gates.filter((g) => g.gate !== "Amount integrity").every((g) => g.pass)).toBe(true);
  });

  it("a clean order passes the amount-integrity gate (the control is not a blanket refusal)", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-OK");
    const mandate = buildPasskeyMandate({ order, authenticator: AUTH, origin: { rpID: HOST, origin: ORIGIN } });
    expect(runGates(mandate).find((g) => g.gate === "Amount integrity")!.pass).toBe(true);
  });

  it("resolveOrder re-prices a hand-edited (tampered) stored total from the catalog, never the token", async () => {
    const h = harness();
    h.seed("ORD-T", [{ id: "aurora-headphones", quantity: 1 }], /* tamperedTotal */ 1);
    const order = await resolveOrder(h.ctx, "ORD-T");
    expect(order?.total).toBe(199); // the catalog wins over the $1 the token claimed
    // The page reflects the catalog amount, not the token's.
    const page = await request(h.app).get("/credentagent/passkey").query({ order: "ORD-T" });
    expect(page.status).toBe(200);
    expect(page.text).toContain("199");
  });

  it("the verify route binds the re-priced amount end-to-end (a passkey ceremony pays the catalog total)", async () => {
    const h = harness();
    h.seed("ORD-T", [{ id: "aurora-headphones", quantity: 1 }], /* tamperedTotal */ 1);
    const res = await authorize(h, "ORD-T");
    expect(res.body.completed).toBe(true);
    expect(res.body.mandate.payment.amount).toBe(199); // bound to the catalog total
    expect(res.body.binding.amount).toBe(199);
    expect(h.records.get("ORD-T")?.amount).toBe(199);
  });
});

// ── Cross-device (caBLE) toggle bound to the derived origin/RP-ID ──────────────

describe("cross-device (?xdev=1) ceremony", () => {
  it("options?xdev=1 pin a cross-platform (roaming/caBLE) authenticator and still bind the origin/RP-ID", async () => {
    const h = harness();
    const res = await request(h.app).get("/credentagent/passkey/options?xdev=1").set("X-Forwarded-Host", HOST).set("X-Forwarded-Proto", "https");
    expect(res.status).toBe(200);
    expect(res.body.options.rp.id).toBe(HOST); // bound to this server's RP-ID
    expect(res.body.options.authenticatorSelection.authenticatorAttachment).toBe("cross-platform");
    expect(typeof res.body.challengeToken).toBe("string");
  });

  it("the page renders the cross-device toggle on ?xdev=1", async () => {
    const h = harness();
    h.seed("ORD-X", [{ id: "aurora-headphones", quantity: 1 }]);
    const res = await request(h.app).get("/credentagent/passkey").query({ order: "ORD-X", xdev: "1" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Use this device instead"); // shown only in cross-device mode
  });
});

// ── CT11 — presence-only honesty on every surface ─────────────────────────────

describe("CT11 — page + receipt state presence-only-demo (not a real safety control)", () => {
  it("the rendered passkey page states trust_level presence-only-demo", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-A");
    expect(renderPasskeyPage({ order })).toContain("presence-only-demo");
  });

  it("the completed receipt links FORWARD to the checkout hub (no browser-back onto a stale, re-payable checkout)", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-RET");
    const html = renderPasskeyPage({ order });
    // The return URL is the checkout hub for THIS order, so completion routes the
    // buyer forward (fresh GET → paid state) rather than back into bfcache.
    expect(html).toContain("/checkout?order=ORD-RET");
    expect(html).toContain("Return to checkout");
    // An explicit override is honored (the committed demo can re-home the link).
    expect(renderPasskeyPage({ order, returnUrl: "/demo/checkout?order=ORD-RET" })).toContain("/demo/checkout?order=ORD-RET");
  });

  it("renders the indeterminate settling bar (the ~10s x402 on-chain wait reads as live work)", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-BAR");
    const html = renderPasskeyPage({ order });
    expect(html).toContain('id="settling"');
    expect(html).toContain("settling-bar");
    expect(html).toContain('settling.classList.add("on")');
  });

  it("on completion, prominently states the order is complete + the close-window / continue-in-agent handoff", () => {
    const order = catalog.createOrder([{ productId: "aurora-headphones", quantity: 1 }], "ORD-DONE");
    const html = renderPasskeyPage({ order });
    // The prominent end-of-ceremony banner is embedded for the receipt script to show
    // once every gate + payment is done (Mode A: the agent polls + resumes).
    expect(html).toContain("complete-banner");
    expect(html).toContain("Order complete");
    expect(html).toContain("close this window");
    expect(html).toContain("continue in your agent");
  });

  it("the verify receipt carries trust_level presence-only-demo", async () => {
    const h = harness();
    h.seed("ORD-P", [{ id: "aurora-headphones", quantity: 1 }]);
    const res = await authorize(h, "ORD-P");
    expect(res.body.trust_level).toBe("presence-only-demo");
    expect(res.body.mandate.trust_level).toBe("presence-only-demo");
  });
});

// ── Unknown / tampered order id is refused at the page + verify routes ─────────

describe("unknown order id is refused (CT3 alignment)", () => {
  it("the page 404s an unknown order id", async () => {
    const h = harness();
    const res = await request(h.app).get("/credentagent/passkey").query({ order: "ORD-UNKNOWN" });
    expect(res.status).toBe(404);
  });

  it("the verify handler refuses an unknown order id (400)", async () => {
    const h = harness();
    const optRes = await request(h.app).get("/credentagent/passkey/options").set("X-Forwarded-Host", HOST).set("X-Forwarded-Proto", "https");
    const { options, challengeToken } = optRes.body as { options: { challenge: string }; challengeToken: string };
    const fixture = makeRegistration({ challenge: options.challenge, origin: ORIGIN, rpID: HOST });
    const res = await request(h.app)
      .post("/credentagent/passkey/verify")
      .set("X-Forwarded-Host", HOST)
      .set("X-Forwarded-Proto", "https")
      .send({ response: fixture.response, challengeToken, order: "ORD-UNKNOWN" });
    expect(res.status).toBe(400);
  });
});

// ── @simplewebauthn/browser ESM served same-origin (T017) ─────────────────────

describe("serves @simplewebauthn/browser ESM same-origin at /credentagent/lib/sw/*", () => {
  it("GET /credentagent/lib/sw/index.js returns the ESM module as JavaScript", async () => {
    const h = harness();
    const res = await request(h.app).get("/credentagent/lib/sw/index.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.text).toMatch(/startRegistration/);
  });

  it("does not escape the served ESM directory (path traversal is refused)", async () => {
    const h = harness();
    const res = await request(h.app).get("/credentagent/lib/sw/../../package.json");
    expect(res.status).not.toBe(200);
  });
});

// ── #46 — the passkey PAYMENT rail is order-derived, never a hardcoded Age ✓ · Membership ✓ ──
// The passkey page shipped the same phantom-gate rail the dc-payment fix removed; this is
// the sibling that PR #62's review caught. Same bypass shape: fails against the old literal.
function passkeyRailLabels(html: string): string[] {
  return [...html.matchAll(/rail-label">([^<]+)</g)].map((m) => m[1]);
}
function passkeyAgeStepDone(html: string): boolean {
  const m = html.match(/rail-step ([a-z]*)"><div class="rail-dot">([^<]+)<\/div><div class="rail-label">Age</);
  return !!m && m[1] === "done" && m[2] === "✓";
}

describe("#46 — passkey rail reflects the order (no phantom gates / phantom ticks)", () => {
  it("a non-age, non-discounted order shows ONLY Pay — no phantom Age/Membership steps", async () => {
    const h = harness();
    h.seed("ORD-NOAGE", [{ id: "aurora-headphones", quantity: 1 }]); // unrestricted, no discount
    const res = await request(h.app).get("/credentagent/passkey").query({ order: "ORD-NOAGE" });
    expect(passkeyRailLabels(res.text)).toEqual(["Pay"]);
    expect(res.text).not.toContain('rail-label">Age');
    expect(res.text).not.toContain('rail-label">Membership');
  });

  it("an age-restricted order shows Age PENDING until it is actually verified (no phantom ✓)", async () => {
    const h = harness();
    h.seed("ORD-AGE", [{ id: "oak-whiskey", quantity: 1 }]); // 21+
    const pending = await request(h.app).get("/credentagent/passkey").query({ order: "ORD-AGE" });
    expect(passkeyRailLabels(pending.text)).toEqual(["Age", "Pay"]);
    expect(passkeyAgeStepDone(pending.text)).toBe(false);
    await h.verificationStore.write("ORD-AGE", { ageVerified: true });
    const done = await request(h.app).get("/credentagent/passkey").query({ order: "ORD-AGE" });
    expect(passkeyAgeStepDone(done.text)).toBe(true);
  });

  it("flips the current (Pay) step to ✓ in the rail once the order completes", async () => {
    const h = harness();
    h.seed("ORD-DONE", [{ id: "oak-whiskey", quantity: 1 }]);
    const res = await request(h.app).get("/credentagent/passkey").query({ order: "ORD-DONE" });
    // checkoutRail renders the CURRENT step un-ticked (a highlighted number); on completion the
    // handler marks it done ✓ so the stepper agrees with the "Order complete" banner. Removing
    // the embed (railCompleteScript) drops this and Pay would stay a highlighted number.
    expect(res.text).toContain(".rail .rail-step.current");
    expect(res.text).toContain('classList.add("done")');
  });
});
