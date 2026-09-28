// theme.ts — the SHARED CredentAgent design system for the browser ceremony flow.
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

import type { Branding } from "../types.js";
import type { CompletionRefusalReason } from "./types.js";
import { INSPECTOR_URL, VERIFIER_URL, X509_URL } from "./inspect.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

// ── Branding sanitizers — the single escaping choke point ────────────────────
// Branding is host-supplied and lands on a consent page the BUYER sees, so every value is
// validated/escaped HERE, at the one point it is interpolated, before it can become HTML/CSS.
// The rule is allowlist-and-drop: a value that isn't provably safe falls back to the default,
// so a malformed or hostile input can never break the stylesheet or inject markup.

// A CSS colour we will drop verbatim into a stylesheet. The grammars admit only characters
// that cannot escape a CSS value or the surrounding <style> (no `<`, `>`, `"`, `;`, `{`, `}`):
// a hex colour or a numeric rgb()/hsl() functional colour. We do NOT accept a bare word — a
// misspelled "purpel" is not a real colour and would emit an INVALID `var(--accent)` instead
// of falling back to the built-in teal, breaking the allowlist-and-drop promise. Hosts that
// want a named colour can pass its hex.
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_COLOR = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/]+\)$/i;

/** Return the accent only if it is a recognized, injection-safe CSS colour; else undefined. */
function safeAccent(accent: string): string | undefined {
  const a = accent.trim();
  return HEX_COLOR.test(a) || FUNC_COLOR.test(a) ? a : undefined;
}

/** Derive a slightly darker hover shade. A 3/6-digit hex is darkened numerically (max browser
 *  support for the documented hex case); any other safe colour uses `color-mix` toward black. */
function accentHover(accent: string): string {
  const hex = accent.startsWith("#") ? accent.slice(1) : "";
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (full.length === 6 && /^[0-9a-fA-F]{6}$/.test(full)) {
    const darker = [0, 2, 4]
      .map((i) => Math.round(parseInt(full.slice(i, i + 2), 16) * 0.86))
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    return `#${darker}`;
  }
  return `color-mix(in srgb, ${accent} 86%, #000)`;
}

// A logo URL we will drop into an <img src>. Allowlist the schemes that are safe to load as an
// image; anything else (e.g. `javascript:`) is dropped so the wordmark shows instead. The value
// is STILL HTML-escaped at interpolation, so quote-breakout is impossible regardless.
function safeLogo(logo: string): string | undefined {
  const l = logo.trim();
  return /^data:image\/[a-z0-9.+-]+[,;]/i.test(l) || /^https?:\/\//i.test(l) || /^\/(?!\/)/.test(l) ? l : undefined;
}

/** The branding style overrides appended after the design system, so a later `:root`
 *  declaration wins. Emits NOTHING when there is no accent/logo to override — keeping the
 *  no-branding output byte-for-byte identical to the built-in look. */
