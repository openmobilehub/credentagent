// Diagnose a failing dc-payment "Amount binding — hash x" run.
//
// Input: the JSON body of POST /credentagent/dc-payment/verify (copy it from
// DevTools > Network > verify > Response). It contains mandate.userAuthorization
// with { transactionData, transactionDataHash, transactionDataHashAlg, vpToken }.
//
//   node inspect-dc-hash.mjs verify-response.json
//
// It prints: what the wallet actually put in deviceSigned, and which hash input
// (if any) reproduces the wallet's hash.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { decode, Tag } from "cbor-x";

const file = process.argv[2];
if (!file) { console.error("usage: node inspect-dc-hash.mjs <verify-response.json>"); process.exit(1); }
const body = JSON.parse(fs.readFileSync(file, "utf8"));
const ua = body?.mandate?.userAuthorization ?? body?.userAuthorization ?? body;
const { transactionData, transactionDataHash, transactionDataHashAlg, vpToken } = ua;

const b64 = (s) => new Uint8Array(Buffer.from(String(s), "base64url"));
const untag = (i) => (i instanceof Tag ? decode(i.value) : i instanceof Uint8Array ? decode(i) : i);

console.log("=== what we sealed (transaction_data we sent) ===");
console.log(Buffer.from(transactionData, "base64url").toString("utf8"));
console.log("\nreported transaction_data_hash_alg (COSE):", transactionDataHashAlg ?? "(absent → SHA-256 default)");
console.log("wallet transaction_data_hash (b64url):", transactionDataHash ?? "(NULL — nothing extracted!)");

if (!vpToken) { console.log("\nno vpToken in the mandate — rerun with the full /verify response"); process.exit(0); }

const dr = decode(b64(vpToken));
for (const [i, doc] of (dr.documents ?? []).entries()) {
  console.log(`\n=== document[${i}] docType=${doc.docType} ===`);
  const ns = untag(doc.deviceSigned?.nameSpaces);
  console.log("deviceSigned namespaces:", ns ? Object.keys(ns) : "(none)");
  for (const [name, items] of Object.entries(ns ?? {})) {
    console.log(`  ${name}:`);
    for (const [k, v] of Object.entries(items ?? {})) {
      const shown = v instanceof Uint8Array
        ? `bstr(${v.length}) b64url=${Buffer.from(v).toString("base64url")}`
        : JSON.stringify(v);
      console.log(`    ${k} = ${shown}`);
    }
  }
}

// Which input reproduces the wallet's hash? Rules out / confirms the two
// competing explanations: hash over the base64url STRING (what we and Multipaz
// do) vs over the decoded JSON bytes, and which SHA-2 length was used.
if (transactionDataHash) {
  console.log("\n=== hash candidates vs the wallet's value ===");
  const jsonBytes = Buffer.from(transactionData, "base64url");
  for (const alg of ["sha256", "sha384", "sha512"]) {
    for (const [label, input] of [["b64url-string", Buffer.from(transactionData, "utf8")], ["decoded-json", jsonBytes]]) {
      const h = createHash(alg).update(input).digest("base64url");
      console.log(`  ${alg} over ${label}: ${h === transactionDataHash ? "*** MATCH ***" : "no"}  ${h}`);
    }
  }
}
