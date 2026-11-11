// The receipt page for a delegated (agent-signed) order — demo-only. It shows the AP2 payload the
// store verified, as JSON, and links the same payload for download. It renders the four mandates and
// nothing else: see `ap2PayloadView` in the gate. Every value is escaped; payload strings come from
// the agent and the wallet.
import type { Ap2PayloadView } from "@openmobilehub/credentagent-gate";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const json = (v: unknown) => esc(JSON.stringify(v, null, 2));

const SECTIONS: Array<{ title: string; note: string; pick: (v: Ap2PayloadView) => unknown }> = [
  { title: "Open Checkout mandate", note: "signed by the person's wallet", pick: (v) => v.intent.checkout },
  { title: "Open Payment mandate", note: "signed by the person's wallet: the limits", pick: (v) => v.intent.payment },
  { title: "Checkout mandate", note: "signed by the agent: this cart", pick: (v) => v.checkout },
  { title: "Payment mandate", note: "signed by the agent: the payment for exactly that cart", pick: (v) => v.payment },
];

export function renderAp2Order(orderId: string, view: Ap2PayloadView, payloadUrl: string, amount: number, currency: string): string {
  const sections = SECTIONS.map((s) => `<h3>${s.title} <small>${s.note}</small></h3><pre>${json(s.pick(view))}</pre>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Order ${esc(orderId)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1a1a2e}pre{background:#f4f5f8;padding:.75rem;border-radius:8px;overflow:auto;font-size:12.5px}small{font-weight:400;color:#667}.trust{border:1px solid #d8dbe3;border-radius:8px;padding:.75rem;background:#fafbfc}a{color:#2563eb}</style></head>
<body><h1>Order ${esc(orderId)}</h1>
<p>${esc(currency)} ${esc(amount.toFixed(2))} · paid by an agent with a spending permission its person signed on a phone wallet.</p>
<h2>AP2 payload</h2>
<p><a href="${esc(payloadUrl)}">Open this payload as JSON</a></p>
${sections}
<p class="trust">🔒 ${esc(view.trustLevel)} · the wallet's key signed these limits and the agent's key signed this purchase. Nothing proves who issued the credential behind them yet. A demo of the consent flow, not a safety control.</p>
</body></html>`;
}
