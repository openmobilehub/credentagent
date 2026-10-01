// <BudgetMeter/> — the exported, validated meter primitive (spec 011 FR-3 / A4). Custom views
// reuse THIS instead of rebuilding a bar, so severity behavior, the cap bracket, and the screen-
// reader semantics stay correct everywhere.
//
// Form (design §3): a depleting horizontal bar, fill = REMAINING (anchored left, recedes as the
// agent spends). Severity comes from the server-derived lifecycle (A2 — never re-derived here):
// healthy = accent, low = FIXED amber, exhausted = FIXED red. The per-purchase cap is a fixed
// reference bracket beneath the track; when remaining < cap it overshoots the fill — the honest
// signal that the budget now caps the next purchase below the nominal limit.

import type { GrantViewData } from "./types";
import { usd } from "./shared";
import styles from "./grants.module.css";

const clampPct = (x: number): number => Math.max(0, Math.min(100, x));

export interface BudgetMeterProps {
  grant: GrantViewData;
  /** A terminal/closed grant: desaturated fill, cap shown as a record (no "next purchase" language). */
  frozen?: boolean;
  /** Dense-row form: render ONLY the slim track (the row supplies its own headline + cap caption). */
  compact?: boolean;
}

export function BudgetMeter({ grant, frozen = false, compact = false }: BudgetMeterProps) {
  const { budget, remaining, perSpend, lifecycle } = grant;
  const remainingPct = clampPct((remaining / budget) * 100);
  const capPct = clampPct((perSpend / budget) * 100);
  const crit = lifecycle === "exhausted";
  const low = lifecycle === "low";
  // When the remaining budget can no longer fund a full per-spend purchase, the cap bracket
  // overshoots the fill. On a frozen/terminal card there is no "next purchase", so we show the
  // nominal cap as a record instead.
  const overshoot = !frozen && remaining < perSpend && remaining > 0;

  const fillClass = frozen
    ? styles.meterFillFrozen
    : crit
      ? styles.meterFillCrit
      : low
        ? styles.meterFillLow
        : "";

  const valueText = `${usd(Math.max(0, remaining))} of ${usd(budget)} remaining · up to ${usd(perSpend)} per purchase`;

  const track = (
    <div
      className={styles.meterTrack}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={budget}
      aria-valuenow={Math.max(0, remaining)}
      aria-valuetext={valueText}
    >
      <div className={`${styles.meterFill} ${fillClass}`} style={{ width: `${crit ? 0 : remainingPct}%` }} aria-hidden="true" />
    </div>
  );

  if (compact) return track;

  return (
    <div className={styles.meter}>
      <div className={styles.budgetHead}>
        {crit ? (
          <>
            {usd(budget)} <span className={styles.budgetOf}>of {usd(budget)} used</span>
          </>
        ) : (
          <>
            {usd(remaining)} <span className={styles.budgetOf}>of {usd(budget)} remaining</span>
          </>
        )}
      </div>
      {track}
      <div className={styles.capwrap}>
        <div className={styles.cap} style={{ width: `${capPct}%` }} aria-hidden="true" />
        <div className={`${styles.capLabel} ${overshoot ? styles.capLabelOver : ""}`}>
          {overshoot ? `budget caps next purchase at ${usd(Math.max(0, remaining))}` : `up to ${usd(perSpend)} per purchase`}
        </div>
      </div>
    </div>
  );
}
