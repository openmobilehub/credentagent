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

/**
 * Both spellings of the delegable `typ` a verifier accepts. Draft -00 itself uses both: §2.2, §5.1.4
 * and its IANA section say `kb+sd-jwt+kb`, and §6 (steps 1.1, 3.e and 4.2) says `kb-sd-jwt+kb`. A
 * review of multipaz#2178 reports that a later draft settled on the `-`. Multipaz and CMWallet each
 * pick one, and AP2's Python SDK accepts both (as reported there; this repo never runs it). The gate
 * accepts either, so a wallet on one spelling is not refused for a difference the draft itself contains.
 *
 * The terminal hop is `kb+sd-jwt` here. §6 step 4.2 writes it `kb-sd-jwt`, which this gate still
 * refuses: nothing sends it yet, and accepting it needs its own decision (#473).
 */
export const DELEGABLE_KB_TYPS: readonly string[] = [DELEGATE_KB_TYP.delegable, "kb-sd-jwt+kb"];

/** Whether `typ` marks a hop whose payload names a further key — the delegable `typ`, either spelling. */
export function isDelegableKbTyp(typ: unknown): boolean {
  return typeof typ === "string" && DELEGABLE_KB_TYPS.includes(typ);
}
