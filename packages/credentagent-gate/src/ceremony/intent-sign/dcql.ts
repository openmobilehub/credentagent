// DCQL for the intent-sign rail: request the SCA payment credential
// (`org.multipaz.payment.sca.1`) — the doctype the demo-PKI `payment.mpzpass`
// toolkit actually imports into the Multipaz wallet (tools/demo-pki/mint/README.md).
//
// Reused from the SIBLING dc-payment rail (`../dc-payment/dcql.js`), not from the
// package's `payment` builder, so there is ONE source of truth for "what a wallet is
// asked for" — and it is the one already proven against a real phone. The `payment`
// builder's doctype only ever fed the `requires` manifest (it never reaches a wallet),
// so it drifted from the credential the toolkit mints; asking for it here would have
// meant no credential could ever match. See dcql.test.ts, which pins these literals to
// the committed fixture.
import { PAYMENT_DOCTYPE, buildDcPaymentDcql } from "../dc-payment/dcql.js";
import type { DcqlQuery } from "../../types.js";

/** The doctype whose device key signs the Intent Mandate. */
export const PAYMENT_CREDENTIAL_DOCTYPE = PAYMENT_DOCTYPE;

/**
 * The instrument leaf /verify requires disclosed (invariant 5: an explicit positive
 * claim, not merely "a token was present").
 */
export const PAYMENT_INSTRUMENT_CLAIM = "payment_instrument_id";

/** The DCQL the signed request embeds — the dc-payment rail's own query. */
export function buildIntentSignDcql(): DcqlQuery {
  return buildDcPaymentDcql();
}
