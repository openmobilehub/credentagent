// THE verification door for AP2 mandates. One function, one refusal vocabulary.
//
// Why one door: the old code had three verification paths — a mock digest comparison, an
// HMAC check, and an ES256 draw check — each with its own idea of what "valid" meant. Three
// paths are three chances to fail open, and the one that failed open would be the one
// nobody re-read. Everything now arrives here.
//
// What a PASS from this file means, exactly: the bytes were signed by the key named, the
// mandate has not expired, and — when key-bound — the holder proved possession of the key
// its own `cnf` commits to. It does NOT mean the amount is right (re-price: security
// invariant 2), that the human agreed (that is `presence`), or that any credential behind
// it came from a real issuer (that is #14, still open).
import { splitSdJwt } from "@sd-jwt/core";
import { sdJwtInstance } from "./sdjwt.js";
import { verifyCompactJwt } from "./jwt.js";
import type { PublicJwkP256 } from "./keys.js";
import { VCT, type AnyMandate, type CheckoutMandate, type UcpCheckout, type Vct } from "./types.js";

/** Why a mandate was refused. Distinct from the draw-level `RefusalCode` on purpose:
 *  these are WIRE failures, and collapsing them into business refusals hides bugs. */
export type MandateRefusalCode =
  | "malformed" // not a parseable SD-JWT
  | "signature" // issuer signature does not verify against the expected key
  | "unexpected-type" // `vct` is not the mandate type the caller asked for
  | "expired" // `exp` has passed
  | "not-yet-valid" // `iat` is in the future beyond the clock-skew allowance
  | "key-binding" // the KB-JWT is missing, or not signed by the key `cnf` names
  | "audience" // the KB-JWT's `aud` is not this verifier
  | "nonce" // the KB-JWT's `nonce` is not the one we issued
  | "checkout-unbound"; // `checkout_jwt` does not hash to the mandate's `checkout_hash`

export interface MandateRefusal {
  ok: false;
  code: MandateRefusalCode;
  detail?: string;
}

export interface MandateVerdict<T extends AnyMandate> {
  ok: true;
  mandate: T;
  /** Present when the token carried a key-binding hop. */
  keyBound?: { aud: string; nonce: string };
}

export type VerifyResult<T extends AnyMandate> = MandateVerdict<T> | MandateRefusal;

/** Clocks disagree. One minute of tolerance on `iat`, none on `exp` — late is safe, early is not. */
const IAT_SKEW_SECONDS = 60;

export interface VerifyOptions {
  /** The issuer key the signature must verify against. */
  publicJwk: PublicJwkP256;
  /** Refuse anything whose `vct` is not this. Omit only when routing by type afterwards. */
  expect?: Vct;
  /** Required when the token is key-bound: who the KB-JWT must be addressed to. */
  audience?: string;
  /** Required when the token is key-bound: the nonce WE issued for this presentation. */
  nonce?: string;
  /** Epoch ms. Injectable so expiry is testable without faking the global clock. */
  nowMs?: number;
}

const refuse = (code: MandateRefusalCode, detail?: string): MandateRefusal => ({ ok: false, code, ...(detail ? { detail } : {}) });

/**
 * Verify one AP2 mandate.
 *
 * Fail-closed on every axis: an unparseable token, a bad signature, a wrong type, a passed
 * expiry, a key-binding hop we cannot check, or an audience/nonce mismatch all refuse. There
 * is no "valid but unverified" outcome, because callers reliably mistake one for the other.
 */
