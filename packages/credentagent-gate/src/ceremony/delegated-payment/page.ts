// The delegated rail's approve page. Unlike the sibling rails it does NOT call
// `navigator.credentials.get` itself: the EXTERNAL verifier runs the wallet ceremony, so
// the page fetches the handoff, drives that verifier's browser flow, then POSTs ONLY the
// sealed reference to /verify (never an approval) for the gate's non-delegable re-checks
// + settlement.
//
// Design: shares the SAME chrome as the age / dc-payment rails — `brandHeader`, the
// order-derived progress rail (`checkoutRail`, built by the route), `orderSummaryCard`
// and `trustFooter` — so a buyer who reaches it from the age screen sees one continuous
// flow, not a bare fallback page.
//
// Honesty (Principle VII): before verify, the page announces NO positive trust outcome —
// the static `trustFooter` is the demo's standing disclaimer ("issuer trust anchor is not
// [real]"), not a per-payment badge. The REAL trust is whatever the verifier reports at
// /verify; the completion line relays that verbatim (`result.trust_level`), never upgrading it.
//
// On completion the page shows the shared "Order complete" banner and returns the buyer to
// the checkout hub (which reflects the paid state) so they are not stranded on the ceremony
// page; a refusal shows the reason plus a return link, never a dead end.

import { pageHead, brandHeader, orderSummaryCard, trustFooter, completionHandoffBanner, railCompleteScript } from "../theme.js";

export interface DelegatedPageOptions {
  order: string;
  total: number;
  currency: string;
  lines: { name: string; quantity: number; lineTotal: number; currency: string }[];
  /** Opaque cart mandate passthrough (statelessOrders) — must survive every hop. */
  cart?: string;
  /** Where to send the buyer after a completed payment — the checkout hub. Defaults to
   *  this server's `/checkout?order=<id>`. */
  returnUrl?: string;
  /** The order-derived progress rail HTML (from `checkoutRail`), built by the route which
   *  holds the full re-priced order. Absent ⇒ no rail (never a hardcoded one). */
  rail?: string;
}

export function renderDelegatedPage(opts: DelegatedPageOptions): string {
  const { order, total, currency, lines, cart, rail } = opts;
  const qs = `order=${encodeURIComponent(order)}${cart ? `&cart=${encodeURIComponent(cart)}` : ""}`;
  const returnUrl = opts.returnUrl ?? `/checkout?order=${encodeURIComponent(order)}${cart ? `&cart=${cart}` : ""}`;
  // The shared order summary card (line items + bold Total) — same chrome as the hub.
  const summary = orderSummaryCard({
    lines: lines.map((l) => ({ name: l.name, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency })),
    total,
    currency,
    caption: `Order ${order}`,
  });

  return `<!doctype html>
<html lang="en">
${pageHead(`Authorize payment · ${order}`)}
<body>
  <div class="wrap">
  ${brandHeader({ h1: "Authorize payment", tagline: "Authorize from your wallet" })}
  ${rail ?? ""}
  ${summary}
  <div class="card">
    <p class="lede">Continue to your wallet to present a payment credential. Verification and
      settlement are handled by an <strong>external verifier</strong> — this site re-derives the
      amount from its own catalog and re-checks the verifier's result before completing, so it
      never accepts an approval from this page.</p>
    <button id="go" class="btn btn-primary">Continue to your wallet</button>
    <div id="out" class="small" role="status"></div>
    <div id="done"></div>
  </div>
  ${trustFooter()}
<script>
(function () {
  var go = document.getElementById("go");
  var out = document.getElementById("out");
  var done = document.getElementById("done");
  var ORDER = ${JSON.stringify(order)};
  var RETURN_URL = ${JSON.stringify(returnUrl)};
  var DONE_BANNER = ${JSON.stringify(completionHandoffBanner(returnUrl))};
  go.addEventListener("click", async function () {
    go.disabled = true;
    out.textContent = "Preparing request\\u2026";
    try {
      var res = await fetch("/credentagent/delegated/request?${qs}");
      if (!res.ok) throw new Error("request failed (" + res.status + ")");
      var data = await res.json();
      var handoff = data.handoff || {};

      // ── Drive the EXTERNAL verifier's wallet ceremony in the browser ──
      // The verifier serves a client script at handoff.verifierBase (e.g. Multipaz's
      // verify_credentials.js). Load it, then hand it the request — THIS is what opens the
      // wallet (navigator.credentials.get / the wallet URL scheme). A local stand-in omits
      // verifierBase, so there is nothing to drive on-page and this block is skipped.
      if (handoff.verifierBase) {
        if (typeof window.multipazVerifyCredentials !== "function") {
          await new Promise(function (resolve, reject) {
            var s = document.createElement("script");
            s.src = String(handoff.verifierBase).replace(/\\/$/, "") + "/verify_credentials.js";
            s.onload = resolve;
            s.onerror = function () { reject(new Error("could not load the verifier's wallet script")); };
            document.head.appendChild(s);
          });
        }
        out.textContent = "Opening your wallet\\u2026";
        // The verified presentment is captured server-side (keyed by the reference); we ignore
        // the return value and carry only the sealed reference back to /verify below.
        await window.multipazVerifyCredentials(handoff);
      }
      out.textContent = "Verifying\\u2026";

      // Complete: the browser sends back ONLY the sealed reference — never an approval.
      // The gate re-fetches the verified presentment, re-checks the amount + policy, and
      // settles server-side.
      var res2 = await fetch("/credentagent/delegated/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order: ORDER, referenceToken: data.referenceToken }),
      });
      var result = await res2.json();
      if (result.completed) {
        // Relay the verifier's reported trust verbatim — never upgraded here.
        out.textContent = "\\u2713 Payment complete \\u00b7 trust: " + result.trust_level;
        done.innerHTML = DONE_BANNER; // "Order complete" + a Return to checkout link
        ${railCompleteScript()}
        // Return the buyer to the checkout hub (it shows the paid state) so they are not
        // stranded here — the completion the buyer asked to see happens on the hub.
        setTimeout(function () { location.href = RETURN_URL; }, 1600);
      } else {
        out.textContent = "Refused: " + (result.reason || result.error || "not completed");
        done.innerHTML = '<a class="ret" href="' + RETURN_URL + '">Return to checkout \\u203a</a>';
        go.disabled = false;
      }
    } catch (err) {
      out.textContent = "Could not complete: " + err.message;
      done.innerHTML = '<a class="ret" href="' + RETURN_URL + '">Return to checkout \\u203a</a>';
      go.disabled = false;
    }
  });
})();
</script>
  </div>
</body></html>`;
}
