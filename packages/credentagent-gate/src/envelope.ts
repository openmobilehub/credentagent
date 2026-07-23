// The `verification_required` envelope — CredentAgent's Mode-B / roadmap primitive.
//
// Mode A (consolidated checkout) is the v0.1 default: the tool mints the link +
// surfaces a `requires` manifest, and the page runs the gates. This envelope is
// the BLOCKING shape for page-less tools (Mode B, roadmap): a tool that has no
// checkout page returns a typed refusal an agent can DRIVE (why it stopped,
// which credential, a per-order approve link, the tool to poll) instead of a
// dead error string. Its wire shape is a tested contract — do NOT break it.

import type { DcqlQuery, TrustLevel } from "./types.js";

export const ENVELOPE_VERSION = "credentagent.verification/v1" as const;
export const ENVELOPE_SENTINEL = "verification_required" as const;

/** Built-in credential kinds the envelope describes. */
export type BuiltinKind = "age" | "membership" | "payment";

/**
 * The age DCQL for a threshold, matching the reference verifier (ISO 18013-5 mDL +
 * EU PID). Mirrors the server's credential-gate/dcql.ts so the envelope describes the
 * request the wallet will actually receive.
 *
 * Every option we offer must be able to prove `age_over_${minAge}` — `age.over(N)`
 * verifies exactly that claim (invariant 5: an 18+ proof must never satisfy a 21+
 * gate). Asking a doctype only for `age_over_18` while gating on 21 would let the
 * wallet match and then get refused at verify — a dead end. So both doctypes are
 * asked for the boolean at THIS threshold (plus the 18 bracket, mirroring
 * credential-gate/doc-spec.ts). A credential that lacks the threshold claim simply
 * won't match its option, which is the correct outcome.
 */
export function ageDcql(minAge = 21): DcqlQuery {
  const over = (ns: string, n: number) => ({ path: [ns, `age_over_${n}`], intent_to_retain: false });
  const claimsIn = (ns: string) => (minAge > 18 ? [over(ns, minAge), over(ns, 18)] : [over(ns, 18)]);
  return {
    credentials: [
      {
        id: "mdl",
        format: "mso_mdoc",
        meta: { doctype_value: "org.iso.18013.5.1.mDL" },
        claims: claimsIn("org.iso.18013.5.1"),
      },
      {
        id: "eupid",
        format: "mso_mdoc",
        meta: { doctype_value: "eu.europa.ec.eudi.pid.1" },
        claims: claimsIn("eu.europa.ec.eudi.pid.1"),
      },
    ],
    // mDL OR EU-PID — either proves age. WITHOUT this set, DCQL treats the two
    // `credentials` as AND (both required), so a wallet holding only one doctype
    // (e.g. an imported mDL) matches nothing and the picker shows "info not found".
    credential_sets: [{ options: [["mdl"], ["eupid"]] }],
  };
}

export interface VerificationRequired {
  /** Sentinel an agent/client keys on to detect a consent handshake. */
  _credentagent: typeof ENVELOPE_SENTINEL;
  version: typeof ENVELOPE_VERSION;
  order: { id: string; total: number; currency: string };
  reason: { gate: string; pass: false; detail: string };
  present: {
    /** A built-in kind, or a custom `defineCredential` id (same wire shape: a string). */
    credential: BuiltinKind | (string & {});
    /** Age threshold, when the credential is `age`. */
    min_age?: number;
    /** The DCQL the wallet will receive. */
    request: DcqlQuery;
    /** Per-order link the buyer opens to prove the credential on their phone. */
    approve_url: string;
  };
  /** How the agent resumes once the buyer has proven the credential. */
  resume: { tool: string; poll: string };
  trust_level: TrustLevel;
}

export interface BuildEnvelopeArgs {
  order: { id: string; total: number; currency: string };
  credential: BuiltinKind | (string & {});
  request: DcqlQuery;
  approveUrl: string;
  detail: string;
  minAge?: number;
  gate?: string;
  resumeTool?: string;
  /** Override the checkout-worded default poll hint (e.g. a gated tool's "re-call…"). */
  resumePoll?: string;
  trustLevel?: TrustLevel;
}

/** Build the typed refusal an agent can drive. Pure — no I/O. */
export function buildVerificationRequired(args: BuildEnvelopeArgs): VerificationRequired {
  return {
    _credentagent: ENVELOPE_SENTINEL,
    version: ENVELOPE_VERSION,
    order: { id: args.order.id, total: args.order.total, currency: args.order.currency },
    reason: {
      gate: args.gate ?? (args.minAge != null ? `Age over ${args.minAge}` : "Verification"),
      pass: false,
      detail: args.detail,
    },
    present: {
      credential: args.credential,
      ...(args.minAge != null ? { min_age: args.minAge } : {}),
      request: args.request,
      approve_url: args.approveUrl,
    },
    resume: { tool: args.resumeTool ?? "get-order-status", poll: args.resumePoll ?? "until status=completed or refused" },
    trust_level: args.trustLevel ?? "presence-only-demo",
  };
}

/** True if a tool result is a verification_required envelope (for agents/clients). */
export function isVerificationRequired(v: unknown): v is VerificationRequired {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { _credentagent?: unknown })._credentagent === ENVELOPE_SENTINEL
  );
}

/** A one-line, agent-facing instruction string to carry alongside the envelope. */
export function envelopeInstruction(env: VerificationRequired): string {
  const what =
    env.present.credential === "age"
      ? `age verification (${env.present.min_age ?? 21}+)`
      : `a ${env.present.credential} credential`;
  return (
    `This order needs ${what} before it can be placed. Share this link with the buyer to ` +
    `prove it on their phone: ${env.present.approve_url} — then poll \`${env.resume.tool}\` ` +
    `until it completes. Do not tell the user the order is placed until then.`
  );
}
