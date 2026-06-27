// DCQL for the credential gate (age / membership). One query per kind, reused
// from the package's own credential builders (credentials.ts) so the request the
// wallet receives is the SAME shape the policy layer describes — no second source
// of truth to drift. age → ISO 18013-5 mDL + EU PID over-age claims; membership →
// the loyalty doctype. verify.ts maps the disclosed claims back to a boolean.
import { age, membership } from "../../credentials.js";
import type { DcqlQuery } from "../../types.js";

export type CredentialKind = "age" | "membership";

export interface CredentialDcqlOpts {
  /** Age threshold (defaults to 21 — the strictest common restriction). */
  minimumAge?: number;
  /** Membership discount percent (defaults to 10). */
  percent?: number;
}

/** The DCQL the signed request embeds for this credential kind. */
export function buildCredentialDcql(kind: CredentialKind, opts: CredentialDcqlOpts = {}): DcqlQuery {
  return kind === "age"
    ? age.over(opts.minimumAge ?? 21).request
    : membership.discount(opts.percent ?? 10).request;
}
