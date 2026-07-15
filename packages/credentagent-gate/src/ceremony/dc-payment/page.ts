// Server-rendered dc-payment gate page. It now drives the REAL OpenID4VP wallet path:
// the PRIMARY button calls navigator.credentials.get({digital}) synchronously inside
// the tap (the signed request is PRE-FETCHED from /credentagent/dc-payment/request so no
// await sits between the click and get() — iOS WebKit drops the transient user
// activation across an await; Chrome 141+ renders the cross-device caBLE QR), then POSTs
// the wallet's encrypted vp_token to /credentagent/dc-payment/verify in the shape the route's
// real path reads ({ order, readerContextToken, result:{protocol,data} }) — the route
// decrypts the JWE, re-checks the device-signed transaction_data_hash against the
// amount we sealed, runs the four gates, and completes through the shared completeOrder
// seam. The SECONDARY "instant demo" button is kept as a fallback: it POSTs the
// canonical disclosed instrument + the catalog-bound amount ({ order, amount, claims })
// (no wallet round-trip; the tested default). On a browser without the Digital
// Credentials API the page points the buyer at the instant-demo button. Every surface
// states trust_level "presence-only-demo" (CT11 / Principle VII / FR-011): the wire
// crypto is real; the wallet's device/issuer trust anchor is not — never a real safety
// control. Self-contained: takes the re-priced amount + lines, not a demo Order type.

import { pageHead, brandHeader, orderSummaryCard, trustFooter, settlingBar, completionHandoffBanner } from "../theme.js";

export interface DcPaymentLine {
  name: string;
  quantity: number;
  lineTotal: number;
  currency: string;
}

export interface DcPaymentPageArgs {
  /** Order id, echoed back so verify is scoped to one order. */
  order: string;
  /** Catalog-priced total (never the token's). */
  total: number;
  currency: string;
  lines: DcPaymentLine[];
  /** Where to send the buyer after payment — the checkout hub, which then shows the
   *  paid confirmation. Defaults to this server's `/checkout?order=<id>`. */
  returnUrl?: string;
  /** statelessOrders: base64url cart mandate carried back to the store-less `/checkout`. */
  cart?: string;
  /** The order-derived progress rail HTML (from `checkoutRail`), built by the route which
   *  holds the full re-priced order. Absent ⇒ no rail (never a hardcoded one). */
  rail?: string;
}

