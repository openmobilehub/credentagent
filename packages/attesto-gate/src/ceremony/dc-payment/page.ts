// Server-rendered dc-payment gate page. The WORKING button is the presence-only
// "instant demo": it POSTs a canonical disclosed instrument + the catalog-bound
// amount for this order to /attesto/dc-payment/verify (no real wallet round-trip;
// the mdoc is not cryptographically verified). The OpenID4VP wallet path
// (navigator.credentials.get({digital}) — Chrome 141+ caBLE QR) is noted as
// in-flight. Every surface states trust_level "presence-only-demo" (CT11 /
// Principle VII) so the page never reads as a real safety control. Self-contained:
// takes the re-priced amount + lines, not a demo Order type.

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
  button { font-size: 1rem; padding: 0.75rem 1.1rem; border-radius: 6px; border: 1px solid #1a7f37; background: #1a7f37; color: #fff; cursor: pointer; width: 100%; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .step { padding: 0.4rem 0; font-family: ui-monospace, Menlo, monospace; font-size: 0.85rem; }
  .step.ok { color: #0a7f2e; } .step.err { color: #b00020; white-space: pre-wrap; }
  .inflight { margin-top: 0.75rem; font-size: 0.8rem; color: #777; }
  .trust { margin-top: 1rem; padding: 0.9rem 1rem; background: #fff7ed; border-left: 4px solid #d97706; border-radius: 6px; font-size: 0.85rem; color: #7c2d12; }
  #receipt { display: none; margin-top: 1.25rem; padding: 1rem 1.1rem; background: #ecfdf3; border-left: 4px solid #0a7f2e; border-radius: 6px; }
  .gate { font-family: ui-monospace, Menlo, monospace; font-size: 0.82rem; padding: 0.15rem 0; }
  .gate.pass { color: #0a7f2e; } .gate.fail { color: #b00020; }
</style>
</head>
<body>
  <h1>Authorize payment · cross-device</h1>
  <p class="lede">Present a payment credential from your phone wallet. Your wallet signs over this exact amount — nothing is charged (demo).</p>
  <table>
    ${rows}
    <tr class="total"><td>Total · order ${escapeHtml(order)}</td><td class="amt">${money(total, currency)}</td></tr>
  </table>
  <button id="go">Authorize ${money(total, currency)} (instant demo)</button>
  <p class="inflight">OpenID4VP wallet presentation (navigator.credentials.get({digital}) — Chrome 141+ caBLE QR) — scaffolded, in-flight.</p>
  <div id="log"></div>
  <div id="receipt"></div>
  <div class="trust">${escapeHtml(TRUST_NOTE)}</div>
  <script type="module">
    const ORDER = ${JSON.stringify(order)};
    const AMOUNT = ${JSON.stringify(total)};
    const DEMO_CLAIMS = ${JSON.stringify(DEMO_CLAIMS)};
    const log = document.getElementById("log");
    const btn = document.getElementById("go");
    const step = (t, c = "") => { const d = document.createElement("div"); d.className = "step " + c; d.textContent = t; log.appendChild(d); };
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
        ? '<div style="background:#0a7f2e;color:#fff;font-size:1.1rem;font-weight:700;line-height:1.4;padding:1rem 1.1rem;border-radius:8px;margin-bottom:1rem;text-align:center;">✓ Purchase complete<div style="font-size:0.9rem;font-weight:500;margin-top:0.25rem;">You can close this page and return to the chat.</div></div>'
        : "";
      el.innerHTML = done + '<div style="font-weight:600;color:#0a7f2e;">✓ Payment Mandate authorized (amount-bound)</div>' +
        '<div style="font-size:0.8rem;color:#666;margin:0.3rem 0 0.6rem;">' + out.mandate.id + "</div>" + gates;
      el.style.display = "block";
      if (out.completed) btn.textContent = "Authorized ✓";
    }
  </script>
</body>
</html>`;
}