function brandingCss(branding?: Branding): string {
  if (!branding) return "";
  let css = "";
  const accent = branding.accent ? safeAccent(branding.accent) : undefined;
  if (accent) css += `:root{--accent:${accent};--accent-hover:${accentHover(accent)};}`;
  if (branding.logo && safeLogo(branding.logo)) css += `.brand-logo{height:20px;width:auto;display:block;}`;
  return css;
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

  /* Prominent end-of-ceremony handoff — shown when the WHOLE ceremony is done
     (payment is the last gate). Bigger than the inline receipt banner: the order is
     complete and the buyer can close the window; the agent (MCP host) polls
     order-status and continues the conversation. */
  .complete-banner {
    background: var(--accent); color: #fff; border-radius: 14px; padding: 22px 18px 20px;
    text-align: center; margin-bottom: 14px; box-shadow: var(--shadow);
    position: relative; overflow: hidden;
  }
  /* The light streak that sweeps left → right as the banner arrives (completedViewScript). */
  .complete-banner .whoosh {
    position: absolute; top: 0; left: 0; width: 35%; height: 100%; pointer-events: none;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,.45), transparent);
  }
  .complete-banner .big { font-size: 1.35rem; font-weight: 800; line-height: 1.2; }
  .complete-banner .sub { font-weight: 500; font-size: .92rem; opacity: .97; margin-top: 8px; line-height: 1.5; }
  .complete-banner .sub strong { font-weight: 800; }
  .complete-banner .ret { display: inline-block; margin-top: 12px; font-size: .82rem; opacity: .92; }
  .complete-banner a { color: #fff; text-decoration: underline; }
  /* A real, high-contrast button (white on the accent banner) — the one action left. */
  .complete-banner .close-btn {
    display: block; width: 100%; margin-top: 16px; padding: 14px 18px; border: 0; border-radius: 12px;
    background: #fff; color: var(--accent); font: inherit; font-weight: 800; font-size: 1.05rem;
    cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.15);
  }
  /* Fallback (the browser refused window.close()): no longer an action, just an
     instruction — an outlined note, so it stops inviting another tap. */
  .complete-banner .close-btn:disabled {
    cursor: default; box-shadow: none; background: transparent; color: #fff;
    outline: 2px solid rgba(255,255,255,.85); outline-offset: -2px;
  }

  /* The finished page (body.completed, set by completedViewScript): the handoff banner
     leads at the top, the now-pointless pay controls go away, and the technical receipt
     folds into "Payment details" — so "you're done, close this window" is the first and
     loudest thing on screen instead of a banner below the fold. */
  body.completed .wrap > .head,
  body.completed .card .lede,
  body.completed .card .btn,
  body.completed .card .toggle,
  body.completed #log,
  body.completed .settling-bar { display: none !important; }
  body.completed #receipt { margin-top: 0 !important; }
  body.completed .receipt-details summary { cursor: pointer; font-size: .85rem; font-weight: 600; color: var(--muted); }
  body.completed .receipt-details[open] summary { margin-bottom: 8px; }

  /* Indeterminate settling bar — shown while x402 settles on-chain (~10s). A teal
     sliver slides across a hairline track so the buyer sees the wait is live work,
     not a hang. Hidden until a page adds .on; both payment rails use it. */
  .settling-bar { display: none; margin: 14px 0 2px; height: 6px; background: var(--hairline); border-radius: 999px; overflow: hidden; }
  .settling-bar.on { display: block; }
  .settling-bar > i { display: block; width: 35%; height: 100%; background: var(--accent); border-radius: 999px; animation: settle-slide 1.15s ease-in-out infinite; }
  @keyframes settle-slide { from { margin-left: -35%; } to { margin-left: 100%; } }

  /* x402 settlement receipt — on-chain proof, design-system styled. The settle card
     reuses the surface chrome; the teal left rail marks it as the success path. */
  .settle {
    margin-top: 14px; padding: 14px 16px; background: #f0fdfa;
    border: 1px solid var(--hairline); border-left: 3px solid var(--accent);
    border-radius: 10px;
  }
  .settle .settle-head { font-weight: 700; font-size: .95rem; color: var(--success); margin: 0 0 8px; }
  .settle dl.kv { display: grid; grid-template-columns: 64px 1fr; gap: 4px 12px; margin: 0; font-size: .9rem; }
  .settle dl.kv dt { color: var(--muted); font-size: .8rem; padding-top: 1px; }
  .settle dl.kv dd { margin: 0; word-break: break-word; }
  .settle .dim { color: var(--muted); font-weight: 400; font-size: .78rem; }
  .settle .mono { font-family: ui-monospace, Menlo, monospace; font-size: .78rem; word-break: break-all; }
  /* Prominent, tappable HashScan link — the buyer is on their phone; one tap to the
     live explorer is the third-party proof (no QR; the package has no qr route). */
  .settle .hashscan {
    display: flex; align-items: center; justify-content: center; gap: 8px;
    margin-top: 12px; height: 44px; border-radius: 10px;
    background: var(--accent); color: #fff; font-weight: 600; font-size: .92rem;
    text-decoration: none;
  }
  .settle .hashscan:hover { background: var(--accent-hover); }
  /* Calm "authorized, not settled" line — never alarming red wall; a muted danger row. */
  .settle-failed {
    margin-top: 14px; padding: 12px 14px; background: #fef2f2;
    border: 1px solid var(--hairline); border-left: 3px solid var(--danger);
    border-radius: 10px; font-size: .88rem; color: var(--danger);
  }
  /* A refused completion: the same calm, muted treatment as settle-failed — the buyer
     needs the OUTCOME and their next step, not an alarming wall. */
  .refusal {
    margin-top: 14px; padding: 12px 14px; background: #fef2f2;
    border: 1px solid var(--hairline); border-left: 3px solid var(--danger);
    border-radius: 10px; font-size: .88rem; color: var(--ink);
  }
  .refusal .refusal-head { font-weight: 700; color: var(--danger); margin-bottom: 4px; }
  .refusal .refusal-detail { color: var(--ink); }
  .refusal .ret { display: inline-block; margin-top: 8px; color: var(--accent); font-weight: 600; text-decoration: none; }
