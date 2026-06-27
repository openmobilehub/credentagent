// Server-rendered credential-gate page (age / membership). The WORKING button is
// the presence-only "instant demo" — it POSTs a canonical positive claim for this
// order's threshold to /attesto/credential/verify (no real wallet round-trip; the
// mdoc is not cryptographically verified). The OpenID4VP wallet path
// (navigator.credentials.get) is noted as in-flight. Every surface states
// trust_level "presence-only-demo" (CT11 / Principle VII) so the page never reads
// as a real safety control.
import type { CredentialKind } from "./dcql.js";

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
}

const TRUST_NOTE = "trust_level: presence-only-demo — a flow demo, not a real safety control (no cryptographic mdoc trust check yet).";

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
  const cta = isAge ? `Verify age (instant demo)` : `Apply membership (instant demo)`;
  // The canonical positive claim the instant-demo button presents — it goes
  // through the SAME server-side explicit-positive-claim check as a real wallet.
  const demoClaims = isAge ? { [`age_over_${minimumAge}`]: true } : { membership_id: "DEMO-MEMBER-0001" };
  const totalLine = args.total != null ? `<p class="amount">Order ${escapeHtml(args.order)} · ${escapeHtml(args.currency ?? "USD")} ${args.total}</p>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 3rem auto; padding: 0 1.25rem; color: #1a1a1a; }
  h1 { font-size: 1.35rem; margin-bottom: 0.25rem; }
  p.lede { color: #555; margin-top: 0; line-height: 1.45; }
  p.amount { font-family: ui-monospace, Menlo, monospace; color: #333; }
  button { font-size: 1rem; padding: 0.75rem 1.1rem; border-radius: 6px; border: 1px solid #1a7f37; background: #1a7f37; color: #fff; cursor: pointer; width: 100%; margin-top: 0.75rem; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .step { padding: 0.4rem 0; font-family: ui-monospace, Menlo, monospace; font-size: 0.85rem; }
  .step.ok { color: #0a7f2e; } .step.err { color: #b00020; white-space: pre-wrap; }
  .trust { margin-top: 1rem; padding: 0.9rem 1rem; background: #fff7ed; border-left: 4px solid #d97706; border-radius: 6px; font-size: 0.85rem; color: #7c2d12; }
  .inflight { margin-top: 0.75rem; font-size: 0.8rem; color: #777; }
  #done { display:none; margin-top:1.25rem; background:#0a7f2e; color:#fff; font-weight:700; padding:1rem 1.1rem; border-radius:8px; text-align:center; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="lede">${escapeHtml(lede)}</p>
  ${totalLine}
  <button id="go">${escapeHtml(cta)}</button>
  <p class="inflight">OpenID4VP wallet presentation (navigator.credentials.get) — scaffolded, in-flight.</p>
  <div id="log"></div>
  <div id="done">Done — you can close this page and return to the chat.</div>
  <div class="trust">${escapeHtml(TRUST_NOTE)}</div>
  <script type="module">
    const ORDER = ${JSON.stringify(args.order)};
    const CRED = ${JSON.stringify(args.kind)};
    const DEMO_CLAIMS = ${JSON.stringify(demoClaims)};
    const log = document.getElementById("log");
    const go = document.getElementById("go");
    const doneEl = document.getElementById("done");
    const step = (t, c = "") => { const d = document.createElement("div"); d.className = "step " + c; d.textContent = t; log.appendChild(d); };
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
        doneEl.style.display = "block";
      } catch (err) {
        step("✗ " + (err?.message ?? String(err)), "err");
        go.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
