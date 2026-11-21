// Pure, non-JSX shared bits for the grant gallery: the token role set, money formatting, the
// status-pill table, and the DATA-DRIVEN trust strings. The trust wording is honest on BOTH axes
// (design §5): the LIMITS are genuinely enforced server-side; the CONSENT depends on the grant's
// state and on the level the store reports (spec 015 FR-10), so it is built from those.

import type { GrantLifecycle } from "../../../grants.js";
import type { GrantTokens, GrantViewData } from "./types";

/** The token role set as CSS custom-property references (resolved in grants.module.css). Only
 *  `accent` is host-brandable; `status.*` are the FIXED never-themed status colors. */
export const grantTokens: GrantTokens = {
  accent: "var(--grant-accent)",
  ink: "var(--grant-ink)",
  muted: "var(--grant-muted)",
  hairline: "var(--grant-hairline)",
  surface: "var(--grant-surface)",
  sunken: "var(--grant-sunken)",
  status: { good: "var(--grant-accent)", warning: "var(--grant-warn)", critical: "var(--grant-crit)" },
  radius: "var(--grant-radius)",
  spacing: "var(--grant-gap)",
};

/** `$146` — proportional figures at display size; whole dollars drop the `.00`, cents show when
 *  present. The money the widget renders is always the server-computed value (never re-derived). */
export function usd(n: number): string {
  return Number.isInteger(n)
    ? "$" + n.toLocaleString("en-US")
    : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Status-pill table, keyed by display lifecycle (icon + word — never color alone, design §4.0). */
export const STATUS_PILL: Record<GrantLifecycle, { tone: "accent" | "warn" | "muted"; icon: string; label: string }> = {
  pending: { tone: "accent", icon: "⧗", label: "Needs approval" },
  active: { tone: "accent", icon: "●", label: "Active" },
  low: { tone: "warn", icon: "⚠", label: "Running low" },
  exhausted: { tone: "muted", icon: "✓", label: "Budget spent" },
  revoked: { tone: "muted", icon: "⊘", label: "Revoked" },
  denied: { tone: "muted", icon: "✕", label: "Declined" },
};

/** What the card says about the consent, by the grant's state first, then by the level the merchant
 *  reports (spec 015 FR-10). The level is the merchant's claim — the card cannot check it — so every
 *  sentence says so. A grant nobody approved has no consent to describe, whatever level it carries:
 *  a grant waiting for the phone reports `server-issued-demo` until it is signed. */
function consentClause(grant: Pick<GrantViewData, "lifecycle" | "trustLevel" | "spent">): string {
  if (grant.lifecycle === "pending" || grant.lifecycle === "denied") {
    return "As the merchant reports it: not approved, so this grant can't spend anything.";
  }
  // Revoked with nothing spent: it may never have been approved, so its level says nothing true.
  if (grant.lifecycle === "revoked" && grant.spent === 0) return "As the merchant reports it: revoked.";
  switch (grant.trustLevel) {
    case "device-signed":
      return "As the merchant reports it: signed on the person's phone. This card did not check that signature, and the credential is not checked against its issuer yet.";
    case "server-issued-demo":
      return "As the merchant reports it: a demo, approved with a click on a page — nothing was signed on a phone. No real money moves.";
    case "presence-only-demo":
      return "As the merchant reports it: a demo — the credential is not checked against its issuer, so a made-up one would pass. No real money moves.";
    default:
      return "Trust level not recognised by this card; treat it as unverified.";
  }
}

/** The full trust sentence (the frame footer + the dense-list footer). Presence is data-driven. */
export function fullTrustSentence(grant: Pick<GrantViewData, "presence" | "lifecycle" | "trustLevel" | "spent">): string {
  return `🔒 ${grant.presence} · limits enforced server-side · ${consentClause(grant)}`;
}

/** The compact per-row trust token (dense list). Keeps the LITERAL presence token on every row so
 *  the FR-4 bypass test passes per-view, while the full sentence de-duplicates to the container. */
export function compactTrustToken(grant: Pick<GrantViewData, "presence">): string {
  return `🔒 ${grant.presence}`;
}

/** The terminal lifecycles — closed objects with no live affordances (design §4.6). */
export function isTerminal(lifecycle: GrantLifecycle): boolean {
  return lifecycle === "exhausted" || lifecycle === "revoked" || lifecycle === "denied";
}