`;

/** <head> with the shared design-system CSS. `extraCss` lets a page add the few
 *  component styles unique to it without forking the design language. `branding` (from
 *  `new CredentAgent({ branding })`) appends the host's accent/logo overrides after the
 *  design system — omitted ⇒ the built-in look, byte-for-byte. */
export function pageHead(title: string, extraCss = "", branding?: Branding): string {
  return `<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${DESIGN_CSS}${extraCss}${brandingCss(branding)}</style>
</head>`;
}

/** The wordmark + a discreet DEMO pill, with an optional confident h1 + identity-first
 *  tagline underneath. Pass `h1`/`tagline` to render the heading block; omit them to render
 *  just the brand row (a page can lay out its own heading). `branding` swaps the wordmark for
 *  the host's (or its logo) and can hide the DEMO pill; omitted ⇒ the CREDENTAGENT wordmark +
 *  DEMO pill, byte-for-byte. The honesty trust footer is NOT branded (see `trustFooter`). */
export function brandHeader(opts: { h1?: string; tagline?: string } = {}, branding?: Branding): string {
  const heading =
    opts.h1 != null
      ? `<div class="head"><h1>${escapeHtml(opts.h1)}</h1>${opts.tagline != null ? `<p class="tagline">${escapeHtml(opts.tagline)}</p>` : ""}</div>`
      : "";
  // Kept RAW and escaped at each interpolation point (the module's escape-once-at-use rule),
  // so neither the alt attribute nor the wordmark span can double-escape a value like "A&B".
  const wordmark = branding?.wordmark || "CREDENTAGENT";
  const logo = branding?.logo ? safeLogo(branding.logo) : undefined;
  const brandLeft = logo
    ? `<img class="brand-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(wordmark)}" />`
    : `<span class="wordmark">${escapeHtml(wordmark)}</span>`;
  const pill = branding?.demoPill === false ? "" : `<span class="demo-pill">DEMO</span>`;
  return `<div class="brand">${brandLeft}${pill}</div>${heading}`;
}

/** An indeterminate "settling…" progress bar (hidden until JS adds `.on`). Shown on
 *  the payment rails while x402 settlement runs on-chain (~10s) so the wait reads as
 *  live work. `id` defaults to "settling" for the page script to toggle. */
export function settlingBar(id = "settling"): string {
  return `<div class="settling-bar" id="${id}"><i></i></div>`;
}

/**
 * The prominent end-of-ceremony handoff banner: every attestation + payment is done,
 * so the order is COMPLETE. It tells the buyer they can close the window and continue
 * in their agent — the MCP host polls order-status and resumes the conversation
 * automatically (Mode A: the agent never runs the ceremony, it only orchestrates +
 * polls). An optional secondary link returns to the checkout hub for a pure-browser
 * flow. Built server-side and embedded into the gate page's receipt script.
 */
export function completionHandoffBanner(returnUrl?: string): string {
  const ret = returnUrl
    ? `<a class="ret" href="${escapeHtml(returnUrl)}">Staying in the browser? Return to checkout ›</a>`
    : "";
  return `<div class="complete-banner"><div class="big">✓ Order complete</div><div class="sub">Your agent has your order and will pick up from here. You can close this window and continue in your agent.</div>${closeWindowButton()}${ret ? `<div>${ret}</div>` : ""}</div>`;
}

/**
 * The "Close this window" button on the completion banners. It tries `window.close()`;
 * browsers only honour that for windows a script opened, so if the page is still here a
 * moment later the button turns into a plain instruction instead of silently doing nothing.
 */
export function closeWindowButton(): string {
  return `<button type="button" class="close-btn" onclick="var b=this;window.close();setTimeout(function(){b.textContent='Close this tab to return to your agent';b.disabled=true;},300)">Close this window</button>`;
}

/**
 * Client-side statement (embed inside a pay rail's completion handler, after the receipt
 * is rendered into `#receipt`): turn the page into a finished screen. It lifts the
 * `.complete-banner` to the top of the page (right under the brand header), hides the pay
 * controls via `body.completed`, folds the rest of the receipt (mandate id, gates,
 * settlement proof) into a collapsed "Payment details", and scrolls to the top — so on a
 * phone the buyer sees "close this window" first, not a disabled button above the fold.
 */
