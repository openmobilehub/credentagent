// Server-rendered credential-gate page (age / membership). It now drives the REAL
// OpenID4VP wallet path: the PRIMARY button calls navigator.credentials.get({digital})
// synchronously inside the tap (the request is PRE-FETCHED from
// /attesto/credential/request so no await sits between the click and get() — iOS WebKit
// drops the transient user activation across an await), then POSTs the wallet result to
// /attesto/credential/verify in the shape the route's real path reads
// ({ order, cred, readerContextToken, mdocContextToken, result:{protocol,data} }) — the
// route dispatches by result.protocol (openid4vp → JWE/nonce-bound; org-iso-mdoc →
// mdoc DeviceResponse). The SECONDARY "instant demo" button is kept as a fallback: it
// POSTs a canonical positive claim ({ order, cred, claims }) for this order's threshold
// (no wallet round-trip; the tested default). On a browser without the Digital
// Credentials API the page points the buyer at the instant-demo button. Every surface
// states trust_level "presence-only-demo" (CT11 / Principle VII / FR-011): the wire
// crypto is real; the issuer trust anchor is not — never a real safety control.
import type { CredentialKind } from "./dcql.js";
import { pageHead, brandHeader, progressRail, trustFooter } from "../theme.js";

export interface CredentialPageArgs {
  kind: CredentialKind;
  /** Order id, echoed back so verify is scoped to one order. */
  order: string;
  /** Re-derived from the catalog (age gate). */
  minimumAge?: number;
  /** Catalog-priced total, shown for context (never the token's). */
  total?: number;
  currency?: string;
  /** Membership discount percent (membership gate). */
  percent?: number;
  /**
   * Where to send the buyer after this gate succeeds — the checkout hub, so the
   * sequence flows (hub → gate → back to hub with this gate ✓ → next gate).
   * Defaults to this server's `/checkout?order=<id>`.
   */
  returnUrl?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderCredentialPage(args: CredentialPageArgs): string {
  const minimumAge = args.minimumAge ?? 21;
  const percent = args.percent ?? 10;
  const isAge = args.kind === "age";
  const title = isAge ? `Verify your age (${minimumAge}+)` : "Apply membership discount";
  const lede = isAge
    ? `Your cart contains age-restricted items. Present a digital ID so we can confirm you are ${minimumAge} or older. Nothing is stored — only an over-${minimumAge} check.`
    : `Present your membership credential to take ${percent}% off your cart. Optional — your purchase works without it.`;
  const cta = isAge ? `Verify with my digital ID` : `Present membership credential`;
  const demoCta = isAge ? `Verify age (instant demo)` : `Apply membership (instant demo)`;
  // The canonical positive claim the instant-demo button presents — it goes
  // through the SAME server-side explicit-positive-claim check as a real wallet.
  const demoClaims = isAge ? { [`age_over_${minimumAge}`]: true } : { membership_number: "DEMO-MEMBER-0001" };
  const totalLine = args.total != null ? `<p class="small amount">Order ${escapeHtml(args.order)} · ${escapeHtml(args.currency ?? "USD")} ${args.total}</p>` : "";
  const returnUrl = args.returnUrl ?? `/checkout?order=${encodeURIComponent(args.order)}`;
  // Identity-first tagline + the progress rail with THIS gate marked current. The age
  // gate is step 0 (Age) of Age · Membership · Pay; membership is the middle step.
  const tagline = isAge ? "Present a digital ID" : "Present a membership credential";
  const rail = isAge
    ? progressRail([{ label: "Age" }, { label: "Membership" }, { label: "Pay" }], 0)
    : progressRail([{ label: "Age", done: true }, { label: "Membership" }, { label: "Pay" }], 1);
  // The PAGE-LOCAL extra styles: the calm gate-page chrome (verify log + the success
  // banner) layered over the shared design system. The verify-progress rows reuse the
  // shared `.step` styling; only the `#done` banner is page-specific.
  const extraCss = `
  .amount { font-variant-numeric: tabular-nums; }
  #done { display:none; margin-top:16px; background:var(--accent); color:#fff; font-weight:700; padding:16px; border-radius:12px; text-align:center; }
  #done a { color:#fff; text-decoration:underline; }`;

  return `<!doctype html>
<html lang="en">
${pageHead(title, extraCss)}
<body>
  <div class="wrap">
  ${brandHeader({ h1: title, tagline })}
  ${rail}
  <div class="card">
    <p class="lede">${escapeHtml(lede)}</p>
    ${totalLine}
    <button id="go-dc" class="btn btn-primary">${escapeHtml(cta)}</button>
    <button id="go" class="btn btn-secondary">${escapeHtml(demoCta)}</button>
    <div id="log"></div>
  </div>
  <div id="done">✓ Done — returning to checkout… <a id="back" href="${escapeHtml(returnUrl)}">continue now ›</a></div>
  ${trustFooter()}
  <script type="module">
    const ORDER = ${JSON.stringify(args.order)};
    const CRED = ${JSON.stringify(args.kind)};
    const DEMO_CLAIMS = ${JSON.stringify(demoClaims)};
    const RETURN_URL = ${JSON.stringify(returnUrl)};
    const log = document.getElementById("log");
    const goDc = document.getElementById("go-dc");
    const go = document.getElementById("go");
    const doneEl = document.getElementById("done");
    const step = (t, c = "") => { const d = document.createElement("div"); d.className = "step " + c; d.textContent = t; log.appendChild(d); };
    function notice(html) { const d = document.createElement("div"); d.className = "notice"; d.innerHTML = html; log.appendChild(d); }
    function done() {
      goDc.disabled = true; go.disabled = true;
      doneEl.style.display = "block";
      // Return to the checkout hub so the next gate is one tap away (no manual
      // browser-back). The hub re-reads verification state and shows this gate ✓.
      setTimeout(() => { window.location.assign(RETURN_URL); }, 650);
    }

    // Pre-fetch the REAL OpenID4VP + org-iso-mdoc request so navigator.credentials.get()
    // can be called SYNCHRONOUSLY inside the tap. iOS WebKit drops the transient user
    // activation across an await, so we must not fetch between the click and get(). We
    // keep a fresh pre-fetched request ready at all times. location.search carries the
    // order + cred this gate is scoped to, so /request re-prices THIS order.
    let reqData = null;
    function prefetch() {
      reqData = null;
      fetch("/attesto/credential/request" + location.search).then((r) => r.json()).then((d) => { reqData = d; }).catch(() => {});
    }

    if (!navigator.credentials || !navigator.credentials.get) {
      goDc.disabled = true;
      notice("This browser doesn't support the Digital Credentials API (needs Chrome 141+/Android or iOS 18+). Use the <strong>instant demo</strong> button.");
    } else {
      prefetch();
    }

    goDc.addEventListener("click", () => {
      if (!navigator.credentials || !navigator.credentials.get) {
        notice("This browser doesn't support the Digital Credentials API. Use the instant-demo button.");
        return;
      }
      if (!reqData || !reqData.requests) { notice("Preparing the request — tap again in a second."); prefetch(); return; }
      goDc.disabled = true;
      const rd = reqData;
      step("→ navigator.credentials.get({digital}) — choose your wallet…");
      // Called synchronously (no await before it) to keep the user activation.
      navigator.credentials.get({ digital: { requests: rd.requests }, mediation: "required" })
        .then(async (result) => {
          let data = result && result.data != null ? result.data : null;
          if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
          step("→ verify (" + ((result && result.protocol) || "?") + ")");
          const out = await fetch("/attesto/credential/verify", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: ORDER, cred: CRED, readerContextToken: rd.readerContextToken, mdocContextToken: rd.mdocContextToken, result: { protocol: (result && result.protocol) || null, data } }),
          }).then((r) => r.json());
          if (!out.verified) throw new Error(out.error || "not verified");
          step("✓ verified (" + out.trust_level + ")", "ok");
          done();
        })
        .catch((err) => {
          step("✗ " + ((err && err.message) || String(err)), "err");
          goDc.disabled = false;
          prefetch(); // fresh request for the next attempt
        });
    });

    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        step("→ verify (presence-only)");
        const out = await fetch("/attesto/credential/verify", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: ORDER, cred: CRED, claims: DEMO_CLAIMS }),
        }).then((r) => r.json());
        if (!out.verified) throw new Error(out.error || "not verified");
        step("✓ verified (" + out.trust_level + ")", "ok");
        done();
      } catch (err) {
        step("✗ " + (err?.message ?? String(err)), "err");
        go.disabled = false;
      }
    });
  </script>
  </div>
</body>
</html>`;
}
