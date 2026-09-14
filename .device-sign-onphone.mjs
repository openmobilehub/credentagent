// LOCAL DEV HELPER (untracked) — serve the intent-sign rail so a REAL phone can sign a
// spending grant. This is the on-device counterpart to examples/device-signed-grants.mjs
// (which simulates the wallet in-process). Not part of the shipped examples.
//
// Two transports, both origin-valid for the DC API:
//
//   A) adb reverse (no tunnel, no HTTPS — localhost IS a secure context)
//        node .device-sign-onphone.mjs
//        adb reverse tcp:4040 tcp:4040
//        → open the printed http://localhost:4040/... link in Chrome ON THE PHONE
//
//   B) public HTTPS tunnel (if you prefer, or adb is unavailable)
//        cloudflared tunnel --url http://localhost:4040
//        PUBLIC_URL=https://xxxx.trycloudflare.com node .device-sign-onphone.mjs
//
// Set INTENT_DEBUG_TRANSCRIPT=1 to log the exact handover bytes the gate hashes
// (on-device-interop.md §5) — that log is what you diff if the signature refuses.
import fs from "node:fs";
import express from "express";
import { CredentAgent } from "@openmobilehub/credentagent-gate";

const PORT = Number(process.env.PORT ?? 4040);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

// The demo reader identity, only if its PRIVATE key exists locally (gitignored — a fresh
// clone does not have it, see docs/guides/testing-on-device.md / issue #51). Without it the
// gate self-signs a reader per request (SAN = the request host): the ceremony still runs,
// but the phone shows an "unknown verifier" warning.
const KEY = "tools/demo-pki/keys/reader-key.pem";
const CERT = "tools/demo-pki/certs/reader-cert.pem";
const readerIdentity = fs.existsSync(KEY) && fs.existsSync(CERT)
  ? { certPem: fs.readFileSync(CERT, "utf8"), keyPem: fs.readFileSync(KEY, "utf8") }
  : undefined;

const credentagent = new CredentAgent({
  walletOrigin: PUBLIC_URL,
  gateSecret: "on-device-dev-secret",
  catalog: { coffee: { price: 18, category: "Beverages" }, "espresso-machine": { price: 120, category: "Beverages" } },
  ...(readerIdentity ? { readerIdentity } : {}),
});

const app = express();
app.use(express.json());
credentagent.grants.serve(app); // the signing page + /sign/request + /sign/verify

// Bind BEFORE minting the grant, so a busy port fails loudly instead of printing a link
// that 404s against whatever else is on it.
await new Promise((resolve, reject) => {
  const server = app.listen(PORT, resolve);
  server.on("error", (err) => {
    reject(err.code === "EADDRINUSE"
      ? new Error(`port ${PORT} is busy — stop the other server or run with PORT=<free port>`)
      : err);
  });
}).catch((err) => { console.error(`\n  ✗ ${err.message}\n`); process.exit(1); });

const grant = await credentagent.grants.create({
  merchant: "utopia",
  budget: 200,
  perSpend: 130,
  allow: { categories: ["Beverages"] },
  signing: "device",
  description: "Coffee runs while I'm away — up to $200 at Utopia, $130 per purchase.",
});

console.log(`\n  gate on :${PORT} · origin ${PUBLIC_URL}`);
console.log(`  readerIdentity: ${readerIdentity ? "demo reader cert" : "self-signed per request (expect an \"unknown verifier\" warning)"}`);
console.log(`  transcript debug: ${process.env.INTENT_DEBUG_TRANSCRIPT ? "ON" : "off (set INTENT_DEBUG_TRANSCRIPT=1)"}`);
console.log(`\n  1. import the payment credential on the phone (once):`);
console.log(`       docs/guides/testing-on-device.md §2 — tools/demo-pki/out/payment.mpzpass`);
console.log(`  2. if using adb:  adb reverse tcp:${PORT} tcp:${PORT}`);
console.log(`  3. open THIS on the phone, in Chrome (signed into a Google account):\n`);
console.log(`       ${grant.approveUrl}\n`);
console.log(`  waiting for the device signature… (ctrl-c to stop)\n`);

let last = "";
setInterval(async () => {
  const g = await credentagent.grants.retrieve(grant.id);
  const line = `status=${g.status} trustLevel=${g.trustLevel ?? "—"} doctype=${g.mandate?.credentialDoctype ?? "—"}`;
  if (line === last) return;
  last = line;
  console.log(`  → ${line}`);
  if (g.status === "authorized") {
    console.log(`\n  ✓ SIGNED ON DEVICE — boundsHash ${String(g.mandate?.boundsHash).slice(0, 16)}… signedAt ${g.mandate?.signedAt}\n`);
    process.exit(0);
  }
}, 1000);
