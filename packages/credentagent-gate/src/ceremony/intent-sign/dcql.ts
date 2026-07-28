// DCQL for the intent-sign rail: request the Digital Payment Credential
// (`org.openwallet.payment.1`) — the same doctype the demo-PKI `payment.mpzpass`
// toolkit imports into the Multipaz wallet. Reused from the package's own
// `payment` builder (credentials.ts) so the request the wallet receives is the
// SAME shape the payment policy describes — no second source of truth to drift,
// exactly as the credential rail reuses `age` / `membership`.
import { payment } from "../../credentials.js";
import type { DcqlQuery } from "../../types.js";

/** The doctype whose device key signs the Intent Mandate. */
export const PAYMENT_CREDENTIAL_DOCTYPE = "org.openwallet.payment.1";

/** The DCQL the signed request embeds — the payment credential's own query. */
export function buildIntentSignDcql(currency = "usd"): DcqlQuery {
  return payment.in(currency).request;
}