export async function verifyMandate<T extends AnyMandate = AnyMandate>(
  token: string,
  opts: VerifyOptions,
): Promise<VerifyResult<T>> {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const sdjwt = sdJwtInstance({ publicJwk: opts.publicJwk });

  // Whether a token is key-bound is a property of the TOKEN, read structurally — never of
  // what the verifier remembered to ask for. Deriving it from the verify result instead let
  // a key-bound presentation pass as an ordinary mandate whenever the caller forgot to
  // supply an audience: a stolen presentation would replay anywhere. Read it first, and make
  // the presence of a KB-JWT itself the thing that demands checking.
  let hasKeyBinding: boolean;
  try {
    hasKeyBinding = Boolean(splitSdJwt(token).kbJwt);
  } catch {
    return refuse("malformed", "not a compact SD-JWT");
  }

  if (hasKeyBinding && (!opts.audience || !opts.nonce)) {
    return refuse("key-binding", "token is key-bound but no audience/nonce was supplied to check it against");
  }
  if (!hasKeyBinding && (opts.audience || opts.nonce)) {
    return refuse("key-binding", "a key-bound presentation was required but the token carries no KB-JWT");
  }

  let payload: Record<string, unknown>;
  let kb: { payload: { aud: string; nonce: string } } | undefined;
  try {
    const result = await sdjwt.verify(token, {
      requiredClaimKeys: ["vct"],
      ...(hasKeyBinding ? { keyBindingNonce: opts.nonce, expectedKeyBindingAudience: opts.audience } : {}),
    });
    payload = result.payload as Record<string, unknown>;
    kb = result.kb as typeof kb;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The library reports an audience/nonce mismatch and a bad holder signature through the
    // same door. Name what we can from the message and fall back to `key-binding`, which is
    // the honest catch-all — never to a success.
    if (hasKeyBinding) {
      if (/audience/i.test(message)) return refuse("audience", message);
      if (/nonce/i.test(message)) return refuse("nonce", message);
      if (/key.?bind|kb/i.test(message)) return refuse("key-binding", message);
    }
    return refuse(token.includes(".") ? "signature" : "malformed", message);
  }

  // Belt and braces: the library verified the hop, and we re-read the claims it verified so
  // a future config change cannot silently stop checking them.
  if (hasKeyBinding) {
    if (!kb) return refuse("key-binding", "the KB-JWT was not returned by the verifier");
    if (kb.payload.aud !== opts.audience) return refuse("audience", `aud=${kb.payload.aud}`);
    if (kb.payload.nonce !== opts.nonce) return refuse("nonce", "key-binding nonce does not match the one issued");
  }

  if (opts.expect && payload.vct !== opts.expect) {
    return refuse("unexpected-type", `expected ${opts.expect}, got ${String(payload.vct)}`);
  }

  const exp = typeof payload.exp === "number" ? payload.exp : undefined;
  if (exp !== undefined && nowSec >= exp) return refuse("expired", `exp=${exp} now=${nowSec}`);

  const iat = typeof payload.iat === "number" ? payload.iat : undefined;
  if (iat !== undefined && iat > nowSec + IAT_SKEW_SECONDS) return refuse("not-yet-valid", `iat=${iat} now=${nowSec}`);

  return {
    ok: true,
    mandate: payload as unknown as T,
    ...(kb ? { keyBound: { aud: kb.payload.aud, nonce: kb.payload.nonce } } : {}),
  };
}

/**
 * Open the Checkout a Checkout Mandate wraps, re-checking the wrapper's own binding.
 *
 * The mandate carries both `checkout_jwt` and `checkout_hash`; a caller that reads the
 * line items straight out of the JWT without re-hashing has trusted an unbound blob. This
 * function is the only supported way in, so that mistake is not available.
 */
export async function openCheckoutPayload(
  mandate: CheckoutMandate,
  publicJwk: PublicJwkP256,
  digest: (token: string) => string,
): Promise<{ ok: true; checkout: UcpCheckout } | MandateRefusal> {
  if (!mandate.checkout_jwt) {
    return refuse("checkout-unbound", "checkout_jwt was not disclosed — cannot read the cart from a digest alone");
  }
  if (digest(mandate.checkout_jwt) !== mandate.checkout_hash) {
    return refuse("checkout-unbound", "checkout_jwt does not hash to checkout_hash");
  }
  const checkout = await verifyCompactJwt<UcpCheckout>(mandate.checkout_jwt, publicJwk);
  if (!checkout) return refuse("signature", "the wrapped Checkout JWT does not verify");
  return { ok: true, checkout };
}

/** Read a token's `vct` without verifying it — for routing only, never for a decision. */
export function peekVct(token: string): Vct | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf-8")) as { vct?: string };
    return (Object.values(VCT) as string[]).includes(claims.vct ?? "") ? (claims.vct as Vct) : undefined;
  } catch {
    return undefined;
  }
}
