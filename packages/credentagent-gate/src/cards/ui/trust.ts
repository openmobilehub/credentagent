// The honesty line's fixed sentences (spec 015 FR-10). The level is the store's claim — the card can't
// check it today — so every sentence says so, and a store's own words never appear in one. A level
// not on this list, `issuer-verified` included (#14 is where real issuer trust lands), is unverified.

const SENTENCES: Readonly<Record<string, string>> = {
  "presence-only-demo":
    "As the store reports it: a demo — the signatures are real, but the payment credential is not checked against its issuer yet. No real money moves.",
  "device-signed":
    "As the store reports it: signed on the person's phone. This card did not check that signature, and the credential is not checked against its issuer yet.",
  "server-issued-demo":
    "As the store reports it: a demo, approved with a click on a page — nothing was signed on a phone. No real money moves.",
};

export const UNRECOGNISED_TRUST = "Trust level not recognised by this card; treat it as unverified.";

/** The sentence for a level. Own keys only, so a level such as `constructor` is unrecognised too. */
export function trustSentence(level: unknown): string {
  return typeof level === "string" && Object.hasOwn(SENTENCES, level) ? SENTENCES[level] : UNRECOGNISED_TRUST;
}
