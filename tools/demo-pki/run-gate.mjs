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
const completion = async () => ({ completed: true });

const app = express();
const credentagent = new CredentAgent({ walletOrigin: `http://localhost:${PORT}`, ...(readerIdentity ? { readerIdentity } : {}) });
credentagent.mount(app, { orderStore, catalog, completion, signingKey: "demo-gate-secret" });

app.get("/", (_req, res) =>
  res.type("html").send(
    `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">` +
    `<h1>CredentAgent demo gate</h1><ul>` +
    `<li><a href="/credentagent/credential?cred=age&order=ORD-DEMO">Age gate (mDL)</a></li>` +
    `<li><a href="/credentagent/dc-payment?order=ORD-DEMO">Payment gate (payment credential)</a></li></ul>`,
  ),
);

app.listen(PORT, () => {
  const b = `http://localhost:${PORT}`;
  console.log(`\nCredentAgent demo gate → ${b}`);
  console.log(readerIdentity
    ? `  reader identity : certs/reader-cert.pem  (SAN=localhost, on utopia.rical → verifier shows TRUSTED)`
    : `  reader identity : none — self-signed per request. Ceremony still works; wallet shows the\n                    verifier as UNTRUSTED (red). Run ./gen-pki.sh + import utopia.rical to fix.`);
  console.log(`  order           : ORD-DEMO  (1× Cinema ticket, age 21+)\n`);
  console.log(`On the phone (after \`adb reverse tcp:${PORT} tcp:${PORT}\`), open one of:`);
  console.log(`  Age gate    : ${b}/credentagent/credential?cred=age&order=ORD-DEMO`);
  console.log(`  Payment gate: ${b}/credentagent/dc-payment?order=ORD-DEMO`);
  console.log(`  (or the index: ${b}/ )\n`);
  console.log(`Ctrl-C to stop.`);
});
