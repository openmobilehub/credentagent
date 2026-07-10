// checkDraw bounds tests — the spike's 13 (spike/intent-mandate/intent-mandate.test.mjs)
// ported to the library surface, per 005 tasks T003. Each fixture mutation asserts
// EXACTLY which gate refuses (typed refusal codes, not first-fail).
import { describe, expect, it } from "vitest";
import {
  canonical,
  contentAddressId,
  sealIntent,
  generateDelegate,
  signDraw,
  checkDraw,
  type IntentBounds,
  type Draw,
} from "./mandate.js";

const JUL15 = Date.parse("2026-07-15T12:00:00Z");

async function fixture() {
  const { privateKey, delegate } = await generateDelegate();
  const intent = await sealIntent({
    type: "credentagent.IntentBounds/v0",
    naturalLanguageDescription: "Buy Ghost 17 size 10, up to $120, until Jul 31, from approved stores",
    merchants: ["utopia-marketplace", "runfast.example"],
    skus: ["gtin:00195394069122"],
    currency: "USD",
    maxAmount: 120,
    totalAmount: 120,
    stepUpOver: 50,
    intentExpiry: "2026-07-31T23:59:59Z",
    notBefore: "2026-07-01T00:00:00Z",
    delegate,
    mayPresent: ["membership:acme-loyalty"],
    presence: "delegated",
    trust_level: "server-issued-demo",
  });
  const draw = await signDraw(
    {
      type: "credentagent.Draw/v0",
      intentId: intent.intentId,
      paymentMandateId: "draw_1",
      merchant: "runfast.example",
      amount: 40,
      currency: "USD",
      pspTransactionId: "tx_1",
      presentments: ["membership:acme-loyalty"],
    },
    privateKey,
  );
  return { privateKey, delegate, intent, draw };
}

const codes = (r: { refusals: { code: string }[] }) => r.refusals.map((x) => x.code).sort();

describe("intent bounds — content addressing + canonical form", () => {
  it("intentId commits to every field; any edit re-hashes it", async () => {
    const { intent } = await fixture();
    expect(intent.intentId.startsWith("int_")).toBe(true);
    expect(await contentAddressId(intent)).toBe(intent.intentId); // stable + omits the id field
    const tampered = { ...intent, maxAmount: 100000 };
    expect(await contentAddressId(tampered)).not.toBe(intent.intentId); // raising the cap orphans the id
  });

  it("canonical() is order-independent", () => {
    expect(canonical({ b: 1, a: [3, { y: 2, x: 1 }] })).toBe(canonical({ a: [3, { x: 1, y: 2 }], b: 1 }));
  });
});

