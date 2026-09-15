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
//
// WHICH SPEC THIS FILE FOLLOWS, because the two disagree (#192). AP2's `agent_authorization.md`
// puts the Mandate Content in the request as `delegate_payload` — an array of plain JSON objects
// — with `format: "dc+sd-jwt"`. Delegate SD-JWT (`draft-gco-oauth-delegate-sd-jwt-00`) §7.1 puts
// a `delegate_payload_disclosure` there instead — one RFC 9901 array disclosure, as a string —
// with `format` naming the delegation format (`dSD-JWT`), and says the KB-JWT carries only the
// DIGEST of it. This rail follows THE DRAFT, because the draft is what a verifier written to the
// standard will read, and AP2's document describes the shape rather than specifying it.
//
// The security property is the same either way and does not depend on which we picked: the
// digest is over content assembled here from the server's grant record, and `/verify` recomputes
// that digest from the same record. What changes is only whether the mandate travels in the
// clear or behind its hash.
import { createHash, createHmac } from "node:crypto";
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

/**
 * The delegation format a `delegate` entry names — Delegate SD-JWT §7.1: "REQUIRED string
 * containing either dSD-JWT or dSD-JWT+KB". NOT the credential's VDC format (`dc+sd-jwt`), which
 * is what AP2's example carries here; the draft's member names the delegation, not the credential.
 * `dSD-JWT` is the plain form: the holder delegates, and the agent adds its own key binding later.
 */
export const DELEGATE_FORMAT = "dSD-JWT";

/**
 * The KB-JWT claim carrying the digests of what the holder signed (Delegate SD-JWT §7.1).
 *
 * `delegate_payload` — no leading underscore. The draft's source writes the claim as
 * `*delegate\_payload*`, Markdown italics around an escaped underscore; datatracker's rendering
 * turns that into `_delegate_payload_`, which is how this rail (and Multipaz) came to send an
 * underscored name that no verifier written against the draft would look for. §7.1's prose,
 * which is not italicised, spells it plainly.
 */
export const DELEGATE_PAYLOAD_CLAIM = "delegate_payload";

/**
 * The `typ` a Delegate Key Binding JWT must carry (§5.1.4): "The typ parameter value MUST be
 * replaced with `kb+sd-jwt` for a KB-SD-JWT, and `kb+sd-jwt+kb` for a KB-SD-JWT+KB." A plain
 * `kb+jwt` — what a wallet emits when it treats this as an ordinary key binding — is the tell
 * that the delegation extension was never applied.
 */
export const DELEGATE_KB_TYP = ["kb+sd-jwt", "kb+sd-jwt+kb"] as const;

/** The hash algorithms this rail can produce, by their IANA `transaction_data_hashes_alg` name. */
const HASH_ALGS = { "sha-256": "sha256", "sha-384": "sha384", "sha-512": "sha512" } as const;

/** One of the algorithms a `delegate` entry may request. */
export type DelegateHashAlg = keyof typeof HASH_ALGS;

/** What this rail asks for when a caller names nothing — the SD-JWT default (RFC 9901 §4.1.1). */
export const DEFAULT_HASH_ALG: DelegateHashAlg = "sha-256";

