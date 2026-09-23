// The intent-sign ceremony page (spec 012). A device-mode grant's approveUrl serves
// THIS page instead of the click-to-approve page: it shows the grant bounds the human
// is authorizing and drives the REAL wallet signature.
//
// It mirrors the credential-gate page's DC API client: pre-fetch the OpenID4VP request
// (so navigator.credentials.get can be called synchronously inside the tap — iOS drops
// the user activation across an await), call get({digital}), then POST the wallet result
// to the rail's /verify. The platform mediates same-device vs cross-device (QR) selection,
// exactly like the credential rail.
//
// The honesty line is `deviceSignedTrustFooter()` (FR-4): the device signature is real;
// the trust anchor is a demo credential. Host branding customises the chrome (#132) but
// never the trust line.
import type { Branding } from "../../types.js";
import { pageHead, brandHeader, deviceSignedTrustFooter } from "../theme.js";

export interface IntentSignPageArgs {
  /** The grant id — scopes the /request + /verify calls. */
  grantId: string;
  merchant: string;
  budget: number;
  perSpend: number;
  allow?: { skus?: string[]; categories?: string[] };
  description?: string;
  /** Where to send the human after the grant authorizes (absent ⇒ just show "done"). */
  returnUrl?: string;
  branding?: Branding;
  /** The progress rail for this grant's steps (#172), rendered by `grants.serve`. Absent ⇒ none. */
  rail?: string;
  /** Optional step cards shown ABOVE the signature (#172) — the wallet credentials the human may
   *  present before signing. They belong above it because what they prove is part of what they
   *  sign: the proofs are inside `canonicalIntentBounds`, so the signature covers them. */
  steps?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderIntentSignPage(args: IntentSignPageArgs): string {
  const title = "Sign this spending grant";
  const bounds = [
    // WHO you are authorizing spend to is consent-tier — always shown, first, alongside the
    // amounts and item bounds. This structured set renders even when `description` is absent, so
    // the human never signs without seeing the full merchant + budget + per-purchase + allow set.
    `to <strong>${escapeHtml(args.merchant)}</strong>`,
    `up to <strong>$${args.budget}</strong> total`,
    `max <strong>$${args.perSpend}</strong> per purchase`,
    ...(args.allow?.categories?.length ? [`only <strong>${escapeHtml(args.allow.categories.join(", "))}</strong>`] : []),
    ...(args.allow?.skus?.length ? [`only these items: <strong>${escapeHtml(args.allow.skus.join(", "))}</strong>`] : []),
  ].join(" · ");
  // The description is a nice-to-have lede; the structured bounds above carry the guarantee.
  const lede = args.description
    ? escapeHtml(args.description)
    : `An AI agent asks to spend on your behalf while you're away. Sign this with your wallet to authorize exactly the bounds below — nothing more.`;

  const extraCss = `
  .bounds { margin:12px 0; padding:12px 14px; background:var(--surface-2, #f6f7f9); border-radius:12px; font-size:.95rem; }
  #done { display:none; margin-top:16px; background:var(--accent); color:#fff; font-weight:700; padding:16px; border-radius:12px; text-align:center; }
  #done a { color:#fff; text-decoration:underline; }`;

  return `<!doctype html>
<html lang="en">
${pageHead(title, extraCss, args.branding)}
<body>
  <div class="wrap">
  ${brandHeader({ h1: title, tagline: "Sign with your wallet" }, args.branding)}
  ${args.rail ?? ""}
  ${args.steps ?? ""}
  <div class="card">
    <p class="lede">${lede}</p>
    <div class="bounds">${bounds}</div>
    <p class="small">What you see here is page-attested; what you authorize is <strong>device-signed</strong> — your wallet's key signs over these exact bounds.</p>
    <button id="go-dc" class="btn btn-primary">Sign with your wallet</button>
    <div id="log"></div>
  </div>
  <div id="done">✓ Signed — this grant is now authorized. <a id="back" href="${escapeHtml(args.returnUrl ?? "#")}">continue ›</a></div>
  ${deviceSignedTrustFooter()}
  <script type="module">
    const ID = ${JSON.stringify(args.grantId)};
    const RETURN_URL = ${JSON.stringify(args.returnUrl ?? "")};
    const log = document.getElementById("log");
    const goDc = document.getElementById("go-dc");
    const doneEl = document.getElementById("done");
    const step = (t, c = "") => { const d = document.createElement("div"); d.className = "step " + c; d.textContent = t; log.appendChild(d); };
    function notice(html) { const d = document.createElement("div"); d.className = "notice"; d.innerHTML = html; log.appendChild(d); }
    function done() {
      goDc.disabled = true;
      doneEl.style.display = "block";
      if (RETURN_URL) setTimeout(() => { window.location.assign(RETURN_URL); }, 800);
    }

    // Pre-fetch the signed OpenID4VP request so get() runs synchronously inside the tap.
    let reqData = null;
    function prefetch() {
      reqData = null;
      fetch("/credentagent/grants/" + encodeURIComponent(ID) + "/sign/request").then((r) => r.json()).then((d) => { reqData = d; }).catch(() => {});
    }
    const DC_API = !!(navigator.credentials && navigator.credentials.get);
    if (!DC_API) {
      goDc.disabled = true;
      notice("Signing needs a digital wallet on a supported device — Chrome 141+ on Android (import <code>payment.mpzpass</code> into Multipaz), or scan from another device. This browser can't run the wallet ceremony.");
    } else {
      prefetch();
    }

    goDc.addEventListener("click", () => {
      if (!reqData || !reqData.requests) { notice("Preparing the request — tap again in a second."); prefetch(); return; }
      goDc.disabled = true;
      const rd = reqData;
      step("→ navigator.credentials.get({digital}) — choose your wallet…");
      navigator.credentials.get({ digital: { requests: rd.requests }, mediation: "required" })
        .then(async (result) => {
          let data = result && result.data != null ? result.data : null;
          if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) {} }
          step("→ verify device signature…");
          const out = await fetch("/credentagent/grants/" + encodeURIComponent(ID) + "/sign/verify", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ readerContextToken: rd.readerContextToken, result: { protocol: (result && result.protocol) || null, data } }),
          }).then((r) => r.json());
          if (!out.ok) throw new Error(out.reason || "not verified");
          step("✓ device-signed (" + out.trustLevel + ")", "ok");
          done();
        })
        .catch((err) => {
          step("✗ " + ((err && err.message) || String(err)), "err");
          goDc.disabled = false;
          prefetch();
        });
    });
  </script>
  </div>
</body>
</html>`;
}
