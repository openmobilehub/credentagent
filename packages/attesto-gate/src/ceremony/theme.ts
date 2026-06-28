// theme.ts — the SHARED Attesto design system for the browser ceremony flow.
//
// The checkout hub (checkout-page.ts) and the two gate pages (credential-gate/page.ts,
// dc-payment/page.ts) all render through THIS module so they read as ONE branded flow:
// the same wordmark, the same card surfaces, the same teal accent, the same discreet
// honesty footer. Each page composes the pieces below around its OWN logic — the chrome
// is presentation-only and never touches a completion path.
//
// Design language (opinionated, build to this):
//   • ONE accent — teal #0d9488 (hover #0f766e). Used sparingly: primary CTA, active
//     step, the discount row, a verified ✓.
//   • ink #0f172a · muted #64748b · hairline #e2e8f0 · surface #fff on app bg #f8fafc.
//   • success #047857 · danger #b91c1c.
//   • System type stack. Money is tabular-nums. Single column, max-width 460px, 14px
//     card radius, a soft two-layer shadow, mobile-first (great at 390px).
//
// Honesty (FR-011 / Principle VII): the trust footer is the single presence-only surface.
// It MUST keep the literal token "presence-only-demo" so the honesty tests and the FR
// stay satisfied — the wire crypto is real; the issuer trust anchor is not.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

