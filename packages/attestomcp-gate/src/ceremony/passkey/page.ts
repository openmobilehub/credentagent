// Server-rendered passkey gate page (US2) — extracted from the demo's
// payment-gate/passkey/page.ts. Shows the binding fields (amount/order), then runs
// ONE registration ceremony and POSTs the result with the challenge token + the
// order id. Loads @simplewebauthn/browser ESM from a same-origin static path
// (/attestomcp/lib/sw). Every surface states trust_level "presence-only-demo"
// (CT11 / Principle VII) so the page never reads as a real safety control.
//
// Rendered through the SHARED design system (theme.ts) — the same teal wordmark,
// progress rail, card surfaces, and x402 settlement receipt as the checkout hub and
// the dc-payment rail — so the whole ceremony reads as ONE branded flow.
//
// The order is resolved + RE-PRICED from the catalog before this render (routes.ts
// → resolveOrder), so the amount shown and bound comes from the catalog, never the
// order id/token (invariant 2).
import type { CeremonyOrder } from "../types.js";
import { pageHead, brandHeader, progressRail, orderSummaryCard, trustFooter, settlingBar, completionHandoffBanner } from "../theme.js";

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function renderPasskeyPage(args: { order: CeremonyOrder; crossDevice?: boolean; returnUrl?: string; cart?: string }): string {
  const { order, crossDevice = false } = args;
  // Where the completed receipt links back to — the checkout hub, which then renders
  // the paid state (a forward, fresh GET — so the buyer never browser-backs onto a
  // stale, re-payable checkout). Defaults to this server's `/checkout?order=<id>`.
  // statelessOrders: carry the cart mandate back so the store-less hub can re-resolve.
  const returnUrl = args.returnUrl ?? `/checkout?order=${encodeURIComponent(order.id)}${args.cart ? `&cart=${args.cart}` : ""}`;
  const total = money(order.total, order.currency);

  // The shared order summary card (line items + bold Total) — same chrome as the hub.
  const summary = orderSummaryCard({
    lines: order.lines.map((l) => ({ name: l.name ?? l.id, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency ?? order.currency })),
    total: order.total,
    currency: order.currency,
    caption: `Order ${order.id}`,
  });
  // Pay is the current (final) step; the upstream gates are done by the time payment runs.
  const rail = progressRail([{ label: "Age", done: true }, { label: "Membership", done: true }, { label: "Pay" }], 2);
  const tagline = crossDevice ? "Approve on your phone (scan a QR)" : "Authorize with this device";

  // crossDevice pins the registration to a roaming authenticator, so the browser
  // skips local Touch ID and shows the QR for a phone (caBLE). The toggle link flips
  // the mode by adding/removing the xdev param on the same gate URL.
  const optionsUrl = crossDevice ? "/attestomcp/passkey/options?xdev=1" : "/attestomcp/passkey/options";
  // statelessOrders: keep the cart mandate on the same-device ⇄ cross-device toggle so the
  // store-less server can still resolve THIS order after switching.
  const cartQ = args.cart ? `&cart=${args.cart}` : "";
  const toggleHref = crossDevice ? `/attestomcp/passkey?order=${encodeURIComponent(order.id)}${cartQ}` : `/attestomcp/passkey?order=${encodeURIComponent(order.id)}&xdev=1${cartQ}`;
  const toggleText = crossDevice ? "← Use this device instead" : "Use my phone instead (scan a QR) →";

  // Page-local chrome over the shared design system: the verify-progress rows reuse
  // `.step`; the receipt gate rows + the QR toggle link are page-specific.
  const extraCss = `
  #receipt { display: none; margin-top: 16px; }
  .gate { font-size: .82rem; padding: 3px 0; }
  .gate.pass { color: var(--success); } .gate.fail { color: var(--danger); }
  .toggle { display: block; text-align: center; margin-top: 12px; font-size: .85rem; color: var(--accent); text-decoration: none; }
  .toggle:hover { text-decoration: underline; }`;

  return `<!doctype html>
<html lang="en">
${pageHead(`Authorize payment · ${order.id}`, extraCss)}
<body>
  <div class="wrap">
  ${brandHeader({ h1: "Authorize payment", tagline })}
  ${rail}
  ${summary}
  <div class="card">
    <p class="lede">An agent prepared this order — confirm the exact amount with your device's secure element (Touch ID, Windows Hello, or a phone via cross-device sign-in). Once authorized, payment settles on-chain via the <strong>x402</strong> protocol — on a <strong>test network</strong>, no real money, a tiny token amount (a fixed demo rate, not the dollar total).</p>
    <button id="go" class="btn btn-primary">Authorize ${total}</button>
    <a class="toggle" href="${toggleHref}">${toggleText}</a>
    <div id="log"></div>
    ${settlingBar()}
    <div id="receipt"></div>
  </div>
  ${trustFooter()}
  <script type="module">
    import { startRegistration } from "/attestomcp/lib/sw/index.js";
    const ORDER_ID = ${JSON.stringify(order.id)};
    // statelessOrders: forward the signed cart mandate (?cart=… in this page's URL) so a
    // store-less server can reconstruct THIS order on verify.
    const CART = new URLSearchParams(location.search).get("cart");
    const OPTIONS_URL = ${JSON.stringify(optionsUrl)};
    const RETURN_URL = ${JSON.stringify(returnUrl)};
    const DONE_BANNER = ${JSON.stringify(completionHandoffBanner(returnUrl))};
    const log = document.getElementById("log");
    const btn = document.getElementById("go");
    const settling = document.getElementById("settling");
    const step = (t, c = "") => { const d = document.createElement("div"); d.className = "step " + c; d.textContent = t; log.appendChild(d); };
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        step("→ GET options");
        const { options, challengeToken } = await fetch(OPTIONS_URL).then((r) => r.json());
        step("→ Touch ID / passkey prompt");
        const response = await startRegistration({ optionsJSON: options });
        step("→ verify · Settling via x402 on Hedera testnet (if configured)… can take ~10s");
        settling.classList.add("on");
        const out = await fetch("/attestomcp/passkey/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ response, challengeToken, order: ORDER_ID, cart: CART }),
        }).then((r) => r.json()).finally(() => settling.classList.remove("on"));
        if (!out.mandate) throw new Error(out.error || "authorization failed");
        step("✓ authorized · mandate built (" + out.trust_level + ")", "ok");
        renderReceipt(out);
        if (out.settlementError) { step("✗ settlement failed — authorized, not settled (retry below)", "err"); btn.disabled = false; }
        else if (!out.completed) btn.disabled = false;
      } catch (err) {
        step("✗ " + (err?.message ?? String(err)), "err");
        btn.disabled = false;
      }
    });

    function renderReceipt(out) {
      const el = document.getElementById("receipt");
      const passCount = out.gates.filter((g) => g.pass).length;
      const allPass = passCount === out.gates.length;
      const gateLines = out.gates.map((g) => '<div class="gate ' + (g.pass ? "pass" : "fail") + '">' + (g.pass ? "✓" : "✗") + " " + esc(g.gate) + " — " + esc(g.detail) + "</div>").join("");
      // The x402 on-chain settlement receipt — same .settle card the dc-payment rail
      // renders: the tinybar amount, payer/merchant, speed, tx, and a PROMINENT
      // tappable HashScan link (the buyer is on their phone; one tap to the live
      // explorer is the third-party proof). A configured-but-failed settle is the
      // calm "authorized, not settled" line (FR-013) — never an alarming wall.
      const s = out.settlement;
      const settlement = s
        ? '<div class="settle"><div class="settle-head">✓ Settled via x402 on Hedera testnet</div>' +
          '<dl class="kv">' +
          "<dt>Amount</dt><dd>" + (s.amountTinybar / 1e8) + ' ℏ <span class="dim">(' + esc(s.fxRate) + ")</span></dd>" +
          "<dt>From</dt><dd>" + esc(s.payer.accountId) + ' <span class="dim">' +
          (s.payer.kind === "session-wallet"
            ? "wallet created for this order, " + (s.walletAgeMs / 1000).toFixed(1) + "s old when it paid"
            : "demo customer") + "</span></dd>" +
          "<dt>To</dt><dd>" + esc(s.payTo) + ' <span class="dim">merchant</span></dd>' +
          "<dt>Speed</dt><dd>settled in " + (s.settledInMs / 1000).toFixed(1) + "s</dd>" +
          '<dt>Tx</dt><dd><span class="mono">' + esc(s.txId) + "</span></dd>" +
          "</dl>" +
          '<a class="hashscan" href="' + esc(s.hashscanUrl) + '" target="_blank" rel="noopener">View on HashScan ›</a>' +
          "</div>"
        : out.settlementError
          ? '<div class="settle-failed">✗ Settlement failed — authorized, not settled: ' + esc(out.settlementError) + "</div>"
          : "";
      // Every gate + payment is done ⇒ the order is COMPLETE. Lead with the prominent
      // handoff: close this window and continue in the agent (the MCP host polls
      // order-status and resumes). No auto-redirect — we don't yank the buyer off the
      // "you're done" message; the on-chain proof + a secondary return link stay below.
      const done = out.completed ? DONE_BANNER : "";
      const gates = '<div class="gate ' + (allPass ? "pass" : "fail") + '">' +
        (allPass ? "✓ All " + out.gates.length + " authorization gates passed" : "✗ " + (out.gates.length - passCount) + " of " + out.gates.length + " failed") + "</div>" + gateLines;
      el.innerHTML = done + '<div class="row-ok">✓ Payment Mandate authorized (amount-bound)</div>' +
        '<div class="small" style="margin:4px 0 8px;">' + esc(out.mandate.id) + "</div>" + gates + settlement;
      el.style.display = "block";
      if (out.completed) {
        btn.disabled = true;
        btn.textContent = "Authorized ✓";
      }
    }
  </script>
  </div>
</body>
</html>`;
}
