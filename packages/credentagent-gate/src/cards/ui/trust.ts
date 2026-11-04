// The honesty line's fixed sentences (spec 015 FR-10). The level is the merchant's claim — the card
// can't check it today — so every sentence says so, and a merchant's own words never appear in one. A
// level not on this list, `issuer-verified` included (#14 is where real issuer trust lands), is unverified.

const SENTENCES: Readonly<Record<string, string>> = {
  "presence-only-demo":
    "As the merchant reports it: a demo — the credential is not checked against its issuer, so a made-up one would pass. No real money moves.",
  "device-signed":
    "As the merchant reports it: signed on the person's phone. This card did not check that signature, and the credential is not checked against its issuer yet.",
  "server-issued-demo":
    "As the merchant reports it: a demo, approved with a click on a page — nothing was signed on a phone. No real money moves.",
};

export const UNRECOGNISED_TRUST = "Trust level not recognised by this card; treat it as unverified.";

// A grant that can't spend says so, and nothing about how it was approved: a grant waiting for the
// phone reports `server-issued-demo` until it is signed, and a revoked one may never have been approved.

/** For a grant still waiting for approval, or declined. */
export const NOT_APPROVED_TRUST = "As the merchant reports it: not approved, so this grant can't spend anything.";
/** For a revoked grant, approved or not before it was revoked. */
export const REVOKED_TRUST = "As the merchant reports it: revoked, so this grant can't spend anything.";

/** The sentence for a level. Own keys only, so a level such as `constructor` is unrecognised too. */
export function trustSentence(level: unknown): string {
  return typeof level === "string" && Object.hasOwn(SENTENCES, level) ? SENTENCES[level] : UNRECOGNISED_TRUST;
}