// ── The design-system stylesheet ────────────────────────────────────────────
// One <style> block shared by all three pages so they are visually identical chrome.
// Pages add only the few component styles unique to them (e.g. the QR notice).
const DESIGN_CSS = `
  :root {
    --accent: #0d9488; --accent-hover: #0f766e;
    --ink: #0f172a; --muted: #64748b; --hairline: #e2e8f0;
    --surface: #ffffff; --app-bg: #f8fafc;
    --success: #047857; --danger: #b91c1c;
    --shadow: 0 1px 3px rgba(15,23,42,.08), 0 1px 2px rgba(15,23,42,.04);
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
    background: var(--app-bg); color: var(--ink);
    margin: 0; padding: 20px 16px 40px;
    line-height: 1.55; -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 460px; margin: 0 auto; }
  h1 { font-size: 1.5rem; font-weight: 700; line-height: 1.2; margin: 0 0 6px; color: var(--ink); }
  p.lede { font-size: .95rem; color: var(--muted); margin: 0 0 4px; }
  small, .small { font-size: .8rem; color: var(--muted); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }

  /* Brand header */
  .brand { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  .wordmark { font-size: .78rem; letter-spacing: .22em; font-weight: 700; color: var(--muted); }
  .demo-pill {
    font-size: .62rem; letter-spacing: .14em; font-weight: 700; color: var(--muted);
    border: 1px solid var(--hairline); border-radius: 999px; padding: 3px 9px; background: var(--surface);
  }
  .head { margin-bottom: 18px; }
  .head .tagline { font-size: .95rem; color: var(--muted); margin: 0; }

  /* Card surface */
  .card {
    background: var(--surface); border: 1px solid var(--hairline);
    border-radius: 14px; box-shadow: var(--shadow);
    padding: 18px; margin-bottom: 16px;
  }
  .card-title { font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); font-weight: 700; margin: 0 0 12px; }

  /* Order summary */
  .summary table { width: 100%; border-collapse: collapse; }
  .summary td { padding: 8px 0; font-size: .95rem; }
  .summary .line td { border-bottom: 1px solid var(--hairline); }
  .summary .qty { color: var(--muted); font-variant-numeric: tabular-nums; }
  .summary .disc td { color: var(--accent); font-weight: 600; }
  .summary .total td { padding-top: 12px; border-top: 1px solid var(--hairline); font-weight: 700; font-size: 1.05rem; }

  /* Progress rail (Age · Membership · Pay) */
  .rail { display: flex; align-items: flex-start; justify-content: space-between; position: relative; margin: 4px 2px 18px; }
  .rail::before { content: ""; position: absolute; top: 11px; left: 11%; right: 11%; height: 2px; background: var(--hairline); z-index: 0; }
  .rail-step { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; flex: 1; }
  .rail-dot {
    width: 22px; height: 22px; border-radius: 999px; background: var(--surface);
    border: 2px solid var(--hairline); display: flex; align-items: center; justify-content: center;
    font-size: .7rem; font-weight: 700; color: var(--muted);
  }
  .rail-step.done .rail-dot { background: var(--accent); border-color: var(--accent); color: #fff; }
  .rail-step.current .rail-dot { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 0 3px rgba(13,148,136,.14); }
  .rail-label { font-size: .68rem; letter-spacing: .02em; color: var(--muted); text-align: center; }
  .rail-step.done .rail-label, .rail-step.current .rail-label { color: var(--ink); font-weight: 600; }

  /* Buttons */
  .btn {
    display: block; width: 100%; height: 48px; line-height: 1; border-radius: 10px;
    font-size: .95rem; font-weight: 600; text-align: center; text-decoration: none;
    border: 1px solid transparent; cursor: pointer; transition: background .12s, transform .04s;
    display: flex; align-items: center; justify-content: center;
  }
  .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn-primary:active { transform: translateY(1px); }
  .btn-secondary { background: transparent; color: var(--accent); border-color: var(--hairline); }
  .btn-secondary:hover { border-color: var(--accent); }
  .btn-danger { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn + .btn { margin-top: 10px; }
  .btn:disabled { opacity: .55; cursor: default; }

  /* Status rows + verify log */
  .row-ok { color: var(--success); font-weight: 600; font-size: .95rem; display: flex; align-items: center; gap: 8px; }
  .row-pending { color: var(--ink); font-size: .95rem; }
  .step { padding: 5px 0; font-size: .85rem; display: flex; gap: 8px; align-items: baseline; }
  .step.ok { color: var(--success); }
  .step.err { color: var(--danger); white-space: pre-wrap; }
  .notice {
    margin-top: 14px; padding: 12px 14px; background: #f1f5f9; border: 1px solid var(--hairline);
    border-radius: 10px; font-size: .88rem; color: var(--ink);
  }

  /* Payment-method group (Shopify-style radio group + one Pay CTA) */
  .pm-head { font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); font-weight: 700; margin: 0 0 12px; }
  .pm-group { border: 1px solid var(--hairline); border-radius: 10px; overflow: hidden; }
  .pm-row { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; cursor: pointer; border-bottom: 1px solid var(--hairline); }
  .pm-row:last-child { border-bottom: none; }
  .pm-row:has(input:checked) { background: #f0fdfa; box-shadow: inset 3px 0 0 var(--accent); }
  .pm-row input { margin-top: 3px; accent-color: var(--accent); }
  .pm-name { display: block; font-size: .9rem; font-weight: 600; color: var(--ink); }
  .pm-desc { display: block; font-size: .8rem; color: var(--muted); margin-top: 2px; }
  .step-no { display: inline-block; min-width: 1.4em; color: var(--muted); font-variant-numeric: tabular-nums; }

  /* Calm payment-lock state (never alarming) */
  .lock {
    display: flex; align-items: center; gap: 8px; justify-content: center;
    color: var(--muted); font-size: .9rem; padding: 14px;
    background: #f1f5f9; border: 1px solid var(--hairline); border-radius: 10px;
  }

  /* Discreet trust footer */
  .trust { margin-top: 22px; text-align: center; }
  .trust .trust-line { font-size: .78rem; color: var(--muted); }

  /* Tidy success / receipt card */
  .receipt-banner {
    background: var(--accent); color: #fff; border-radius: 12px; padding: 16px;
    text-align: center; font-weight: 700; font-size: 1.05rem; margin-bottom: 12px;
  }
  .receipt-banner .sub { font-weight: 500; font-size: .85rem; opacity: .95; margin-top: 4px; }
  .receipt-banner a { color: #fff; text-decoration: underline; }
`;

/** <head> with the shared design-system CSS. `extraCss` lets a page add the few
 *  component styles unique to it without forking the design language. */
export function pageHead(title: string, extraCss = ""): string {
  return `<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${DESIGN_CSS}${extraCss}</style>
</head>`;
}

