// node --test spike/intent-mandate/intent-mandate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, contentAddressId, sealIntent, generateDelegate, signDraw, checkDraw } from "./intent-mandate.mjs";

const JUL15 = Date.parse("2026-07-15T12:00:00Z");

// A sealed intent + a valid in-bounds draw, signed by the delegate key. Each test mutates
// one thing and asserts exactly which gate refuses.
async function fixture() {
  const { privateKey, delegate } = await generateDelegate();
  const intent = await sealIntent({
    type: "attestomcp.IntentBounds/v0",
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
    trust_level: "issuer-verified (demo PKI)",
  });
  const draw = await signDraw(
    { type: "attestomcp.Draw/v0", intentId: intent.intentId, paymentMandateId: "draw_1", merchant: "runfast.example", amount: 40, currency: "USD", transactionId: "tx_1", presentments: ["membership:acme-loyalty"] },
    privateKey,
  );
  return { privateKey, delegate, intent, draw };
}
const codes = (r) => r.refusals.map((x) => x.code).sort();

test("content-addressing: intentId commits to every field; any edit re-hashes it", async () => {
  const { intent } = await fixture();
  assert.equal(intent.intentId.startsWith("int_"), true);
  assert.equal(await contentAddressId(intent), intent.intentId); // stable + omits the id field
  const tampered = { ...intent, maxAmount: 100000 };
  assert.notEqual(await contentAddressId(tampered), intent.intentId); // raising the cap orphans the id
});

test("canonical() is order-independent", () => {
  assert.equal(canonical({ b: 1, a: [3, { y: 2, x: 1 }] }), canonical({ a: [3, { x: 1, y: 2 }], b: 1 }));
});

test("an in-bounds draw passes all gates", async () => {
  const { intent, draw } = await fixture();
  const r = await checkDraw(intent, draw, { now: JUL15 });
  assert.deepEqual(r, { ok: true, refusals: [] });
});

test("over-cap: a draw above maxAmount is refused (co-fires over-total + step-up — a schema finding)", async () => {
  const { intent, draw, privateKey } = await fixture();
  const big = await signDraw({ ...draw, amount: 200, signature: undefined }, privateKey);
  // FINDING: with `stepUpOver ≤ maxAmount` (schema) and here `maxAmount == totalAmount`, an
  // over-cap draw NECESSARILY also trips over-total and step-up. over-cap can't fire alone.
  assert.deepEqual(codes(await checkDraw(intent, big, { now: JUL15 })), ["over-cap", "over-total", "step-up-required"]);
});

test("over-total: cumulative prior draws + this one exceed totalAmount", async () => {
  const { intent, draw } = await fixture();
  const prior = [{ amount: 100, transactionId: "tx_prev" }]; // 100 spent, cap 120, this draw 40 → 140
  assert.deepEqual(codes(await checkDraw(intent, draw, { now: JUL15, priorDraws: prior })), ["over-total"]);
});

test("window: before notBefore and after intentExpiry are refused", async () => {
  const { intent, draw } = await fixture();
  assert.deepEqual(codes(await checkDraw(intent, draw, { now: Date.parse("2026-06-01T00:00:00Z") })), ["before-window"]);
  assert.deepEqual(codes(await checkDraw(intent, draw, { now: Date.parse("2026-08-01T00:00:00Z") })), ["expired"]);
});

test("scope: a draw to a merchant not in the bounds is refused", async () => {
  const { intent, draw, privateKey } = await fixture();
  const off = await signDraw({ ...draw, merchant: "sketchy.example", signature: undefined }, privateKey);
  assert.deepEqual(codes(await checkDraw(intent, off, { now: JUL15 })), ["out-of-scope-merchant"]);
});

test("replay: reusing a transactionId is refused", async () => {
  const { intent, draw } = await fixture();
  const r = await checkDraw(intent, draw, { now: JUL15, priorDraws: [{ amount: 10, transactionId: "tx_1" }] });
  assert.deepEqual(codes(r), ["replay"]);
});

test("presentment: a credential not in mayPresent is refused (age is never delegable)", async () => {
  const { intent, draw, privateKey } = await fixture();
  const age = await signDraw({ ...draw, presentments: ["age:over-21"], signature: undefined }, privateKey);
  assert.deepEqual(codes(await checkDraw(intent, age, { now: JUL15 })), ["unpermitted-presentment"]);
});

test("step-up: a draw over stepUpOver is a RETRYABLE refusal (needs a human tap)", async () => {
  const { intent, draw, privateKey } = await fixture();
  const over = await signDraw({ ...draw, amount: 75, signature: undefined }, privateKey); // > stepUpOver 50, ≤ cap 120
  const r = await checkDraw(intent, over, { now: JUL15 });
  assert.deepEqual(codes(r), ["step-up-required"]);
  assert.equal(r.refusals[0].retryable, true);
});

test("bad-signature: tampering a signed draw's amount is refused (K_s covers the canonical draw)", async () => {
  const { intent, draw } = await fixture();
  const tampered = { ...draw, amount: 5 }; // edit AFTER signing → signature no longer matches
  assert.equal((await checkDraw(intent, tampered, { now: JUL15 })).refusals.some((x) => x.code === "bad-signature"), true);
});

test("bad-signature: a draw signed by a DIFFERENT key (not the delegate) is refused", async () => {
  const { intent, draw } = await fixture();
  const attacker = await generateDelegate();
  const forged = await signDraw({ ...draw, signature: undefined }, attacker.privateKey);
  assert.deepEqual(codes(await checkDraw(intent, forged, { now: JUL15 })), ["bad-signature"]);
});

test("multiple violations accumulate (typed refusal list, not first-fail)", async () => {
  const { intent, draw, privateKey } = await fixture();
  const bad = await signDraw({ ...draw, amount: 200, currency: "EUR", merchant: "sketchy.example", signature: undefined }, privateKey);
  const c = codes(await checkDraw(intent, bad, { now: JUL15 }));
  assert.deepEqual(c, ["currency-mismatch", "out-of-scope-merchant", "over-cap", "over-total", "step-up-required"]);
});
