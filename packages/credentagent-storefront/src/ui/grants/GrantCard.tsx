// GrantCard — the zero-config entry point (spec 011 §The surface). Picks the highest-specificity
// fitting stock view automatically; `views` overrides the candidate set; `density="row"` delegates
// to the budgetMeter (A6). GrantList renders the dense multi-grant layout (≥3 grants, A7): compact
// rows with the literal per-row trust token, and ONE full trust sentence de-duplicated to the
// container footer — so repetition never trains the eye to skip the honesty line.

import type { CSSProperties } from "react";
import type { GrantSlots, GrantView, GrantViewData } from "./types";
import { Frame } from "./frame";
import { grantViews, budgetMeter } from "./views";
import { BudgetMeter } from "./BudgetMeter";
import { GrantActionsContext, type GrantActions } from "./actions";
import { grantTokens, compactTrustToken, fullTrustSentence, isTerminal, usd } from "./shared";
import styles from "./grants.module.css";

/** Host branding: only `--grant-accent` is overridable (status colors stay FIXED). */
const accentStyle = (accent?: string): CSSProperties | undefined =>
  accent ? ({ "--grant-accent": accent } as CSSProperties) : undefined;

/** Highest-scoring fitting view wins; array order is a stable tie-break only (A3). */
function selectView(grant: GrantViewData, candidates: GrantView[]): GrantView {
  let best: GrantView | undefined;
  let bestScore = -Infinity;
  for (const view of candidates) {
    const score = view.fits(grant);
    if (score === false) continue;
    if (score > bestScore) {
      best = view;
      bestScore = score;
    }
  }
  // A valid lifecycle always has a fit; fall back to the compact meter so a card never blanks.
  return best ?? budgetMeter;
}

export interface GrantCardProps {
  grant: GrantViewData;
  /** Override the candidate view set (e.g. `[grantViews.budgetMeter]`, or a custom view first). */
  views?: GrantView[];
  /** `row` renders the compact form (delegates to budgetMeter); default `card`. */
  density?: "card" | "row";
  slots?: GrantSlots;
  /** Host `branding.accent` — themes the healthy fill/links; status colors stay fixed. */
  accent?: string;
  /** Frame-owned affordances (open the approval page / revoke via the tool). */
  actions?: GrantActions;
}

export function GrantCard({ grant, views, density = "card", slots, accent, actions }: GrantCardProps) {
  const view = density === "row" ? budgetMeter : selectView(grant, views ?? grantViews.all);
  return (
    <div className={styles.gallery} style={accentStyle(accent)}>
      <GrantActionsContext.Provider value={actions ?? {}}>
        <Frame grant={grant} slots={slots} row={density === "row"}>
          {view.body({ grant, tokens: grantTokens, slots: slots ?? {} })}
        </Frame>
      </GrantActionsContext.Provider>
    </div>
  );
}

export interface GrantListProps {
  grants: GrantViewData[];
  accent?: string;
}

/** The dense multi-grant layout (A7). Each row keeps the literal `delegated-demo` token; the full
 *  trust sentence de-duplicates to the container footer. Use it for ≥ 3 grants (design §7). */
export function GrantList({ grants, accent }: GrantListProps) {
  return (
    <div className={styles.gallery} style={accentStyle(accent)}>
      <div className={styles.meterList}>
        {grants.map((grant) => (
          <div key={grant.id} className={styles.mrow}>
            <div className={styles.mName}>{grant.merchant}</div>
            <div className={styles.mVals}>
              {grant.lifecycle === "exhausted" ? `${usd(grant.budget)} of ${usd(grant.budget)} used` : `${usd(grant.remaining)} of ${usd(grant.budget)}`} · ≤{usd(grant.perSpend)}/purchase
            </div>
            <div className={styles.mBar}>
              <BudgetMeter grant={grant} compact frozen={isTerminal(grant.lifecycle)} />
            </div>
            <div className={styles.mLock}>{compactTrustToken(grant)}</div>
          </div>
        ))}
        {grants.length > 0 && <div className={styles.listTrust}>{fullTrustSentence(grants[0])}</div>}
      </div>
    </div>
  );
}