/** The ATTESTO wordmark + a discreet DEMO pill, with an optional confident h1 +
 *  identity-first tagline underneath. Pass `h1`/`tagline` to render the heading block;
 *  omit them to render just the brand row (a page can lay out its own heading). */
export function brandHeader(opts: { h1?: string; tagline?: string } = {}): string {
  const heading =
    opts.h1 != null
      ? `<div class="head"><h1>${escapeHtml(opts.h1)}</h1>${opts.tagline != null ? `<p class="tagline">${escapeHtml(opts.tagline)}</p>` : ""}</div>`
      : "";
  return `<div class="brand"><span class="wordmark">ATTESTO</span><span class="demo-pill">DEMO</span></div>${heading}`;
}

// ── Order summary card ──────────────────────────────────────────────────────

export interface OrderSummaryLine {
  /** Display label (e.g. "Oak Whiskey"). */
  name: string;
  quantity: number;
  lineTotal: number;
  /** ISO 4217; falls back to the card currency. */
  currency?: string;
}

export interface OrderSummaryArgs {
  lines: OrderSummaryLine[];
  total: number;
  /** Major-units discount; the accent row renders only when > 0. */
  discount?: number;
  currency: string;
  /** Optional label on the discount row, e.g. "Loyalty discount (10%)". */
  discountLabel?: string;
  /** Optional caption above the table (e.g. "Order ORD-1 · 2 items"). */
  caption?: string;
}

/** The order summary card: line items, an accent discount row, a bold Total with a
 *  top hairline. Money is tabular. Shared by all three pages so the cart reads the
 *  same everywhere. */
export function orderSummaryCard(args: OrderSummaryArgs): string {
  const cur = args.currency;
  const rows = args.lines
    .map(
      (l) =>
        `<tr class="line"><td>${escapeHtml(l.name)} <span class="qty">×${l.quantity}</span></td><td class="num">${money(l.lineTotal, l.currency ?? cur)}</td></tr>`,
    )
    .join("\n");
  const discount = args.discount ?? 0;
  const discRow =
    discount > 0
      ? `<tr class="disc"><td>${escapeHtml(args.discountLabel ?? "Discount")}</td><td class="num">-${money(discount, cur)}</td></tr>`
      : "";
  const caption = args.caption ? `<p class="card-title">${escapeHtml(args.caption)}</p>` : "";
  return `<div class="card summary">
  ${caption}<table>
    ${rows}
    ${discRow}
    <tr class="total"><td>Total</td><td class="num">${money(args.total, cur)}</td></tr>
  </table>
</div>`;
}

// ── Progress rail ───────────────────────────────────────────────────────────

export interface RailStep {
  label: string;
  /** true once this step's verification is recorded. */
  done?: boolean;
}

/**
 * The Age · Membership · Pay stepper. DONE = filled accent with ✓; CURRENT (the step
 * at `currentIndex`, when not already done) = accent ring; everything else = muted.
 * The hub passes real status; each gate page marks its OWN step current.
 */
export function progressRail(steps: RailStep[], currentIndex: number): string {
  if (steps.length === 0) return "";
  const dots = steps
    .map((s, i) => {
      const isDone = !!s.done;
      const isCurrent = i === currentIndex && !isDone;
      const cls = isDone ? "done" : isCurrent ? "current" : "";
      const mark = isDone ? "✓" : String(i + 1);
      return `<div class="rail-step ${cls}"><div class="rail-dot">${mark}</div><div class="rail-label">${escapeHtml(s.label)}</div></div>`;
    })
    .join("");
  return `<div class="rail" role="list" aria-label="Progress">${dots}</div>`;
}

// ── Trust footer ────────────────────────────────────────────────────────────

/**
 * The single, DISCREET presence-only honesty line (replaces the old yellow warning
 * box). It MUST keep the literal "presence-only-demo" token (FR-011 + the honesty
 * tests) — the wire crypto is real; the issuer trust anchor is not.
 */
export function trustFooter(): string {
  return `<div class="trust"><div class="trust-line">🔒 presence-only-demo · secured by Attesto · the wire crypto is real; issuer trust anchor is not</div></div>`;
}
