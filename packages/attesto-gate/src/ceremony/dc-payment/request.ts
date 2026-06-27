// OpenID4VP request descriptor for the dc-payment rail — SCAFFOLD, PR-in-flight.
//
// The WORKING presence-only mechanism is verify.ts (build the amount-bound mandate
// + run the four gates). This module scaffolds the OpenID4VP signed-request SHAPE
// alongside it — the DCQL the wallet receives, the origin binding
// (client_id / expected_origins), and the real amount-bound `transaction_data`
// entry (txData.ts) — so the rail mirrors the demo's dc-payment split
// (dcql / request / verify / page / routes). It deliberately stops short of the
// reader-cert (x509) signing + JWE response encryption + nonce sealing the demo's
// payment-gate/dc-payment/request.ts does via jose, so the package stays
// dependency-light while the OpenID4VP path lands. It is fenced presence-only-demo
// and marked `scaffold-in-flight` so no surface mistakes it for a live, trusted
// verifier.
import { buildDcPaymentDcql } from "./dcql.js";
import { buildTransactionData, encodeTransactionData } from "./txData.js";
import type { CeremonyOrder } from "../types.js";
import type { Origin } from "../origin.js";
import type { DcqlQuery } from "../../types.js";

export interface DcPaymentRequestDescriptor {
  protocol: "openid4vp-v1-signed";
  /** Honesty: this is the request SHAPE, not a live signed/encrypted request yet. */
  status: "scaffold-in-flight";
  /** x509 SAN-DNS client id bound to this server's RP-ID (invariant 6). */
  client_id: string;
  /** Only this origin may satisfy the request. */
  expected_origins: string[];
  /** What the wallet is asked to disclose. */
  dcql_query: DcqlQuery;
  /** The amount-bound transaction_data entries (base64url) — REAL binding. */
  transaction_data: string[];
  trust_level: "presence-only-demo";
}

/** Build the (scaffold) OpenID4VP request descriptor for the payment credential. */
export function buildDcPaymentRequest(order: CeremonyOrder, origin: Origin): DcPaymentRequestDescriptor {
  return {
    protocol: "openid4vp-v1-signed",
    status: "scaffold-in-flight",
    client_id: `x509_san_dns:${origin.rpID}`,
    expected_origins: [origin.origin],
    dcql_query: buildDcPaymentDcql(),
    transaction_data: [encodeTransactionData(buildTransactionData(order, origin))],
    trust_level: "presence-only-demo",
  };
}