export function completedViewScript(): string {
  return `(function(){document.body.classList.add("completed");var b=document.querySelector("#receipt .complete-banner");var w=document.querySelector(".wrap");if(b&&w){var h=w.querySelector(".head")||w.querySelector(".brand");if(h)h.insertAdjacentElement("afterend",b);else w.prepend(b);}var r=document.getElementById("receipt");if(r&&r.firstChild){var d=document.createElement("details");d.className="receipt-details";var s=document.createElement("summary");s.textContent="Payment details";d.appendChild(s);while(r.firstChild)d.appendChild(r.firstChild);r.appendChild(d);}window.scrollTo(0,0);if(b)requestAnimationFrame(function(){${entranceScript()}});})();`;
}

/**
 * Client-side statement: the banner's entrance (the variable `b` in `completedViewScript`).
 * A light streak whooshes across the banner left → right, "✓ Order complete" is revealed
 * left → right right behind it, the sub-text and Close button fade up just after, and the
 * confetti fires as the headline lands — all in under a second. Skipped entirely under
 * `prefers-reduced-motion` (the banner then simply appears).
 */
function entranceScript(): string {
  return `if(!b.animate||matchMedia("(prefers-reduced-motion: reduce)").matches)return;var big=b.querySelector(".big");var s=document.createElement("span");s.className="whoosh";b.appendChild(s);s.animate([{transform:"translateX(-120%) skewX(-20deg)",opacity:0},{opacity:1,offset:0.2},{transform:"translateX(320%) skewX(-20deg)",opacity:0}],{duration:650,easing:"cubic-bezier(.3,.7,.3,1)",fill:"forwards"}).onfinish=function(){s.remove();};if(big)big.animate([{clipPath:"inset(0 100% 0 0)",transform:"translateX(-14px)",opacity:0.4},{clipPath:"inset(0 0 0 0)",transform:"translateX(0)",opacity:1}],{duration:520,delay:60,easing:"cubic-bezier(.2,.8,.2,1)",fill:"backwards"});[].forEach.call(b.querySelectorAll(".sub,.close-btn,.ret"),function(el,i){el.animate([{opacity:0,transform:"translateY(6px)"},{opacity:1,transform:"none"}],{duration:320,delay:420+i*70,easing:"ease-out",fill:"backwards"});});setTimeout(function(){${confettiScript()}},380);`;
}

