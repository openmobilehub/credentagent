// Policy builders — the typed surface a developer writes (Principle I).
//
//   required(age.over(21).when(hasAlcohol))   // 21+, only when the predicate is true
//   optional(membership.discount(10))          // 10% off if a loyalty credential is presented
//   required(payment.in("usd"))                // amount derived from the order; settles last
//
// Each builder returns a `Credential` carrying an `effect`; `.when()` attaches a
// call-site conditional. These hold FUNCTIONS — they live in your server and are
// resolved to data by `requirements()` (the code→data boundary). Nothing here
// crosses the wire.

import type { Credential, DcqlQuery, Effect, GateOrder, Step } from "./types.js";
import { ageDcql } from "./envelope.js";

// ── Effects (tagged data the resolver interprets) ──────────────────────────

export function gate(): Effect {
  return { kind: "gate" };
}
export function discount(opts: { percent?: number; amount?: number }): Effect {
  return { kind: "discount", ...opts };
}
export function authorize(): Effect {
  return { kind: "authorize" };
}

// ── DCQL sugar ─────────────────────────────────────────────────────────────

/**
 * Concise DCQL for a single mdoc credential: name the doctype and the claim
 * leaves, get back the full verifier-shaped `DcqlQuery`. Selective disclosure
 * (never retain) is the default.
 */
export function dcql(spec: { docType: string; claims: string[] }): DcqlQuery {
  return {
    credentials: [
      {
        id: spec.docType.split(".").pop() ?? spec.docType,
        format: "mso_mdoc",
        meta: { doctype_value: spec.docType },
        claims: spec.claims.map((leaf) => ({ path: [spec.docType, leaf], intent_to_retain: false })),
      },
    ],
  };
}

// ── Credential factory (non-mutating, chainable `.when()`) ─────────────────

/**
 * Build a Credential and attach the chainable `.when()`. `.when()` returns a
 * fresh Credential whose predicate is AND-ed onto any existing `appliesTo`, so
 * `defineCredential`'s definition-time conditional and a call-site `.when()`
 * compose (both must hold for the gate to apply).
 */
function makeCredential(base: Omit<Credential, "when">): Credential {
  return {
    ...base,
    when(predicate: (order: GateOrder) => boolean): Credential {
      const prev = base.appliesTo;
      return makeCredential({
        ...base,
        appliesTo: prev ? (order) => prev(order) && predicate(order) : predicate,
      });
    },
  };
}

// ── Built-in credentials ───────────────────────────────────────────────────

/** Age verification. `age.over(21)` proves the `age_over_21` claim (explicit positive). */
export const age = {
  over(minAge: number): Credential {
    return makeCredential({
      id: "age",
      request: ageDcql(),
      // Security invariant 5: require the explicit positive claim at THIS threshold
      // (an 18+ proof must not satisfy a 21+ gate).
      verify: (claims) => claims[`age_over_${minAge}`] === true,
      effect: gate(),
      ui: { label: `Age ${minAge}+`, action: `Verify you are ${minAge} or older` },
      params: { minAge },
    });
  },
};

/** Loyalty / membership — optional; presenting it applies a discount. */
export const membership = {
  discount(percent: number): Credential {
    return makeCredential({
      id: "membership",
      // Real, interoperable loyalty doctype a wallet actually holds (Multipaz),
      // matching the demo — NOT a branded placeholder, or the wallet finds nothing.
      request: dcql({ docType: "org.multipaz.loyalty.1", claims: ["membership_number", "tier"] }),
      verify: (claims) => typeof claims.membership_number === "string" && claims.membership_number.length > 0,
      effect: discount({ percent }),
      ui: { label: `${percent}% member discount`, action: "Present your membership" },
      params: { percent },
    });
  },
};

/**
 * Payment authorization. Settles LAST (the resolver sorts authorize-effect
 * entries to the end). The amount is derived from the order server-side, never
 * passed as a field (Principle IV / Security invariant 2).
 */
export const payment = {
  in(currency: string): Credential {
    return makeCredential({
      id: "payment",
      request: dcql({ docType: "org.openwallet.payment.1", claims: ["account"] }),
      verify: (claims) => claims.authorized === true,
      effect: authorize(),
      ui: { label: `Pay (${currency.toUpperCase()})`, action: "Authorize payment" },
      params: { currency },
    });
  },
};

// ── Extensibility ──────────────────────────────────────────────────────────

/** Define a custom credential — gate ANY consequential action with ANY credential. */
export function defineCredential(c: {
  id: string;
  request: DcqlQuery;
  verify: (claims: Record<string, unknown>) => boolean;
  effect: Effect;
  appliesTo?: (order: GateOrder) => boolean;
  ui: { label: string; action: string };
}): Credential {
  return makeCredential({
    id: c.id,
    request: c.request,
    verify: c.verify,
    effect: c.effect,
    appliesTo: c.appliesTo,
    ui: c.ui,
  });
}

// ── Policy entries ─────────────────────────────────────────────────────────

/** A required gate — present in the manifest whenever it applies. */
export function required(c: Credential): Step {
  return { credential: c, required: true };
}
/** An optional gate — surfaced but never blocking. */
export function optional(c: Credential): Step {
  return { credential: c, required: false };
}
