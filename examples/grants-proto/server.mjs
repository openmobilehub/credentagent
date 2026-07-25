// ⚠ PROTOTYPE — a validation demo, NOT the shipping library API. It graduates into the
//   real credentagent.orders.* / credentagent.grants.* API in #97 (the demo is rewired to it).
// server.mjs — runnable demo of the v10 `grants.*` surface (human-not-present) with a live UI.
//
//   (npm run build --workspaces)                 # once, if not built
//   node examples/grants-proto/server.mjs        # → http://localhost:4020
//
// Left pane  = human PRESENT: authorize once (the Intent Mandate is produced).
// Right pane = human AWAY: the agent's spend loop (budget/perSpend, remaining, replay) + revoke.

import { createServer } from "node:http";
import { GrantsProto, usd } from "./grants.mjs";

const PORT = Number(process.env.PORT ?? 4020);
const BASE = `http://localhost:${PORT}`;

const grants = new GrantsProto({ catalog: { wine: 2000, case: 5000 } });   // wine=$20, case=$50 (minor units; case > $30/spend)
const log = [];

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const read = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const p = url.pathname;

  if (p === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); return; }

  // grants.create — authorize once (human present)
  if (p === "/api/grant" && req.method === "POST") {
    const g = await grants.create({ merchant: "utopia", budget: usd.dollars(100), perSpend: usd.dollars(30), policy: [{ id: "age" }] });
    log.length = 0;
    log.push(`→ grants.create → ${g.id.slice(0, 14)}… · Intent Mandate sealed (${g.intentMandate.presence} · ${g.intentMandate.trustLevel})`);
    return json(res, 200, { grant: pub(g), log });
  }

  // grant.spend — human away
  if (p.match(/^\/api\/grant\/[^/]+\/spend$/) && req.method === "POST") {
    const id = p.split("/")[3];
    const { idempotencyKey, sku = "wine" } = await read(req);
    const g = grants.retrieve(id);
    if (!g) return json(res, 404, { error: "unknown grant" });
    const s = await g.spend({ idempotencyKey, items: [{ sku, qty: 1 }] });
    log.push(s.ok
      ? `  spend ${idempotencyKey} (${sku})${s.replayed ? " · replayed" : ""} → ok · $${(s.amount.amount / 100).toFixed(2)} · remaining $${(s.remaining.amount / 100).toFixed(2)}`
      : `  spend ${idempotencyKey} (${sku}) → refused: ${s.code} · remaining $${(s.remaining.amount / 100).toFixed(2)}`);
    return json(res, 200, { result: s, log });
  }

  // grant.revoke
  if (p.match(/^\/api\/grant\/[^/]+\/revoke$/) && req.method === "POST") {
    const id = p.split("/")[3];
    const g = grants.retrieve(id);
    if (!g) return json(res, 404, { error: "unknown grant" });
    const r = await g.revoke();
    log.push(`✗ grant.revoke → ${r.status} · next spend fails closed`);
    return json(res, 200, { result: r, log });
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => {
  console.log(`\n  grants.* prototype (human not present) → ${BASE}`);
  console.log(`  Left: authorize once (Intent Mandate produced).  Right: the spend loop + revoke.`);
  console.log(`  Real engine: DelegatedGate (dev-sealed intent, real bounds/ledger/revocation).\n  Open ${BASE}.\n`);
});

const pub = (g) => ({ id: g.id, status: g.status, intentMandate: g.intentMandate, budget: g.budget, perSpend: g.perSpend });

// ────────────────────────────────────────────────────────────────────
const CSS = `
  :root{--bg:#0b0f17;--surface:#121826;--surface2:#171f30;--border:#273043;--ink:#eaeff8;--muted:#9aa6bd;--accent:#6d93ff;--ok:#3ed89a;--pend:#e7a73c;--rf:#f1637c;--mono:ui-monospace,"SF Mono",Menlo,monospace}
  @media(prefers-color-scheme:light){:root{--bg:#f4f6fa;--surface:#fff;--surface2:#eef2f8;--border:#dce3ec;--ink:#101827;--muted:#59637a;--accent:#2b54d6;--ok:#0e9e6a;--pend:#c67c0a;--rf:#d63e57}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.55}
  .top{padding:1.1rem 1.5rem;border-bottom:1px solid var(--border);display:flex;align-items:baseline;gap:.7rem}
  .top h1{font-size:1.05rem;margin:0}.top .tag{font-family:var(--mono);font-size:.7rem;color:var(--accent);letter-spacing:.08em;text-transform:uppercase}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);min-height:calc(100vh - 58px)}
  .pane{background:var(--bg);padding:1.4rem 1.5rem}
  .pane h2{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 1rem;font-family:var(--mono)}
  button{font:inherit;font-weight:600;border:1px solid var(--accent);background:var(--accent);color:#fff;padding:.55rem 1rem;border-radius:9px;cursor:pointer;margin:.2rem .35rem .2rem 0}
  button.ghost{background:transparent;color:var(--accent)}button.deny{border-color:var(--rf);color:var(--rf);background:transparent}
  button:disabled{opacity:.4;cursor:not-allowed}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:1.1rem;margin-top:1rem}
  .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;font-family:var(--mono);font-size:.82rem;margin:.25rem 0}
  .k{color:var(--muted)}.pill{font-family:var(--mono);font-weight:700;font-size:.72rem;padding:.12rem .5rem;border-radius:999px}
  .p-ok{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
  .p-rf{background:color-mix(in srgb,var(--rf) 18%,transparent);color:var(--rf)}
  .p-pend{background:color-mix(in srgb,var(--pend) 20%,transparent);color:var(--pend)}
  pre{font-family:var(--mono);font-size:.74rem;background:var(--surface2);border:1px solid var(--border);border-radius:9px;padding:.8rem;overflow:auto;margin:.55rem 0 0}
  .bar{height:10px;border-radius:6px;background:var(--surface2);border:1px solid var(--border);overflow:hidden;margin:.4rem 0}
  .bar>span{display:block;height:100%;background:var(--ok)}
  .log{font-family:var(--mono);font-size:.75rem;color:var(--muted)}.log div{padding:.18rem 0;border-bottom:1px solid var(--border)}
  code{font-family:var(--mono)}
`;