/**
 * Client-side statement: a short, subtle confetti burst from the `.complete-banner` (the
 * variable `b` in `completedViewScript`) — ~40 small pieces that pop up, drift down and
 * fade out in under two seconds, then remove themselves. It only runs at the live moment
 * of completion (never when revisiting a paid order), is skipped under
 * `prefers-reduced-motion`, and uses the Web Animations API — no library, no CSS keyframes.
 */
function confettiScript(): string {
  return `if(!b.animate||matchMedia("(prefers-reduced-motion: reduce)").matches)return;var R=b.getBoundingClientRect();var acc=getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()||"#0f8a7e";var C=[acc,"#f5c451","#ff8fa3","#7dd3fc","#a7f3d0"];for(var i=0;i<40;i++){var p=document.createElement("i");var w=4+Math.random()*4;p.style.cssText="position:fixed;z-index:9999;pointer-events:none;border-radius:1px;width:"+w+"px;height:"+(w*1.6)+"px;left:"+(R.left+R.width*(0.15+Math.random()*0.7))+"px;top:"+(R.top+24)+"px;background:"+C[i%C.length];document.body.appendChild(p);var dx=(Math.random()-0.5)*180,up=-(50+Math.random()*70),down=160+Math.random()*160,rot=(Math.random()-0.5)*720;p.animate([{transform:"translate(0,0) rotate(0)",opacity:0.95},{transform:"translate("+dx*0.6+"px,"+up+"px) rotate("+rot*0.4+"deg)",opacity:0.95,offset:0.3},{transform:"translate("+dx+"px,"+down+"px) rotate("+rot+"deg)",opacity:0}],{duration:1400+Math.random()*700,delay:Math.random()*150,easing:"cubic-bezier(.2,.6,.4,1)",fill:"forwards"}).onfinish=(function(el){return function(){el.remove();};})(p);}`;
}

/**
 * Buyer-facing copy for every refusal `completeOrder` can make, keyed by its `reason`
 * (plus `unknown` for a reason this build doesn't recognise — a newer gate talking to an
 * older page). The payment rails embed the whole map server-side and pick one at runtime,
 * so escaping happens HERE and the page script stays logic-free.
 *
 * This exists because a refusal used to render as nothing at all: the pages showed the
 * success banner on `completed` and dropped `reason` on the floor, so a buyer whose order
 * was correctly refused saw "✓ Payment Mandate authorized", four green gates, and silence
 * — indistinguishable from a hang. Every notice therefore states the OUTCOME ("the order
 * was not placed") before the cause, and names the buyer's next step in their language.
 *
 * `returnUrl` (the checkout hub) adds the way back; omit it for an MCP-only flow where
 * there is no hub to return to. The `Record` is exhaustive over `CompletionRefusalReason`,
 * so adding a reason to that union fails the build until its copy lands.
 */
