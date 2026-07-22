#!/usr/bin/env node
// Test the demo credentials against what the gate ACTUALLY requests: for each
// .mpzpass, confirm it carries the exact doctype + claim elements the gate's DCQL
// asks for, and chains to the trusted demo IACA (which utopia.vical wraps). If all
// pass, a ceremony would find the right elements to disclose and the wallet would
// show the card as issuer-trusted — everything short of the physical present.
//
//   (cd packages/credentagent-gate && npm run build)   # once, for dist/
//   node tools/demo-pki/test-credentials.mjs
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decode } from "cbor-x";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const gate = (p) => import(join(REPO, "packages/credentagent-gate/dist/ceremony", p));
const { buildCredentialDcql } = await gate("credential-gate/dcql.js");
const { buildDcPaymentDcql } = await gate("dc-payment/dcql.js");

// DER of the demo IACA (the anchor the VICAL publishes).
const iacaDer = Buffer.from(
  readFileSync(join(HERE, "certs/iaca-cert.pem"), "utf8").replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, ""),
  "base64",
);
const vical = readFileSync(join(HERE, "out/utopia.vical"));

// each credential → the DCQL the gate sends for it (the professional license has no
// built-in rail on this branch, so its request is stated inline).
const CREDS = [
  { file: "mdl.mpzpass", label: "Driver License (age gate)", dcql: buildCredentialDcql("age", { minimumAge: 21 }) },
  { file: "membership.mpzpass", label: "Membership", dcql: buildCredentialDcql("membership") },
  { file: "payment.mpzpass", label: "Digital Payment", dcql: buildDcPaymentDcql() },
  { file: "professional-license.mpzpass", label: "Professional License",
    dcql: { credentials: [{ meta: { doctype_value: "org.example.license.1" }, claims: [{ path: ["org.example.license.1", "license_active"] }] }] } },
];

function inflate(file) {
  const top = decode(readFileSync(join(HERE, "out", file))); // ["MpzPass", raw-deflate(cbor)]
  return inflateRawSync(top[1]);
}

let allPass = true;
for (const c of CREDS) {
  const opt = c.dcql.credentials[0];
  const doctype = opt.meta.doctype_value;
  const leaves = opt.claims.map((cl) => cl.path[cl.path.length - 1]);
  const bytes = inflate(c.file);
  const text = bytes.toString("latin1");

  const missing = leaves.filter((l) => !text.includes(l));
  const rows = [
    [`doctype the gate requests present (${doctype})`, text.includes(doctype)],
    [`all requested claims present (${leaves.join(", ")})`, missing.length === 0, missing.length ? `missing: ${missing}` : ""],
    ["chains to the demo IACA", bytes.includes(iacaDer)],
    ["IACA is on utopia.vical (issuer-trusted)", vical.includes(iacaDer)],
  ];
  console.log(`\n${c.label}  [${c.file}]`);
  for (const [name, pass, detail] of rows) {
    if (!pass) allPass = false;
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  }
}
console.log(`\n${allPass ? "ALL PASS — every credential satisfies its gate's request and is issuer-trusted." : "FAILED — see above."}`);
process.exit(allPass ? 0 : 1);
