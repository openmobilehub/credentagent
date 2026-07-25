#!/usr/bin/env node
// End-to-end verifier-trust proof (short of the phone) for #51.
//
// Feeds the REAL demo reader identity (keys/reader-key.pem + certs/reader-cert.pem)
// into the gate's actual request builder and proves a wallet that imported utopia.rical
// WOULD trust this verifier:
//   1. the gate presents the demo reader cert in the request's x5c  (gate is wired)
//   2. that cert is signed for by the ES256 request signature       (reader key is used)
//   3. the request's client_id host == the cert SAN (== localhost)   (origin binding holds)
//   4. utopia.rical wraps THIS exact cert                            (wallet trusts the reader)
//
// The one thing it can't do is the physical on-phone ceremony. Run:
//   (cd packages/credentagent-gate && npm run build)   # once, to produce dist/
//   node tools/demo-pki/verify-reader-trust.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as jose from "jose";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const { buildDcPaymentRequest } = await import(
  join(REPO, "packages/credentagent-gate/dist/ceremony/dc-payment/request.js")
);

const keyPem = readFileSync(join(HERE, "keys/reader-key.pem"), "utf8");
const certPem = readFileSync(join(HERE, "certs/reader-cert.pem"), "utf8");
const ricalBytes = readFileSync(join(HERE, "out/utopia.rical"));

const certDerB64 = certPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
const certDer = Buffer.from(certDerB64, "base64");

const ORIGIN = { rpID: "localhost", origin: "http://localhost:3007" };
const ORDER = {
  id: "ORD-VRT", lines: [{ id: "x", name: "x", unitPrice: 100, currency: "USD", quantity: 1, lineTotal: 100 }],
  itemCount: 1, subtotal: 100, discount: 0, total: 100, currency: "USD",
};

const req = await buildDcPaymentRequest(ORDER, ORIGIN, "verify-secret", { key: keyPem, cert: certPem });
const header = jose.decodeProtectedHeader(req.request);
const payload = jose.decodeJwt(req.request);

const checks = [];
const ok = (name, cond, detail = "") => checks.push({ name, pass: !!cond, detail });

// 1. the gate presents the demo reader cert (not a self-signed one)
ok("gate presents demo reader cert in x5c", header.x5c?.[0] === certDerB64);

// 2. the request is really signed by the demo reader key
let sigOk = false;
try {
  await jose.jwtVerify(req.request, await jose.importX509(certPem, "ES256"));
  sigOk = true;
} catch { /* sigOk stays false */ }
ok("request ES256 signature verifies against the reader cert", sigOk);

// 3. origin binding: client_id host == the cert SAN (localhost)
ok("client_id binds to the origin host", payload.client_id === `x509_san_dns:${ORIGIN.rpID}`, String(payload.client_id));

// 4. the RICAL wraps THIS exact reader cert → the wallet trusts the verifier
ok("utopia.rical wraps this reader cert", ricalBytes.includes(certDer));

console.log("\nverifier-trust proof — reader = tools/demo-pki/certs/reader-cert.pem");
for (const c of checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
const allPass = checks.every((c) => c.pass);
console.log(`\n${allPass ? "ALL PASS — a wallet holding utopia.rical would show this verifier as trusted." : "FAILED — see above."}`);
process.exit(allPass ? 0 : 1);