// The canonical disclosed instrument the instant-demo button presents — it goes
// through the SAME server-side amount-binding gates as a real wallet presentation.
const DEMO_CLAIMS = {
  issuer_name: "Demo Bank",
  payment_instrument_id: "pi-77AABBCC",
  masked_account_reference: "•••• 4242",
  holder_name: "Demo Buyer",
  expiry_date: "2032-09-01",
};

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function renderDcPaymentPage(args: DcPaymentPageArgs): string {
  const { order, total, currency, lines } = args;
  const returnUrl = args.returnUrl ?? `/checkout?order=${encodeURIComponent(order)}${args.cart ? `&cart=${args.cart}` : ""}`;
  // The shared order summary card (line items + bold Total) — same chrome as the hub.
  const summary = orderSummaryCard({
    lines: lines.map((l) => ({ name: l.name, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency })),
    total,
    currency,
    caption: `Order ${order}`,
  });
  // The order-derived progress rail (built by the route via checkoutRail) with Pay current;
  // it lists only the gates THIS order actually has — never a hardcoded Age ✓ · Membership ✓.
  const rail = args.rail ?? "";
  // Page-local chrome layered over the shared design system: the verify-progress rows
  // reuse `.step`; the receipt gate rows + the success card are page-specific.
  const extraCss = `
  #receipt { display: none; margin-top: 16px; }
  .gate { font-size: .82rem; padding: 3px 0; }
  .gate.pass { color: var(--success); } .gate.fail { color: var(--danger); }`;
  return `<!doctype html>
<html lang="en">
${pageHead(`Authorize payment (cross-device) · ${order}`, extraCss)}
<body>
  <div class="wrap">
  ${brandHeader({ h1: "Authorize payment", tagline: "Authorize from your wallet" })}
  ${rail}
  ${summary}
  <div class="card">
    <p class="lede">Present a payment credential from your phone wallet. Chrome shows a QR; scanning it uses the cross-device channel (FIDO caBLE). Your wallet signs over this exact amount, then payment settles on-chain via the <strong>x402</strong> protocol — on a <strong>test network</strong>, no real money, a tiny token amount (a fixed demo rate, not the dollar total).</p>
    <button id="go-dc" class="btn btn-primary">Authorize ${money(total, currency)} with my wallet</button>
    <button id="go" class="btn btn-secondary">Authorize ${money(total, currency)} (instant demo)</button>
    <div id="log"></div>
    ${settlingBar()}
    <div id="receipt"></div>
  </div>
  ${trustFooter()}
  <script type="module">
    const ORDER = ${JSON.stringify(order)};
    // statelessOrders: the signed cart mandate rides in the page URL (?cart=…); forward
    // it on every verify POST so a store-less server can reconstruct THIS order.
    const CART = new URLSearchParams(location.search).get("cart");
    const AMOUNT = ${JSON.stringify(total)};
    const DEMO_CLAIMS = ${JSON.stringify(DEMO_CLAIMS)};
    const RETURN_URL = ${JSON.stringify(returnUrl)};
    const DONE_BANNER = ${JSON.stringify(completionHandoffBanner(returnUrl))};
    const log = document.getElementById("log");
    const goDc = document.getElementById("go-dc");
    const btn = document.getElementById("go");
    const settling = document.getElementById("settling");
    const step = (t, c = "") => { const d = document.createElement("div"); d.className = "step " + c; d.textContent = t; log.appendChild(d); };
    function notice(html) { const d = document.createElement("div"); d.className = "notice"; d.innerHTML = html; log.appendChild(d); }
    // Escape any server-returned value before it goes into innerHTML (txId, accountId,
    // the settlementError message): they're built server-side but never trusted raw.
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");

    // Pre-fetch the REAL signed OpenID4VP request so navigator.credentials.get() can be
    // called SYNCHRONOUSLY inside the tap. iOS WebKit drops the transient user
    // activation across an await, so we must not fetch between the click and get(). We
    // keep a fresh pre-fetched request ready at all times. location.search carries the
    // order this gate is scoped to, so /request re-prices THIS order (amount-bound).
    let reqData = null;
    function prefetch() {
      reqData = null;
      fetch("/credentagent/dc-payment/request" + location.search).then((r) => r.json()).then((d) => { reqData = d; }).catch(() => {});
    }

    if (!("credentials" in navigator) || !window.DigitalCredential) {
      goDc.disabled = true;
      notice('This browser does not support <code>navigator.credentials.get({digital})</code> (needs <strong>Chrome 141+</strong>/Android or iOS 18+). Use the <strong>instant demo</strong> button.');
    } else {
      prefetch();
    }

    goDc.addEventListener("click", () => {
      if (!("credentials" in navigator) || !window.DigitalCredential) {
        notice('This browser does not support <code>navigator.credentials.get({digital})</code>. Use the instant-demo button.');
        return;
      }
      if (!reqData || !reqData.request) { notice("Preparing the request — tap again in a second."); prefetch(); return; }
      goDc.disabled = true;
      const rd = reqData;
      step("→ navigator.credentials.get({digital}) — Chrome should show a QR…");
      // Called synchronously (no await before it) to keep the user activation.
      navigator.credentials.get({ digital: { requests: [{ protocol: "openid4vp-v1-signed", data: { request: rd.request } }] }, mediation: "required" })
        .then(async (result) => {
          let data = result && result.data != null ? result.data : null;
          if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
          step("→ verify · Settling via x402 on Hedera testnet (if configured)… can take ~10s");
          settling.classList.add("on");
          const out = await fetch("/credentagent/dc-payment/verify", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: ORDER, cart: CART, readerContextToken: rd.readerContextToken, result: { protocol: (result && result.protocol) || null, data } }),
          }).then((r) => r.json()).finally(() => settling.classList.remove("on"));
          if (!out.mandate) throw new Error(out.error || "authorization failed");
          step("✓ presentation verified · mandate built (" + out.mandate.trust_level + ")", "ok");
          renderReceipt(out);
          // Configured-but-failed settle: authorized, not settled — let the buyer retry.
          if (out.settlementError) { step("✗ settlement failed — authorized, not settled (retry below)", "err"); goDc.disabled = false; prefetch(); }
        })
        .catch((err) => {
          step("✗ " + ((err && err.message) || String(err)), "err");
          goDc.disabled = false;
          prefetch(); // fresh request for the next attempt
        });
    });

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        step("→ verify (presence-only, amount-bound) · Settling via x402 on Hedera testnet (if configured)… can take ~10s");
        settling.classList.add("on");
        const out = await fetch("/credentagent/dc-payment/verify", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: ORDER, cart: CART, amount: AMOUNT, claims: DEMO_CLAIMS }),
        }).then((r) => r.json()).finally(() => settling.classList.remove("on"));
        if (!out.mandate) throw new Error(out.error || "authorization failed");
        step("✓ presentation verified · mandate built (" + out.mandate.trust_level + ")", "ok");
        renderReceipt(out);
        // Configured-but-failed settle: authorized, not settled — let the buyer retry.
        if (out.settlementError) { step("✗ settlement failed — authorized, not settled (retry below)", "err"); btn.disabled = false; }
      } catch (err) {
        step("✗ " + (err?.message ?? String(err)), "err");
        btn.disabled = false;
      }
    });

    function renderReceipt(out) {
      const el = document.getElementById("receipt");
      const gates = out.gates.map((g) => '<div class="gate ' + (g.pass ? "pass" : "fail") + '">' + (g.pass ? "✓" : "✗") + " " + g.gate + " — " + g.detail + "</div>").join("");
      // The x402 on-chain settlement receipt. When the host settled (Hedera/blocky402),
      // show the actual tinybar amount, payer/merchant, speed, tx, and a PROMINENT
      // tappable HashScan link — the third-party proof the buyer (on their phone) taps
      // straight into the live explorer. A configured-but-failed settle is the calm
      // "authorized, not settled" line (FR-013) — never an alarming wall.
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
      el.innerHTML = done + '<div class="row-ok">✓ Payment Mandate authorized (amount-bound)</div>' +
        '<div class="small" style="margin:4px 0 8px;">' + out.mandate.id + "</div>" + gates + settlement;
      el.style.display = "block";
      if (out.completed) {
        goDc.disabled = true;
        btn.textContent = "Authorized ✓";
      }
    }
  </script>
  </div>
</body>
</html>`;
}
