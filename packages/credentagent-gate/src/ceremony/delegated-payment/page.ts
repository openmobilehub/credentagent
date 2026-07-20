// The delegated rail's approve page. Unlike the sibling rails it does NOT call
// `navigator.credentials.get` itself: on this rail the EXTERNAL verifier runs the
// wallet ceremony, so the page's job is to fetch the handoff and pass it to that
// verifier, then carry the sealed reference back.
//
// Honesty (Principle VII): the page states that verification and settlement are
// performed by an external verifier, and it does NOT print a trust level — on this
// rail trust is whatever the verifier reports at /verify, which has not happened yet
// when this page renders.
//
// Scope: the completion leg (POST /verify) lands with #87. Until it exists this page
// stops after the handoff rather than pretending to complete — see routes.ts for why
// the verify route is absent rather than stubbed.

export interface DelegatedPageOptions {
  order: string;
  total: number;
  currency: string;
  lines: { name: string; quantity: number; lineTotal: number; currency: string }[];
  /** Opaque cart mandate passthrough (statelessOrders) — must survive every hop. */
  cart?: string;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const money = (n: number, currency: string): string => `${currency} ${n.toFixed(2)}`;

export function renderDelegatedPage(opts: DelegatedPageOptions): string {
  const { order, total, currency, lines, cart } = opts;
  const qs = `order=${encodeURIComponent(order)}${cart ? `&cart=${encodeURIComponent(cart)}` : ""}`;
  const rows = lines
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.name)}</td><td class="q">×${l.quantity}</td><td class="a">${money(l.lineTotal, l.currency)}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize payment</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; margin: 0; padding: 2rem 1.25rem; max-width: 34rem; margin-inline: auto; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  .sub { opacity: .7; font-size: .9rem; margin: 0 0 1.5rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
  td { padding: .5rem 0; border-bottom: 1px solid rgba(128,128,128,.25); }
  .q { text-align: center; opacity: .7; width: 4rem; }
  .a { text-align: right; white-space: nowrap; }
  .total { display: flex; justify-content: space-between; font-weight: 600; font-size: 1.1rem; margin-bottom: 1.5rem; }
  button { width: 100%; padding: .85rem 1rem; font: inherit; font-weight: 600; border: 0; border-radius: .5rem; background: #2563eb; color: #fff; cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; }
  .note { margin-top: 1.25rem; padding: .75rem .9rem; border-radius: .5rem; background: rgba(128,128,128,.12); font-size: .85rem; }
  #out { margin-top: 1rem; font-size: .85rem; white-space: pre-wrap; word-break: break-word; }
</style></head>
<body>
  <h1>Authorize payment</h1>
  <p class="sub">Order ${escapeHtml(order)}</p>
  <table>${rows}</table>
  <div class="total"><span>Total</span><span>${money(total, currency)}</span></div>

  <button id="go">Continue to your wallet</button>
  <div id="out" role="status"></div>

  <p class="note">
    Verification and settlement are performed by an <strong>external verifier</strong>.
    This site re-derives the amount from its own catalog and re-checks the result before
    completing &mdash; it does not accept an approval from this page.
  </p>

<script>
(function () {
  var go = document.getElementById("go");
  var out = document.getElementById("out");
  go.addEventListener("click", async function () {
    go.disabled = true;
    out.textContent = "Preparing request\\u2026";
    try {
      var res = await fetch("/credentagent/delegated/request?${qs}");
      if (!res.ok) throw new Error("request failed (" + res.status + ")");
      var data = await res.json();
      // The handoff is the external verifier's own payload; this page forwards it and
      // keeps the sealed reference for the completion leg (#87). Nothing here decides
      // whether the payment is approved.
      sessionStorage.setItem("credentagent.delegated.ref", data.referenceToken);
      out.textContent = "Handoff ready. Completion lands with the verify leg.";
    } catch (err) {
      out.textContent = "Could not start: " + err.message;
      go.disabled = false;
    }
  });
})();
</script>
</body></html>`;
}
