// OpenID4VP request descriptor for the credential gate (age / membership) —
// SCAFFOLD, PR-in-flight.
//
// The WORKING presence-only mechanism is verify.ts#evaluateCredential (the demo's
// instant-demo path, adapted). This module scaffolds the OpenID4VP signed-request
// shape ALONGSIDE it — the DCQL the wallet would receive, plus the origin binding
// (client_id / expected_origins) — so the rail mirrors the dc-payment split
// (dcql / request / verify / page / routes). It deliberately stops short of the
// reader-cert + JWE encryption + nonce sealing (the demo's
// payment-gate/credential-gate/request.ts does that via jose), so the package stays
// light while the OpenID4VP path lands. It is fenced presence-only-demo and marked
// `scaffold-in-flight` so no surface mistakes it for a live, trusted verifier.
import { buildCredentialDcql, type CredentialDcqlOpts, type CredentialKind } from "./dcql.js";
import type { Origin } from "../origin.js";
import type { DcqlQuery } from "../../types.js";

export interface CredentialRequestDescriptor {
  protocol: "openid4vp-v1-signed";
  /** Honesty: this is the request SHAPE, not a live signed/encrypted request yet. */
  status: "scaffold-in-flight";
  /** x509 SAN-DNS client id bound to this server's RP-ID (invariant 6). */
  client_id: string;
  /** Only this origin may satisfy the request. */
  expected_origins: string[];
  /** What the wallet is asked to disclose. */
  dcql_query: DcqlQuery;
  trust_level: "presence-only-demo";
}

/** Build the (scaffold) OpenID4VP request descriptor for one credential kind. */
export function buildCredentialRequest(kind: CredentialKind, origin: Origin, opts: CredentialDcqlOpts = {}): CredentialRequestDescriptor {
  return {
    protocol: "openid4vp-v1-signed",
    status: "scaffold-in-flight",
    client_id: `x509_san_dns:${origin.rpID}`,
    expected_origins: [origin.origin],
    dcql_query: buildCredentialDcql(kind, opts),
    trust_level: "presence-only-demo",
  };
}
