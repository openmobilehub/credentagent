// ⚠ PROTOTYPE — a validation demo, NOT the shipping library API. It graduates into the
//   real credentagent.orders.* / credentagent.grants.* API in #97 (the demo is rewired to it).
// server.mjs — the v10 `orders.*` surface wired to the REAL ceremony.
//
//   (npm run build --workspaces)                 # once, if not built
//   node examples/orders-proto/server.mjs        # → http://localhost:4010
//   # to prove on your phone: adb reverse tcp:4010 tcp:4010, then open the approveUrl there.
//
// This is now a REAL gate: it wraps createStorefront() + CredentAgent.mount() (exactly like
// tools/demo-pki/run-gate.mjs) and exposes orders.create / orders.retrieve over it. The
// approveUrl is the genuine checkout ceremony (age via OpenID4VP + payment via passkey/x402);
// real completion writes the completed-order store, and that write IS the order.settled webhook.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createStorefront } from "@openmobilehub/credentagent-storefront/server";
import { createOrder, SAMPLE_CATALOG } from "@openmobilehub/credentagent-storefront";
import { CredentAgent, age, payment, required, issueCartMandate } from "@openmobilehub/credentagent-gate";

const SIGNING_KEY = "orders-proto-secret";
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

// Build the REAL mandate bundle for a settled order (increment A): the cartMandate is a
// genuinely signed ap2.CartMandate (issueCartMandate over the order's lines); the paymentMandate
// is assembled from the real settlement record. intentMandate is absent on a human-present order.
function buildMandateBundle(order, rec) {
  const cart = issueCartMandate(
    { orderId: order.id, lines: order.lines, currency: order.currency ?? rec.currency, total: order.total ?? rec.amount },
    SIGNING_KEY,
  );
  const cartMandate = { ...cart, serialize() { return b64u(cart); } };
  const pay = {
    type: "ap2.PaymentMandate",
    orderId: order.id,
    amount: { amount: rec.amount, currency: rec.currency },
    method: rec.method,
    presenceMode: "human_present",
    authorization: "direct",
    cart: cart.id,
    ...(rec.txId ? { txId: rec.txId } : {}),
    ...(rec.network ? { network: rec.network } : {}),
    trust_level: "presence-only-demo",
  };
  const paymentMandate = { ...pay, serialize() { return b64u(pay); } };
  return { intentMandate: undefined, cartMandate, paymentMandate, trustLevel: "presence-only-demo" };
}

const PORT = Number(process.env.PORT ?? 4010);
const BASE = `http://localhost:${PORT}`;

// Optional demo reader identity (so the wallet shows the verifier TRUSTED). Reuses the
// demo-pki certs if present; otherwise self-signs (ceremony still works, shows "untrusted").
const RID = "/Users/diegozuluaga/tools/git/attestomcp/.worktrees/demo-pki/tools/demo-pki";
const readerIdentity =
  existsSync(`${RID}/keys/reader-key.pem`) && existsSync(`${RID}/certs/reader-cert.pem`)
    ? { key: readFileSync(`${RID}/keys/reader-key.pem`, "utf8"), cert: readFileSync(`${RID}/certs/reader-cert.pem`, "utf8") }
    : undefined;

// ── the stores (in-memory) — the completed store's write() is the order.settled webhook ──
const created = new Map();
const completed = new Map();
const events = new EventEmitter();
const createdOrderStore = { read: async (id) => created.get(id) ?? null, write: async (id, o) => { created.set(id, o); } };
const orderStore = {
  read: async (id) => completed.get(id) ?? null,
  write: async (id, rec) => { completed.set(id, rec); events.emit("order.settled", { id }); },
};

const store = createStorefront({ createdOrderStore, orderStore, baseUrl: BASE, signingKey: "orders-proto-secret" });
const credentagent = new CredentAgent({ walletOrigin: BASE, ...(readerIdentity ? { readerIdentity } : {}) });
credentagent.mount(store.app);

// The policy — age 21+ on age-restricted lines, payment last. Static array (predicates inside).
const POLICY = [
  required(age.over(21).when((o) => o.lines.some((l) => l.minimumAge != null))),
  required(payment.in("usd")),
];
store.gate((order) => credentagent.requirements(order, POLICY));

// The webhook (FR-009) — fired by the completed-store write when the REAL ceremony finishes.
const log = [];
events.on("order.settled", async ({ id }) => {
  const rec = completed.get(id);
  log.push(`✓ order.settled ${id} → ok · ${rec?.method ?? "?"} · ${rec?.currency ?? ""} ${(rec?.amount ?? 0) / 100} · ${rec?.txId ? "tx " + String(rec.txId).slice(0, 10) : "settled"}`);
});

