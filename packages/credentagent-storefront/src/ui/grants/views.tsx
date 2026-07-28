// The stock gallery (spec 011 FR-2). Each view is built with defineGrantView and selected by its
// declared `fits(grant)` specificity score (A3). The bodies below render ONLY the body; the frame
// (chrome + status + trust line) is owned by defineGrantView/Frame. The flagship is the
// productGrantCard — "buy me THIS one thing while I'm away" — so it scores highest among the
// active cards; the approvalCard (the consent moment) and terminalCard outrank the active cards.

import type { GrantViewData, GrantViewProduct } from "./types";
import { defineGrantView } from "./frame";
import { BudgetMeter } from "./BudgetMeter";
import { usd } from "./shared";
import styles from "./grants.module.css";

const active = (g: GrantViewData): boolean => g.lifecycle === "active" || g.lifecycle === "low";

// ── body helpers ────────────────────────────────────────────────────────────

function ProductTile({ product, perSpend }: { product: GrantViewProduct; perSpend: number }) {
  const units = Math.floor(perSpend / product.price);
  return (
    <div className={styles.ptile}>
      {product.image ? (
        <img className={styles.thumb} src={product.image} alt="" />
      ) : (
        <div className={styles.thumb} aria-hidden="true">🛍️</div>
      )}
      <div>
        <div className={styles.ptName}>{product.name}</div>
        <div className={styles.ptMeta}>{product.category} · {usd(product.price)} each</div>
        <div className={styles.ptQty}>up to <b>{units}</b> per purchase · {usd(units * product.price)} max</div>
      </div>
    </div>
  );
}

function ScopeChips({ categories, skus }: { categories: string[]; skus: string[] }) {
  return (
    <>
      {categories.length > 0 && (
        <div className={styles.chips} aria-label={`Allowed categories: ${categories.join(", ")}`}>
          {categories.map((c) => (
            <span key={c} className={`${styles.chip} ${styles.chipCat}`}>{c}</span>
          ))}
        </div>
      )}
      {skus.length > 0 && (
        <div className={styles.chips} aria-label={`Also allowed: ${skus.join(", ")}`}>
          <span className={styles.chipsLabel}>plus:</span>
          {skus.map((s) => (
            <span key={s} className={`${styles.chip} ${styles.chipSku}`}>{s}</span>
          ))}
        </div>
      )}
    </>
  );
}

// The Revoke / Approve / Decline affordances are NOT here — they are FRAME-OWNED (see ActionFooter
// in frame.tsx), so a view body receives only the inert `{ grant, tokens, slots }` and can never
// wire an action (spec A1 / design §9.1). Bodies below are pure display.

// ── stock views ──────────────────────────────────────────────────────────────

/** The flagship: a grant scoped to exactly one product, no categories. */
export const productGrantCard = defineGrantView({
  id: "product-grant-card",
  fits: (g) => (active(g) && g.allow.skus.length === 1 && g.allow.categories.length === 0 ? 70 : false),
  body: ({ grant }) => (
    <>
      {grant.product ? (
        <ProductTile product={grant.product} perSpend={grant.perSpend} />
      ) : (
        <div className={styles.scopeLede}>{grant.allow.skus[0]}</div>
      )}
      <BudgetMeter grant={grant} />
    </>
  ),
});

/** Categories (± explicit SKUs). Scope chips lead; the cap line is the only per-item ceiling. */
export const categoryGrantCard = defineGrantView({
  id: "category-grant-card",
  fits: (g) => (active(g) && (g.allow.categories.length > 0 || g.allow.skus.length > 0) ? 50 : false),
  body: ({ grant }) => (
    <>
      <div className={styles.scopeLede}>
        {grant.allow.categories.length > 0 ? `Anything in these categories at ${grant.merchant}` : `These items at ${grant.merchant}`}
      </div>
      <ScopeChips categories={grant.allow.categories} skus={grant.allow.skus} />
      <BudgetMeter grant={grant} />
    </>
  ),
});

/** No bounds — the money IS the scope. The card says so plainly (honest, not dressed up). */
export const openGrantCard = defineGrantView({
  id: "open-grant-card",
  fits: (g) => (active(g) && g.allow.categories.length === 0 && g.allow.skus.length === 0 ? 40 : false),
  body: ({ grant }) => (
    <>
      <div className={styles.scopeLede}>🏬 Anything at {grant.merchant}</div>
      <div className={styles.scopeSub}>No product limits on this grant — the budget and per-purchase cap carry all the limits.</div>
      <BudgetMeter grant={grant} />
    </>
  ),
});

