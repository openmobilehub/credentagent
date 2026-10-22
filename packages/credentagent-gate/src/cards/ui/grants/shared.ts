// Pure, non-JSX shared bits for the grant gallery: the token role set, money formatting, the
// status-pill table, and the DATA-DRIVEN trust strings. The trust wording is honest on BOTH axes
// (design §5): the LIMITS are genuinely enforced server-side; HOW the consent was given comes from
// the grant's status and `trustLevel` (spec 015 FR-10), never one fixed claim for every grant.

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

/** The card's sentence for each trust level (spec 015 FR-10). The level is the server's claim and the
 *  card cannot check it, so each sentence says so; a level not listed here is never shown as given. */
const TRUST_SENTENCES: Readonly<Record<string, string>> = {
  "presence-only-demo":
    "As the store reports it: a demo — the signatures are real, but the payment credential is not checked against its issuer yet. No real money moves.",
  "device-signed":
    "As the store reports it: signed on the person's phone. This card did not check that signature, and the credential is not checked against its issuer yet.",
  "server-issued-demo":
    "As the store reports it: a demo, approved with a click on a page — nothing was signed on a phone. No real money moves.",
};
const UNKNOWN_TRUST = "Trust level not recognised by this card; treat it as unverified.";

/** The full trust sentence (the frame footer + the dense-list footer). A grant nobody has approved
 *  yet, or one declined, says so: its trust level describes no consent yet (a pending grant reports
 *  `server-issued-demo` even when the phone will sign it). Otherwise, the level's sentence. */
export function fullTrustSentence(grant: Pick<GrantViewData, "status" | "trustLevel">): string {
  const consent =
    grant.status === "pending"
      ? "Not approved yet — nothing can be spent until the person approves."
      : grant.status === "denied"
        ? "Declined — nothing can be spent."
        : Object.hasOwn(TRUST_SENTENCES, grant.trustLevel)
          ? TRUST_SENTENCES[grant.trustLevel]
          : UNKNOWN_TRUST;
  return `🔒 Limits enforced server-side. ${consent}`;
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