const RESTRICTED = SAMPLE_CATALOG.find((p) => p.minimumAge != null) ?? SAMPLE_CATALOG[0];
const manifestFor = (order) => {
  const m = credentagent.requirements(order, POLICY);
  const list = Array.isArray(m) ? m : (m?.requires ?? m?.manifest ?? []);
  return list.map((e) => ({ credential: e.credential ?? e.id, required: e.required !== false, label: e.label ?? e.credential ?? e.id, minAge: e.minAge }));
};

// ── orders.* routes on the real gate's app ──
store.app.post("/api/checkout", async (_req, res) => {
  const id = `ord_${randomUUID().slice(0, 8)}`;
  const order = createOrder([{ productId: RESTRICTED.id, quantity: 1 }], id, SAMPLE_CATALOG);   // priced from the catalog
  await createdOrderStore.write(id, order);
  log.push(`→ orders.create → ${id} · ${RESTRICTED.name} · pending`);
  res.json({ id, approveUrl: `${BASE}/checkout?order=${id}`, manifest: manifestFor(order) });
});

store.app.get("/api/order/:id", async (req, res) => {
  const id = req.params.id;
  const rec = completed.get(id);
  const order = created.get(id);
  const door = rec
    ? {
        ok: true,
        authorization: "direct",
        trustLevel: "presence-only-demo",
        mandateBundle: order ? serializeBundle(buildMandateBundle(order, rec)) : undefined,   // increment A
        completion: { amount: rec.amount, currency: rec.currency, method: rec.method, txId: rec.txId ?? null, network: rec.network ?? null, completedAt: rec.completedAt },
      }
    : (order
        ? { ok: false, pending: true, approveUrl: `${BASE}/checkout?order=${id}`, trustLevel: "presence-only-demo" }
        : { ok: false, code: "not-found", trustLevel: "presence-only-demo" });
  res.json({ door, log });
});

// JSON-safe view of the bundle for the wire (calls the mandates' serialize()).
function serializeBundle(b) {
  return {
    intentMandate: b.intentMandate ?? null,
    cartMandate: { type: b.cartMandate.type, id: b.cartMandate.id, total: b.cartMandate.total, trust_level: b.cartMandate.trust_level, serialized: b.cartMandate.serialize() },
    paymentMandate: { type: b.paymentMandate.type, amount: b.paymentMandate.amount, method: b.paymentMandate.method, presenceMode: b.paymentMandate.presenceMode, authorization: b.paymentMandate.authorization, trust_level: b.paymentMandate.trust_level, serialized: b.paymentMandate.serialize() },
    trustLevel: b.trustLevel,
  };
}

// TEST-ONLY: simulate a ceremony completion so the ok-branch (+ mandateBundle) is verifiable
// without a phone. Writes the completed store exactly as the real rail does → fires order.settled.
store.app.post("/api/_test/settle/:id", async (req, res) => {
  const id = req.params.id;
  const order = created.get(id);
  if (!order) return res.status(404).json({ error: "unknown order" });
  await orderStore.write(id, { orderId: id, amount: order.total, currency: order.currency ?? "usd", method: "test-passkey", txId: "0xTEST" + id.slice(-6), network: "hedera-testnet", completedAt: new Date().toISOString() });
  res.json({ settled: true });
});

store.app.get("/", (_req, res) => { res.type("html").send(PAGE); });

const { url } = await store.listen(PORT);
console.log(`\n  orders.* prototype — wired to the REAL ceremony  →  ${BASE}`);
console.log(`  reader identity : ${readerIdentity ? "demo-pki (verifier shows TRUSTED)" : "self-signed (verifier shows untrusted)"}`);
console.log(`  demo UI         : ${BASE}/            (Start checkout → real checkout → order.settled)`);
console.log(`  MCP endpoint    : ${url}`);
console.log(`  On your phone   : adb reverse tcp:${PORT} tcp:${PORT}, then open the approveUrl there for the real wallet ceremony.\n`);

