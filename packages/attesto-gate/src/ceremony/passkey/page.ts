// Server-rendered passkey gate page (US2) — extracted from the demo's
// payment-gate/passkey/page.ts. Shows the binding fields (amount/order), then runs
// ONE registration ceremony and POSTs the result with the challenge token + the
// order id. Loads @simplewebauthn/browser ESM from a same-origin static path
// (/attesto/lib/sw). Every surface states trust_level "presence-only-demo"
// (CT11 / Principle VII) so the page never reads as a real safety control.
//
// The order is resolved + RE-PRICED from the catalog before this render (routes.ts
// → resolveOrder), so the amount shown and bound comes from the catalog, never the
// order id/token (invariant 2).
import type { CeremonyOrder } from "../types.js";

const TRUST_NOTE =
  "trust_level: presence-only-demo — a flow demo, not a real safety control. The WebAuthn ceremony is real, but the AP2 mandate is dev-signed, not key-bound.";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function renderPasskeyPage(args: { order: CeremonyOrder; crossDevice?: boolean; returnUrl?: string }): string {
  const { order, crossDevice = false } = args;
  const id = escapeHtml(order.id);
  // Where the completed receipt links back to — the checkout hub, which then renders
  // the paid state (a forward, fresh GET — so the buyer never browser-backs onto a
  // stale, re-payable checkout). Defaults to this server's `/checkout?order=<id>`.
  const returnUrl = args.returnUrl ?? `/checkout?order=${encodeURIComponent(order.id)}`;
  const rows = order.lines
    .map((l) => `<tr><td>${escapeHtml(l.name ?? l.id)} <span style="color:#999;">×${l.quantity}</span></td><td class="amt">${money(l.lineTotal, l.currency ?? order.currency)}</td></tr>`)
    .join("\n");
  // crossDevice pins the registration to a roaming authenticator, so the browser
  // skips local Touch ID and shows the QR for a phone (caBLE). The toggle link
  // flips the mode by adding/removing the xdev param on the same gate URL.
  const optionsUrl = crossDevice ? "/attesto/passkey/options?xdev=1" : "/attesto/passkey/options";
  const toggle = crossDevice
    ? `<a class="toggle" href="/attesto/passkey?order=${id}">← Use this device instead</a>`
    : `<a class="toggle" href="/attesto/passkey?order=${id}&amp;xdev=1">Use my phone instead (scan a QR) →</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize payment · ${id}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 880px; margin: 3rem auto; padding: 0 1.25rem; color: #1a1a1a; }
  .cols { display: flex; gap: 2rem; align-items: flex-start; }
  .main { flex: 1; min-width: 0; }
  aside.info { width: 250px; flex-shrink: 0; background: #f6f8f7; border: 1px solid #e3e8e5; border-radius: 10px; padding: 0.4rem 1rem 0.9rem; font-size: 0.82rem; color: #555; line-height: 1.5; }
  aside.info h2 { font-size: 0.9rem; color: #1a1a1a; margin-bottom: 0; }
  @media (max-width: 720px) { .cols { flex-direction: column; } aside.info { width: auto; } }
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
  #receipt { display: none; margin-top: 1.25rem; padding: 1rem 1.1rem; background: #ecfdf3; border-left: 4px solid #0a7f2e; border-radius: 6px; }
  #bar { display: none; margin: 0.75rem 0 0.25rem; height: 6px; background: #e6f2ea; border-radius: 3px; overflow: hidden; }
  #bar.on { display: block; }
  #bar > div { width: 35%; height: 100%; background: #1a7f37; border-radius: 3px; animation: slide 1.2s ease-in-out infinite; }
  @keyframes slide { from { margin-left: -35%; } to { margin-left: 100%; } }
  .gate { font-family: ui-monospace, Menlo, monospace; font-size: 0.82rem; padding: 0.15rem 0; }
  .gate.pass { color: #0a7f2e; } .gate.fail { color: #b00020; }
  a.toggle { display: inline-block; margin-top: 0.75rem; font-size: 0.85rem; color: #1a7f37; text-decoration: none; }
  a.toggle:hover { text-decoration: underline; }
  .trust { margin-top: 1rem; padding: 0.9rem 1rem; background: #fff7ed; border-left: 4px solid #d97706; border-radius: 6px; font-size: 0.82rem; color: #7c2d12; }
  .r-head { font-weight: 600; color: #0a7f2e; margin: 0.9rem 0 0.4rem; }
  .dim { color: #666; font-weight: 400; font-size: 0.78rem; }
  .mono { font-family: ui-monospace, Menlo, monospace; font-size: 0.78rem; word-break: break-all; }
  details.gates { margin: 0.2rem 0 0.4rem; }
  details.gates summary { cursor: pointer; font-weight: 600; color: #0a7f2e; font-size: 0.95rem; }
  details.gates .gate { margin-left: 1rem; }
  dl.kv { display: grid; grid-template-columns: 64px 1fr; gap: 0.3rem 0.75rem; margin: 0.4rem 0 0; font-size: 0.9rem; }
  dl.kv dt { color: #666; font-size: 0.8rem; padding-top: 0.1rem; }
  dl.kv dd { margin: 0; }
</style>
</head>
<body>
  <h1>Authorize payment</h1>
  <p class="lede">An agent prepared this order — confirm the exact amount with your device to pay.</p>
  <div class="cols">
  <div class="main">
  <table>
    ${rows}
    <tr class="total"><td>Total · order ${id}</td><td class="amt">${money(order.total, order.currency)}</td></tr>
  </table>
  <button id="go">Authorize ${money(order.total, order.currency)}</button>
  <div>${toggle}</div>
  <div id="log"></div>
  <div id="bar"><div></div></div>
  <div id="receipt"></div>
  <div class="trust">${escapeHtml(TRUST_NOTE)}</div>
  </div>
  <aside class="info">
    <h2>How this payment works</h2>
    <p>Your device's secure element (Touch ID, Windows Hello, or a phone via cross-device sign-in) authorizes this exact amount — nothing else.</p>
    <p>Once authorized, an optional settlement runs on a <strong>test network</strong> via the host's settlement seam — no real money moves, and the demo settles a <strong>tiny token amount</strong> (a fixed demo rate, not the dollar total).</p>
  </aside>
  </div>
  <script type="module">
    import { startRegistration } from "/attesto/lib/sw/index.js";
    const ORDER_ID = ${JSON.stringify(order.id)};
    const OPTIONS_URL = ${JSON.stringify(optionsUrl)};
    const RETURN_URL = ${JSON.stringify(returnUrl)};
    const log = document.getElementById("log");
    const bar = document.getElementById("bar");
    const btn = document.getElementById("go");
    const step = (t, c = "") => { const d = document.createElement("div"); d.className = "step " + c; d.textContent = t; log.appendChild(d); };
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        step("→ GET options");
        const { options, challengeToken } = await fetch(OPTIONS_URL).then((r) => r.json());
        step("→ Touch ID / passkey prompt");
        const response = await startRegistration({ optionsJSON: options });
        step("→ verify · settling (if the host configured a settlement seam)… can take ~10s");
        bar.classList.add("on");
        const out = await fetch("/attesto/passkey/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ response, challengeToken, order: ORDER_ID }),
        }).then((r) => r.json()).finally(() => bar.classList.remove("on"));
        if (!out.mandate) throw new Error(out.error || "authorization failed");
        step("✓ authorized · mandate built (" + out.trust_level + ")", "ok");
        renderReceipt(out);
        if (out.settlementError) step("✗ settlement failed — authorized, not settled (retry below)", "err");
        if (!out.completed) btn.disabled = false;
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
      const gates = '<details class="gates"' + (allPass ? "" : " open") + "><summary>" +
        (allPass ? "✓ All " + out.gates.length + " authorization gates passed" : "✗ " + (out.gates.length - passCount) + " of " + out.gates.length + " authorization gates failed") +
        ' <span class="mono dim">' + esc(out.mandate.id) + "</span></summary>" + gateLines + "</details>";
      const s = out.settlement;
      const settlement = s
        ? '<div class="r-head">✓ Settled on ' + esc(s.network) + "</div>" +
          '<dl class="kv"><dt>Tx</dt><dd><span class="mono">' + esc(s.txId) + "</span></dd>" +
          (s.hashscanUrl ? '<dt>Proof</dt><dd><a href="' + esc(s.hashscanUrl) + '" target="_blank" rel="noopener">View on explorer</a></dd>' : "") +
          "</dl>"
        : out.settlementError
          ? '<div class="gate fail">✗ Settlement failed — authorized, not settled: ' + esc(out.settlementError) + "</div>"
          : "";
      const done = out.completed
        ? "<div style=\\"background:#0a7f2e;color:#fff;font-size:1.1rem;font-weight:700;line-height:1.4;padding:1rem 1.1rem;border-radius:8px;margin-bottom:1rem;text-align:center;\\">✓ Purchase complete<div style=\\"font-size:0.9rem;font-weight:500;margin-top:0.25rem;\\">Return to the chat, or <a href=\\"" + RETURN_URL + "\\" style=\\"color:#fff;text-decoration:underline;\\">return to checkout ›</a></div></div>"
        : "";
      el.innerHTML = done + gates + settlement;
      el.style.display = "block";
      if (out.completed) btn.textContent = "Authorized ✓";
    }
  </script>
</body>
</html>`;
}
