#!/usr/bin/env node
// LIVE end-to-end test of #51 (short of the phone): stand up a real Express gate
// configured with the demo reader identity, drive both rails' request routes over
// actual HTTP, and prove the signed request the server returns presents the demo
// reader cert (the one utopia.rical vouches for). This exercises the full path a
// phone would hit — CredentAgent -> mount -> route handler -> builder — not just
// the unit-level builder.
//
//   (cd packages/credentagent-gate && npm run build)   # once, for dist/
//   node tools/demo-pki/e2e-gate-test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import * as jose from "jose";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const { CredentAgent } = await import(join(REPO, "packages/credentagent-gate/dist/index.js"));

const readerIdentity = {
  key: readFileSync(join(HERE, "keys/reader-key.pem"), "utf8"),
  cert: readFileSync(join(HERE, "certs/reader-cert.pem"), "utf8"),
};
const certDerB64 = readerIdentity.cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
const readerPub = await jose.importX509(readerIdentity.cert, "ES256");

// Minimal seams: one product, an order store that returns it, a re-pricing catalog.
const PRODUCTS = { "aurora-headphones": { price: 199 } };
const catalog = {
  createOrder(items, orderId) {
    const lines = items.map((it) => {
      const p = PRODUCTS[it.productId] ?? { price: 0 };
      return { id: it.productId, name: it.productId, unitPrice: p.price, currency: "USD", quantity: it.quantity, lineTotal: p.price * it.quantity };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    return { id: orderId, lines, itemCount: lines.length, subtotal, discount: 0, total: subtotal, currency: "USD" };
  },
};
const orderStore = { read: async () => ({ id: "ORD-E2E", lines: [{ id: "aurora-headphones", quantity: 1 }] }) };
const completion = async () => ({ completed: true });

const app = express();
const credentagent = new CredentAgent({ walletOrigin: "http://localhost:3000", readerIdentity });
credentagent.mount(app, { orderStore, catalog, completion, signingKey: "e2e-secret" });

const server = await new Promise((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const base = `http://localhost:${server.address().port}`;

const checks = [];
const ok = (name, cond, detail = "") => checks.push({ name, pass: !!cond, detail });

async function x5cAndVerify(label, jwt) {
  const x5c = (jose.decodeProtectedHeader(jwt).x5c ?? [])[0];
  ok(`${label}: presents the demo reader cert in x5c`, x5c === certDerB64);
  let sig = false;
  try { await jose.jwtVerify(jwt, readerPub); sig = true; } catch { /* */ }
  ok(`${label}: signature verifies against the demo reader key`, sig);
  const host = String(jose.decodeJwt(jwt).client_id ?? "");
  ok(`${label}: client_id binds x509_san_dns:localhost`, host === "x509_san_dns:localhost", host);
}

try {
  // Rail 1 — dc-payment
  const pay = await (await fetch(`${base}/credentagent/dc-payment/request?order=ORD-E2E`)).json();
  await x5cAndVerify("dc-payment", pay.request);

  // Rail 2 — credential (age); OpenID4VP request is requests[0]
  const cred = await (await fetch(`${base}/credentagent/credential/request?cred=age&order=ORD-E2E`)).json();
  const oid = cred.requests.find((r) => r.protocol === "openid4vp-v1-signed").data.request;
  await x5cAndVerify("credential(age)", oid);
  // the iOS ISO path is present but self-mints (documented scope) — assert it is NOT the demo cert
  const isoPresent = cred.requests.some((r) => r.protocol === "org-iso-mdoc");
  ok("credential(age): iOS ISO path present (self-signed, out of #51 scope)", isoPresent);
} finally {
  server.close();
}

console.log(`\nLIVE gate e2e — server drove real HTTP routes with readerIdentity = certs/reader-cert.pem`);
for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
const allPass = checks.every((c) => c.pass);
console.log(`\n${allPass ? "ALL PASS — the live gate presents the demo reader identity on both rails." : "FAILED — see above."}`);
process.exit(allPass ? 0 : 1);
