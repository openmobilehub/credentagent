// The shared typed-refusal vocabulary (design §9 + the redemption-choreography draft):
// ONE discriminated shape across the gate seam, the (future) intent rail, and the
// (future) wallet server — every refusal names the failure, WHO refused (`enforcer`),
// and the recovery class (`retryable`) an unattended agent loop branches on. Pure data
// (Principle VI): refusals cross the MCP wire to agents, so no functions, no Errors.
//
// The agent-facing projection is intentionally minimal (`enforcer` + `code`); the
// per-code detail fields exist for the merchant's own logs and the human approve
// surface — do not leak bounds detail to the counterparty (choreography draft, the
// security persona's oracle concern).

/** Why a draw was refused. Finer-grained than §9's collapsed wire set so the seam can
 *  log precisely; surfaces MAY coarsen (e.g. `not-yet-valid`/`expired` → "expired"). */
export type RefusalCode =
  | "signature" // draw not signed by the delegate key named in the bounds
  | "bounds-tampered" // intent's fields don't hash to its own intentId — bounds mutated after sealing
  | "intent-mismatch" // draw binds to a different intentId
  | "currency-mismatch"
  | "invalid-amount" // draw amount is not a finite, positive number — the caps fail OPEN on NaN/negative
  | "over-cap" // per-draw cap (TS12 max_amount) — absolute ceiling, tolerance 0
  | "over-total" // cumulative cap (TS12 total_amount) across committed draws
  | "not-yet-valid" // now < notBefore
  | "expired" // now > intentExpiry
  | "out-of-scope" // merchant (or, later, SKU) outside the bounds allowlist
  | "unpermitted-presentment" // credential not in mayPresent — age is NEVER delegable
  | "replay" // pspTransactionId already committed for this intent
  | "step-up" // over the presence-required threshold — a human tap resumes it
  | "revoked" // the grant (or its subject, via kill-switch) was revoked
  | "consumed" // single-use grant already drawn
  | "revocation-unavailable"; // the revocation store errored — fail-closed, never open

/** Who refused. The gate seam always answers as the merchant; the wallet server and
 *  PSP use their own values so cross-party logs attribute cleanly. */
export type RefusalEnforcer = "wallet" | "merchant" | "psp";

/** The recovery class an unattended loop branches on:
 *  - "retry":       transient (e.g. store unavailable) — retry with backoff, unattended.
 *  - "needs-human": a live ceremony resumes it (step-up) — surface an approve link.
 *  - "terminal":    do not retry; the draw can never succeed as-is. */
export type RefusalRetryable = "retry" | "needs-human" | "terminal";

export interface Refusal {
  code: RefusalCode;
  enforcer: RefusalEnforcer;
  retryable: RefusalRetryable;
  /** Per-code detail for the enforcer's own logs / approve page (not the wire). */
  detail?: Record<string, unknown>;
}

/** The gate-seam constructor: merchant-attributed, retryability derived from the code. */
export function refusal(code: RefusalCode, detail?: Record<string, unknown>): Refusal {
  const retryable: RefusalRetryable =
    code === "step-up" ? "needs-human" : code === "revocation-unavailable" ? "retry" : "terminal";
  return { code, enforcer: "merchant", retryable, ...(detail ? { detail } : {}) };
}
