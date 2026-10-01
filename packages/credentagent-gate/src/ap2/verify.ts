// THE verification door for AP2 mandates. One function, one refusal vocabulary.
//
// Why one door: the old code had three verification paths — a mock digest comparison, an
// HMAC check, and an ES256 draw check — each with its own idea of what "valid" meant. Three
// paths are three chances to fail open, and the one that failed open would be the one
// nobody re-read. Everything now arrives here.
//
// What a PASS from this file means, exactly: the bytes were signed by the key named, the
// mandate's `iss` / `kid` name that same key, it carries an `exp` that has not passed, and — when key-bound — the holder proved possession of the key
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
  | "malformed" // not a parseable SD-JWT, a non-numeric time claim, or no `exp` at all
  | "signature" // issuer signature does not verify against the expected key, or a disallowed `alg`
  | "issuer" // `iss` / header `kid` do not name the key the signature was checked against
  | "unexpected-type" // `vct` is not the mandate type the caller asked for
  | "expired" // `exp` has passed
  | "not-yet-valid" // `iat` / `nbf` is in the future beyond the clock-skew allowance
  | "key-binding" // the KB-JWT is missing, malformed, or not signed by the key `cnf` names
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

/** Clocks disagree. One minute of tolerance on `iat` / `nbf`, none on `exp` — late is safe,
 *  early is not. The library applies its skew to `exp` as well; our own `exp` check below
 *  runs after it with no skew, so the stricter rule is the one that decides. */
const IAT_SKEW_SECONDS = 60;

/** The only issuer algorithm this package signs with, so the only one it accepts. */
const ALLOWED_ALGS = ["ES256"];

export interface VerifyOptions {
  /** The issuer key the signature must verify against. Its `kid` (as `mount()` publishes it,
   *  or as {@link publicJwkFromDidDocument} returns it) also names the expected issuer. */
  publicJwk: PublicJwkP256;
  /** The DID the mandate's `iss` must equal. Defaults to the DID in `publicJwk.kid`; one of
   *  the two is required, because a signature that verifies says nothing about who CLAIMS to
   *  have issued it. */
  issuer?: string;
  /** Refuse anything whose `vct` is not this. Omit only when routing by type afterwards. */
  expect?: Vct;
  /** Required when the token is key-bound: who the KB-JWT must be addressed to. */
  audience?: string;
  /**
   * Required when the token is key-bound: the nonce WE issued for this presentation.
   *
   * This checks the nonce MATCHES; it does not remember it. The same presentation verifies
   * again if you pass the same nonce again — making a nonce single-use (consume it from your
   * store on first success) is the caller's job, per security invariant 6.
   */
  nonce?: string;
  /** Epoch ms. Injectable so expiry is testable without faking the global clock. */
  nowMs?: number;
}

const refuse = (code: MandateRefusalCode, detail?: string): MandateRefusal => ({ ok: false, code, ...(detail ? { detail } : {}) });

/**
 * Name an issuer-side failure from `@sd-jwt/core`'s message. The library reports every
 * failure as one exception type, so the message is all there is; `verify.test.ts` pins one
 * real token per message, so a library upgrade that rewords one turns a test red instead of
 * silently changing the code a caller switches on. Unknown messages fall to `signature` —
 * a refusal, never a pass.
 */
function issuerRefusal(message: string): MandateRefusal {
  if (/is expired/i.test(message)) return refuse("expired", message);
  if (/not yet valid/i.test(message)) return refuse("not-yet-valid", message);
  if (/must be a number|missing required claim|invalid sd jwt|invalid jwt/i.test(message) && !/signature/i.test(message)) {
    return refuse("malformed", message);
  }
  return refuse("signature", message);
}

/** Name a key-binding failure. Runs only after the issuer side has passed, so every failure
 *  here is the holder's hop — never mislabelled as the issuer's signature. */
function keyBindingRefusal(message: string): MandateRefusal {
  if (/audience/i.test(message)) return refuse("audience", message);
  if (/nonce/i.test(message)) return refuse("nonce", message);
  return refuse("key-binding", message);
}

