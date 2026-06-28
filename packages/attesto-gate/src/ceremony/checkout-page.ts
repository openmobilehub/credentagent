// renderRequirements() — ONE polished three-gate checkout page, served by both the
// committed demo and @openmobilehub/attesto-storefront. Driven by the `requires`
// manifest (the data `requirements()` emits) + this order's per-order verification
// state, so the page reflects exactly what the buyer has and hasn't done.
//
// ROUTE-AGNOSTIC. The renderer never hardcodes a ceremony route: each non-payment
// gate links to its own manifest entry's `approveUrl` (the demo's token-bearing
// `/credential-gate/*` link or the storefront's mounted `/attesto/*` link, both flow
// through unchanged). The payment section's affordances are supplied by the host
// (`PaymentMethod[]` + the place-order endpoint), so the demo can reproduce its rich
// passkey / cross-device / instant-demo group while a leaner host derives a single
// Pay CTA from the payment entry's `approveUrl`.
//
// Security note: this is PRESENTATION. The lock the page renders is render-only —
// every completion path (place-order, the rails' /verify handlers) re-enforces the
// age gate server-side (Security invariant 1). Hiding the payment group is not the
// control; it just keeps the UI honest about what the server will refuse.

import type { VerificationManifestEntry } from "../types.js";
import { pageHead, brandHeader, progressRail, trustFooter, type RailStep } from "./theme.js";

// ── Inputs ──────────────────────────────────────────────────────────────────

/** A priced order line — structurally a demo / storefront `PricedCartLine` (and a
 *  `CeremonyOrderLine`, whose name/currency are optional). */
export interface RenderOrderLine {
  /** Display name; falls back to the product id (or "Item") when absent. */
  name?: string;
  /** Product id — the name fallback when a re-priced line carries no name. */
  id?: string;
  quantity: number;
  lineTotal: number;
  /** ISO 4217; falls back to the order currency when the line omits it. */
  currency?: string;
}

/**
 * The priced order the page summarizes. Structural superset of both the demo's and
 * the storefront's `Order`, so either feeds the renderer with no mapping. Totals are
 * the catalog-re-derived ones (Security invariant 2 — never the token's).
 */
export interface RenderOrder {
  id: string;
  lines: RenderOrderLine[];
  /** Total item count; defaults to the summed line quantities when absent. */
  itemCount?: number;
  /** Discount in major units; the loyalty row renders only when > 0. */
  discount: number;
  total: number;
  currency: string;
}

/** Per-order verification state that drives the live gate status (never global). */
export interface RenderVerification {
  ageVerified?: boolean;
  loyaltyApplied?: boolean;
}

/** A recorded completion for THIS order — a revisit shows the paid state. */
export interface RenderPaid {
  amount: number;
  currency: string;
  method?: string;
  settlement?: {
    network: string;
    payer: { accountId: string };
    hashscanUrl: string;
  } | null;
}

/**
 * One selectable payment method in the locked-until-ready payment group. The host
 * supplies these so the renderer never hardcodes a route:
 *   • `href`   — selecting + paying navigates here (a gate page); OR
 *   • `placeOrder: true` — POSTs the order token to `placeOrderPath` (instant demo).
 */
export interface PaymentMethod {
  value: string;
  name: string;
  desc: string;
  /** Gate-page URL the Pay CTA navigates to when this method is chosen. */
  href?: string;
  /** This method completes by POSTing the order token to `placeOrderPath`. */
  placeOrder?: boolean;
  /** Selected by default (first method if none flagged). */
  checked?: boolean;
}

export interface PaymentOptions {
  /** The selectable methods (rendered as a radio group + one Pay CTA). */
  methods: PaymentMethod[];
  /** Where a `placeOrder` method POSTs `{ order }`. Default `/checkout/place-order`. */
  placeOrderPath?: string;
  /** The encoded order token the instant-demo method binds + POSTs. */
  orderToken?: string;
}

