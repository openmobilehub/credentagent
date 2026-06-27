// DCQL for the dc-payment rail. One query for the SCA payment credential
// (ISO 18013-5 mso_mdoc, doctype org.multipaz.payment.sca.1) — the SAME doctype +
// claim leaves the demo's payment-gate/dc-payment/request.ts asks for, so the
// request the wallet receives matches what verify.ts maps back. The credential id
// is "dpc" (referenced by transaction_data.credential_ids in txData.ts).
import type { DcqlQuery } from "../../types.js";

export const PAYMENT_DOCTYPE = "org.multipaz.payment.sca.1";

// The disclosed instrument leaves verify.ts reads back into the DC mandate.
export const PAYMENT_CLAIM_LEAVES = [
  "issuer_name",
  "payment_instrument_id",
  "masked_account_reference",
  "holder_name",
  "issue_date",
  "expiry_date",
] as const;

/** The DCQL the signed request embeds for the payment credential. */
export function buildDcPaymentDcql(): DcqlQuery {
  return {
    credentials: [
      {
        id: "dpc",
        format: "mso_mdoc",
        meta: { doctype_value: PAYMENT_DOCTYPE },
        claims: PAYMENT_CLAIM_LEAVES.map((leaf) => ({ path: [PAYMENT_DOCTYPE, leaf], intent_to_retain: false })),
      },
    ],
  };
}