/**
 * Verify one AP2 mandate.
 *
 * Fail-closed on every axis: an unparseable token, a bad signature, a disallowed `alg`, an
 * issuer that is not the key's, a wrong type, a missing or passed expiry, a key-binding hop
 * we cannot check, or an audience/nonce mismatch all refuse. There is no "valid but
 * unverified" outcome, because callers reliably mistake one for the other.
 */
export async function verifyMandate<T extends AnyMandate = AnyMandate>(
  token: string,
  opts: VerifyOptions,
): Promise<VerifyResult<T>> {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const sdjwt = sdJwtInstance({ publicJwk: opts.publicJwk });

  const expectedIssuer = opts.issuer ?? (opts.publicJwk.kid ? opts.publicJwk.kid.split("#")[0] : undefined);
  if (!expectedIssuer) {
    return refuse("issuer", "no issuer to check `iss` against — pass `issuer`, or a publicJwk carrying its `kid`");
  }

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

  // The library checks `iat` / `nbf` / `exp` itself, BEFORE anything below runs. Hand it OUR
  // clock and OUR skew: left to its defaults it read the real clock with zero tolerance, so an
  // injected `nowMs` never reached it, normal clock drift read as a bad signature, and a really
  // expired mandate came back labelled "signature".
  const libOptions = {
    requiredClaimKeys: ["vct"],
    currentDate: nowSec,
    skewSeconds: IAT_SKEW_SECONDS,
    allowedIssuerAlgorithms: ALLOWED_ALGS,
  };

  // Two passes, so a failure is named by the side that failed. Pass 1 is the issuer: signature,
  // `alg`, time claims, disclosures. Pass 2 adds the holder's hop; the issuer has already
  // passed, so anything it throws is the hop's fault.
  let payload: Record<string, unknown>;
  let header: Record<string, unknown> | undefined;
  try {
    const result = await sdjwt.verify(token, libOptions);
    payload = result.payload as Record<string, unknown>;
    header = result.header as Record<string, unknown> | undefined;
  } catch (err) {
    return issuerRefusal(err instanceof Error ? err.message : String(err));
  }

  let kb: { payload: { aud: string; nonce: string } } | undefined;
  if (hasKeyBinding) {
    try {
      const result = await sdjwt.verify(token, { ...libOptions, keyBindingNonce: opts.nonce, expectedKeyBindingAudience: opts.audience });
      kb = result.kb as typeof kb;
    } catch (err) {
      return keyBindingRefusal(err instanceof Error ? err.message : String(err));
    }
    // Belt and braces: the library verified the hop, and we re-read the claims it verified so
    // a future config change cannot silently stop checking them.
    if (!kb) return refuse("key-binding", "the KB-JWT was not returned by the verifier");
    if (kb.payload.aud !== opts.audience) return refuse("audience", `aud=${kb.payload.aud}`);
    if (kb.payload.nonce !== opts.nonce) return refuse("nonce", "key-binding nonce does not match the one issued");
  }

  // A signature that verifies proves who SIGNED; `iss` and `kid` are who the mandate says
  // issued it. They must agree, or a mandate can claim an issuer whose key never touched it.
  if (payload.iss !== expectedIssuer) return refuse("issuer", `iss=${String(payload.iss)} expected=${expectedIssuer}`);
  if (opts.publicJwk.kid && header?.kid !== opts.publicJwk.kid) {
    return refuse("issuer", `kid=${String(header?.kid)} expected=${opts.publicJwk.kid}`);
  }

  if (opts.expect && payload.vct !== opts.expect) {
    return refuse("unexpected-type", `expected ${opts.expect}, got ${String(payload.vct)}`);
  }

  // Every mandate `Ap2Issuer` mints carries `exp`. One without it would verify forever, so it
  // is refused rather than read as "never expires".
  if (typeof payload.exp !== "number") return refuse("malformed", "mandate carries no numeric `exp`");
  if (nowSec >= payload.exp) return refuse("expired", `exp=${payload.exp} now=${nowSec}`);

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
