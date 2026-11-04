// Pure, non-JSX shared bits for the grant gallery: the token role set, money formatting, the
// status-pill table, and the trust line. The trust line is one of the kit's fixed sentences, picked
// by `trustLevel` (spec 015 FR-10) — never the merchant's own words, which a card can't check.

import type { GrantLifecycle } from "../../../grants.js";
import type { GrantTokens, GrantViewData } from "./types";
import { NOT_APPROVED_TRUST, trustSentence } from "../trust";

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

/** The trust line (the frame footer + the dense-list footer): the kit's sentence for the grant's level,
 *  or, for a grant nobody approved (pending or declined), the one that says it can't spend. */
export function fullTrustSentence(grant: Pick<GrantViewData, "trustLevel" | "lifecycle">): string {
  const approved = grant.lifecycle !== "pending" && grant.lifecycle !== "denied";
  return `🔒 ${approved ? trustSentence(grant.trustLevel) : NOT_APPROVED_TRUST}`;
}

/** The terminal lifecycles — closed objects with no live affordances (design §4.6). */
export function isTerminal(lifecycle: GrantLifecycle): boolean {
  return lifecycle === "exhausted" || lifecycle === "revoked" || lifecycle === "denied";
}
