// The AP2 Mandate Content this rail asks a wallet to sign, derived from the SERVER's grant
// record — and the equality check that makes the signature mean something.
//
// WHAT REPLACED WHAT (spec 014). The rail used to fold the grant's bounds into the ceremony
// NONCE (`boundsHash` → `deriveNonce`) and rely on the wallet's mdoc DeviceAuth signature over
// a session transcript carrying it. That bound the signature to the bounds, but in a shape
// only this project could read. AP2 specifies the mechanism directly: the verifier puts the
// Mandate Content in an OpenID4VP `transaction_data` entry of type `delegate`, and the wallet
// returns it inside the Key Binding JWT. The user's key binding IS the authorization.
//
// THE SECURITY PROPERTY IS UNCHANGED, and it is the reason this file exists: the mandates are
// assembled here from the grant record and NOTHING the client sent, and `/verify` rebuilds
// them from that same record and requires what came back to be identical. A grant whose terms
// changed between /request and /verify therefore stops verifying, instead of silently riding a
// signature the human gave for different terms.
//
// HONESTY: a verified delegation proves the wallet holding that credential signed these
// mandates. It proves nothing about whether the credential came from a real card issuer —
// that is #14, and `trust_level` still says so.
import { createHash } from "node:crypto";
import { canonical } from "../mandate.js";
import { checkoutConstraintsFromGrant, paymentConstraintsFromGrant } from "../../ap2/from-gate.js";
import { VCT } from "../../ap2/types.js";
import type { IntentBoundsInput } from "./bounds.js";

/** The delegate public key (`K_s`) an open mandate names in `cnf` — the agent's key. */
export interface DelegateJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** One AP2 Mandate Content object, as it travels in `delegate_payload`. */
export type MandateContent = Record<string, unknown>;

/** The VDC format the returned Mandate must be in. AP2's `format` member. */
export const DELEGATE_FORMAT = "dc+sd-jwt";

/** The KB-JWT claim carrying the signed Mandate Content (Delegate SD-JWT). */
export const DELEGATE_PAYLOAD_CLAIM = "_delegate_payload";

/**
 * Digest of a Mandate Content object, over its canonical encoding.
 *
 * Used for `payment.reference`, which is how AP2 ties the two halves of a grant together: the
 * payment authority is only valid for the checkout authority whose digest it names. Both
 * halves travel inside ONE key binding here, so they are already bound by that signature —
 * but naming the digest keeps the pair readable on its own, and keeps the constraint AP2
 * requires present rather than omitted for convenience.
 */
function contentDigest(content: MandateContent): string {
  return createHash("sha256").update(canonical(content)).digest("base64url");
}

/**
 * The two "open" mandates for a grant: what the agent may buy, and how much it may spend.
 *
 * Deterministic in its inputs — the same grant record and delegate key always produce the same
 * bytes. That is what lets `/verify` rebuild them and compare.
 *
 * `exp` is an absolute epoch-seconds expiry. It comes from the grant's own validity window
 * when it has one; a caller must pass it rather than have this file invent a lifetime, because
 * an expiry the human never saw is a term they never agreed to.
 */
export function openMandatesForGrant(args: {
  bounds: IntentBoundsInput;
  /** The gate's origin — the merchant identity the constraints name. */
  origin: string;
  /** The agent's public key. AP2 binds an open mandate to the agent allowed to use it. */
  delegate: DelegateJwk;
  /** Absolute expiry, epoch seconds. */
  exp: number;
}): MandateContent[] {
  const { bounds, origin, delegate, exp } = args;
  const grantBounds = {
    merchant: bounds.merchant,
    budget: bounds.budget,
    perSpend: bounds.perSpend,
    currency: "USD",
    skus: bounds.allow?.skus ?? [],
  };

  const checkout: MandateContent = {
    vct: VCT.openCheckout,
    constraints: checkoutConstraintsFromGrant(grantBounds, origin),
    cnf: { jwk: delegate },
    exp,
  };

  const payment: MandateContent = {
    vct: VCT.openPayment,
    constraints: paymentConstraintsFromGrant(grantBounds, origin, contentDigest(checkout)),
    cnf: { jwk: delegate },
    exp,
  };

  return [checkout, payment];
}

/**
 * Does what the wallet signed match what the server asked it to sign?
 *
 * Compared over the canonical encoding, so a wallet that re-serialized the JSON with different
 * key order or spacing still matches — while any change to a VALUE does not. A looser check
 * (say, comparing only the merchant and the caps) would let a wallet or a man in the middle
 * add a constraint, drop one, or swap the `cnf` key for its own, and still pass.
 */
export function delegatePayloadMatches(signed: unknown, expected: MandateContent[]): boolean {
  if (!Array.isArray(signed) || signed.length !== expected.length) return false;
  return signed.every((got, i) => {
    if (typeof got !== "object" || got === null) return false;
    return canonical(got as MandateContent) === canonical(expected[i]);
  });
}

/**
 * The `transaction_data` entry AP2 defines for delegation, ready to base64url-encode.
 *
 * `credential_ids` MUST reference the DCQL credential allowed to authorize it; a mismatch
 * there is one of the ways the whole presentation fails with an error that points nowhere
 * near the cause.
 */
export function delegateTransactionData(args: {
  mandates: MandateContent[];
  credentialId: string;
}): Record<string, unknown> {
  return {
    type: "delegate",
    format: DELEGATE_FORMAT,
    credential_ids: [args.credentialId],
    transaction_data_hashes_alg: ["sha-256"],
    delegate_payload: args.mandates,
  };
}
