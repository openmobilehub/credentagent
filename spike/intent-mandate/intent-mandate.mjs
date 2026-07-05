// Design spike (HNP / 005) — the Intent Mandate bounds model + the deterministic draw
// gates, validating `specs/005-human-not-present/intent-bounds-schema-draft.md`.
//
// This is a SPIKE — a runnable reference to de-risk the hardest 005 modeling before the
// formal build; it is NOT shipped production code and does not touch the packages. It
// prototypes the top of the "Russian doll": the user-signs BOUNDS (cap / cumulative cap /
// window / scope / delegate key), and each DRAW (a Payment Mandate) is checked in-bounds
// server-side on every action (§4/§9 of the connector design).
//
// Honesty: the wire crypto is REAL (ES256 over the canonical draw; content-addressed
// intentId over SHA-256). What's fictitious in the demo is the PKI + the money — not the
// bounds enforcement, which is deterministic and total.
import { webcrypto } from "node:crypto";
const { subtle } = webcrypto;

const enc = new TextEncoder();
const b64url = (buf) => Buffer.from(buf).toString("base64url");

// ── Canonical JSON (stable, recursive key sort) — the bytes we hash + sign. Any edit to
// any field changes these bytes, so a signature/hash over them covers the whole document.
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

// ── Content-addressing: intentId = "int_" + b64url(SHA-256(canonical(bounds \ intentId))).
// No circularity (the id field is omitted from the hash), and it transitively commits to
// EVERY other field — delegate key, skus, honesty labels included.
export async function contentAddressId(bounds) {
  const { intentId: _omit, ...rest } = bounds;
  const digest = await subtle.digest("SHA-256", enc.encode(canonical(rest)));
  return "int_" + b64url(digest);
}
export async function sealIntent(boundsWithoutId) {
  return { ...boundsWithoutId, intentId: await contentAddressId(boundsWithoutId) };
}

// ── The delegate key K_s (the ONLY key that may sign draws). ES256 (P-256).
export async function generateDelegate() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = await subtle.exportKey("jwk", pair.publicKey);
  // The bounds doc's `delegate` is the PUBLIC JWK (kty/crv/x/y).
  return { privateKey: pair.privateKey, delegate: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y } };
}
export async function signDraw(draw, privateKey) {
  const { signature: _omit, ...unsigned } = draw;
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(canonical(unsigned)));
  return { ...unsigned, signature: b64url(sig) };
}
async function verifyDrawSignature(draw, delegateJwk) {
  try {
    const { signature, ...unsigned } = draw;
    if (typeof signature !== "string") return false;
    const key = await subtle.importKey("jwk", { ...delegateJwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(signature, "base64url"), enc.encode(canonical(unsigned)));
  } catch {
    return false;
  }
}

// ── THE DETERMINISTIC GATES: is this draw in-bounds? Returns a TYPED refusal list (§9) —
// every failure a machine-readable reason, so the surface can act on it (retryable = the
// agent can step up + retry; enforcer = a hard stop). `now`/`priorDraws` are injected so
// the check is pure + testable. Never throws.
export async function checkDraw(intent, draw, { now = Date.now(), priorDraws = [] } = {}) {
  const refusals = [];
  const fail = (code, extra = {}) => refusals.push({ code, ...extra });

  // 1. binds to THIS intent
  if (draw.intentId !== intent.intentId) fail("intent-mismatch", { enforcer: true });

  // 2. signed by the delegate key named in the (content-addressed, DeviceKey-covered) bounds
  if (!(await verifyDrawSignature(draw, intent.delegate))) fail("bad-signature", { enforcer: true });

  // 3. currency
  if (draw.currency !== intent.currency) fail("currency-mismatch", { enforcer: true, expected: intent.currency, got: draw.currency });

  // 4. per-draw cap (TS12 max_amount)
  if (draw.amount > intent.maxAmount) fail("over-cap", { enforcer: true, cap: intent.maxAmount, amount: draw.amount });

  // 5. cumulative cap (TS12 total_amount) — sum of prior committed draws + this one
  const spent = priorDraws.reduce((s, d) => s + d.amount, 0);
  if (spent + draw.amount > intent.totalAmount) fail("over-total", { enforcer: true, total: intent.totalAmount, wouldBe: spent + draw.amount });

  // 6. window (notBefore ≤ now ≤ intentExpiry)
  if (intent.notBefore && now < Date.parse(intent.notBefore)) fail("before-window", { enforcer: true, notBefore: intent.notBefore });
  if (intent.intentExpiry && now > Date.parse(intent.intentExpiry)) fail("expired", { enforcer: true, intentExpiry: intent.intentExpiry });

  // 7. scope — merchant (absent list ⇒ any suitable merchant)
  if (Array.isArray(intent.merchants) && intent.merchants.length > 0 && !intent.merchants.includes(draw.merchant)) {
    fail("out-of-scope-merchant", { enforcer: true, merchant: draw.merchant });
  }

  // 8. replay guard — the PSP transactionId is fresh + single-use
  if (priorDraws.some((d) => d.transactionId === draw.transactionId)) fail("replay", { enforcer: true, transactionId: draw.transactionId });

  // 9. presentment bundle ⊆ mayPresent (§16). Age is NEVER delegable → never in mayPresent.
  for (const p of draw.presentments ?? []) {
    if (!(intent.mayPresent ?? []).includes(p)) fail("unpermitted-presentment", { enforcer: true, presentment: p });
  }

  // 10. step-up: a draw over the presence-required threshold needs a fresh human tap — a
  // RETRYABLE refusal (the agent surfaces an approve link, the human taps, the draw retries).
  if (typeof intent.stepUpOver === "number" && draw.amount > intent.stepUpOver) {
    fail("step-up-required", { retryable: true, threshold: intent.stepUpOver });
  }

  return { ok: refusals.length === 0, refusals };
}
