// Pure, non-JSX shared bits for the grant gallery: the token role set, money formatting, the
// status-pill table, and the DATA-DRIVEN trust strings. The trust wording is honest on BOTH axes
// (design §5): the LIMITS are genuinely enforced server-side; the CONSENT is dev-sealed, not
// wallet-signed. Built from `presence`/`trustLevel` so it stays truthful if those ever change.

import type { GrantLifecycle } from "@openmobilehub/credentagent-gate";
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

/** The full trust sentence (the frame footer + the dense-list footer). Presence is data-driven. */
export function fullTrustSentence(grant: Pick<GrantViewData, "presence">): string {
  return `🔒 ${grant.presence} · limits enforced server-side · consent is dev-sealed, not wallet-signed`;
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
