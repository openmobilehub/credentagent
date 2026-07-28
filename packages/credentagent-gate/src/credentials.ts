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

/**
 * The claim's leaf element id — the LAST path segment (the shape `dcql()` builds:
 * `[docType, leaf]`). One definition of the path→leaf convention so the request
 * builder, the org-iso-mdoc doc-spec, and the instant-demo claim derivation agree.
 */
export function claimLeaf(path: string[]): string | undefined {
  return path[path.length - 1];
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
      // Ask at THIS threshold, so every credential the wallet can pick is one that can
      // actually prove it (an EU-PID asked only for age_over_18 would match a 21+ gate
      // in the picker and then be refused by `verify` below).
      request: ageDcql(minAge),
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

/**
 * The built-in credential ids. They stay on their existing order-parameterized
 * ceremony + completion paths (age's per-order threshold, membership's percent);
 * the generalized custom-credential rail + `completeOrder` sweep exclude them so a
 * custom credential never shadows a built-in and the built-ins never regress (007).
 */
export const RESERVED_CREDENTIAL_IDS: ReadonlySet<string> = new Set(["age", "membership", "payment"]);

/** Define a custom credential — gate ANY consequential action with ANY credential. */
export function defineCredential(c: {
  id: string;
  request: DcqlQuery;
  verify: (claims: Record<string, unknown>) => boolean;
  effect: Effect;
  appliesTo?: (order: GateOrder) => boolean;
  ui: { label: string; action: string };
}): Credential {
  // A reserved id would be silently shadowed: resolveCred routes age/membership to the built-in
  // ceremony and the completion sweep skips any reserved id (RESERVED_CREDENTIAL_IDS), so a custom
  // `gate()` here would never run its own verify and would fail OPEN. Reject it at construction —
  // fail-fast beats accepting a policy the seam cannot honor (Principle III / IV).
  if (RESERVED_CREDENTIAL_IDS.has(c.id)) {
    throw new Error(
      `defineCredential: "${c.id}" is a reserved built-in credential id (age / membership / payment). ` +
        `Choose a different id — a custom credential cannot reuse a built-in's id.`,
    );
  }
  // Only `gate()` is wired end-to-end for a CUSTOM credential today (the completion sweep
  // enforces it; the credential-gate rail proves it). A custom `authorize()` or `discount()`
  // is accepted but NEVER honored — authorize() is surfaced yet never enforced (fail-OPEN:
  // the order completes unproven), and discount() verifies but applies no price change (inert).
  // Reject both at construction — the SAME fail-fast posture as the reserved-id guard above —
  // rather than accept a policy the seam can't honor (#59 findings 1 + 4; Principle III / IV).
  // The built-ins that DO use these effects (payment → authorize, membership → discount) keep
  // their own order-parameterized paths and never pass through defineCredential, so they are
  // unaffected. Lift this guard once custom authorize/discount are wired through completion.
  if (c.effect.kind === "authorize" || c.effect.kind === "discount") {
    throw new Error(
      `defineCredential: a custom "${c.effect.kind}" effect is not supported yet — only gate() is enforced ` +
        `for a custom credential. Use effect: gate() to hard-block completion until the credential is proven. ` +
        `(A custom ${c.effect.kind} would ${c.effect.kind === "authorize" ? "complete unproven (fail-open)" : "apply no discount (inert)"}.)`,
    );
  }
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

// The effect kind fixes how a step MUST be declared, and a mismatch is a policy the
// ceremony seam cannot honor (item 4 — fail-fast, like finding 1):
//   • gate / authorize are BLOCKING — the completion sweep enforces them only when
//     required, so an optional() one is surfaced but never enforced (fail-OPEN).
//   • discount is a BENEFIT applied when the credential is presented — it never blocks
//     completion, so required() asks the seam to gate on something it can't.

/** A required gate — present in the manifest whenever it applies. */
export function required(c: Credential): Step {
  if (c.effect.kind === "discount") {
    throw new Error(
      `required(${c.id}): a discount is a benefit applied when the credential is presented, ` +
        `not a blocking requirement — it must be optional(), not required().`,
    );
  }
  return { credential: c, required: true };
}
/** An optional gate — surfaced but never blocking. */
export function optional(c: Credential): Step {
  if (c.effect.kind === "gate" || c.effect.kind === "authorize") {
    throw new Error(
      `optional(${c.id}): a ${c.effect.kind} credential is blocking and must be required(), ` +
        `not optional() — an optional blocking credential is surfaced but never enforced (it would fail open).`,
    );
  }
  return { credential: c, required: false };
}