/** The consent moment. WHAT → HOW MUCH → WHO, then equal-weight Approve/Decline. */
export const approvalCard = defineGrantView({
  id: "approval-card",
  fits: (g) => (g.status === "pending" ? 100 : false),
  body: ({ grant }) => (
    <>
      <h2 className={styles.apprH1}>Approve a spending grant</h2>
      <p className={styles.apprLede}>Your agent will spend at {grant.merchant} while you&apos;re away. Here&apos;s exactly what you&apos;re allowing:</p>
      <div className={styles.scopeBlock}>
        <div className={styles.sbLabel}>What</div>
        {grant.product ? (
          <div>
            <b>{grant.product.name}</b> — {usd(grant.product.price)}
            <div className={styles.ptMeta}>{grant.product.category} · up to {Math.floor(grant.perSpend / grant.product.price)} per purchase</div>
          </div>
        ) : grant.allow.categories.length > 0 || grant.allow.skus.length > 0 ? (
          <ScopeChips categories={grant.allow.categories} skus={grant.allow.skus} />
        ) : (
          <div>Anything at {grant.merchant} — <b>no product limits</b></div>
        )}
      </div>
      <div className={styles.scopeBlock}>
        <div className={styles.sbLabel}>How much</div>
        <div className={styles.moneyRow}>
          <span className={styles.moneyAmt}>{usd(grant.budget)}</span>
          <span className={styles.moneyLbl}>total</span>
          <span className={styles.moneyDivider}>·</span>
          <span className={styles.moneyAmt}>{usd(grant.perSpend)}</span>
          <span className={styles.moneyLbl}>per purchase</span>
        </div>
      </div>
      <div className={styles.scopeBlock}>
        <div className={styles.sbLabel}>Who</div>
        <div className={styles.whoText}>Your agent spends <b>unattended</b> until the budget runs out — or you revoke it.</div>
      </div>
    </>
  ),
});

function terminalCopy(grant: GrantViewData): { line: string; sub: string } {
  if (grant.lifecycle === "exhausted") return { line: `Budget spent — ${usd(grant.budget)} of ${usd(grant.budget)} used`, sub: "This grant is closed." };
  if (grant.lifecycle === "revoked") return { line: "Revoked", sub: "No further purchases will be made." };
  return { line: "Declined", sub: "This grant was never activated." };
}

/** Terminal states — closed objects, no live affordances (design §4.6). */
export const terminalCard = defineGrantView({
  id: "terminal-card",
  fits: (g) => (g.lifecycle === "exhausted" || g.lifecycle === "revoked" || g.lifecycle === "denied" ? 90 : false),
  body: ({ grant }) => {
    const { line, sub } = terminalCopy(grant);
    const scope = grant.product
      ? grant.product.name
      : grant.allow.categories.length > 0
        ? grant.allow.categories.join(" + ")
        : grant.allow.skus.length > 0
          ? grant.allow.skus.join(" + ")
          : `Anything at ${grant.merchant}`;
    return (
      <>
        <div className={styles.scopeLede}>{scope}</div>
        {grant.lifecycle !== "denied" && <BudgetMeter grant={grant} frozen />}
        <div>
          <div className={styles.terminalLine}>{line}</div>
          <div className={styles.terminalSub}>{sub}</div>
        </div>
      </>
    );
  },
});

/** Compact one-line meter for dense layouts (and the row density). Lowest score, so it only wins
 *  card selection when chosen explicitly or via density; it is also the per-row form of GrantList. */
export const budgetMeter = defineGrantView({
  id: "budget-meter",
  row: true,
  fits: (g) => (active(g) ? 10 : false),
  body: ({ grant }) => (
    <div className={styles.meter}>
      <div className={styles.mName}>{grant.merchant}</div>
      <div className={styles.mVals}>
        {grant.lifecycle === "exhausted" ? `${usd(grant.budget)} of ${usd(grant.budget)} used` : `${usd(grant.remaining)} of ${usd(grant.budget)}`} · ≤{usd(grant.perSpend)}/purchase
      </div>
      <BudgetMeter grant={grant} compact />
    </div>
  ),
});

/** The gallery. `all` is the default candidate set (highest-scoring fitting view wins). */
export const grantViews = {
  productGrantCard,
  categoryGrantCard,
  openGrantCard,
  approvalCard,
  terminalCard,
  budgetMeter,
  all: [approvalCard, terminalCard, productGrantCard, categoryGrantCard, openGrantCard, budgetMeter],
};
