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
  /** Does THIS order's policy carry a payment credential (`policyHasPayment`)? When it does
   *  not, the ceremony settles nothing, so the page must not announce a payment, a payment
   *  credential or a settlement — it proves identity and returns. Defaults to true so the
   *  payment framing stays the default for every existing caller. */
  hasPayment?: boolean;
}

export function renderDelegatedPage(opts: DelegatedPageOptions): string {
  const { order, total, currency, lines, cart, rail } = opts;
  // Honesty (Principle VII): the page may not claim more than the ceremony does. A policy
  // with no authorize() credential never settles — pinned by "an identity-only delegated
  // gate (no payment) completes with NO settlement call" — so every word below that promises
  // a payment is simply false on that path.
  const hasPayment = opts.hasPayment !== false;
  const copy = hasPayment
    ? {
        h1: "Authorize payment",
        tagline: "Authorize from your wallet",
        lede: `Continue to your wallet to present a payment credential. Verification and
      settlement are handled by an <strong>external verifier</strong> — this site re-derives the
      amount from its own catalog and re-checks the verifier's result before completing, so it
      never accepts an approval from this page.`,
        complete: "\\u2713 Payment complete \\u00b7 trust: ",
        banner: {},
        returnLabel: "Return to checkout \\u203a",
      }
    : {
        h1: "Verify your credential",
        tagline: "Prove it from your wallet",
        lede: `Continue to your wallet to present the credential this action requires. Verification
      is handled by an <strong>external verifier</strong> — this site re-checks the verifier's
      result before releasing the action, so it never accepts an approval from this page.`,
        complete: "\\u2713 Verified \\u00b7 trust: ",
        banner: { headline: "✓ Verified", returnLabel: "Staying in the browser? Continue ›" },
        returnLabel: "Continue \\u203a",
      };
  const qs = `order=${encodeURIComponent(order)}${cart ? `&cart=${encodeURIComponent(cart)}` : ""}`;
  // `cart` is caller-supplied and lands in a URL the page later renders, so it is
  // percent-encoded here exactly as `qs` above does. Unencoded, a crafted
  // `?cart="><img src=x onerror=…>` would survive into the page as raw markup.
  // (A legitimate mandate is base64url, which encodeURIComponent leaves byte-identical.)
  const returnUrl = opts.returnUrl ?? `/checkout?order=${encodeURIComponent(order)}${cart ? `&cart=${encodeURIComponent(cart)}` : ""}`;
  // The shared summary card — same chrome as the hub. On an identity-only gate it still
  // names WHAT is being gated (the one thing the user is consenting to) but shows no
  // money: nothing was priced, and a "$0.00 Total" reads as a free purchase.
  const summary = orderSummaryCard({
    lines: lines.map((l) => ({ name: l.name, quantity: l.quantity, lineTotal: l.lineTotal, currency: l.currency })),
    total,
    currency,
    caption: `${hasPayment ? "Order" : "Request"} ${order}`,
    showAmounts: hasPayment,
  });

  return `<!doctype html>
<html lang="en">
${pageHead(`${copy.h1} · ${order}`)}
<body>
  <div class="wrap">
  ${brandHeader({ h1: copy.h1, tagline: copy.tagline })}
  ${rail ?? ""}
  ${summary}
  <div class="card">
    <p class="lede">${copy.lede}</p>
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
  // statelessOrders (FR-007): the signed cart mandate on the URL is the ONLY order transport —
  // there is no order store to fall back on — so it must ride every hop, including the verify
  // POST below. Read from the live URL, exactly as the dc-payment rail does.
  var CART = new URLSearchParams(location.search).get("cart");
  var RETURN_URL = ${JSON.stringify(returnUrl)};
  var DONE_BANNER = ${JSON.stringify(completionHandoffBanner(returnUrl, copy.banner))};
  // Show the return link (labelled for this ceremony) built with DOM APIs — never by
  // concatenating RETURN_URL into innerHTML. The URL carries a caller-supplied cart param,
  // and innerHTML would PARSE any markup that survived in it; setAttribute + textContent cannot.
  // (The success path uses DONE_BANNER, which the server already HTML-escapes.)
  function showReturnLink() {
    var a = document.createElement("a");
    a.className = "ret";
    a.setAttribute("href", RETURN_URL);
    a.textContent = "${copy.returnLabel}";
    done.textContent = "";
    done.appendChild(a);
  }
  go.addEventListener("click", async function () {
    go.disabled = true;
    out.textContent = "Preparing request\\u2026";
    try {
      var res = await fetch("/credentagent/delegated/request?${qs}");
      if (!res.ok) throw new Error("request failed (" + res.status + ")");
      var data = await res.json();
      var handoff = data.handoff || {};

      // ── Drive the EXTERNAL verifier's wallet ceremony in the browser ──
      // The ADAPTER names its verifier, not the gate: data.clientScript is a URL that
      // verifier serves, and data.clientEntry the global function it defines. Load it, then
      // hand it the opaque handoff — THIS is what opens the wallet (navigator.credentials.get
      // / a wallet URL scheme). The gate interprets these only as "a script" and "a function
      // name", so ANY adapter works without the package naming it. A verifier that captures
      // the presentment server-side omits both, and this block is skipped.
      if (data.clientScript && data.clientEntry) {
        if (typeof window[data.clientEntry] !== "function") {
          await new Promise(function (resolve, reject) {
            var s = document.createElement("script");
            s.src = data.clientScript;
            s.onload = resolve;
            s.onerror = function () { reject(new Error("could not load the verifier's wallet script")); };
            document.head.appendChild(s);
          });
        }
        var entry = window[data.clientEntry];
        if (typeof entry !== "function") throw new Error("the verifier's script did not define " + data.clientEntry);
        out.textContent = "Opening your wallet\\u2026";
        // The verified presentment is captured server-side (keyed by the reference); we ignore
        // the return value and carry only the sealed reference back to /verify below.
        await entry(handoff);
      }
      out.textContent = "Verifying\\u2026";

      // Complete: the browser sends back ONLY the sealed reference — never an approval.
      // The gate re-fetches the verified presentment, re-checks the amount + policy, and
      // settles server-side.
      var res2 = await fetch("/credentagent/delegated/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ order: ORDER, cart: CART, referenceToken: data.referenceToken }),
      });
      var result = await res2.json();
      if (result.completed) {
        // Relay the verifier's reported trust verbatim — never upgraded here.
        out.textContent = "${copy.complete}" + result.trust_level;
        done.innerHTML = DONE_BANNER; // the completion banner + its return link
        ${railCompleteScript()}
        // Return the buyer to the checkout hub (it shows the paid state) so they are not
        // stranded here — the completion the buyer asked to see happens on the hub.
        setTimeout(function () { location.href = RETURN_URL; }, 1600);
      } else {
        out.textContent = "Refused: " + (result.reason || result.error || "not completed");
        showReturnLink();
        go.disabled = false;
      }
    } catch (err) {
      out.textContent = "Could not complete: " + err.message;
      showReturnLink();
      go.disabled = false;
    }
  });
})();
</script>
  </div>
</body></html>`;
}