export function refusalNotices(opts: { returnUrl?: string } = {}): Record<CompletionRefusalReason | "unknown", string> {
  const back = opts.returnUrl
    ? `<a class="ret" href="${escapeHtml(opts.returnUrl)}">Return to checkout ›</a>`
    : "";
  const notice = (detail: string): string =>
    `<div class="refusal"><div class="refusal-head">The order was not placed</div><div class="refusal-detail">${detail}</div>${back}</div>`;
  return {
    age: notice(
      "This order has an age-restricted item and no age proof on file for it yet. Prove your age on the checkout page, then authorize payment again.",
    ),
    gate: notice(
      "This order still needs a credential you haven't presented yet. Finish the outstanding step on the checkout page, then authorize payment again.",
    ),
    reprice: notice(
      "The total no longer matches what these items cost. Start a new checkout to get a fresh total.",
    ),
    reconcile: notice(
      "The signed cart and the signed payment disagree about the amount or currency, so neither was trusted. Start a new checkout.",
    ),
    "cart-mandate": notice(
      "This checkout link has expired or been altered since it was issued. Start a new checkout.",
    ),
    gates: notice("One of the payment checks did not pass, so nothing was authorized."),
    draw: notice(
      "The spending grant behind this purchase could not cover it. Authorize the payment yourself, or set up a new grant.",
    ),
    unknown: notice("The payment was authorized but the order did not complete. Nothing was charged."),
  };
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

/**
 * Order-derived progress rail for the ceremony gate pages (payment / credential). Includes
 * ONLY the gates the ORDER actually has — Age when the cart is age-restricted, Membership
 * when a discount is in play, Pay when there's an amount — plus the CURRENT gate, which is
 * always shown even if the order can't imply it (a custom credential id). A step shows ✓
 * only when ACTUALLY satisfied (age from the verification record, membership from an applied
 * discount), never merely because it precedes the current step — so a payment page can't
 * claim "Age ✓" the buyer never presented. Mirrors the hub's stepper inputs without needing
 * the policy manifest, which the rails don't carry.
 */
export function checkoutRail(
  order: { lines: { minimumAge?: number }[]; discount: number; total: number },
  current: string, // "age" | "membership" | "pay" | a custom credential id
  opts: { ageVerified?: boolean; currentLabel?: string } = {},
): string {
  const isBuiltin = current === "age" || current === "membership" || current === "pay";
  const gates = [
    { key: "age", label: "Age", applies: order.lines.some((l) => typeof l.minimumAge === "number" && l.minimumAge > 0), done: opts.ageVerified === true },
    { key: "membership", label: "Membership", applies: order.discount > 0, done: order.discount > 0 },
    // A custom gate isn't implied by the order — surface it only while it's the current step.
    ...(isBuiltin ? [] : [{ key: current, label: opts.currentLabel ?? current, applies: false, done: false }]),
    { key: "pay", label: "Pay", applies: order.total > 0, done: false },
  ];
  const steps = gates.filter((g) => g.applies || g.key === current);
  const currentIndex = steps.findIndex((g) => g.key === current);
  // The current step is highlighted (ring), never ticked — even if otherwise "done".
  return progressRail(steps.map((g) => ({ label: g.label, done: g.done && g.key !== current })), currentIndex);
}

/**
 * Client-side statement (embed inside a rail page's completion handler): flip the progress
 * rail's CURRENT step to done ✓. `checkoutRail` renders the current step un-ticked (a
 * highlighted number), but once the order COMPLETES that step IS done — the pay rails call
 * this on `out.completed` so the stepper agrees with the "Order complete" banner instead of
 * leaving Pay a highlighted number (#46).
 */
export function railCompleteScript(): string {
  return `(function(){var s=document.querySelector(".rail .rail-step.current");if(s){s.classList.remove("current");s.classList.add("done");var d=s.querySelector(".rail-dot");if(d)d.textContent="✓";}})();`;
}

/**
 * Client-side declaration: `showInspectLink(presentation, containerId = "log")` — when a
 * verify response carries `presentation` (the host set `inspectPresentations`), append an
 * "Inspect this presentation" link that opens the wallet's DeviceResponse in Multipaz
 * Tools, with the honest note that this gate does not check the issuer signature. A no-op
 * when `presentation` is absent (the default), so pages call it unconditionally. Only a
 * tools.multipaz.org link is ever rendered, and it is built with DOM APIs (no innerHTML).
 */
export function inspectLinkScript(): string {
  // Three Multipaz Tools links, each opening in a new tab: the credential itself (decoded), the
  // certificate that signed it (only when the credential carries one), and the Multipaz verifier
  // for an independent signature check. Only tools.multipaz.org links ever render.
  return `function showInspectLink(p,id){if(!p||typeof p.inspectUrl!=="string"||p.inspectUrl.indexOf("${INSPECTOR_URL}#")!==0)return;var c=document.getElementById(id||"log")||document.body;var d=document.createElement("div");d.className="inspect";d.style.cssText="margin-top:12px;padding:10px 12px;border:1px solid var(--hairline);border-radius:10px";function link(href,label,note){var a=document.createElement("a");a.href=href;a.target="_blank";a.rel="noopener noreferrer";a.style.fontWeight="600";a.style.display="inline-block";a.style.marginTop="6px";a.textContent=label;var n=document.createElement("div");n.className="small";n.textContent=note;d.appendChild(a);d.appendChild(n);}link(p.inspectUrl,"Inspect this presentation ›","The ISO mdoc credential your wallet sent, decoded in your browser by Multipaz Tools (nothing is uploaded).");if(typeof p.issuerCertUrl==="string"&&p.issuerCertUrl.indexOf("${X509_URL}#")===0)link(p.issuerCertUrl,"Issuer certificate ›","Who signed this credential — the certificate it carries, in the Multipaz X.509 viewer.");link("${VERIFIER_URL}","Check the signatures ›","The Multipaz verifier asks your wallet directly and checks the issuer and device signatures itself.");var t=document.createElement("div");t.className="small";t.style.marginTop="8px";t.textContent="This gate checks what was disclosed and that it answers this request; it does not check the issuer signature (presence-only-demo).";d.appendChild(t);c.appendChild(d);}`;
}

/**
 * Client-side declaration: `showRecordLink()` — once the order completes, append an "Order record ›"
 * link to `#receipt` that opens the store's own order-status JSON (the completed order, with what was
 * proven for it). `statusUrl` comes from the host's `statusUrl` seam; only a root-relative path or an
 * https URL is linked, anything else (or absent) makes this a no-op. Built with DOM APIs (no innerHTML).
 */
export function recordLinkScript(statusUrl: string | undefined): string {
  const safe = typeof statusUrl === "string" && (/^\/(?!\/)/.test(statusUrl) || /^https:\/\//i.test(statusUrl));
  if (!safe) return "function showRecordLink(){}";
  return `function showRecordLink(){if(document.getElementById("record-link"))return;var c=document.getElementById("receipt")||document.body;var d=document.createElement("div");d.id="record-link";d.className="inspect";d.style.cssText="margin-top:12px;padding:10px 12px;border:1px solid var(--hairline);border-radius:10px";var a=document.createElement("a");a.href=${JSON.stringify(statusUrl).replace(/</g, "\\u003c")};a.target="_blank";a.rel="noopener noreferrer";a.style.fontWeight="600";a.textContent="Order record ›";var n=document.createElement("div");n.className="small";n.textContent="The store's order-status record (JSON): the completed order and what was proven for it, each with its trust level.";d.appendChild(a);d.appendChild(n);c.appendChild(d);}`;
}

// ── Trust footer ────────────────────────────────────────────────────────────

/**
 * The single, DISCREET presence-only honesty line (replaces the old yellow warning
 * box). It MUST keep the literal "presence-only-demo" token (FR-011 + the honesty
 * tests) — the wire crypto is real; the issuer trust anchor is not.
 *
 * DELIBERATELY takes no `branding` argument (issue #61): host branding customises the
 * chrome, never the trust disclosure. This line is identical on every page, branded or
 * not — do not thread branding in here (a bypass test asserts it stays fixed).
 */
export function trustFooter(): string {
  return `<div class="trust"><div class="trust-line">🔒 presence-only-demo · secured by CredentAgent · the wire crypto is real; issuer trust anchor is not</div></div>`;
}

/**
 * The honesty line for the intent-sign rail (spec 012, FR-4). Distinct from
 * `trustFooter()` because the trust level is different: here the wallet's device
 * signature IS verified, so the disclosure says so — while stating plainly that the
 * trust ANCHOR is still a demo credential (no issuer/VICAL check — #14). It MUST keep
 * the literal token "device-signed".
 *
 * Like `trustFooter()`, it takes NO branding argument: host branding customises the
 * chrome, never the trust disclosure (a bypass test asserts it stays fixed).
 */
export function deviceSignedTrustFooter(): string {
  return `<div class="trust"><div class="trust-line">🔒 device-signed · secured by CredentAgent · the device signature is real; the trust anchor is a demo credential (no issuer verification yet)</div></div>`;
}
