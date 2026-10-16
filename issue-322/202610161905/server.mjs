// Evidence server. Run with cwd = a checkout (before/ or repo/). Env:
//   PORT          port to listen on (localhost:PORT stands in for https://shop.example)
//   WALLET_ORIGIN the gate's walletOrigin, e.g. https://shop.example/store
//   MOUNT_PREFIX  where the store's app sits on the host ("/store" or "" for root)
// `outer.use(prefix, app)` strips the prefix before the gate's app sees the request — exactly what a
// path-stripping reverse proxy does in front of a store served under a path.
import { join } from "node:path";
import { createRequire } from "node:module";

const cwd = process.cwd();
const require = createRequire(join(cwd, "package.json"));
const express = require("express");
const { CredentAgent } = await import(join(cwd, "packages/credentagent-gate/dist/index.js"));

const PORT = Number(process.env.PORT);
const WALLET_ORIGIN = process.env.WALLET_ORIGIN;
const PREFIX = process.env.MOUNT_PREFIX ?? "";
const LOCAL = `http://localhost:${PORT}`;

const gate = new CredentAgent({ walletOrigin: WALLET_ORIGIN });
const app = express();
gate.mount(app);

const outer = express();
if (PREFIX) outer.use(PREFIX, app);
else outer.use(app);

// did:web resolution (W3C did:web method): did:web:host[:seg...] ->
//   no path  -> https://host/.well-known/did.json
//   path     -> https://host/seg/.../did.json
function didWebToUrl(did) {
  const parts = did.slice("did:web:".length).split(":").map(decodeURIComponent);
  const host = parts.shift();
  return parts.length ? `https://${host}/${parts.join("/")}/did.json` : `https://${host}/.well-known/did.json`;
}
// shop.example is played by localhost:PORT.
const toLocal = (u) => u.replace(/^https:\/\/shop\.example/, LOCAL);

async function probe(url) {
  const r = await fetch(url);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { url, status: r.status, json };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

outer.get("/__resolve", async (_req, res) => {
  const base = WALLET_ORIGIN.replace(/\/$/, "");
  const candidates = [`${base}/.well-known/did.json`, `${base}/did.json`];
  const probes = [];
  for (const c of candidates) probes.push({ public: c, ...(await probe(toLocal(c))) });
  const published = probes.find((p) => p.status === 200 && p.json?.id);
  let verdict = "No DID document is published under the store's origin.";
  let ok = false, resolution = null;
  if (published) {
    const did = published.json.id;
    const resolveUrl = didWebToUrl(did);
    resolution = { did, resolveUrl, ...(await probe(toLocal(resolveUrl))) };
    ok = resolution.status === 200 && resolution.json?.id === did &&
      JSON.stringify(resolution.json) === JSON.stringify(published.json);
    verdict = ok
      ? `PASS: resolving ${did} lands on ${resolveUrl}, which serves this store's own key document.`
      : `FAIL: the store claims ${did}, but did:web resolution of that id goes to ${resolveUrl} (HTTP ${resolution.status}), not to where the store published its key.`;
  }
  const row = (p) => `<tr><td><code>${esc(p.public ?? p.resolveUrl)}</code></td><td class="s${p.status}">${p.status}</td><td><code>${esc(p.json?.id ?? "—")}</code></td></tr>`;
  res.type("html").send(`<!doctype html><meta charset="utf-8"><title>did:web resolution check</title>
<style>body{font:15px system-ui;margin:32px;max-width:1150px}code{font:13px ui-monospace,monospace}
table{border-collapse:collapse;width:100%;margin:8px 0 20px}td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}
.s200{color:#06622a;font-weight:600}.s404{color:#a00;font-weight:600}
.v{padding:14px;border-radius:6px;font-weight:600}.ok{background:#e3f6e8;border:2px solid #2a8a4a}.bad{background:#fde6e6;border:2px solid #b33}
pre{background:#f5f5f5;padding:10px;overflow:auto;font-size:12px}</style>
<h2>did:web resolution check — <code>${esc(process.env.SIDE_LABEL ?? "")}</code></h2>
<p>Gate: <code>new CredentAgent({ walletOrigin: "${esc(WALLET_ORIGIN)}" })</code>, <code>mount(app)</code>, app served ${PREFIX ? `under <code>${esc(PREFIX)}</code> behind a path-stripping mount` : "at the site root"}.
<br><code>shop.example</code> is played by <code>${esc(LOCAL)}</code>.</p>
<h3>1. Where the store publishes its key</h3>
<table><tr><th>Public URL</th><th>HTTP</th><th>Document id</th></tr>${probes.map(row).join("")}</table>
<h3>2. What a stranger does: resolve the DID the store claims</h3>
${resolution ? `<table><tr><th>did:web resolves <code>${esc(resolution.did)}</code> to</th><th>HTTP</th><th>Document id</th></tr>${row(resolution)}</table>` : "<p>(nothing to resolve)</p>"}
<div class="v ${ok ? "ok" : "bad"}">${esc(verdict)}</div>
${published ? `<h3>Published document</h3><pre>${esc(JSON.stringify(published.json, null, 2))}</pre>` : ""}`);
});

outer.listen(PORT, () => console.log(`evidence server on ${LOCAL} walletOrigin=${WALLET_ORIGIN} prefix=${PREFIX || "/"}`));
