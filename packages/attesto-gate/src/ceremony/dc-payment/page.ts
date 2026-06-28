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

const TRUST_NOTE = "trust_level: presence-only-demo — a flow demo, not a real safety control (the wallet's device/issuer signatures are not cryptographically verified yet).";

// The canonical disclosed instrument the instant-demo button presents — it goes
// through the SAME server-side amount-binding gates as a real wallet presentation.
const DEMO_CLAIMS = {
  issuer_name: "Demo Bank",
  payment_instrument_id: "pi-77AABBCC",
  masked_account_reference: "•••• 4242",
  holder_name: "Demo Buyer",
  expiry_date: "2032-09-01",
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function renderDcPaymentPage(args: DcPaymentPageArgs): string {
  const { order, total, currency, lines } = args;
  const returnUrl = args.returnUrl ?? `/checkout?order=${encodeURIComponent(order)}`;
  const rows = lines
    .map((l) => `<tr><td>${escapeHtml(l.name)} <span style="color:#999;">×${l.quantity}</span></td><td class="amt">${money(l.lineTotal, l.currency)}</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize payment (cross-device) · ${escapeHtml(order)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 3rem auto; padding: 0 1.25rem; color: #1a1a1a; }
  h1 { font-size: 1.35rem; margin-bottom: 0.25rem; }
  p.lede { color: #555; margin-top: 0; line-height: 1.45; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.95rem; }
  td { padding: 0.35rem 0; border-bottom: 1px solid #f0f0f0; }
  td.amt { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { border-bottom: none; font-weight: 600; padding-top: 0.6rem; }
  button { font-size: 1rem; padding: 0.75rem 1.1rem; border-radius: 6px; border: 1px solid #1a7f37; background: #1a7f37; color: #fff; cursor: pointer; width: 100%; margin-top: 0.75rem; }
  button.secondary { background: #fff; color: #1a7f37; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .step { padding: 0.4rem 0; font-family: ui-monospace, Menlo, monospace; font-size: 0.85rem; }
  .step.ok { color: #0a7f2e; } .step.err { color: #b00020; white-space: pre-wrap; }
  .notice { margin-top: 1rem; padding: 0.9rem 1rem; background: #fff7ed; border-left: 4px solid #d97706; border-radius: 6px; font-size: 0.9rem; }
  .trust { margin-top: 1rem; padding: 0.9rem 1rem; background: #fff7ed; border-left: 4px solid #d97706; border-radius: 6px; font-size: 0.85rem; color: #7c2d12; }
  #receipt { display: none; margin-top: 1.25rem; padding: 1rem 1.1rem; background: #ecfdf3; border-left: 4px solid #0a7f2e; border-radius: 6px; }
  .gate { font-family: ui-monospace, Menlo, monospace; font-size: 0.82rem; padding: 0.15rem 0; }
  .gate.pass { color: #0a7f2e; } .gate.fail { color: #b00020; }
</style>
</head>
<body>
  <h1>Authorize payment · cross-device</h1>
  <p class="lede">Present a payment credential from your phone wallet. Chrome shows a QR; scanning it uses the cross-device channel (FIDO caBLE). Your wallet signs over this exact amount — nothing is charged (demo).</p>
  <table>
    ${rows}
    <tr class="total"><td>Total · order ${escapeHtml(order)}</td><td class="amt">${money(total, currency)}</td></tr>
  </table>
  <button id="go-dc">Authorize ${money(total, currency)} with my wallet</button>
  <button id="go" class="secondary">Authorize ${money(total, currency)} (instant demo)</button>
  <div id="log"></div>
  <div id="receipt"></div>
  <div class="trust">${escapeHtml(TRUST_NOTE)}</div>
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
        ? '<div style="background:#0a7f2e;color:#fff;font-size:1.1rem;font-weight:700;line-height:1.4;padding:1rem 1.1rem;border-radius:8px;margin-bottom:1rem;text-align:center;">✓ Purchase complete<div style="font-size:0.9rem;font-weight:500;margin-top:0.25rem;">Returning to checkout… <a href="' + RETURN_URL + '" style="color:#fff;text-decoration:underline;">continue now ›</a></div></div>'
        : "";
      el.innerHTML = done + '<div style="font-weight:600;color:#0a7f2e;">✓ Payment Mandate authorized (amount-bound)</div>' +
        '<div style="font-size:0.8rem;color:#666;margin:0.3rem 0 0.6rem;">' + out.mandate.id + "</div>" + gates;
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
</body>
</html>`;
}
