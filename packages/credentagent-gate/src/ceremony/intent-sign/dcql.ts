// DCQL for the intent-sign rail: ask for the payment credential as an SD-JWT VC.
//
// WHY NOT mdoc (spec 014). This rail used to request `org.multipaz.payment.sca.1`, the ISO
// mdoc doctype `payment.mpzpass` mints. AP2's delegation mechanism is specified for SD-JWT VCs
// only — its chain serialization is SD-JWT syntax and mdoc has no equivalent — so a delegated
// Intent Mandate needs the credential in the other format. `tools/demo-pki/mint/` mints it.
//
// TWO THINGS THAT LOOK OPTIONAL AND ARE NOT. Both were found on a real device, and both fail
// with the same unhelpful message ("Your info wasn't found") that a wallet holding no
// credential at all would give:
//
//   1. `claims` MUST be present. An mdoc query matches on `meta.doctype_value` alone; a
//      `dc+sd-jwt` query with `meta.vct_values` alone matches nothing. It also needs
//      `claim_sets` to ask for "either of these claims" rather than all of them (see below).
//   2. The credential's issuer JWT MUST carry an `x5c` chain, or the wallet exports it to the
//      Android matcher with no claims and it can never match. That is the minter's job, not
//      this file's — see `tools/demo-pki/mint/mint-dpc-sdjwt.mjs`.
import type { DcqlQuery } from "../../types.js";

/**
 * Credential types accepted for signing an Intent Mandate.
 *
 * Two, because the ecosystem has not settled on one: AP2's own example uses `com.emvco.dpc`,
 * while Multipaz registers `urn:emvco:dpc:card:1` for its SD-JWT payment credential. `vct_values`
 * is a list, so accepting both costs nothing and spares a caller a failed device session over a
 * naming difference.
 */
export const PAYMENT_CREDENTIAL_VCTS = ["urn:emvco:dpc:card:1", "com.emvco.dpc"] as const;

/** The DCQL id the `transaction_data` entries must reference in `credential_ids`. */
export const PAYMENT_CREDENTIAL_ID = "dpc_credential";

/**
 * The claims that prove a payment card, ONE of which a wallet must disclose. The single source
 * for both what the request asks for and what /verify requires, so the two cannot drift.
 *
 * - `credential_id` — carried by the official Multipaz Payment card (`payment_sca_sd_jwt` at
 *   `issuer.multipaz.org`). Matched on a phone; the card's other claims (`network`, `last_four`)
 *   are read from Multipaz `main` and not requested.
 * - `payment_instrument_id` — carried by the test card `tools/demo-pki/mint/` mints.
 *
 * Invariant 5 holds: /verify needs an explicit, non-empty, issuer-signed value for one of
 * these, never merely "a token was present".
 */
export const PAYMENT_CLAIMS = ["credential_id", "payment_instrument_id"] as const;

/** The DCQL the signed request embeds. */
export function buildIntentSignDcql(): DcqlQuery {
  return {
    credentials: [
      {
        id: PAYMENT_CREDENTIAL_ID,
        format: "dc+sd-jwt",
        meta: { vct_values: [...PAYMENT_CREDENTIAL_VCTS] },
        claims: PAYMENT_CLAIMS.map((name) => ({ id: name, path: [name] })),
        // "Either claim": one option per card. Confirmed on a phone (2026-11-13): Android's matcher
        // honours `claim_sets` and offered the official Payment card for it (Multipaz Wallet dev
        // build, one run against a local server). Without `claim_sets` this would ask for BOTH
        // claims, and no single card carries both.
        claim_sets: PAYMENT_CLAIMS.map((name) => [name]),
      },
    ],
  } as unknown as DcqlQuery;
}