describe("checkDraw — the deterministic gates", () => {
  it("an in-bounds draw passes all gates", async () => {
    const { intent, draw } = await fixture();
    const r = await checkDraw(intent, draw, { now: JUL15 });
    expect(r.ok).toBe(true);
    expect(r.refusals).toEqual([]);
  });

  it("over-cap: a draw above maxAmount is refused (co-fires over-total + step-up — the schema finding)", async () => {
    const { intent, draw, privateKey } = await fixture();
    const big = await signDraw({ ...draw, amount: 200 }, privateKey);
    // With stepUpOver ≤ maxAmount (schema) and maxAmount == totalAmount here, an over-cap
    // draw NECESSARILY also trips over-total and step-up — over-cap can't fire alone.
    expect(codes(await checkDraw(intent, big, { now: JUL15 }))).toEqual(["over-cap", "over-total", "step-up"]);
  });

  it("over-total: cumulative prior draws + this one exceed totalAmount", async () => {
    const { intent, draw } = await fixture();
    const prior = [{ amount: 100, pspTransactionId: "tx_prev" }]; // 100 spent, cap 120, this draw 40 → 140
    expect(codes(await checkDraw(intent, draw, { now: JUL15, priorDraws: prior }))).toEqual(["over-total"]);
  });

  it("window: before notBefore and after intentExpiry are refused", async () => {
    const { intent, draw } = await fixture();
    expect(codes(await checkDraw(intent, draw, { now: Date.parse("2026-06-01T00:00:00Z") }))).toEqual(["not-yet-valid"]);
    expect(codes(await checkDraw(intent, draw, { now: Date.parse("2026-08-01T00:00:00Z") }))).toEqual(["expired"]);
  });

  it("scope: a draw to a merchant not in the bounds is refused", async () => {
    const { intent, draw, privateKey } = await fixture();
    const off = await signDraw({ ...draw, merchant: "sketchy.example" }, privateKey);
    expect(codes(await checkDraw(intent, off, { now: JUL15 }))).toEqual(["out-of-scope"]);
  });

  it("replay: reusing a pspTransactionId is refused", async () => {
    const { intent, draw } = await fixture();
    const r = await checkDraw(intent, draw, { now: JUL15, priorDraws: [{ amount: 10, pspTransactionId: "tx_1" }] });
    expect(codes(r)).toEqual(["replay"]);
  });

  it("presentment: a credential not in mayPresent is refused (age is never delegable)", async () => {
    const { intent, draw, privateKey } = await fixture();
    const age = await signDraw({ ...draw, presentments: ["age:over-21"] }, privateKey);
    expect(codes(await checkDraw(intent, age, { now: JUL15 }))).toEqual(["unpermitted-presentment"]);
  });

  it("step-up: a draw over stepUpOver is a needs-human refusal", async () => {
    const { intent, draw, privateKey } = await fixture();
    const over = await signDraw({ ...draw, amount: 75 }, privateKey); // > stepUpOver 50, ≤ cap 120
    const r = await checkDraw(intent, over, { now: JUL15 });
    expect(codes(r)).toEqual(["step-up"]);
    expect(r.refusals[0]!.retryable).toBe("needs-human");
  });

  it("signature: tampering a signed draw's amount is refused (K_s covers the canonical draw)", async () => {
    const { intent, draw } = await fixture();
    const tampered = { ...draw, amount: 5 }; // edit AFTER signing → signature no longer matches
    const r = await checkDraw(intent, tampered, { now: JUL15 });
    expect(r.refusals.some((x) => x.code === "signature")).toBe(true);
  });

  it("signature: a draw signed by a DIFFERENT key (not the delegate) is refused", async () => {
    const { intent, draw } = await fixture();
    const attacker = await generateDelegate();
    const forged = await signDraw({ ...draw }, attacker.privateKey);
    expect(codes(await checkDraw(intent, forged, { now: JUL15 }))).toEqual(["signature"]);
  });

  it("intent-mismatch: a draw bound to a different intentId is refused", async () => {
    const { intent, draw, privateKey } = await fixture();
    const other = await signDraw({ ...draw, intentId: "int_other" }, privateKey);
    expect(codes(await checkDraw(intent, other, { now: JUL15 }))).toEqual(["intent-mismatch"]);
  });

  it("bounds-tampered: mutated bounds under a victim's intentId are refused (content-address integrity)", async () => {
    const { intent, draw } = await fixture();
    // The attack (Codex P1): keep the victim's intentId, but swap the delegate key to the
    // attacker's, raise the cap, and change the merchant — then sign the draw with the
    // ATTACKER's key. Signature/cap/scope all pass against the mutated bounds; only the
    // content-address self-check catches that these bounds never produced this intentId.
    const attacker = await generateDelegate();
    // Inflate every bound so the forged draw would sail through signature/cap/scope/window —
    // then the ONLY thing that can refuse it is the content-address integrity check.
    const tampered = { ...intent, maxAmount: 100000, totalAmount: 100000, stepUpOver: 100000, merchants: ["attacker.example"], delegate: attacker.delegate };
    const forged = await signDraw({ ...draw, merchant: "attacker.example", amount: 9999 }, attacker.privateKey);
    const r = await checkDraw(tampered, forged, { now: JUL15 });
    expect(r.ok).toBe(false);
    // load-bearing: bounds-tampered is the SOLE refusal — remove the check and this forged
    // draw (attacker's key, inflated cap + scope) would pass every other gate.
    expect(codes(r)).toEqual(["bounds-tampered"]);
  });

  it("multiple violations accumulate (typed refusal list, not first-fail)", async () => {
    const { intent, draw, privateKey } = await fixture();
    const bad = await signDraw({ ...draw, amount: 200, currency: "EUR", merchant: "sketchy.example" }, privateKey);
    expect(codes(await checkDraw(intent, bad, { now: JUL15 }))).toEqual([
      "currency-mismatch",
      "out-of-scope",
      "over-cap",
      "over-total",
      "step-up",
    ]);
  });

  it("every refusal is merchant-attributed typed data", async () => {
    const { intent, draw, privateKey } = await fixture();
    const bad = await signDraw({ ...draw, amount: 200 }, privateKey);
    const r = await checkDraw(intent, bad, { now: JUL15 });
    for (const ref of r.refusals) {
      expect(ref.enforcer).toBe("merchant");
      expect(["retry", "needs-human", "terminal"]).toContain(ref.retryable);
    }
  });
});

// Type-level: IntentBounds/Draw are exported, usable shapes.
const _typecheck: (i: IntentBounds, d: Draw) => string = (i, d) => i.intentId + d.pspTransactionId;
void _typecheck;