// ────────────────────────────────────────────────────────────────────
const CSS = `
  :root{--bg:#0b0f17;--surface:#121826;--surface2:#171f30;--border:#273043;--ink:#eaeff8;--muted:#9aa6bd;--accent:#6d93ff;--ok:#3ed89a;--pend:#e7a73c;--rf:#f1637c;--mono:ui-monospace,"SF Mono",Menlo,monospace}
  @media(prefers-color-scheme:light){:root{--bg:#f4f6fa;--surface:#fff;--surface2:#eef2f8;--border:#dce3ec;--ink:#101827;--muted:#59637a;--accent:#2b54d6;--ok:#0e9e6a;--pend:#c67c0a;--rf:#d63e57}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.55}
  .top{padding:1.1rem 1.5rem;border-bottom:1px solid var(--border);display:flex;align-items:baseline;gap:.7rem}
  .top h1{font-size:1.05rem;margin:0;letter-spacing:-.01em}.top .tag{font-family:var(--mono);font-size:.7rem;color:var(--accent);letter-spacing:.08em;text-transform:uppercase}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);min-height:calc(100vh - 58px)}
  .pane{background:var(--bg);padding:1.4rem 1.5rem}
  .pane h2{font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 1rem;font-family:var(--mono)}
  button{font:inherit;font-weight:600;border:1px solid var(--accent);background:var(--accent);color:#fff;padding:.6rem 1.1rem;border-radius:9px;cursor:pointer}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:1.1rem;margin-top:1rem}
  .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;font-family:var(--mono);font-size:.82rem;margin:.3rem 0}
  .k{color:var(--muted)}.pill{font-family:var(--mono);font-weight:700;font-size:.75rem;padding:.15rem .55rem;border-radius:999px}
  .p-ok{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
  .p-pend{background:color-mix(in srgb,var(--pend) 20%,transparent);color:var(--pend)}
  pre{font-family:var(--mono);font-size:.76rem;background:var(--surface2);border:1px solid var(--border);border-radius:9px;padding:.85rem;overflow:auto;margin:.6rem 0 0}
  .log{font-family:var(--mono);font-size:.75rem;color:var(--muted)}.log div{padding:.2rem 0;border-bottom:1px solid var(--border)}
  a{color:var(--accent)}code{font-family:var(--mono)}iframe{width:100%;height:520px;border:1px solid var(--border);border-radius:11px;margin-top:1rem;background:var(--surface)}
  .hint{font-size:.85rem;color:var(--muted);margin:.6rem 0 0}
`;

const PAGE = `<!doctype html><html><head><meta charset="utf8"><meta name=viewport content="width=device-width,initial-scale=1"><title>orders.* · real ceremony</title><style>${CSS}</style></head><body>
<div class=top><h1>orders.* — wired to the real ceremony</h1><span class=tag>credentagent · prototype</span></div>
<div class=grid>
  <div class=pane>
    <h2>① Merchant / Agent</h2>
    <button id=start>Start checkout — real gate · age 21+ · payment</button>
    <div id=order></div>
    <div class=card><div class=k style="font-family:var(--mono);font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;margin-bottom:.5rem">order.settled webhook · server log</div><div class=log id=log></div></div>
  </div>
  <div class=pane>
    <h2>② The real checkout (prove age + pay)</h2>
    <div id=wallet class=k style="font-size:.85rem">Start a checkout on the left — the genuine checkout page loads here. Age is proven with your phone wallet (OpenID4VP); payment is a passkey (x402 on Hedera testnet).</div>
    <p class=hint>To prove on your phone: <code>adb reverse tcp:4010 tcp:4010</code>, then open the approveUrl there.</p>
  </div>
</div>
<script>
let ID=null,timer=null;const el=id=>document.getElementById(id);
el('start').onclick=async()=>{
  const r=await(await fetch('/api/checkout',{method:'POST'})).json();ID=r.id;
  el('order').innerHTML=\`<div class=card>
    <div class=row><span class=k>order</span><code>\${r.id}</code><span class="pill p-pend" id=st>pending</span></div>
    <div class=row><span class=k>must prove</span>\${r.manifest.map(m=>\`<code>\${m.label}\${m.required?'':' (optional)'}</code>\`).join(' · ')}</div>
    <div class=row><span class=k>approveUrl</span><a href=\${r.approveUrl} target=_blank><code>\${r.approveUrl}</code></a></div>
    <div id=result></div></div>\`;
  el('wallet').innerHTML='<iframe src="'+r.approveUrl+'"></iframe><p class=hint>Or open it on your phone for the wallet ceremony.</p>';
  clearInterval(timer);timer=setInterval(poll,1200);poll();
};
async function poll(){
  if(!ID)return;const {door,log}=await(await fetch('/api/order/'+ID)).json();
  el('log').innerHTML=log.slice(-8).map(l=>'<div>'+l+'</div>').join('');
  const st=el('st');if(!st)return;
  if(door.ok){st.className='pill p-ok';st.textContent='ok';clearInterval(timer);
    const mb=door.mandateBundle;
    el('result').innerHTML=\`<div class=row style="margin-top:.6rem"><span class=k>authorization</span><code>\${door.authorization}</code><span class="pill p-ok">trust: \${door.trustLevel}</span></div>
    <pre>res.mandateBundle = \${JSON.stringify({intentMandate:mb?.intentMandate,cartMandate:{type:mb?.cartMandate.type,id:mb?.cartMandate.id,total:mb?.cartMandate.total,trust_level:mb?.cartMandate.trust_level,'serialize()':(mb?.cartMandate.serialized||'').slice(0,32)+'…'},paymentMandate:{...mb?.paymentMandate,serialized:(mb?.paymentMandate.serialized||'').slice(0,32)+'…'}},null,2)}</pre>
    <pre>res.completion = \${JSON.stringify(door.completion,null,2)}</pre>\`;}
}
</script></body></html>`;
