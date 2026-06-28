// Server-rendered dc-payment gate page. It now drives the REAL OpenID4VP wallet path:
// the PRIMARY button calls navigator.credentials.get({digital}) synchronously inside
// the tap (the signed request is PRE-FETCHED from /attesto/dc-payment/request so no
// await sits between the click and get() — iOS WebKit drops the transient user
// activation across an await; Chrome 141+ renders the cross-device caBLE QR), then POSTs
// the wallet's encrypted vp_token to /attesto/dc-payment/verify in the shape the route's
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

import { pageHead, brandHeader, progressRail, orderSummaryCard, trustFooter } from "../theme.js";

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
  const returnUrl = args.returnUrl ?? `/checkout?order=${encodeURIComponent(order)}`;
  // The shared order summary card (line items + bold Total) — same chrome as the hub.
  const summary = orderSummaryCard({
    lines: lines.map((l) => ({ name: l.name, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency })),
    total,
    currency,
    caption: `Order ${order}`,
  });
  // The progress rail with Pay as the current (final) step; the upstream gates are done.
  const rail = progressRail([{ label: "Age", done: true }, { label: "Membership", done: true }, { label: "Pay" }], 2);
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
    <p class="lede">Present a payment credential from your phone wallet. Chrome shows a QR; scanning it uses the cross-device channel (FIDO caBLE). Your wallet signs over this exact amount — nothing is charged (demo).</p>
    <button id="go-dc" class="btn btn-primary">Authorize ${money(total, currency)} with my wallet</button>
    <button id="go" class="btn btn-secondary">Authorize ${money(total, currency)} (instant demo)</button>
    <div id="log"></div>
    <div id="receipt"></div>
  </div>
  ${trustFooter()}
  <script type="module">
    const ORDER = ${JSON.stringify(order)};
    const AMOUNT = ${JSON.stringify(total)};
    const DEMO_CLAIMS = ${JSON.stringify(DEMO_CLAIMS)};
    const RETURN_URL = ${JSON.stringify(returnUrl)};
    const log = document.getElementById("log");
    const goDc = document.getElementById("go-dc");
    const btn = document.getElementById("go");
    const step = (t, c = "") => { const d = document.createElement("div"); d.className = "step " + c; d.textContent = t; log.appendChild(d); };
    function notice(html) { const d = document.createElement("div"); d.className = "notice"; d.innerHTML = html; log.appendChild(d); }

    // Pre-fetch the REAL signed OpenID4VP request so navigator.credentials.get() can be
    // called SYNCHRONOUSLY inside the tap. iOS WebKit drops the transient user
    // activation across an await, so we must not fetch between the click and get(). We
    // keep a fresh pre-fetched request ready at all times. location.search carries the
    // order this gate is scoped to, so /request re-prices THIS order (amount-bound).
    let reqData = null;
    function prefetch() {
      reqData = null;
      fetch("/attesto/dc-payment/request" + location.search).then((r) => r.json()).then((d) => { reqData = d; }).catch(() => {});
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
          step("→ verify");
          const out = await fetch("/attesto/dc-payment/verify", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: ORDER, readerContextToken: rd.readerContextToken, result: { protocol: (result && result.protocol) || null, data } }),
          }).then((r) => r.json());
          if (!out.mandate) throw new Error(out.error || "authorization failed");
          step("✓ presentation verified · mandate built (" + out.mandate.trust_level + ")", "ok");
          renderReceipt(out);
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
        step("→ verify (presence-only, amount-bound)");
        const out = await fetch("/attesto/dc-payment/verify", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: ORDER, amount: AMOUNT, claims: DEMO_CLAIMS }),
        }).then((r) => r.json());
        if (!out.mandate) throw new Error(out.error || "authorization failed");
        step("✓ presentation verified · mandate built (" + out.mandate.trust_level + ")", "ok");
        renderReceipt(out);
      } catch (err) {
        step("✗ " + (err?.message ?? String(err)), "err");
        btn.disabled = false;
      }
    });

    function renderReceipt(out) {
      const el = document.getElementById("receipt");
      const gates = out.gates.map((g) => '<div class="gate ' + (g.pass ? "pass" : "fail") + '">' + (g.pass ? "✓" : "✗") + " " + g.gate + " — " + g.detail + "</div>").join("");
      const done = out.completed
        ? '<div class="receipt-banner">✓ Purchase complete<div class="sub">Returning to checkout… <a href="' + RETURN_URL + '">continue now ›</a></div></div>'
        : "";
      el.innerHTML = done + '<div class="row-ok">✓ Payment Mandate authorized (amount-bound)</div>' +
        '<div class="small" style="margin:4px 0 8px;">' + out.mandate.id + "</div>" + gates;
      el.style.display = "block";
      if (out.completed) {
        goDc.disabled = true;
        btn.textContent = "Authorized ✓";
        // Final gate done — return to the checkout hub, which shows the paid
        // confirmation (and the widget poll picks it up in the chat).
        setTimeout(() => { window.location.assign(RETURN_URL); }, 1400);
      }
    }
  </script>
  </div>
</body>
</html>`;
}