const PAGE = `<!doctype html><html><head><meta charset="utf8"><meta name=viewport content="width=device-width,initial-scale=1"><title>grants.* prototype</title><style>${CSS}</style></head><body>
<div class=top><h1>grants.* — authorize once, spend later (human not present)</h1><span class=tag>credentagent · prototype</span></div>
<div class=grid>
  <div class=pane>
    <h2>① Human present — authorize once</h2>
    <button id=create>Create grant — $100 budget · $30/spend · Utopia</button>
    <div id=grant></div>
    <div class=card><div class=k style="font-family:var(--mono);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:.5rem">event log</div><div class=log id=log></div></div>
  </div>
  <div class=pane>
    <h2>② Human away — the agent spends</h2>
    <div id=spend class=k style="font-size:.85rem">Create a grant on the left; the spend controls appear here.</div>
    <div id=rows></div>
  </div>
</div>
<script>
let ID=null,n=0,lastKey=null,lastSku='wine',budgetMinor=10000;
const el=id=>document.getElementById(id);
el('create').onclick=async()=>{
  const {grant,log}=await(await fetch('/api/grant',{method:'POST'})).json();
  ID=grant.id;n=0;lastKey=null;budgetMinor=grant.budget.amount;
  el('grant').innerHTML=\`<div class=card>
    <div class=row><span class=k>grant</span><code>\${grant.id.slice(0,16)}…</code><span class="pill p-ok">\${grant.status}</span></div>
    <div class=row><span class=k>Intent Mandate</span><span class="pill p-pend">\${grant.intentMandate.presence}</span><span class="pill p-pend">\${grant.intentMandate.trustLevel}</span></div>
    <pre>intentMandate = \${JSON.stringify({type:grant.intentMandate.type,intentId:grant.intentMandate.intentId.slice(0,20)+'…',bounds:grant.intentMandate.bounds},null,2)}</pre>
    <p class=k style="font-size:.78rem;margin:.5rem 0 0">Today the intent is sealed server-side (\${grant.intentMandate.trustLevel}). The phone-wallet key-signing ceremony is the roadmap.</p></div>\`;
  el('spend').innerHTML=\`<div class=row><span class=k>budget</span><b id=rem>$\${(budgetMinor/100).toFixed(2)}</b><span class=k>left</span></div>
    <div class=bar><span id=barfill style="width:100%"></span></div>
    <div style="margin-top:.6rem">
      <button id=buy>Spend 1× wine ($20)</button>
      <button id=buycase class=ghost>Spend 1× case ($50 · over per-spend)</button>
      <button id=retry class=ghost disabled>Retry last (same key)</button>
      <button id=revoke class=deny>Revoke grant</button>
    </div>\`;
  el('rows').innerHTML='';
  paintLog(log);
  el('buy').onclick=()=>doSpend('buy-'+(++n),'wine');
  el('buycase').onclick=()=>doSpend('buy-'+(++n),'case');
  el('retry').onclick=()=>lastKey&&doSpend(lastKey,lastSku);
  el('revoke').onclick=async()=>{const {log}=await(await fetch('/api/grant/'+ID+'/revoke',{method:'POST'})).json();paintLog(log);};
};
async function doSpend(key,sku){
  lastKey=key;lastSku=sku;el('retry').disabled=false;
  const {result,log}=await(await fetch('/api/grant/'+ID+'/spend',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idempotencyKey:key,sku})})).json();
  const remMinor=result.remaining.amount;
  el('rem').textContent='$'+(remMinor/100).toFixed(2);el('barfill').style.width=(100*remMinor/budgetMinor)+'%';
  el('barfill').style.background=result.ok?'var(--ok)':'var(--rf)';
  const pill=result.ok?\`<span class="pill p-ok">ok\${result.replayed?' · replayed':''}</span>\`:\`<span class="pill p-rf">\${result.code}</span>\`;
  const detail=result.ok?\`$\${(result.amount.amount/100).toFixed(2)} · authorization=\${result.authorization} · presenceMode=\${result.mandateBundle.paymentMandate.presenceMode}\`:\`retryable=\${result.retryable||'—'}\`;
  const row=document.createElement('div');row.className='row';row.innerHTML=\`<code>\${key}</code>\${pill}<span class=k>\${detail}</span>\`;
  el('rows').prepend(row);paintLog(log);
}
function paintLog(log){el('log').innerHTML=log.slice(-10).map(l=>'<div>'+l+'</div>').join('');}
</script></body></html>`;