/** Is `alg` one this rail can actually compute? A wallet asked for anything else cannot answer. */
export function isDelegateHashAlg(alg: string): alg is DelegateHashAlg {
  return alg in HASH_ALGS;
}

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
  /**
   * The concrete product ids the grant may buy, resolved from the SERVER's record and catalog
   * (`grants._allowedSkusFor`). NOT `bounds.allow.skus`: a category-bounded grant names no
   * products, and putting its empty list into `checkout.line_items` would say "nothing may be
   * bought" — the constraint's own meaning — for a grant the human approved for a category.
   */
  allowedSkus: string[];
}): MandateContent[] {
  const { bounds, origin, delegate, exp } = args;
  // Refuse rather than mint an authorization that permits nothing while looking like a grant.
  // An empty list here is not a tighter bound, it is a wrong one: the page told the human what
  // they could buy, and the mandate would contradict it.
  if (args.allowedSkus.length === 0) {
    throw new Error(
      `grant ${bounds.grantId}: no products resolve from its bounds, so \`checkout.line_items\` would authorize nothing — refusing to mint a mandate that contradicts what the human approved`,
    );
  }
  const grantBounds = {
    merchant: bounds.merchant,
    budget: bounds.budget,
    perSpend: bounds.perSpend,
    currency: "USD",
    skus: args.allowedSkus,
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
 * The KB-JWT's `delegate_payload` is an array whose elements have been "replaced with
 * disclosures" (§5.1.4) — RFC 9901 §4.2.4.2 array-element digests, each `{"...": "<digest>"}`.
 * So the check is: every digest this server computed from its OWN grant record is present.
 *
 * WHY CONTAINMENT AND NOT EQUALITY. §7.1 permits the wallet to add decoy digests, and a KB-JWT
 * with several delegations in it is the draft's normal case. An extra digest authorizes nothing
 * here — it stands for content this server never produced and will never accept — while
 * demanding an exact set would refuse a conformant wallet. What is NOT optional is that EVERY
 * expected digest is there: a wallet that signed only the last entry it was given (#192) fails
 * this, where a length check alone would have let it through.
 *
 * The digest is over the disclosure's exact bytes, which encode the mandate's exact bytes, so a
 * wallet or a man in the middle that added a constraint, dropped one, or swapped the `cnf` key
 * for its own produces a different digest and does not match.
 */
export function delegatePayloadMatches(signed: unknown, expectedDigests: string[]): boolean {
  if (!Array.isArray(signed) || expectedDigests.length === 0) return false;
  const got = new Set<string>();
  for (const element of signed) {
    // RFC 9901 §4.2.4.2: a replaced array element is an object with the single key "...".
    if (typeof element === "object" && element !== null) {
      const digest = (element as Record<string, unknown>)["..."];
      if (typeof digest === "string") got.add(digest);
    }
  }
  return expectedDigests.every((digest) => got.has(digest));
}

/**
 * The salt for the array disclosure of mandate `index`.
 *
 * DETERMINISTIC, and that is the point: `/request` mints the disclosure and `/verify` has to
 * recompute the identical bytes to recognise the digest the wallet signed over. A random salt
 * would force the server to remember it between the two hops; deriving it under the gate secret
 * keeps both hops a pure function of the grant record, which is the property the rest of this
 * rail is built on.
 *
 * RFC 9901 §4.1.1 asks for ≥128 bits of entropy so a third party cannot guess the disclosed
 * value from its digest. An HMAC under a secret the client never sees gives that. (The agent
 * already knows these mandates — it is the delegate — so there is no secrecy to lose here
 * anyway; the salt is doing binding work, not hiding work.)
 */
function delegateSalt(secret: string, grantId: string, index: number): string {
  return createHmac("sha256", secret).update(`ap2-delegate-salt|${grantId}|${index}`).digest("base64url").slice(0, 22);
}

/**
 * An RFC 9901 §4.2.4.2 array-element disclosure: `base64url(JSON([salt, value]))`.
 *
 * This is what Delegate SD-JWT §7.1 calls "the Array Disclosure of the delegate payload" and
 * sends in `delegate_payload_disclosure`. The element it discloses is ONE Mandate Content object.
 */
export function arrayDisclosure(salt: string, value: MandateContent): string {
  return Buffer.from(JSON.stringify([salt, value]), "utf-8").toString("base64url");
}

/**
 * The digest of a disclosure, per RFC 9901 §4.2.4.2 — hashed over the ASCII of the disclosure
 * string itself, not over the value it encodes. Re-encoding the JSON differently therefore
 * produces a different digest, which is exactly the tamper-evidence we want.
 */
export function disclosureDigest(disclosure: string, alg: DelegateHashAlg): string {
  return createHash(HASH_ALGS[alg]).update(disclosure, "ascii").digest("base64url");
}

/** The `delegate` request entries for a set of mandates, and the digests they must come back as. */
export interface DelegateEntries {
  /** One `transaction_data` object per mandate, ready to base64url-encode. */
  entries: Record<string, unknown>[];
  /** The array-element digests the KB-JWT's `delegate_payload` must carry, in the same order. */
  digests: string[];
  /** The disclosures themselves — echoed so a caller can show or log what it asked for. */
  disclosures: string[];
}

/**
 * The `transaction_data` entries Delegate SD-JWT §7.1 defines, ready to base64url-encode.
 *
 * ONE ENTRY PER MANDATE. §5.1.4's `delegate_payload` array holds one Delegate Payload per
 * element, and §7.1 says "Multiple delegate transaction_data MAY be included in the same request.
 * In that case, each MUST have their digest included in the delegate_payload." A grant's checkout
 * authority and payment authority are two payloads, so they are two entries — which is also the
 * shape that catches a wallet signing only the last entry it was given (#192).
 *
 * `credential_ids` MUST reference the DCQL credential allowed to authorize it; a mismatch
 * there is one of the ways the whole presentation fails with an error that points nowhere
 * near the cause.
 */
export function delegateEntries(args: {
  mandates: MandateContent[];
  credentialId: string;
  /** The gate secret — salts the disclosures so `/verify` can rebuild them (see `delegateSalt`). */
  secret: string;
  /** Scopes the salts to this grant, so two grants never share a disclosure. */
  grantId: string;
  hashAlg?: DelegateHashAlg;
}): DelegateEntries {
  const alg = args.hashAlg ?? DEFAULT_HASH_ALG;
  const disclosures = args.mandates.map((m, i) => arrayDisclosure(delegateSalt(args.secret, args.grantId, i), m));
  return {
    disclosures,
    digests: disclosures.map((d) => disclosureDigest(d, alg)),
    entries: disclosures.map((disclosure) => ({
      type: "delegate",
      format: DELEGATE_FORMAT,
      credential_ids: [args.credentialId],
      transaction_data_hashes_alg: [alg],
      delegate_payload_disclosure: disclosure,
    })),
  };
}