export interface RenderRequirementsOptions {
  /** Host-supplied payment affordances. Omitted ⇒ derive a single Pay CTA from the
   *  manifest's `authorize` entry (its `approveUrl`), if any. */
  payment?: PaymentOptions;
  /** A recorded completion for THIS order ⇒ render the paid state, not the methods. */
  paid?: RenderPaid | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The single honesty surface (FR-011 / Principle VII): every entry carries the same
// trust_level; state it once on the page (the shared discreet footer) so the gates
// never read as a real safety control. Suppressed only when the flow is issuer-verified.
function trustNote(entries: VerificationManifestEntry[]): string {
  if (entries[0]?.trust_level === "issuer-verified") return "";
  return trustFooter();
}

// Map the manifest to the three-step progress rail (Age · Membership · Pay) with live
// status, so the hub mirrors the same stepper the gate pages render. A gate the manifest
// doesn't carry simply doesn't appear; payment is always the trailing step.
function railSteps(
  gateEntries: VerificationManifestEntry[],
  ageVerified: boolean,
  loyaltyApplied: boolean,
  paid: boolean,
): RailStep[] {
  const steps: RailStep[] = [];
  for (const e of gateEntries) {
    if (e.effect === "gate" && e.credential === "age") steps.push({ label: "Age", done: ageVerified || paid });
    else if (e.effect === "discount") steps.push({ label: "Membership", done: loyaltyApplied || paid });
  }
  steps.push({ label: "Pay", done: paid });
  return steps;
}

// ── The page ──────────────────────────────────────────────────────────────────

/**
 * Render the unified checkout page: the order summary, the numbered gates (in policy
 * order, payment LAST) with live status, and the payment section — locked until every
 * blocking gate passes. The membership discount is reflected in the displayed total
 * via `order.discount` (the host re-prices server-side and passes the priced order).
 */
export function renderRequirements(
  order: RenderOrder,
  manifest: VerificationManifestEntry[],
  verification: RenderVerification = {},
  opts: RenderRequirementsOptions = {},
): string {
  const ageVerified = !!verification.ageVerified;
  const loyaltyApplied = !!verification.loyaltyApplied;
  const paid = opts.paid ?? null;

  // Payment settles last: split the manifest into the blocking/discount gates (kept
  // in declared order) and the single authorize entry, which becomes the payment
  // section. requirements() already sorts authorize last, but be explicit so a
  // hand-built manifest renders the same.
  const gateEntries = manifest.filter((e) => e.effect !== "authorize");
  const paymentEntry = manifest.find((e) => e.effect === "authorize");

  // A REQUIRED gate that isn't yet satisfied blocks payment. Age is the demo's
  // blocking gate; a discount never blocks (it's an opt-in saving).
  const isSatisfied = (e: VerificationManifestEntry): boolean => {
    if (e.effect === "gate" && e.credential === "age") return ageVerified;
    if (e.effect === "discount") return loyaltyApplied;
    return false;
  };
  const blocked = gateEntries.some((e) => e.required && e.effect === "gate" && !isSatisfied(e));

  // ── order summary ────────────────────────────────────────────────────────
  // A paid revisit arrives after completion CLEARED this order's verification, so a
  // re-priced order may have dropped the discount it was actually paid at and disagree
  // with the recorded `paid.amount`. Anchor the displayed total on that authoritative
  // amount, deriving the discount row from the line-sum − paid difference so the table
  // and the paid banner always agree (a host that pre-anchors gets the same numbers).
  const lineSum = order.lines.reduce((s, l) => s + l.lineTotal, 0);
  const displayTotal = paid ? paid.amount : order.total;
  const displayDiscount = paid
    ? Math.max(0, Math.round((lineSum - paid.amount) * 100) / 100)
    : order.discount;

  const rows = order.lines
    .map((l) => {
      const name = l.name ?? l.id ?? "Item";
      return `<tr class="line"><td>${escapeHtml(name)} <span class="qty">×${l.quantity}</span></td><td class="num">${formatMoney(l.lineTotal, l.currency ?? order.currency)}</td></tr>`;
    })
    .join("\n");
  const discountPct = manifest.find((e) => e.effect === "discount")?.discountPct;
  const discountRow =
    displayDiscount > 0
      ? `<tr class="disc"><td>Loyalty discount${discountPct != null ? ` (${discountPct}%)` : ""}</td><td class="num">-${formatMoney(displayDiscount, order.currency)}</td></tr>`
      : "";

  // ── numbered gates (live status) ───────────────────────────────────────────
  const gateSections = gateEntries
    .map((e, i) => renderGate(e, i + 1, isSatisfied(e)))
    .filter((s) => s !== "")
    .join("\n");

  // ── payment section (locked until the blocking gates pass) ─────────────────
  // Resolve the method list ONCE so the rendered group and its CTA script agree:
  // either the host's explicit methods, or a single Pay CTA derived from the
  // authorize entry's approveUrl (route-agnostic — works for any mounted rail).
  const methods: PaymentMethod[] =
    opts.payment?.methods ??
    (paymentEntry?.approveUrl
      ? [{ value: "pay", name: paymentEntry.label ?? "Authorize payment", desc: "Authorize on your device.", href: paymentEntry.approveUrl, checked: true }]
      : []);
  const paymentNumber = gateEntries.length + 1;
  const paidSection = paid ? renderPaid(paid) : "";
  // Calm, muted lock — never alarming. Keeps the literal "Payment is locked" the flow
  // tests pin, framed as a gentle "unlocks after age verification" message.
  const paymentSection = paid
    ? `<div class="card section">${paidSection}</div>`
    : blocked
      ? `<div class="lock">🔒 Payment is locked · unlocks after age verification</div>`
      : renderPayment(order, paymentNumber, methods);
  const placeScript = paid || blocked ? "" : renderPlaceScript(order, methods, opts.payment);

  // Progress rail mirrors the live gate status; current = first not-done step.
  const steps = railSteps(gateEntries, ageVerified, loyaltyApplied, !!paid);
  const rail = progressRail(steps, steps.findIndex((s) => !s.done));
  const itemCount = order.itemCount ?? order.lines.reduce((n, l) => n + l.quantity, 0);

  return `<!doctype html>
<html lang="en">
${pageHead(`Checkout · ${order.id}`)}
<body>
  <div class="wrap">
  ${brandHeader({ h1: "Checkout", tagline: "Prove it. Then pay." })}
  <div class="card summary">
    <p class="card-title">Order ${escapeHtml(order.id)} · ${itemCount} item(s)</p>
    <table>
    ${rows}
    ${discountRow}
    <tr class="total"><td>Total</td><td class="num">${formatMoney(displayTotal, order.currency)}</td></tr>
    </table>
  </div>

  ${rail}
  ${paid ? "" : gateSections}
  ${paymentSection}
  ${placeScript}
  ${paid ? "" : trustNote(manifest)}
  </div>
</body>
</html>`;
}

// One numbered gate card with live status (pending → ✓), built from its manifest
// entry. Links to the entry's OWN approveUrl (route-agnostic). Returns "" for a
// discount entry that the host renders no approve link for.
function renderGate(entry: VerificationManifestEntry, n: number, satisfied: boolean): string {
  // `step-no` is kept (tests + the rail both read off the numbered policy order); the
  // card chrome and teal accent come from the shared design system.
  const no = `<span class="step-no">${n}.</span>`;
  if (entry.effect === "discount") {
    const pct = entry.discountPct;
    return satisfied
      ? `<div class="card"><div class="row-ok">${no} ✓ Loyalty discount applied${pct != null ? ` (${pct}% off)` : ""}</div></div>`
      : entry.approveUrl
        ? `<div class="card"><a class="btn btn-secondary" href="${escapeHtml(entry.approveUrl)}">${no} Apply loyalty discount${pct != null ? ` (${pct}% off)` : ""}</a></div>`
        : "";
  }
  // gate effect (age):
  const age = entry.minAge ?? 21;
  if (satisfied) {
    return `<div class="card"><div class="row-ok">${no} ✓ Age verified — ${age}+</div></div>`;
  }
  const link = entry.approveUrl
    ? `<a class="btn btn-primary" href="${escapeHtml(entry.approveUrl)}">Verify age (${age}+)</a>`
    : "";
  return `<div class="card"><div class="row-pending">${no} 🔒 This order contains age-restricted items. Verify you're ${age} or older to continue.</div>${link ? `<div style="margin-top:12px;">${link}</div>` : ""}</div>`;
}

// The Shopify-style payment-method group (one radio group, one Pay CTA). The methods
// are resolved by the caller (host-supplied, or derived from the authorize entry's
// approveUrl) and shared with the CTA script so the two never disagree.
function renderPayment(order: RenderOrder, n: number, methods: PaymentMethod[]): string {
  const payLabel = `Pay ${formatMoney(order.total, order.currency)}`;
  if (methods.length === 0) return "";

  const anyChecked = methods.some((m) => m.checked);
  const rows = methods
    .map((m, i) => {
      const checked = m.checked ?? (!anyChecked && i === 0);
      return `    <label class="pm-row">
      <input type="radio" name="pm" value="${escapeHtml(m.value)}"${checked ? " checked" : ""} />
      <span class="pm-text"><span class="pm-name">${escapeHtml(m.name)}</span>
      <span class="pm-desc">${escapeHtml(m.desc)}</span></span>
    </label>`;
    })
    .join("\n");

  return `<div class="card">
  <h2 class="pm-head">${n}. Payment method</h2>
  <div class="pm-group" role="radiogroup" aria-label="Payment method">
${rows}
  </div>
  <button id="pay" class="btn btn-primary" style="margin-top:14px;">${payLabel}</button>
  <p class="small" style="text-align:center;margin:10px 0 0;">You'll confirm the exact amount with your device. Demo — no real charge.</p>
</div>`;
}

// The CTA script: selecting a method narrates the CTA; paying navigates to that
// method's href (a gate page) or POSTs the order token for the instant-demo method.
function renderPlaceScript(order: RenderOrder, methods: PaymentMethod[], payment: PaymentOptions | undefined): string {
  const payLabel = `Pay ${formatMoney(order.total, order.currency)}`;
  if (methods.length === 0) return "";
  const placePath = payment?.placeOrderPath ?? "/checkout/place-order";
  const token = payment?.orderToken ?? "";
  // value → { href? , placeOrder? } for the client to act on.
  const map: Record<string, { href?: string; placeOrder?: boolean }> = {};
  for (const m of methods) map[m.value] = { ...(m.href ? { href: m.href } : {}), ...(m.placeOrder ? { placeOrder: true } : {}) };

  return `<script>
    const METHODS = ${JSON.stringify(map)};
    const PAY_LABEL = ${JSON.stringify(payLabel)};
    const PLACE_PATH = ${JSON.stringify(placePath)};
    const ORDER_TOKEN = ${JSON.stringify(token)};
    const pay = document.getElementById('pay');
    if (pay) {
      const selected = () => document.querySelector('input[name="pm"]:checked').value;
      const relabel = () => {
        const m = METHODS[selected()] || {};
        pay.textContent = m.placeOrder ? 'Place order (instant demo)' : PAY_LABEL;
      };
      document.querySelectorAll('input[name="pm"]').forEach((r) => r.addEventListener('change', relabel));
      relabel();
      pay.addEventListener('click', async function () {
        const m = METHODS[selected()] || {};
        if (!m.placeOrder) { if (m.href) window.location.href = m.href; return; }
        this.disabled = true;
        this.textContent = 'Placing order…';
        try {
          const res = await fetch(PLACE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ order: ORDER_TOKEN }),
          });
          if (!res.ok) throw new Error('place-order failed: ' + res.status);
          this.textContent = 'Order placed ✓ (demo)';
        } catch (e) {
          this.disabled = false;
          this.textContent = 'Place order (instant demo)';
          alert('Could not place the order. Please try again.');
        }
      });
    }
  </script>`;
}

// The paid banner shown when revisiting an already-completed order. Settlement
// details (when present) carry the public on-chain proof.
function renderPaid(paid: RenderPaid): string {
  const via = paid.settlement ? " via x402" : paid.method === "passkey" ? " via passkey" : "";
  const banner = `<div class="receipt-banner">✓ Order paid · ${formatMoney(paid.amount, paid.currency)}${via}</div>`;
  const detail = paid.settlement
    ? `<p class="small" style="margin:0;">Settled on ${escapeHtml(paid.settlement.network)} · paid from ${escapeHtml(paid.settlement.payer.accountId)} · <a href="${escapeHtml(paid.settlement.hashscanUrl)}" target="_blank" rel="noopener">View on HashScan</a></p>`
    : `<p class="small" style="margin:0;">No on-chain settlement for this payment method.</p>`;
  return banner + detail;
}
