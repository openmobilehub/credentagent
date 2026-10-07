// The Delegate SD-JWT names this package uses on BOTH sides: the phone-signing rail that asks a
// wallet to sign, and the chain verifier a merchant runs. One definition of each, so the rail can
// never accept what the merchant refuses.

/**
 * The KB-JWT claim carrying the digests of what the holder signed (Delegate SD-JWT §7.1).
 *
 * `delegate_payload`, with NO leading or trailing underscore — datatracker renders §7.1's
 * italicised heading as `_delegate_payload_`, and a verifier written against the draft looks for
 * the plain name that §7.1's prose spells out.
 */
export const DELEGATE_PAYLOAD_CLAIM = "delegate_payload";

/**
 * The `typ` a Delegate key binding carries (§5.1.4): `kb+sd-jwt+kb` for a hop whose payload names
 * a further key in `cnf` (one that may be delegated again), `kb+sd-jwt` for one that ends the
 * chain. A plain `kb+jwt` — what a wallet emits when it treats this as an ordinary key binding — is
 * the tell that the delegation extension was never applied.
 */
export const DELEGATE_KB_TYP = { delegable: "kb+sd-jwt+kb", terminal: "kb+sd-jwt" } as const;
