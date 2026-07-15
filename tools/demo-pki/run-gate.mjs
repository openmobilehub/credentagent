#!/usr/bin/env node
// A runnable CredentAgent gate for on-device testing of the demo credentials.
// Serves the ceremony pages on a fixed port, configured with the demo reader
// identity (so a wallet holding utopia.rical shows this verifier as trusted).
//
//   (cd packages/credentagent-gate && npm run build)   # once, for dist/
//   node tools/demo-pki/run-gate.mjs                    # gate on :3007
//   adb reverse tcp:3007 tcp:3007                       # phone → localhost:3007
// then open a printed URL on the phone and run the ceremony.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const PORT = Number(process.env.PORT ?? 3007);
const { CredentAgent } = await import(join(REPO, "packages/credentagent-gate/dist/index.js"));

// The demo reader identity is OPTIONAL. If the demo PKI has been generated
// (keys/reader-key.pem + certs/reader-cert.pem, from ./gen-pki.sh), present it so a
// wallet holding utopia.rical trusts the verifier. If it's absent — e.g. a fresh
// clone — run WITHOUT it: the gate self-signs a reader cert per request, the ceremony
// still works, the wallet just shows the verifier as untrusted (red). Zero-config:
// `node run-gate.mjs` works on a fresh checkout; the PKI is a trust upgrade, not a
// prerequisite.
const keyPath = join(HERE, "keys/reader-key.pem");
const certPath = join(HERE, "certs/reader-cert.pem");
const readerIdentity = existsSync(keyPath) && existsSync(certPath)
  ? { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") }
  : undefined;

// One age-restricted demo product, so BOTH the age gate and payment apply.
const PRODUCTS = { "cinema-ticket": { price: 15, minimumAge: 21 } };
const catalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => {
      const p = PRODUCTS[it.productId] ?? { price: 0 };
      return {
        id: it.productId, name: "Cinema ticket", unitPrice: p.price, currency: "USD",
        quantity: it.quantity, lineTotal: p.price * it.quantity,
        ...(p.minimumAge ? { minimumAge: p.minimumAge } : {}),
      };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal, discount: 0, total: subtotal, currency: "USD" };
  },
};
const orderStore = { read: async (id) => ({ id, lines: [{ id: "cinema-ticket", quantity: 1 }] }) };
const completed = new Set(); // order ids that finished payment, so /checkout can show "done"
const completion = async (input) => { if (input?.order?.id) completed.add(input.order.id); return { completed: true }; };

const app = express();
const credentagent = new CredentAgent({ walletOrigin: `http://localhost:${PORT}`, ...(readerIdentity ? { readerIdentity } : {}) });
credentagent.mount(app, { orderStore, catalog, completion, signingKey: "demo-gate-secret" });

// Checkout hub — sequences the gates (age → pay → done) so ONE link walks the whole
// flow. This is what the gate pages return to (their default returnUrl is
// /checkout?order=<id>). NOTE: the hub is run-gate's own demo glue, NOT part of the
// gate library — the gate mounts /credentagent/*; a real host (the storefront) owns
// its own checkout. It reads age-verified from CredentAgent's per-order store and
// "paid" from the completion seam above.
app.get("/checkout", async (req, res) => {
  const orderId = typeof req.query.order === "string" ? req.query.order : "ORD-DEMO";
  const stored = await orderStore.read(orderId);
  const order = catalog.createOrder(stored.lines.map((l) => ({ productId: l.id, quantity: l.quantity })), orderId);
  const ageRestricted = order.lines.some((l) => typeof l.minimumAge === "number" && l.minimumAge > 0);
  const ageDone = (((await credentagent.store.read(orderId)) || {}).ageVerified) === true;
  const paid = completed.has(orderId);
  const q = `order=${encodeURIComponent(orderId)}`;
  const next =
    ageRestricted && !ageDone ? { label: "Verify age (21+) →", href: `/credentagent/credential?cred=age&${q}` }
    : !paid ? { label: `Authorize $${order.total} →`, href: `/credentagent/dc-payment?${q}` }
    : null;
  const tick = (d) => (d ? "✅" : "⬜️");
  const rows = [
    ...(ageRestricted ? [`${tick(ageDone)} Verify age (21+)`] : []),
    `${tick(paid)} Pay $${order.total}`,
  ].map((r) => `<li>${r}</li>`).join("");
  res.type("html").send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<style>body{font:16px/1.55 -apple-system,system-ui,sans-serif;max-width:560px;margin:44px auto;padding:0 20px;color:#0f172a}
h1{font-size:22px;margin:0 0 4px}.muted{color:#64748b}
.card{border:1px solid #e2e8f0;border-radius:14px;padding:22px;box-shadow:0 1px 3px rgba(15,23,42,.08)}
ul{list-style:none;padding:0;font-size:18px;margin:0}li{margin:10px 0}
a.btn{display:block;text-align:center;background:#0d9488;color:#fff;font-weight:700;text-decoration:none;padding:14px;border-radius:10px;margin-top:18px}
.done{background:#ecfdf5;border:1px solid #34d399;color:#047857;font-weight:700;text-align:center;padding:16px;border-radius:12px;margin-top:18px}</style>
<h1>Checkout — ${orderId}</h1>
<p class="muted">Cinema ticket ×1 · $${order.total}${ageRestricted ? " · age-restricted (21+)" : ""}</p>
<div class="card">
  <ul>${rows}</ul>
  ${next ? `<a class="btn" href="${next.href}">${next.label}</a>` : `<div class="done">✓ Order complete — every gate satisfied</div>`}
</div>
<p class="muted" style="font-size:13px;margin-top:14px">🔒 presence-only-demo. Red "untrusted" warnings on the wallet are expected unless you've imported the VICAL/RICAL — the flow still completes.</p>`);
});

app.get("/", (_req, res) => res.redirect("/checkout?order=ORD-DEMO"));

app.listen(PORT, () => {
  const b = `http://localhost:${PORT}`;
  console.log(`\nCredentAgent demo gate → ${b}`);
  console.log(readerIdentity
    ? `  reader identity : certs/reader-cert.pem  (SAN=localhost, on utopia.rical → verifier shows TRUSTED)`
    : `  reader identity : none — self-signed per request. Ceremony still works; wallet shows the\n                    verifier as UNTRUSTED (red). Run ./gen-pki.sh + import utopia.rical to fix.`);
  console.log(`  order           : ORD-DEMO  (1× Cinema ticket, age 21+)\n`);
  console.log(`Full checkout flow (age → pay → done) — one link:`);
  console.log(`  ${b}/checkout?order=ORD-DEMO`);
  console.log(`  (on the phone: \`adb reverse tcp:${PORT} tcp:${PORT}\` first, then open it there)\n`);
  console.log(`Ctrl-C to stop.`);
});
