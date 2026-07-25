// CredentAgent — "see it work" hub. ONE page where you click through every shipped capability
// yourself, with the webhook made VISIBLE (watch it fire + get signature-verified live).
//
//   node examples/demo-hub/hub.mjs      # → open http://localhost:4000
//
// It wires the real library: credentagent.orders.serve() (the checkout) + a webhook endpoint
// pointed back at this same app's /hooks receiver, so completing a checkout POSTs a SIGNED
// order.settled event that shows up in the live feed — the invisible made visible.
import express from "express";
import { CredentAgent, constructEvent, generateWebhookSecret, SIGNATURE_HEADER, age, payment, required } from "@openmobilehub/credentagent-gate";

const PORT = 4000;
const SECRET = generateWebhookSecret();
const app = express();
// JSON-parse every route EXCEPT /hooks — the webhook signature is over the RAW bytes, so that
// route reads the body with express.raw() below; parsing it here would break verification.
app.use((req, res, next) => (req.path === "/hooks" ? next() : express.json()(req, res, next)));

// Live feed plumbing: /hooks verifies + broadcasts; the page listens on /events (SSE).
const clients = new Set();
const broadcast = (obj) => { const line = `data: ${JSON.stringify(obj)}\n\n`; for (const res of clients) res.write(line); };

// The gate, configured to POST every settled order to THIS app's /hooks (a stand-in for a
// separate fulfillment service). One config line turns on signed HTTP delivery.
const credentagent = new CredentAgent({
  walletOrigin: `http://localhost:${PORT}`,
  webhooks: { endpoints: [{ url: `http://localhost:${PORT}/hooks`, secret: SECRET }] },
});
credentagent.orders.serve(app);

// ── the "different service" that receives the webhook ──────────────────────────
app.post("/hooks", express.raw({ type: "application/json" }), (req, res) => {
  let event, verified = true, reason = "";
  try { event = constructEvent(req.body, req.get(SIGNATURE_HEADER), SECRET); }
  catch (err) { verified = false; reason = err.message; }
  broadcast(verified
    ? { verified: true, type: event.type, id: event.id, order: event.data.object }
    : { verified: false, reason });
  res.json({ received: true });
});
app.get("/events", (req, res) => {
  res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

// ── what an agent calls to start a purchase (returns a link to open) ───────────
app.post("/demo/buy-sticker", async (_req, res) => res.json(await credentagent.orders.create({
  order: { id: "", total: 5, currency: "USD", lines: [{ id: "sticker", name: "Sticker pack", quantity: 1, unitPrice: 5 }] },
  policy: [], // ungated → completes with a click, no wallet needed
})));
app.post("/demo/buy-wine", async (_req, res) => res.json(await credentagent.orders.create({
  order: { id: "", total: 21, currency: "USD", lines: [{ id: "wine", name: "Bottle of wine", quantity: 1, unitPrice: 21, minimumAge: 21 }] },
  policy: [required(age.over(21)), required(payment.in("usd"))], // gated → shows the 21+ age gate
})));

app.get("/", (_req, res) => res.type("html").send(PAGE));

app.listen(PORT, () => {
  console.log(`\n  CredentAgent demo hub → open http://localhost:${PORT}\n`);
  console.log(`  webhook receiver verifying with secret ${SECRET.slice(0, 14)}…\n`);
});

const PAGE = /* html */ `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CredentAgent — see it work</title>
<style>
  :root { color-scheme: light dark; --bg:#0b0d10; --card:#15181d; --ink:#e8eaed; --muted:#9aa3ad; --line:#262b32; --accent:#3fae8e; --ok:#3fae8e; --bad:#e5675f; }
  @media (prefers-color-scheme: light){ :root{ --bg:#f6f7f9; --card:#fff; --ink:#1a1d21; --muted:#5b636c; --line:#e4e7eb; } }
  * { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-size: 28px; margin: 0 0 6px; } .sub { color:var(--muted); margin:0 0 28px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:22px 24px; margin:16px 0; }
  .card h2 { font-size:17px; margin:0 0 4px; } .card p { color:var(--muted); margin:6px 0 16px; }
  .n { display:inline-flex; width:24px; height:24px; border-radius:50%; background:var(--accent); color:#03150f; font-weight:700; font-size:13px; align-items:center; justify-content:center; margin-right:8px; vertical-align:2px; }
  button { font:inherit; font-weight:600; border:0; border-radius:10px; padding:11px 16px; cursor:pointer; background:var(--accent); color:#03150f; }
  button.ghost { background:transparent; color:var(--ink); border:1px solid var(--line); }
  .row { display:flex; gap:10px; flex-wrap:wrap; }
  #feed { margin-top:14px; display:flex; flex-direction:column; gap:8px; min-height:44px; }
  .ev { border:1px solid var(--line); border-left:3px solid var(--ok); border-radius:8px; padding:10px 12px; font-size:14px; animation:pop .25s ease; }
  .ev.bad { border-left-color:var(--bad); } .ev .k { color:var(--muted); }
  .empty { color:var(--muted); font-size:14px; font-style:italic; }
  @keyframes pop { from{ opacity:0; transform:translateY(-4px);} to{opacity:1;transform:none;} }
  code { background:rgba(127,127,127,.14); padding:1px 5px; border-radius:5px; font-size:13px; }
  .foot { color:var(--muted); font-size:13px; margin-top:28px; border-top:1px solid var(--line); padding-top:16px; }
</style></head><body><div class="wrap">
  <h1>CredentAgent — see it work</h1>
  <p class="sub">The consent layer for AI agents. Click through it yourself — no code, no wallet needed for the quick path.</p>

  <div class="card">
    <h2><span class="n">1</span>A checkout an agent can drive</h2>
    <p>An AI agent starts a purchase and hands <em>you</em> a link. You approve on the page. Try the quick one (completes with a click), or the age-gated one (shows the real 21+ gate).</p>
    <div class="row">
      <button onclick="start('sticker')">Buy a $5 sticker pack →</button>
      <button class="ghost" onclick="start('wine')">Buy $21 wine (21+ gate) →</button>
    </div>
  </div>

  <div class="card">
    <h2><span class="n">2</span>The webhook — a different service gets told, <em>signed</em></h2>
    <p>When an order settles, the gate sends a <strong>signed</strong> HTTP notification to a separate service. Below is that service's live feed. Complete a checkout above and watch its <code>order.settled</code> event arrive here — with its signature verified.</p>
    <div id="feed"><span class="empty">Waiting for a settled order… complete a checkout above.</span></div>
  </div>

  <p class="foot">🔒 <strong>Demo, not a safety control.</strong> The signature is real HMAC-SHA256, but the wallet trust level is <code>presence-only-demo</code> (no issuer anchor yet) and <strong>no real money moves</strong>.</p>
</div>
<script>
  async function start(kind){
    const r = await fetch('/demo/buy-' + kind, { method:'POST' });
    const { approveUrl } = await r.json();
    window.open(approveUrl, '_blank');            // the checkout page opens in a new tab
  }
  const feed = document.getElementById('feed');
  new EventSource('/events').onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (feed.querySelector('.empty')) feed.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'ev' + (e.verified ? '' : ' bad');
    div.innerHTML = e.verified
      ? '✓ <strong>' + e.type + '</strong> — signature verified · <span class="k">order</span> ' + e.order.orderId
        + ' · <span class="k">$</span>' + (e.order.amount ?? '?') + ' · <span class="k">via</span> ' + (e.order.method ?? 'demo')
      : '✗ <strong>rejected</strong> — ' + e.reason;
    feed.prepend(div);
  };
</script></body></html>`;
